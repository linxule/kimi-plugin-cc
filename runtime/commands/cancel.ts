import process from "node:process";

import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { markJobCancelled, sweepStaleJobs } from "../jobs.js";
import { JobStore, withJobStore } from "../job-store.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { parseJobLookupArgs } from "../parsing.js";
import { getManagedCommandConfig } from "./registry.js";
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
    //
    // Because the row is now terminal, waitForCancellation returns
    // immediately on the status check and never escalates to SIGKILL. Run
    // an unconditional SIGTERM→1s→SIGKILL sequence on the recorded pids
    // here and return early so the lower-level wait/escalation path does
    // not skip cleanup. (v0.2.4)
    if (job.command_type === "review_gate") {
      // Pre-mark before signaling so the row persists as `cancelled` rather
      // than the `failed` the hook's catch path would write on WIRE_PROCESS_EXITED.
      //
      // If the pre-mark itself fails (disk I/O, SQLite contention), we must
      // STILL signal the Kimi child — otherwise the user's cancel command
      // produces an alive-but-marked-cancelled stuck state. Capture the
      // pre-mark failure, run the SIGTERM→SIGKILL escalation unconditionally,
      // and rethrow at the end so the user sees the underlying error.
      let preMarkError: unknown;
      try {
        await withJobStore(paths, async (preMarkStore) => {
          const reviewGateCancel = getManagedCommandConfig("review_gate").cancellation;
          await markJobCancelled(
            preMarkStore,
            paths,
            job,
            reviewGateCancel.cancelledSummary,
            new RuntimeError(
              reviewGateCancel.errorCodes.cancelled,
              reviewGateCancel.cancelMessages.default,
              "cancel.runtime",
            ),
          );
        });
      } catch (error) {
        preMarkError = error;
      }

      signalJobProcesses(job, "SIGTERM");
      await sleep(1_000);
      if (hasLiveRecordedProcess(job)) {
        signalJobProcesses(job, "SIGKILL");
      }

      if (preMarkError) {
        throw preMarkError;
      }

      return `${JSON.stringify(
        {
          job_id: job.job_id,
          status: "cancelled",
          message: "review_gate cancelled; SIGTERM→SIGKILL escalation completed.",
        },
        null,
        2,
      )}\n`;
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

    await withJobStore(paths, async (forcedStore) => {
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
    });

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
