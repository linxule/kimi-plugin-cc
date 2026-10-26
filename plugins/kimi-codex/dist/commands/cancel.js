import process from "node:process";
import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { markJobCancelled, sweepStaleJobs } from "../jobs.js";
import { JobStore, withJobStore } from "../job-store.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { parseJobLookupArgs } from "../parsing.js";
import { revalidateProcessIdentities } from "../process-tree.js";
import { getManagedCommandConfig } from "./registry.js";
export async function runCancel(argv, context) {
    const parsed = parseJobLookupArgs(argv);
    const paths = resolvePluginPaths(context.env);
    await ensurePluginPaths(paths);
    const repoIdentity = await resolveRepoIdentity(context.cwd);
    const store = new JobStore(paths);
    try {
        await sweepStaleJobs(store, paths);
        const job = parsed.jobId
            ? store.getJob(parsed.jobId)
            : store.findLatestJob({
                repoId: repoIdentity.repoId,
                commandType: parsed.type,
                runningOnly: true,
            });
        if (!job) {
            throw new RuntimeError("JOB_NOT_FOUND", "No running job was found to cancel.", "cancel.lookup");
        }
        if (job.status !== "running") {
            return `${JSON.stringify({
                job_id: job.job_id,
                status: job.status,
                message: "cancel is a no-op for terminal jobs.",
            }, null, 2)}\n`;
        }
        if (store.getMcpTask(job.job_id) &&
            (context.mcpCompanionIdentity === undefined || context.mcpKimiIdentity === undefined)) {
            throw new RuntimeError("MCP_CANCEL_REQUIRES_BINDING", `MCP job ${job.job_id} requires MCP job-control cancellation with recorded identities; use tasks/cancel or kimi_job_cancel.`, "mcp.cancel");
        }
        const recovery = store.getSwarmRecovery(job.job_id)?.record;
        if (recovery) {
            const identity = recovery.owner;
            const verified = identity && identity.pid === job.pid ? await revalidateProcessIdentities([identity]) : undefined;
            if (!verified?.complete || verified.groupChanged?.length || verified.identities.length !== 1) {
                throw new RuntimeError("SWARM_RECOVERY_REQUIRED", `Recorded swarm ownership is no longer live or verifiable. Preview companion.sh recover-swarm ${job.job_id}; no process was signalled.`, "cancel.identity");
            }
        }
        if (job.pid === null && job.kimi_pid === null) {
            throw new RuntimeError("CANCEL_NOT_SUPPORTED", `Job ${job.job_id} does not have a recorded process id to cancel.`, "cancel.runtime");
        }
        // review_gate runs in a Stop hook. Pre-mark the row as cancelled before
        // signaling so the subprocess close/result path cannot persist a failure
        // over the user's intent; later updates are no-ops on a terminal row.
        //
        // The terminal row also makes waitForCancellation return before its own
        // escalation, so this path always attempts SIGTERM after the pre-mark
        // attempt, waits 1s, and sends SIGKILL only if a recorded process remains
        // live. A pre-mark failure is rethrown only after termination is attempted.
        if (job.command_type === "review_gate") {
            let preMarkError;
            try {
                await withJobStore(paths, async (preMarkStore) => {
                    const reviewGateCancel = getManagedCommandConfig("review_gate").cancellation;
                    await markJobCancelled(preMarkStore, paths, job, reviewGateCancel.cancelledSummary, new RuntimeError(reviewGateCancel.errorCodes.cancelled, reviewGateCancel.cancelMessages.default, "cancel.runtime"));
                });
            }
            catch (error) {
                preMarkError = error;
            }
            await assertMcpCompanionIdentity(job, context.mcpCompanionIdentity);
            signalJobProcesses(job, "SIGTERM");
            await sleep(1_000);
            if (hasLiveRecordedProcess(job)) {
                signalJobProcesses(job, "SIGKILL");
            }
            if (preMarkError) {
                throw preMarkError;
            }
            return `${JSON.stringify({
                job_id: job.job_id,
                status: "cancelled",
                message: "review_gate cancelled; SIGTERM→SIGKILL escalation completed.",
            }, null, 2)}\n`;
        }
        await assertMcpCompanionIdentity(job, context.mcpCompanionIdentity);
        await assertMcpKimiIdentity(job, context.mcpKimiIdentity);
        if (recovery)
            await assertMcpCompanionIdentity(job, recovery.owner);
        // The live swarm owner owns child teardown, including web phases after print exit.
        signalJobProcesses(job, "SIGTERM", { companion: true, kimi: !recovery });
        const cancelled = await waitForCancellation(paths, job.job_id);
        if (cancelled) {
            return `${JSON.stringify({
                job_id: cancelled.job_id,
                status: cancelled.status,
                message: "Cancellation completed.",
            }, null, 2)}\n`;
        }
        const companionMatches = await assertMcpCompanionIdentity(job, recovery ? recovery.owner : context.mcpCompanionIdentity, true);
        const kimiMatches = await assertMcpKimiIdentity(job, context.mcpKimiIdentity, true);
        if (companionMatches || kimiMatches) {
            signalJobProcesses(job, "SIGKILL", { companion: companionMatches, kimi: !recovery && kimiMatches });
        }
        await withJobStore(paths, async (forcedStore) => {
            const current = forcedStore.getJob(job.job_id);
            if (current?.status === "running") {
                await markJobCancelled(forcedStore, paths, current, "Job was force-cancelled after recorded process termination.", undefined, current.command_type === "ask" || current.command_type === "rescue" ? { phase: "cancelled" } : undefined);
            }
        });
        return `${JSON.stringify({
            job_id: job.job_id,
            status: "cancelled",
            message: "Cancellation escalated to worker termination.",
        }, null, 2)}\n`;
    }
    finally {
        store.close();
    }
}
async function assertMcpCompanionIdentity(job, expected, allowMissing = false) {
    return assertMcpProcessIdentity(job.pid, expected, "companion", allowMissing);
}
async function assertMcpKimiIdentity(job, expected, allowMissing = false) {
    return assertMcpProcessIdentity(job.kimi_pid, expected, "Kimi", allowMissing);
}
async function assertMcpProcessIdentity(actualPid, expected, label, allowMissing) {
    if (expected === undefined)
        return true;
    if (expected === null) {
        if (actualPid === null)
            return false;
        throw new RuntimeError("CANCEL_NOT_SUPPORTED", `MCP job ${actualPid} has no verified ${label} identity; refusing PID-only cancellation.`, "mcp.cancel");
    }
    if (actualPid !== expected.pid) {
        throw new RuntimeError("MCP_PROCESS_IDENTITY_MISMATCH", `The recorded ${label} process identity no longer matches; no signal was sent.`, "mcp.cancel");
    }
    const validation = await revalidateProcessIdentities([expected]);
    if (!validation.complete) {
        throw new RuntimeError("MCP_PROCESS_IDENTITY_UNAVAILABLE", `The ${label} identity probe was inconclusive; no further signal was sent and the job was not changed.`, "mcp.cancel");
    }
    const matches = validation.identities.length > 0;
    if (!matches && !allowMissing) {
        throw new RuntimeError("MCP_PROCESS_IDENTITY_MISMATCH", `The recorded ${label} process identity no longer matches; no signal was sent.`, "mcp.cancel");
    }
    return matches;
}
function signalJobProcesses(job, signal, include = { companion: true, kimi: true }) {
    const pids = new Set();
    if (include.companion && job.pid !== null)
        pids.add(job.pid);
    if (include.kimi && job.kimi_pid !== null)
        pids.add(job.kimi_pid);
    for (const pid of pids) {
        try {
            process.kill(pid, signal);
        }
        catch (error) {
            const code = error.code;
            // ESRCH: process already gone. EPERM: pid was likely reused by an
            // unrelated process we don't own — silently skip rather than surface a
            // confusing "operation not permitted" to the user.
            if (code !== "ESRCH" && code !== "EPERM") {
                throw error;
            }
        }
    }
}
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
async function waitForCancellation(paths, jobId) {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
        const store = new JobStore(paths);
        try {
            const current = store.getJob(jobId);
            if (current && current.status !== "running") {
                return current;
            }
            if (current && !hasLiveRecordedProcess(current)) {
                return null;
            }
        }
        finally {
            store.close();
        }
        await new Promise((resolve) => {
            setTimeout(resolve, 200);
        });
    }
    return null;
}
function hasLiveRecordedProcess(job) {
    const pids = new Set();
    if (job.pid !== null)
        pids.add(job.pid);
    if (job.kimi_pid !== null)
        pids.add(job.kimi_pid);
    for (const pid of pids) {
        try {
            process.kill(pid, 0);
            return true;
        }
        catch (error) {
            const code = error.code;
            // ESRCH: definitively dead. EPERM: pid likely reused by an
            // unrelated process — treat as dead for our purposes (consistent
            // with isPidAlive in jobs.ts and signalJobProcesses above).
            if (code !== "ESRCH" && code !== "EPERM") {
                return true;
            }
        }
    }
    return false;
}
