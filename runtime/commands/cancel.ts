import process from "node:process";

import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { markJobCancelled, sweepStaleBackgroundJobs } from "../jobs.js";
import { JobStore } from "../job-store.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { parseJobLookupArgs } from "../parsing.js";
import type { CommandContext } from "../types.js";

export async function runCancel(argv: string[], context: CommandContext): Promise<string> {
  const parsed = parseJobLookupArgs(argv);
  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);
  const repoIdentity = await resolveRepoIdentity(context.cwd);
  const store = new JobStore(paths);

  try {
    await sweepStaleBackgroundJobs(store, paths);

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
      return `${JSON.stringify(
        {
          job_id: job.job_id,
          status: job.status,
          message: "cancel is a no-op for terminal jobs.",
        },
        null,
        2,
      )}\n`;
    }

    if (!job.background || job.pid === null) {
      throw new RuntimeError(
        "CANCEL_NOT_SUPPORTED",
        `Job ${job.job_id} is not a cancellable background worker.`,
        "cancel.runtime",
      );
    }

    try {
      process.kill(job.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }

    const cancelled = await waitForCancellation(paths, job.job_id);
    if (cancelled) {
      return `${JSON.stringify(
        {
          job_id: cancelled.job_id,
          status: cancelled.status,
          message: "Cancellation completed.",
        },
        null,
        2,
      )}\n`;
    }

    try {
      process.kill(job.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }

    const forcedStore = new JobStore(paths);
    try {
      const current = forcedStore.getJob(job.job_id);
      if (current?.status === "running") {
        await markJobCancelled(
          forcedStore,
          paths,
          current,
          "Background rescue was force-cancelled after worker termination.",
          undefined,
          current.command_type === "rescue" ? { phase: "cancelled" } : undefined,
        );
      }
    } finally {
      forcedStore.close();
    }

    return `${JSON.stringify(
      {
        job_id: job.job_id,
        status: "cancelled",
        message: "Cancellation escalated to worker termination.",
      },
      null,
      2,
    )}\n`;
  } finally {
    store.close();
  }
}

async function waitForCancellation(paths: ReturnType<typeof resolvePluginPaths>, jobId: string) {
  const deadline = Date.now() + 4_000;

  while (Date.now() < deadline) {
    const store = new JobStore(paths);
    try {
      const current = store.getJob(jobId);
      if (current && current.status !== "running") {
        return current;
      }
    } finally {
      store.close();
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
  }

  return null;
}
