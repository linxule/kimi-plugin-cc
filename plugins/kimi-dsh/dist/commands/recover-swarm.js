import { RECOVER_SWARM_SUPPORTED_FLAGS } from "../parsing.js";
import { randomUUID } from "node:crypto";
import { lstat, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCliCancellationHandlers } from "../cli-cancellation.js";
import { RuntimeError } from "../errors.js";
import { captureWorktreePatch, resolveRepoIdentity } from "../git.js";
import { verifyHookInstalled } from "../hooks/install.js";
import { markJobFailed } from "../jobs.js";
import { JobStore } from "../job-store.js";
import { executionPlanFromPersisted, prepareKimiExecutionPlan } from "../kimi-engine.js";
import { resolveKimiHome } from "../kimi-home.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { probeProcessIdentity } from "../process-tree.js";
import { deactivateSwarmSession } from "../swarm-activation.js";
import { assertRecoveryOwnerGone, finishRecoveryRecord, recordRecoveryEvent, recoverLaunch, recoveryError } from "../swarm-recovery.js";
export async function runRecoverSwarm(argv, context) {
    const positional = argv.filter((arg) => !arg.startsWith("-"));
    if (positional.length !== 1 || argv.some((arg) => arg.startsWith("-") && arg !== RECOVER_SWARM_SUPPORTED_FLAGS) || argv.filter((arg) => arg === RECOVER_SWARM_SUPPORTED_FLAGS).length > 1) {
        throw new RuntimeError("INVALID_ARGS", `Usage: companion.sh recover-swarm <job-id> [${RECOVER_SWARM_SUPPORTED_FLAGS}]. Defaults to preview.`, "swarm.recovery.args");
    }
    const jobId = positional[0];
    const apply = argv.includes(RECOVER_SWARM_SUPPORTED_FLAGS);
    const paths = resolvePluginPaths(context.env);
    await ensurePluginPaths(paths);
    const repo = await resolveRepoIdentity(context.cwd);
    const store = new JobStore(paths);
    let claim;
    const handlers = createCliCancellationHandlers();
    const signal = AbortSignal.any([handlers.signal, AbortSignal.timeout(30_000)]);
    try {
        const job = store.getJob(jobId);
        const saved = store.getSwarmRecovery(jobId);
        if (!job || job.repo_id !== repo.repoId || !saved || saved.record.schema !== 1 || saved.record.jobId !== jobId) {
            throw recoveryError("No recovery record owned by this repository. Older runs require manual inspection.");
        }
        let record = saved.record;
        const summary = () => ({ job_id: jobId, mode: apply ? "apply" : "preview", recovery_complete: record.complete,
            session_id: record.session?.sessionId ?? null, session_cleanup_pending: record.sessionDirty,
            launches: record.launches, worktree: record.workspaceRoot, patch_path: record.patchPath,
            next_step: record.complete ? "No recovery is needed. Retained worktrees may be inspected and removed manually."
                : `Inspect this record; use companion.sh recover-swarm ${jobId} --apply only after the original job has stopped.` });
        const settleAbandonedJob = async () => {
            if (job.status === "running")
                await markJobFailed(store, paths, job, new RuntimeError("SWARM_OWNER_DISAPPEARED", "The original swarm companion stopped without reporting a result; resource recovery completed, not the task.", "swarm.recovery"), "Abandoned swarm resources recovered; task did not complete.", { phase: "failed" });
        };
        if (!apply)
            return `${JSON.stringify(summary(), null, 2)}\n`;
        if (record.complete) {
            if (job.status === "running") {
                await assertRecoveryOwnerGone(record);
                await settleAbandonedJob();
            }
            return `${JSON.stringify(summary(), null, 2)}\n`;
        }
        await assertRecoveryOwnerGone(record);
        if (saved.owner !== null) {
            const owner = JSON.parse(saved.owner);
            const live = await probeProcessIdentity(owner.pid);
            if (!live.complete || live.identity?.startToken === owner.startToken)
                throw recoveryError("Another recovery owner is alive or cannot be verified.");
        }
        const self = await probeProcessIdentity(process.pid);
        if (!self.complete || !self.identity)
            throw recoveryError("Cannot establish recovery ownership on this host.");
        claim = JSON.stringify(self.identity);
        if (!store.claimSwarmRecovery(jobId, saved.owner, claim)) {
            claim = undefined;
            throw recoveryError("Another recovery acquired this job.");
        }
        // Another owner may have completed and released the claim between our first read
        // and the CAS (null -> owner -> null). Never overwrite that newer journal.
        record = store.getSwarmRecovery(jobId).record;
        if (record.complete) {
            await settleAbandonedJob();
            return `${JSON.stringify(summary(), null, 2)}\n`;
        }
        const expectedRoot = job.operation_kind === "swarm-write"
            ? path.join(paths.worktreesDir, job.repo_id, `swarm-write-${job.job_id}`) : null;
        if (record.workspaceRoot !== expectedRoot || record.cwd !== (expectedRoot ?? job.cwd)
            || record.kimiHome !== resolveKimiHome(context.env, record.cwd)) {
            throw recoveryError("Recovery workspace or Kimi home differs from the recorded job. Use its original home and repository; do not guess a session.");
        }
        if (expectedRoot) {
            const st = await lstat(expectedRoot);
            if (!st.isDirectory() || st.isSymbolicLink())
                throw recoveryError("Recovery worktree must be the original non-symlink directory.");
            const parent = await realpath(path.dirname(expectedRoot));
            if (await realpath(expectedRoot) !== path.join(parent, path.basename(expectedRoot)))
                throw recoveryError("Recovery worktree path is redirected.");
        }
        const persist = () => store.saveSwarmRecovery(jobId, record);
        for (const launch of record.launches)
            await recoverLaunch(launch, persist, signal);
        if (record.sessionDirty) {
            if (!record.session || !/^[\w-]+$/.test(record.session.sessionId) || !/^[\w-]+$/.test(record.session.workspaceId))
                throw recoveryError("Recovery session identity is missing or invalid.");
            const installed = await verifyHookInstalled(context.env);
            if (!installed.installed)
                throw recoveryError(`Managed hook verification failed: ${installed.reason ?? "unknown"}. Recovery does not install or relax hooks.`);
            const plan = executionPlanFromPersisted(job);
            const current = await prepareKimiExecutionPlan({ operationKind: plan.operationKind, cwd: record.cwd, env: context.env });
            if (current.command !== plan.command || current.kimiVersion !== plan.kimiVersion || JSON.stringify(current.prefixArgs) !== JSON.stringify(plan.prefixArgs))
                throw recoveryError("The exact recorded CLI is not selected. Restore that certified binary before session cleanup.");
            signal.throwIfAborted();
            await deactivateSwarmSession({ cwd: record.cwd, env: context.env, command: current.command,
                prefixArgs: current.prefixArgs, executionPlan: current, commandLabel: expectedRoot ? "swarm-write" : "swarm",
                trustedWorkspaceRoot: expectedRoot ?? undefined, ...record.session, signal,
                onRecoveryEvent: (event) => recordRecoveryEvent(store, record, event) });
        }
        signal.throwIfAborted();
        if (expectedRoot) {
            // Capture without applying or deleting. A crash after the write leaves a recoverable artifact.
            const patch = await captureWorktreePatch(expectedRoot, signal);
            const patchPath = path.join(paths.artifactsDir, `swarm-recovered-${jobId}-${randomUUID()}.patch`);
            await writeFile(patchPath, patch, { flag: "wx", mode: 0o600 });
            record.patchPath = patchPath;
        }
        finishRecoveryRecord(store, record);
        if (!record.complete)
            throw recoveryError("Recovery remains incomplete; evidence and worktree were retained.");
        await settleAbandonedJob();
        return `${JSON.stringify(summary(), null, 2)}\n`;
    }
    finally {
        handlers.dispose();
        try {
            if (claim !== undefined)
                store.claimSwarmRecovery(jobId, claim, null);
        }
        finally {
            store.close();
        }
    }
}
