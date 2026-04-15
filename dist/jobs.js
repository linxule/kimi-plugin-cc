import { createHash } from "node:crypto";
import { RuntimeError } from "./errors.js";
import { renderTerminalJobArtifact, writeArtifact } from "./render.js";
export function digestPrompt(prompt) {
    return createHash("sha256").update(prompt).digest("hex");
}
export function normalizeJobError(error) {
    if (error instanceof RuntimeError) {
        return {
            code: error.code,
            message: error.message,
            stage: error.stage,
        };
    }
    if (error instanceof Error) {
        return {
            code: "UNEXPECTED_ERROR",
            message: error.message,
            stage: "runtime",
        };
    }
    return {
        code: "UNEXPECTED_ERROR",
        message: String(error),
        stage: "runtime",
    };
}
export async function markJobFailed(store, paths, job, error, summary = "Job failed.", options) {
    const normalized = normalizeJobError(error);
    const phase = options?.phase;
    const artifactJob = {
        ...job,
        status: "failed",
        summary,
        error: normalized,
        final_output_path: null,
        pid: null,
        kimi_pid: null,
        ...(phase !== undefined ? { phase } : {}),
    };
    const artifactPath = await writeArtifact(paths, artifactJob, renderTerminalJobArtifact(artifactJob));
    return (store.markFailed(job.job_id, {
        summary,
        error: normalized,
        final_output_path: artifactPath,
        ...(phase !== undefined ? { phase } : {}),
    }) ?? artifactJob);
}
export async function markJobCancelled(store, paths, job, summary, error, options) {
    const normalized = error ? normalizeJobError(error) : null;
    const phase = options?.phase;
    const artifactJob = {
        ...job,
        status: "cancelled",
        summary,
        error: normalized,
        final_output_path: null,
        pid: null,
        kimi_pid: null,
        ...(phase !== undefined ? { phase } : {}),
    };
    const artifactPath = await writeArtifact(paths, artifactJob, renderTerminalJobArtifact(artifactJob));
    return (store.markCancelled(job.job_id, {
        summary,
        error: normalized,
        final_output_path: artifactPath,
        ...(phase !== undefined ? { phase } : {}),
    }) ?? artifactJob);
}
export async function sweepStaleBackgroundJobs(store, paths) {
    for (const job of store.listRunningBackgroundJobs()) {
        if (job.pid === null) {
            continue;
        }
        // This is still vulnerable to PID reuse races. Fixing that needs pidfds or a worker heartbeat,
        // which is out of scope for phase 3b.
        if (isPidAlive(job.pid)) {
            continue;
        }
        await markJobFailed(store, paths, job, new RuntimeError("WORKER_DISAPPEARED", `Background worker pid ${job.pid} is no longer running.`, "jobs.sweep"), "Background worker disappeared before reporting a terminal state.", job.command_type === "rescue" ? { phase: "failed" } : undefined);
    }
}
function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        const code = error.code;
        if (code === "ESRCH") {
            return false;
        }
        return true;
    }
}
export async function waitForTerminalJob(storeFactory, jobId, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const store = storeFactory();
        try {
            const job = store.getJob(jobId);
            if (job && job.status !== "running") {
                return job;
            }
        }
        finally {
            store.close();
        }
        await sleep(200);
    }
    throw new RuntimeError("JOB_WAIT_TIMEOUT", `Timed out after ${timeoutMs}ms while waiting for job ${jobId} to finish. The worker may still be running; use /kimi:status ${jobId} to check progress or /kimi:result ${jobId} once it completes.`, "jobs.wait");
}
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
