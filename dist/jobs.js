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
export async function sweepStaleJobs(store, paths) {
    for (const job of store.listRunningJobsWithProcessHints()) {
        if (!isStaleEnoughToSweep(job)) {
            continue;
        }
        const companionMissing = job.pid !== null && !isPidAlive(job.pid);
        const kimiMissing = job.kimi_pid !== null && !isPidAlive(job.kimi_pid);
        if (job.background) {
            if (!companionMissing && !kimiMissing) {
                continue;
            }
            terminateRecordedProcesses(job);
            await markJobFailed(store, paths, job, new RuntimeError(companionMissing ? "WORKER_DISAPPEARED" : "KIMI_PROCESS_DISAPPEARED", companionMissing
                ? `Background worker pid ${job.pid} is no longer running.`
                : `Kimi pid ${job.kimi_pid} is no longer running while background worker pid ${job.pid} is still recorded.`, "jobs.sweep"), companionMissing
                ? "Background worker disappeared before reporting a terminal state."
                : "Kimi process disappeared before reporting a terminal state.", job.command_type === "ask" || job.command_type === "rescue" ? { phase: "failed" } : undefined);
            continue;
        }
        if (!companionMissing && !kimiMissing) {
            continue;
        }
        terminateRecordedProcesses(job);
        await markJobFailed(store, paths, job, new RuntimeError("FOREGROUND_PROCESS_DISAPPEARED", describeMissingForegroundProcess(job, companionMissing, kimiMissing), "jobs.sweep"), "Foreground Kimi job disappeared before reporting a terminal state.", job.command_type === "ask" || job.command_type === "rescue" ? { phase: "failed" } : undefined);
    }
}
const STALE_SWEEP_GRACE_MS = 15_000;
function isStaleEnoughToSweep(job) {
    const updatedAt = Date.parse(job.updated_at);
    return Number.isFinite(updatedAt) && Date.now() - updatedAt >= STALE_SWEEP_GRACE_MS;
}
function describeMissingForegroundProcess(job, companionMissing, kimiMissing) {
    if (companionMissing && kimiMissing) {
        return `Foreground companion pid ${job.pid} and Kimi pid ${job.kimi_pid} are no longer running.`;
    }
    if (companionMissing) {
        return `Foreground companion pid ${job.pid} is no longer running.`;
    }
    return `Kimi pid ${job.kimi_pid} is no longer running.`;
}
function terminateRecordedProcesses(job) {
    const pids = new Set();
    if (job.pid !== null)
        pids.add(job.pid);
    if (job.kimi_pid !== null)
        pids.add(job.kimi_pid);
    for (const pid of pids) {
        if (isPidAlive(pid)) {
            killPid(pid, "SIGTERM");
        }
    }
}
function killPid(pid, signal) {
    try {
        process.kill(pid, signal);
    }
    catch (error) {
        if (error.code !== "ESRCH") {
            throw error;
        }
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
