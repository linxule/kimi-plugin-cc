import { spawn } from "node:child_process";
import { access, appendFile, constants as fsConstants } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RuntimeError, formatError } from "./errors.js";
import { preferStableNodePath } from "./hooks/install-paths.js";
import { markJobFailed, serializedProcessIdentity, waitForTerminalJob } from "./jobs.js";
import { JobStore, type JobRecord } from "./job-store.js";
import { readArtifact } from "./render.js";
import { type PluginPaths } from "./paths.js";
import type { CommandContext } from "./types.js";
import { sleep } from "./util.js";

// Resolves to runtime/companion.ts in dev (via tsx) and dist/companion.js in production (compiled
// with tsc to the same relative layout). The extension is derived from the running module so the
// child-process spawn in startBackgroundJob targets the right entrypoint in both modes.
const isCompiledRuntime = import.meta.url.endsWith(".js");
const companionEntrypoint = fileURLToPath(
  new URL(isCompiledRuntime ? "./companion.js" : "./companion.ts", import.meta.url),
);
const companionProjectRoot = path.resolve(path.dirname(companionEntrypoint), "..");
const FAILURE_PERSIST_RETRY_DELAYS_MS = [100, 200, 400] as const;

// Error codes, stages and the prompt env name all derive from workerKind,
// e.g. RESCUE_WORKER_SPAWN_FAILED at stage rescue.worker.spawn.
export interface BackgroundSpawnOptions {
  workerKind: "rescue" | "ask";
  wait: boolean;
  failedSummary: string;
}

export async function startBackgroundJob(
  job: JobRecord,
  prompt: string,
  context: CommandContext,
  paths: PluginPaths,
  options: BackgroundSpawnOptions,
): Promise<string> {
  const stem = options.workerKind.toUpperCase();
  const spawnStage = `${options.workerKind}.worker.spawn`;
  // Background spawn and hook verification must resolve the same stable Node
  // path: the worker re-verifies the byte-exact hook command from its own
  // runtime path, so a different spelling than setup pinned fails closed. For
  // example, spawn(process.execPath) can resolve …/Cellar/node/<ver>/bin/node
  // while setup pinned /opt/homebrew/bin/node.
  //
  // An explicit spawn override need not be absolute because spawn() resolves
  // bare names through PATH. The hook command separately requires an absolute
  // override because /bin/sh -c may have a sanitized PATH. Only the no-override
  // default uses preferStableNodePath to match the verifier.
  const override = context.env.KIMI_PLUGIN_CC_NODE_BIN;
  const nodeBinary =
    override !== undefined && override.length > 0
      ? override
      : preferStableNodePath(process.execPath);

  // Only fast-path the `fs.access` check for absolute/relative paths. A bare
  // name like "node" is resolved by spawn() via PATH; the spawn `error` listener
  // will still surface ENOENT on nextTick for that path, classified as
  // <KIND>_WORKER_SPAWN_FAILED via the listener below.
  if (nodeBinary.includes("/") || nodeBinary.includes("\\")) {
    try {
      await access(nodeBinary, fsConstants.X_OK);
    } catch (accessError) {
      const code = (accessError as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
        const classified = new RuntimeError(
          `${stem}_NODE_BIN_INVALID`,
          `Configured Node binary is not executable: ${nodeBinary}. Set KIMI_PLUGIN_CC_NODE_BIN to a valid Node >=22.5 executable and retry.`,
          spawnStage,
          accessError instanceof Error ? { cause: accessError } : undefined,
        );
        await persistBackgroundFailure(paths, job.job_id, classified, options.failedSummary, "node-bin-invalid");
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
      [`KIMI_PLUGIN_CC_${stem}_PROMPT_B64`]: b64,
      // A worker must reopen the exact store its parent selected, regardless of cwd.
      KIMI_PLUGIN_CC_DATA: path.resolve(paths.dataRoot),
    },
  });

  let spawnReportedFailure = false;
  const spawnErrorPromise = new Promise<RuntimeError | null>((resolve) => {
    let settled = false;
    const settle = (value: RuntimeError | null) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    child.once("error", (spawnError) => {
      spawnReportedFailure = true;
      settle(
        new RuntimeError(
          `${stem}_WORKER_SPAWN_FAILED`,
          `Background ${options.workerKind} worker failed to spawn: ${spawnError.message}`,
          spawnStage,
          { cause: spawnError },
        ),
      );
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
    const classified = new RuntimeError(
      `${stem}_WORKER_EXITED_EARLY`,
      `Background ${options.workerKind} worker exited with code ${exitCode}${signal ? ` (signal ${signal})` : ""} before reporting a result.`,
      spawnStage,
    );
    void markEarlyExit(paths, job.job_id, classified, options.failedSummary);
  });
  child.unref();

  const spawnError = await spawnErrorPromise;
  if (spawnError) {
    await persistBackgroundFailure(paths, job.job_id, spawnError, options.failedSummary, "spawn-failed");
    throw spawnError;
  }

  const companionIdentity =
    child.pid !== undefined ? await serializedProcessIdentity(child.pid) : null;
  const store = new JobStore(paths);
  try {
    store.updateRunningJob(job.job_id, {
      pid: child.pid ?? null,
      ...(companionIdentity ? { companion_identity: companionIdentity } : {}),
      phase: "worker-spawned",
    });
  } finally {
    store.close();
  }

  if (options.wait) {
    const completed = await waitForTerminalJob(() => new JobStore(paths), job.job_id);
    if (!completed.final_output_path) {
      throw new RuntimeError(
        `${stem}_RESULT_MISSING`,
        describeMissingResult(completed, options.workerKind),
        `${options.workerKind}.wait`,
      );
    }

    return readArtifact(completed.final_output_path);
  }

  return `${JSON.stringify(
    {
      job_id: job.job_id,
      command_type: job.command_type,
    },
    null,
    2,
  )}\n`;
}

async function markEarlyExit(
  paths: PluginPaths,
  jobId: string,
  classified: RuntimeError,
  failedSummary: string,
): Promise<void> {
  await persistBackgroundFailure(paths, jobId, classified, failedSummary, "early-exit", (current) => {
    // Only mark failure if the worker exited before advancing past the spawn phase.
    // Once the worker reaches worker-running or turn-running, the child owns the
    // job state and the parent's close listener must not race with it.
    return current.phase === "worker-spawned" || current.phase === "queued";
  });
}

async function persistBackgroundFailure(
  paths: PluginPaths,
  jobId: string,
  classified: RuntimeError,
  failedSummary: string,
  event: string,
  shouldMark: (job: JobRecord) => boolean = () => true,
): Promise<void> {
  let lastWriteError: unknown;

  for (let attempt = 0; attempt <= FAILURE_PERSIST_RETRY_DELAYS_MS.length; attempt += 1) {
    let store: JobStore | undefined;
    try {
      store = new JobStore(paths);
      const current = store.getJob(jobId);
      if (!current || current.status !== "running" || !shouldMark(current)) {
        return;
      }
      await markJobFailed(store, paths, current, classified, failedSummary, { phase: "failed" });
      return;
    } catch (writeError) {
      lastWriteError = writeError;
      if (attempt < FAILURE_PERSIST_RETRY_DELAYS_MS.length) {
        await sleep(FAILURE_PERSIST_RETRY_DELAYS_MS[attempt]);
      }
    } finally {
      try {
        store?.close();
      } catch {
        // The persistence attempt outcome above is the signal that matters.
      }
    }
  }

  await appendStuckJobTelemetry(paths, {
    event,
    job_id: jobId,
    failed_summary: failedSummary,
    error: {
      code: classified.code,
      stage: classified.stage,
      message: classified.message,
      details: classified.details,
    },
    persistence_error: formatError(lastWriteError),
  });
}

async function appendStuckJobTelemetry(
  paths: PluginPaths,
  entry: Record<string, unknown>,
): Promise<void> {
  const stuckPath = path.join(paths.pluginRoot, "stuck-jobs.jsonl");
  try {
    await appendFile(
      stuckPath,
      `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
      "utf8",
    );
  } catch (appendError) {
    process.stderr.write(
      `[kimi-plugin-cc] failed to append stuck job telemetry at ${stuckPath}: ${formatError(appendError)}\n`,
    );
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
export function describeMissingResult(job: JobRecord, workerKind: string = "rescue"): string {
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
