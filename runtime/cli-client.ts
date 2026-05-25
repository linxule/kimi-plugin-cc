// Subprocess client for `kimi -p --output-format stream-json`.
//
// Replaces runtime/wire/client.ts for v1.0. Both modules coexist during the
// PR 1-3 transition; PR 4 deletes wire/. The contract is intentionally
// narrower than the v0.4 wire client — one process per prompt, no in-band
// approvals (PreToolUse hook handles those), no resumable JSON-RPC channel.
//
// Where v0.4 streamed turn events to a TurnCapture state machine,
// stream-json gives us flattened OpenAI-shaped records that callers
// reassemble at their own seam. The buffered result is the primary return
// shape; callers needing incremental visibility (e.g., updating SQLite
// phase as tools run) can pass `onRecord` to observe records as they arrive
// without paying for a separate event-stream API.
//
// Per-job env (`KIMI_PLUGIN_CC_CMD`) is set on this spawn so the
// PreToolUse hook can branch per command (review vs rescue vs ask). It is
// passed via the spawn `env` option, not exported to a shell, so concurrent
// jobs never share an env block.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { RuntimeError, formatError } from "./errors.js";
import {
  StreamJsonParser,
  extractSessionIdFromStderr,
  type StreamJsonOutcome,
  type StreamJsonRecord,
} from "./stream-json.js";

/** Bytes of stderr retained for diagnostics on completion. Rolling buffer. */
const STDERR_TAIL_BYTES = 8192;
/** Hard cap on awaiting diagnostics log drain before resolving the result. */
const LOG_DRAIN_TIMEOUT_MS = 250;

export interface CliClientOptions {
  /** Working directory for the kimi subprocess. */
  cwd: string;
  /** Environment block. KIMI_PLUGIN_CC_CMD is overlaid from `commandLabel`. */
  env: NodeJS.ProcessEnv;
  /** Resolved kimi binary path (or bare name if it's on PATH). */
  command: string;
  /** Optional argv prefix (mirrors v0.4's KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS pattern). */
  prefixArgs?: string[];
  /** Required user-facing prompt text. */
  prompt: string;
  /**
   * Per-command label propagated to the PreToolUse hook via env.
   * Recognized values: "ask" | "review" | "challenge" | "review_gate" | "rescue".
   * Unset means the hook treats the call as out-of-plugin context (allows everything).
   */
  commandLabel?: string;
  /** Model override; falls through to kimi-code's default_model if omitted. */
  model?: string;
  /**
   * Override kimi's --skills-dir.
   * NOTE: kimi-code treats --skills-dir as REPLACE (not additive). Repeat the
   * flag to preserve user-configured skill paths.
   */
  skillsDirs?: string[];
  /** Resume an existing session via `kimi -r <session_id>`. */
  resumeSessionId?: string;
  /** Optional absolute path for an append-only JSONL diagnostics log. */
  logPath?: string;
  /** Optional cancellation. */
  signal?: AbortSignal;
  /**
   * Optional callback fired as each stream-json record is parsed. Useful for
   * callers that need to update SQLite phase / status mid-run without waiting
   * for the process to close. Errors thrown by this callback are caught and
   * never propagate to the kimi subprocess.
   */
  onRecord?: (record: StreamJsonRecord) => void;
}

export interface CliClientResult {
  /**
   * Session id parsed from kimi's stderr announce line. Undefined if the
   * process never reached the announce point (early exit, crash, etc.).
   * For commands that require a session id, call `requireSessionId(result, …)`.
   */
  sessionId?: string;
  records: StreamJsonRecord[];
  /** Lines that failed parsing. Diagnostics only — not load-bearing. */
  malformed: ReadonlyArray<{ line: string; reason: string }>;
  stderrTail: string;
  exitCode: number;
  /** OS signal that terminated the process, if any. */
  signal: NodeJS.Signals | null;
  /** Whether the process was terminated by an AbortSignal from this caller. */
  aborted: boolean;
}

export async function runCliPrompt(opts: CliClientOptions): Promise<CliClientResult> {
  // Pre-aborted signal: refuse to spawn at all.
  if (opts.signal?.aborted === true) {
    throw new RuntimeError(
      "CLI_ABORTED",
      "kimi subprocess request cancelled before spawn",
      "cli-client.pre-spawn",
      { details: { command: opts.command } },
    );
  }

  const args = buildArgs(opts);
  const env = buildEnv(opts);

  if (opts.logPath !== undefined) {
    await mkdir(path.dirname(opts.logPath), { recursive: true }).catch(() => {
      // Best-effort; if mkdir fails the appendFile below will error and be
      // swallowed by the log chain (diagnostics are non-blocking).
    });
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(opts.command, args, {
      cwd: opts.cwd,
      env,
      stdio: "pipe",
    });
  } catch (err) {
    throw new RuntimeError(
      "CLI_SPAWN_FAILED",
      `Failed to spawn kimi: ${formatError(err)}`,
      "cli-client.spawn",
      err instanceof Error
        ? { cause: err, details: { command: opts.command, args } }
        : { details: { command: opts.command, args } },
    );
  }

  // Pre-attach an 'error' listener immediately. Bun (and Node) can emit
  // 'error' asynchronously between spawn returning and our Promise body
  // attaching the real listener — without a handler in place, EventEmitter
  // crashes the process. Capture into an array (not a single slot) so two
  // back-to-back errors don't lose the first; we replay the first one when
  // the real handler installs. The replacement is atomic across two
  // synchronous statements (flag-flip + .on attach), so no async work can
  // interleave between them.
  const earlyErrors: Error[] = [];
  let earlyErrorHandled = false;
  child.on("error", function earlyErrorListener(err: Error) {
    if (earlyErrorHandled) return;
    earlyErrors.push(err);
  });

  const parser = new StreamJsonParser();
  const records: StreamJsonRecord[] = [];
  const malformed: Array<{ line: string; reason: string }> = [];
  // Rolling stderr tail — keep only the trailing STDERR_TAIL_BYTES so a
  // long-running kimi process emitting megabytes of stderr (tool.progress,
  // thinking deltas) doesn't grow our RSS unboundedly.
  let stderrTail = "";
  let logChain: Promise<void> = Promise.resolve();

  const appendLogLine = (payload: Record<string, unknown>) => {
    if (opts.logPath === undefined) return;
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...payload })}\n`;
    logChain = logChain.then(() =>
      appendFile(opts.logPath!, line, "utf8").catch(() => {
        // Diagnostics best-effort; never crash on log failure.
      }),
    );
  };

  appendLogLine({
    event: "spawn",
    command: opts.command,
    args,
    cwd: opts.cwd,
    command_label: opts.commandLabel ?? null,
  });

  const invokeOnRecord = (record: StreamJsonRecord) => {
    if (opts.onRecord === undefined) return;
    try {
      opts.onRecord(record);
    } catch {
      // Caller-supplied callback must never destabilize the parse loop.
    }
  };

  const consumeOutcomes = (outcomes: StreamJsonOutcome[]) => {
    for (const outcome of outcomes) {
      if (outcome.record !== undefined) {
        records.push(outcome.record);
        appendLogLine({ event: "record", record: outcome.record });
        invokeOnRecord(outcome.record);
      } else if (outcome.malformedLine !== undefined) {
        const entry = {
          line: outcome.malformedLine,
          reason: outcome.malformedReason ?? "unknown",
        };
        malformed.push(entry);
        appendLogLine({ event: "malformed", ...entry });
      }
    }
  };

  const errorDetails = (): Record<string, unknown> => ({
    command: opts.command,
    args,
    command_label: opts.commandLabel ?? null,
  });

  return await new Promise<CliClientResult>((resolve, reject) => {
    let settled = false;
    let aborted = false;
    const settle = (
      kind: "resolve" | "reject",
      payload: CliClientResult | RuntimeError,
    ) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      if (kind === "resolve") resolve(payload as CliClientResult);
      else reject(payload as RuntimeError);
    };

    const onAbort = () => {
      aborted = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Best-effort.
      }
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    // Swap the pre-attached early listener for the real handler. These two
    // statements are synchronous and execute as one unit; no event can
    // interleave between marking earlyErrorHandled and attaching the new
    // listener.
    earlyErrorHandled = true;
    child.on("error", (err) => {
      appendLogLine({ event: "process_error", message: formatError(err) });
      settle(
        "reject",
        new RuntimeError(
          "CLI_PROCESS_ERROR",
          `kimi subprocess error: ${formatError(err)}`,
          "cli-client.process",
          err instanceof Error
            ? { cause: err, details: errorDetails() }
            : { details: errorDetails() },
        ),
      );
    });
    if (earlyErrors.length > 0) {
      const captured = earlyErrors[0]!;
      queueMicrotask(() => {
        appendLogLine({
          event: "process_error",
          message: formatError(captured),
          early: true,
          additional_count: earlyErrors.length - 1,
        });
        settle(
          "reject",
          new RuntimeError(
            "CLI_PROCESS_ERROR",
            `kimi subprocess error: ${formatError(captured)}`,
            "cli-client.process",
            { cause: captured, details: errorDetails() },
          ),
        );
      });
    }

    child.on("close", async (exitCode, signal) => {
      consumeOutcomes(parser.flush());
      const sessionId = extractSessionIdFromStderr(stderrTail);
      appendLogLine({
        event: "exit",
        exit_code: exitCode,
        signal,
        session_id: sessionId,
        malformed_count: malformed.length,
        record_count: records.length,
        aborted,
      });
      // Cap the log drain wait so a wedged disk can't block result delivery.
      // The result itself is in memory; diagnostics are best-effort.
      await raceWithTimeout(logChain, LOG_DRAIN_TIMEOUT_MS);
      settle("resolve", {
        sessionId,
        records,
        malformed,
        stderrTail,
        exitCode: exitCode ?? -1,
        signal,
        aborted,
      });
    });

    // Stdin: kimi -p reads from argv, not stdin. End it immediately so the
    // child never blocks. Stream method calls on a failed-spawn child can
    // throw synchronously — guard so the 'error' event still wins.
    try {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        consumeOutcomes(parser.push(chunk));
      });
      child.stderr.on("data", (chunk: string) => {
        stderrTail = appendToTail(stderrTail, chunk, STDERR_TAIL_BYTES);
      });
      child.stdin.end();
    } catch (err) {
      settle(
        "reject",
        new RuntimeError(
          "CLI_PROCESS_ERROR",
          `kimi subprocess stream setup failed: ${formatError(err)}`,
          "cli-client.streams",
          err instanceof Error
            ? { cause: err, details: errorDetails() }
            : { details: errorDetails() },
        ),
      );
    }
  });
}

/**
 * Helper for callers that require a session id (replay-capable commands).
 * Throws CLI_NO_SESSION_ID if the result lacks one, embedding the command
 * label and exit code in details so the failure is actionable in logs.
 *
 * Use this AT the call site rather than baking the requirement into
 * runCliPrompt — some callers (setup probes, smoke tests) are fine with
 * an undefined sessionId.
 */
export function requireSessionId(
  result: CliClientResult,
  context: { commandLabel?: string },
): string {
  if (result.sessionId !== undefined && result.sessionId.length > 0) {
    return result.sessionId;
  }
  throw new RuntimeError(
    "CLI_NO_SESSION_ID",
    "kimi subprocess completed without announcing a session id; replay and resume will be unavailable",
    "cli-client.session-id",
    {
      details: {
        command_label: context.commandLabel ?? null,
        exit_code: result.exitCode,
        signal: result.signal,
        aborted: result.aborted,
        stderr_tail_len: result.stderrTail.length,
      },
    },
  );
}

function buildArgs(opts: CliClientOptions): string[] {
  const args: string[] = [...(opts.prefixArgs ?? [])];
  args.push("--output-format", "stream-json");
  if (opts.resumeSessionId !== undefined) {
    args.push("-r", opts.resumeSessionId);
  }
  if (opts.model !== undefined) {
    args.push("-m", opts.model);
  }
  if (opts.skillsDirs !== undefined) {
    for (const dir of opts.skillsDirs) {
      args.push("--skills-dir", dir);
    }
  }
  // -p accepts the prompt as the option value. We pass it as a separate argv
  // entry so prompts with leading dashes or whitespace are not interpreted as
  // additional flags.
  args.push("-p", opts.prompt);
  return args;
}

function buildEnv(opts: CliClientOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...opts.env };
  if (opts.commandLabel !== undefined) {
    env.KIMI_PLUGIN_CC_CMD = opts.commandLabel;
  }
  return env;
}

function appendToTail(tail: string, chunk: string, maxBytes: number): string {
  const combined = tail + chunk;
  if (combined.length <= maxBytes) return combined;
  return combined.slice(combined.length - maxBytes);
}

function raceWithTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([
    promise.then(() => {}, () => {}),
    timeoutPromise,
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
