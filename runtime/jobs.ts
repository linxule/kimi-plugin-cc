import { createHash } from "node:crypto";

import { RuntimeError } from "./errors.js";
import type { JobRecord, JobStore } from "./job-store.js";
import type { PluginPaths } from "./paths.js";
import { renderTerminalJobArtifact, writeArtifact } from "./render.js";
import type { JobError } from "./types.js";

export function digestPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

export function normalizeJobError(error: unknown): JobError {
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

export async function markJobFailed(
  store: JobStore,
  paths: PluginPaths,
  job: JobRecord,
  error: unknown,
  summary = "Job failed.",
): Promise<JobRecord> {
  const normalized = normalizeJobError(error);
  const artifactJob = {
    ...job,
    status: "failed" as const,
    summary,
    error: normalized,
    final_output_path: null,
    pid: null,
    kimi_pid: null,
  };
  const artifactPath = await writeArtifact(paths, artifactJob, renderTerminalJobArtifact(artifactJob));

  return (
    store.markFailed(job.job_id, {
      summary,
      error: normalized,
      final_output_path: artifactPath,
    }) ?? artifactJob
  );
}

export async function markJobCancelled(
  store: JobStore,
  paths: PluginPaths,
  job: JobRecord,
  summary: string,
  error?: unknown,
): Promise<JobRecord> {
  const normalized = error ? normalizeJobError(error) : null;
  const artifactJob = {
    ...job,
    status: "cancelled" as const,
    summary,
    error: normalized,
    final_output_path: null,
    pid: null,
    kimi_pid: null,
  };
  const artifactPath = await writeArtifact(paths, artifactJob, renderTerminalJobArtifact(artifactJob));

  return (
    store.markCancelled(job.job_id, {
      summary,
      error: normalized,
      final_output_path: artifactPath,
    }) ?? artifactJob
  );
}

export async function sweepStaleBackgroundJobs(store: JobStore, paths: PluginPaths): Promise<void> {
  for (const job of store.listRunningBackgroundJobs()) {
    if (job.pid === null) {
      continue;
    }

    if (isPidAlive(job.pid)) {
      continue;
    }

    await markJobFailed(
      store,
      paths,
      job,
      new RuntimeError(
        "WORKER_DISAPPEARED",
        `Background worker pid ${job.pid} is no longer running.`,
        "jobs.sweep",
      ),
      "Background worker disappeared before reporting a terminal state.",
    );
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    return true;
  }
}

export async function waitForTerminalJob(
  storeFactory: () => JobStore,
  jobId: string,
  timeoutMs = 60_000,
): Promise<JobRecord> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const store = storeFactory();
    try {
      const job = store.getJob(jobId);
      if (job && job.status !== "running") {
        return job;
      }
    } finally {
      store.close();
    }

    await sleep(200);
  }

  throw new RuntimeError(
    "JOB_WAIT_TIMEOUT",
    `Timed out while waiting for job ${jobId} to finish.`,
    "jobs.wait",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
