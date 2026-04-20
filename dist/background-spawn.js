import { spawn } from "node:child_process";
import { access, constants as fsConstants } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeError } from "./errors.js";
import { markJobFailed, waitForTerminalJob } from "./jobs.js";
import { JobStore } from "./job-store.js";
import { readArtifact } from "./render.js";
// Resolves to runtime/companion.ts in dev (via tsx) and dist/companion.js in production (compiled
// with tsc to the same relative layout). The extension is derived from the running module so the
// child-process spawn in startBackgroundJob targets the right entrypoint in both modes.
const isCompiledRuntime = import.meta.url.endsWith(".js");
const companionEntrypoint = fileURLToPath(new URL(isCompiledRuntime ? "./companion.js" : "./companion.ts", import.meta.url));
const companionProjectRoot = path.resolve(path.dirname(companionEntrypoint), "..");
export async function startBackgroundJob(job, prompt, context, paths, options) {
    const nodeBinary = context.env.KIMI_PLUGIN_CC_NODE_BIN || process.execPath;
    // Only fast-path the `fs.access` check for absolute/relative paths. A bare
    // name like "node" is resolved by spawn() via PATH; the spawn `error` listener
    // will still surface ENOENT on nextTick for that path, classified as
    // spawnFailedErrorCode via the listener below.
    if (nodeBinary.includes("/") || nodeBinary.includes("\\")) {
        try {
            await access(nodeBinary, fsConstants.X_OK);
        }
        catch (accessError) {
            const code = accessError.code;
            if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
                const classified = new RuntimeError(options.nodeBinInvalidErrorCode, `Configured Node binary is not executable: ${nodeBinary}. Set KIMI_PLUGIN_CC_NODE_BIN to a valid Node >=22.5 executable and retry.`, options.spawnStage, accessError instanceof Error ? { cause: accessError } : undefined);
                const failStore = new JobStore(paths);
                try {
                    await markJobFailed(failStore, paths, job, classified, options.failedSummary, { phase: "failed" });
                }
                finally {
                    failStore.close();
                }
                throw classified;
            }
            // Any other errno (EIO, etc.) — fall through to the spawn attempt and let the
            // existing spawn error path surface it.
        }
    }
    const b64 = Buffer.from(prompt, "utf8").toString("base64");
    const spawnArgs = isCompiledRuntime
        ? [companionEntrypoint, "worker", options.workerKind, job.job_id]
        : ["--import", "tsx", companionEntrypoint, "worker", options.workerKind, job.job_id];
    const child = spawn(nodeBinary, spawnArgs, {
        cwd: companionProjectRoot,
        detached: true,
        stdio: "ignore",
        env: {
            ...context.env,
            KIMI_PLUGIN_CC_WORKSPACE_CWD: context.cwd,
            [options.promptEnvVar]: b64,
            [options.reusedSessionEnvVar]: options.reusedSession ? "1" : "0",
            ...(options.extraEnv ?? {}),
        },
    });
    let spawnReportedFailure = false;
    const spawnErrorPromise = new Promise((resolve) => {
        let settled = false;
        const settle = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(value);
        };
        child.once("error", (spawnError) => {
            spawnReportedFailure = true;
            settle(new RuntimeError(options.spawnFailedErrorCode, `Background ${options.workerKind} worker failed to spawn: ${spawnError.message}`, options.spawnStage, { cause: spawnError }));
        });
        // Give the event loop one tick to deliver a synchronous spawn error
        // (ENOENT fires on process.nextTick). If nothing fires by then, the
        // child is live and we can proceed.
        setImmediate(() => settle(null));
    });
    child.on("close", (exitCode, signal) => {
        if (spawnReportedFailure) {
            return;
        }
        if (exitCode === null || exitCode === 0) {
            return;
        }
        // The worker exited non-zero before any state update. If the job is
        // still in its spawn phase, the worker never reached executeJob.
        const classified = new RuntimeError(options.earlyExitErrorCode, `Background ${options.workerKind} worker exited with code ${exitCode}${signal ? ` (signal ${signal})` : ""} before reporting a result.`, options.spawnStage);
        void markEarlyExit(paths, job.job_id, classified, options.failedSummary);
    });
    child.unref();
    const spawnError = await spawnErrorPromise;
    if (spawnError) {
        await markSpawnFailure(paths, job.job_id, spawnError, options.failedSummary);
        throw spawnError;
    }
    const store = new JobStore(paths);
    try {
        store.updateRunningJob(job.job_id, {
            pid: child.pid ?? null,
            phase: "worker-spawned",
        });
    }
    finally {
        store.close();
    }
    if (options.wait) {
        const completed = await waitForTerminalJob(() => new JobStore(paths), job.job_id);
        if (!completed.final_output_path) {
            throw new RuntimeError(options.missingResultErrorCode, describeMissingResult(completed, options.workerKind), options.waitStage);
        }
        return readArtifact(completed.final_output_path);
    }
    return `${JSON.stringify({
        job_id: job.job_id,
        command_type: job.command_type,
    }, null, 2)}\n`;
}
async function markSpawnFailure(paths, jobId, classified, failedSummary) {
    const store = new JobStore(paths);
    try {
        const current = store.getJob(jobId);
        if (!current || current.status !== "running") {
            return;
        }
        await markJobFailed(store, paths, current, classified, failedSummary, { phase: "failed" });
    }
    catch (writeError) {
        process.stderr.write(`[kimi-plugin-cc] failed to mark job ${jobId} as spawn-failed: ${writeError.message ?? String(writeError)}\n`);
    }
    finally {
        store.close();
    }
}
async function markEarlyExit(paths, jobId, classified, failedSummary) {
    const store = new JobStore(paths);
    try {
        const current = store.getJob(jobId);
        if (!current || current.status !== "running") {
            return;
        }
        // Only mark failure if the worker exited before advancing past the spawn phase.
        // Once the worker reaches worker-running or turn-running, the child owns the
        // job state and the parent's close listener must not race with it.
        if (current.phase !== "worker-spawned" && current.phase !== "queued") {
            return;
        }
        await markJobFailed(store, paths, current, classified, failedSummary, { phase: "failed" });
    }
    catch (writeError) {
        process.stderr.write(`[kimi-plugin-cc] failed to mark job ${jobId} as early-exit: ${writeError.message ?? String(writeError)}\n`);
    }
    finally {
        store.close();
    }
}
/**
 * Builds a descriptive message for the rare edge case where `waitForTerminalJob`
 * returns a terminal job whose `final_output_path` is null (e.g. `markJobFailed`'s
 * own artifact write failed). The normal background --wait failure path returns
 * the rendered failure artifact via `readArtifact` — that artifact already
 * carries the code, stage, and message via `renderTerminalJobArtifact`. This
 * helper is belt-and-suspenders for the near-unreachable case where even the
 * failure artifact could not be written. Intended for terminal job records only;
 * a running record would render the generic "finished without a rendered result."
 * sentence, which would be misleading.
 */
export function describeMissingResult(job, workerKind = "rescue") {
    const base = `Background ${workerKind} job ${job.job_id} finished without a rendered result`;
    if (job.status === "failed" || job.status === "cancelled") {
        const code = job.error?.code || "unknown";
        const stage = job.error?.stage || "unknown";
        // `||` (not `??`) intentionally: empty-string error.message or summary
        // should fall through to the next fallback, not render as blank.
        const detail = job.error?.message || job.summary || "no further detail";
        return `${base} (${job.status}, ${code}, stage ${stage}): ${detail}`;
    }
    return `${base}.`;
}
