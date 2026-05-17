import process from "node:process";

import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { markJobCancelled, sweepStaleJobs } from "../jobs.js";
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

    if (job.pid === null && job.kimi_pid === null) {
      throw new RuntimeError(
        "CANCEL_NOT_SUPPORTED",
        `Job ${job.job_id} does not have a recorded process id to cancel.`,
        "cancel.runtime",
      );
    }

    // review_gate runs in a Stop hook; SIGTERMing kimi_pid causes the wire
    // process to exit with WIRE_PROCESS_EXITED, which the hook's catch path
    // would persist as `failed`. Pre-mark the row as `cancelled` here so the
    // user's intent is recorded canonically — the subsequent wire exit is a
    // no-op against an already-terminal row (markFailed has a WHERE
    // status='running' guard).
    if (job.command_type === "review_gate") {
      const preMarkStore = new JobStore(paths);
      try {
        await markJobCancelled(
          preMarkStore,
          paths,
          job,
          "review_gate cancelled by user request.",
          new RuntimeError(
            "REVIEW_GATE_CANCELLED",
            "review_gate cancelled by user request.",
            "cancel.runtime",
          ),
        );
      } finally {
        preMarkStore.close();
      }
    }

    signalJobProcesses(job, "SIGTERM");

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

    signalJobProcesses(job, "SIGKILL");

    const forcedStore = new JobStore(paths);
    try {
      const current = forcedStore.getJob(job.job_id);
      if (current?.status === "running") {
        await markJobCancelled(
          forcedStore,
          paths,
          current,
          "Job was force-cancelled after recorded process termination.",
          undefined,
          current.command_type === "ask" || current.command_type === "rescue" ? { phase: "cancelled" } : undefined,
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

function signalJobProcesses(
  job: { pid: number | null; kimi_pid: number | null },
  signal: NodeJS.Signals,
): void {
  const pids = new Set<number>();
  if (job.pid !== null) pids.add(job.pid);
  if (job.kimi_pid !== null) pids.add(job.kimi_pid);

  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ESRCH: process already gone. EPERM: pid was likely reused by an
      // unrelated process we don't own — silently skip rather than surface a
      // confusing "operation not permitted" to the user.
      if (code !== "ESRCH" && code !== "EPERM") {
        throw error;
      }
    }
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
      if (current && !hasLiveRecordedProcess(current)) {
        return null;
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

function hasLiveRecordedProcess(job: { pid: number | null; kimi_pid: number | null }): boolean {
  const pids = new Set<number>();
  if (job.pid !== null) pids.add(job.pid);
  if (job.kimi_pid !== null) pids.add(job.kimi_pid);

  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
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
