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
import { resolveKimiHome } from "./kimi-home.js";
import {
  StreamJsonParser,
  extractSessionIdFromStderr,
  type GoalSummaryRecord,
  type StreamJsonOutcome,
  type StreamJsonRecord,
} from "./stream-json.js";
import {
  collectDescendantIdentities,
  revalidateProcessIdentities,
  waitForProcessTreeExit,
  type ProcessIdentity,
  type ProcessIdentityReader,
} from "./process-tree.js";

/** Bytes of stderr retained for diagnostics on completion. Rolling buffer. */
const STDERR_TAIL_BYTES = 8192;
/** Hard cap on awaiting diagnostics log drain before resolving the result. */
const LOG_DRAIN_TIMEOUT_MS = 250;
/**
 * Default delay between SIGTERM and SIGKILL when an abort fires.
 * Matches v0.4's `cancellation.ts` escalation timing for wire clients,
 * so rescue/ask/review continue to feel identical to a stuck-kimi user
 * after the v1.0 cutover.
 */
const DEFAULT_ESCALATION_MS = 1_500;
/** Maximum time spent confirming POSIX tree exit after SIGKILL dispatch. */
const POST_KILL_QUIESCENCE_MS = 500;
/** Hard bound for the one-shot descendant identity snapshot. */
const DESCENDANT_SNAPSHOT_TIMEOUT_MS = 1_000;
/** Hard bound for each batched identity revalidation pass. */
const IDENTITY_REVALIDATION_TIMEOUT_MS = 250;
const DESCENDANT_SNAPSHOT_TIMEOUT = Symbol("descendant-snapshot-timeout");

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
   * Recognized values: "ask" | "review" | "challenge" | "review_gate" | "rescue" | "swarm" | "swarm-write".
   * Unset means the hook treats the call as out-of-plugin context (allows everything).
   */
  commandLabel?: string;
  /**
   * Trusted workspace root for the "swarm-write" label (v1.4), exported to the
   * spawn as KIMI_PLUGIN_CC_WORKSPACE_ROOT. The swarm-write hook case confines
   * every subagent write to THIS path instead of the hook payload's `cwd`,
   * removing any dependence on upstream payload-cwd semantics: the model running
   * inside kimi cannot forge an env var on the already-spawned process. Set by
   * swarm.ts to the ephemeral worktree path. Ignored by every other label.
   */
  swarmWriteWorkspaceRoot?: string;
  /**
   * Hard cap on how many AgentSwarm subagents kimi-code runs CONCURRENTLY,
   * exported to the spawn as KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY (kimi-code
   * 0.18.0+, PR #888). Older binaries silently ignore the unknown env var, so
   * on < 0.18 the soft --cap prompt-count hint is the only count bound. Only
   * /kimi:swarm sets this (from --max-concurrency, distinct from the soft --cap
   * total-count hint). Upstream's `resolveSwarmMaxConcurrency` THROWS on a
   * non-positive-integer value; the swarm parser rejects anything that isn't a
   * positive `Number.isInteger` (the same predicate upstream applies), so every
   * accepted --max-concurrency round-trips through `String(swarmMaxConcurrency)`
   * without throwing — verified across 19 edge inputs incl. the integer-valued-
   * float extreme (e.g. 1e21 → "1e+21", accepted by both sides as effectively
   * uncapped).
   */
  swarmMaxConcurrency?: number;
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
  /**
   * Reserved for future thinking-mode control. **Currently a no-op.**
   *
   * kimi-code 0.1.1 does NOT expose a `--no-thinking` CLI flag; thinking
   * is controlled by config (`default_thinking` + `[thinking].mode`) and
   * `allowUnknownOption(false)` means a `--no-thinking` argv would
   * crash the spawn. The Round 2 Codex review caught the broken alpha.4
   * emission of this flag.
   *
   * The field stays in the options bag so review-gate (the only caller
   * that needs thinking-off semantics) carries intent through the
   * runtime contract. If/when upstream kimi-code adds a per-spawn
   * thinking override, wire it through here. Until then, review-gate's
   * 8s budget assumes the user has `default_thinking = false` or a
   * non-thinking model selected — see docs/safety.md.
   */
  thinking?: boolean;
  /** Optional absolute path for an append-only JSONL diagnostics log. */
  logPath?: string;
  /** Optional cancellation. */
  signal?: AbortSignal;
  /**
   * Internal test seam for hosts that block process-listing commands.
   * Production callers should leave this unset so cancellation uses the
   * platform process-tree collector.
   */
  descendantIdentityCollector?: (pid: number) => Promise<ProcessIdentity[]>;
  /** Internal test seam; production uses start-time/PGID identity reads. */
  processIdentityReader?: ProcessIdentityReader;
  /** Internal test seam for proving teardown rejection cannot strand settlement. */
  cancellationTeardownHook?: () => Promise<void>;
  /**
   * Optional callback fired as each stream-json record is parsed. Useful for
   * callers that need to update SQLite phase / status mid-run without waiting
   * for the process to close. Errors thrown by this callback are caught and
   * never propagate to the kimi subprocess.
   */
  onRecord?: (record: StreamJsonRecord) => void;
  /**
   * Milliseconds between SIGTERM and the SIGKILL escalation when an
   * abort fires. The default (1500ms) matches v0.4's wire-client
   * cancellation. Pass a smaller value for tests that want to observe
   * the escalation faster; pass a larger value (or `Infinity`) to
   * suppress the escalation entirely.
   */
  escalationMs?: number;
}

export interface CliClientResult {
  /**
   * Session id parsed from kimi's stderr announce line. Undefined if the
   * process never reached the announce point (early exit, crash, etc.).
   * For commands that require a session id, call `requireSessionId(result, …)`.
   */
  sessionId?: string;
  records: StreamJsonRecord[];
  /**
   * Out-of-band goal-mode summary from a headless `/goal` run (kimi-code
   * 0.8.0+): goalId, terminal status, reason, turns/tokens/wallClock. Undefined
   * for ordinary (non-goal) runs. Captured first-announce-wins and filtered
   * from records[], mirroring the resume-hint meta record. /kimi:pursue
   * consumes it; goalId is distinct from the resume-hint sessionId.
   */
  goalSummary?: GoalSummaryRecord;
  /**
   * kimi-code version reported by agent-core-v2's `system.version` meta record,
   * emitted once before the stream when a truthy ambient
   * KIMI_CODE_EXPERIMENTAL_FLAG selects v2. Undefined on the default v1 driver
   * (which emits no such record). Captured first-announce-wins and filtered from
   * records[], mirroring the resume-hint. Diagnostic/observability only — not
   * load-bearing; a caller can use it to tell which engine served the run.
   */
  systemVersion?: string;
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
      // POSIX gets a fresh process group so cancellation reaches kimi's
      // descendants; Windows has no negative-pid process-group signaling.
      detached: process.platform !== "win32",
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
  let announcedSessionId: string | undefined;
  let announcedGoalSummary: GoalSummaryRecord | undefined;
  let announcedSystemVersion: string | undefined;
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
    swarm_max_concurrency: opts.swarmMaxConcurrency ?? null,
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
      if (outcome.unknownRecord !== undefined) {
        // H3 forward-compat: a stream-json line with a role we don't model
        // (a future kimi-code role). Log it for diagnostics but keep it OUT of
        // records[] and out of onRecord — consumers iterate records[] expecting
        // assistant/tool only. Tolerated, not treated as malformed/error.
        appendLogLine({
          event: "unknown_record",
          role: outcome.unknownRecord.role,
        });
        continue;
      }
      if (outcome.goalSummary !== undefined) {
        // Goal-mode summary is out-of-band metadata for our wrapper, not a
        // consumer-facing record. First-announce wins (a run emits exactly one,
        // at session end); capture and skip so records[] stays assistant/tool.
        if (announcedGoalSummary === undefined) {
          announcedGoalSummary = outcome.goalSummary;
          appendLogLine({
            event: "goal_summary",
            goal_id: outcome.goalSummary.goalId,
            status: outcome.goalSummary.status,
            turns_used: outcome.goalSummary.turnsUsed,
            tokens_used: outcome.goalSummary.tokensUsed,
            wall_clock_ms: outcome.goalSummary.wallClockMs,
          });
        }
        continue;
      }
      if (outcome.record !== undefined) {
        // Meta records are out-of-band wrapper metadata, never consumer-facing
        // assistant/tool records. Capture session.resume_hint (first-announce
        // wins, mirroring the stderr capture below for kimi 0.1.x), and skip
        // every recognized meta type, including 0.23.5's turn.step.retrying and
        // agent-core-v2's system.version. This keeps records[] and onRecord
        // stable while preserving the resume hint as the primary session-id
        // source under kimi 0.2.0+.
        if (outcome.record.role === "meta") {
          if (
            outcome.record.type === "session.resume_hint" &&
            announcedSessionId === undefined
          ) {
            announcedSessionId = outcome.record.sessionId;
            appendLogLine({
              event: "session_announce",
              source: "stream-json.meta",
              session_id: outcome.record.sessionId,
            });
          } else if (
            outcome.record.type === "system.version" &&
            announcedSystemVersion === undefined
          ) {
            announcedSystemVersion = outcome.record.version;
            appendLogLine({
              event: "system_version",
              source: "stream-json.meta",
              version: outcome.record.version,
            });
          }
          continue;
        }
        records.push(outcome.record);
        appendLogLine({ event: "record", record: outcome.record });
        invokeOnRecord(outcome.record);
      } else if (outcome.malformedLine !== undefined) {
        const entry = {
          line: truncateChars(outcome.malformedLine, 200),
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
    let aborted = false;
    type TeardownOutcome = { ok: true } | { ok: false; error: unknown };
    let cancellationTeardown: Promise<TeardownOutcome> | undefined;
    let settlementStarted = false;
    const settle = (
      kind: "resolve" | "reject",
      payload: CliClientResult | RuntimeError,
    ) => {
      if (settlementStarted) return;
      settlementStarted = true;
      opts.signal?.removeEventListener("abort", onAbort);
      // Abort teardown can outlive the direct child's close event while a
      // detached descendant is still being enumerated or escalated. Never
      // expose a result/error until that one owned teardown path completes.
      void (cancellationTeardown ?? Promise.resolve<TeardownOutcome>({ ok: true })).then(
        (teardown) => {
          if (!teardown.ok) {
            appendLogLine({
              event: "cancellation_teardown_error",
              message: formatError(teardown.error),
            });
            reject(
              new RuntimeError(
                "CLI_CANCELLATION_TEARDOWN_FAILED",
                `kimi cancellation teardown failed: ${formatError(teardown.error)}`,
                "cli-client.cancellation",
                teardown.error instanceof Error
                  ? { cause: teardown.error, details: errorDetails() }
                  : { details: errorDetails() },
              ),
            );
            return;
          }
          if (kind === "resolve") resolve(payload as CliClientResult);
          else reject(payload as RuntimeError);
        },
      );
    };

    const escalationMs = opts.escalationMs ?? DEFAULT_ESCALATION_MS;
    const identityReader = opts.processIdentityReader;
    let processExited = false;
    child.once("exit", () => {
      processExited = true;
    });

    const captureDescendantIdentities = async (childPid: number): Promise<ProcessIdentity[]> => {
      let snapshot: ProcessIdentity[];
      try {
        const collected = await raceWithValueTimeout(
          (opts.descendantIdentityCollector ?? collectDescendantIdentities)(childPid),
          DESCENDANT_SNAPSHOT_TIMEOUT_MS,
          DESCENDANT_SNAPSHOT_TIMEOUT,
        );
        if (collected === DESCENDANT_SNAPSHOT_TIMEOUT) {
          appendLogLine({
            event: "descendant_collection_timeout",
            timeout_ms: DESCENDANT_SNAPSHOT_TIMEOUT_MS,
          });
          return [];
        }
        snapshot = collected;
      } catch (err) {
        appendLogLine({
          event: "descendant_collection_error",
          message: formatError(err),
        });
        return [];
      }

      const identities: ProcessIdentity[] = [];
      const seen = new Set<string>();
      for (const identity of snapshot) {
        const key = `${identity.pid}:${identity.startToken}:${identity.processGroupId}`;
        if (
          Number.isInteger(identity.pid) &&
          identity.pid > 0 &&
          identity.pid !== childPid &&
          Number.isInteger(identity.processGroupId) &&
          identity.processGroupId > 0 &&
          identity.startToken.length > 0 &&
          !seen.has(key)
        ) {
          seen.add(key);
          identities.push({ ...identity });
        }
      }
      return identities;
    };

    const trySignalPid = (pid: number, signal: NodeJS.Signals) => {
      try {
        process.kill(pid, signal);
      } catch (err) {
        const ignored = isErrnoException(err, "ESRCH") || isErrnoException(err, "EPERM");
        void ignored;
      }
    };

    const signalCapturedTree = async (
      childPid: number,
      identities: readonly ProcessIdentity[],
      signal: NodeJS.Signals,
    ) => {
      // The live ChildProcess anchors its detached group. Signal the group
      // before the direct child can exit and make that numeric PGID stale.
      if (!processExited) {
        trySignalPid(-childPid, signal);
        try {
          child.kill(signal);
        } catch {
          // Best-effort direct-child signaling; ChildProcess owns this pid.
        }
      }

      // One bounded pass replaces up to 512 sequential ps calls. A pid whose
      // start token or PGID changed belongs to another process and is skipped.
      const pidValidation = await revalidateProcessIdentities(identities, {
        identityReader,
        timeoutMs: IDENTITY_REVALIDATION_TIMEOUT_MS,
      });
      for (const current of pidValidation.identities) {
        trySignalPid(current.pid, signal);
      }

      // Revalidate again immediately before signaling non-root groups. Never
      // send to an unanchored numeric PGID left over from collection.
      const groupValidation = await revalidateProcessIdentities(identities, {
        identityReader,
        timeoutMs: IDENTITY_REVALIDATION_TIMEOUT_MS,
      });
      const activeGroupIds = new Set(
        groupValidation.identities.map((identity) => identity.processGroupId),
      );
      activeGroupIds.delete(childPid);
      for (const processGroupId of activeGroupIds) {
        trySignalPid(-processGroupId, signal);
      }
    };

    const teardownChildTree = async () => {
      await opts.cancellationTeardownHook?.();
      const childPid = child.pid;
      if (childPid === undefined || processExited) return;

      const finiteEscalation = Number.isFinite(escalationMs);

      if (process.platform === "win32") {
        // Preserve the documented win32 behavior: only the direct child is
        // managed; descendant enumeration/reaping remains unsupported.
        try {
          child.kill("SIGTERM");
        } catch {
          // Best-effort.
        }
        const exited = await waitForProcessTreeExit([], escalationMs, {
          isRootAlive: () => !processExited,
        });
        if (!exited && finiteEscalation) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Best-effort.
          }
        }
        return;
      }

      const identities = await captureDescendantIdentities(childPid);
      await signalCapturedTree(childPid, identities, "SIGTERM");

      // The grace interval starts only after SIGTERM has reached every
      // revalidated target. Slow process enumeration never consumes the grace.
      const exited = await waitForProcessTreeExit(identities, escalationMs, {
        identityReader,
        isRootAlive: () => !processExited,
      });
      if (!exited && finiteEscalation) {
        await signalCapturedTree(childPid, identities, "SIGKILL");
        const quiescent = await waitForProcessTreeExit(
          identities,
          POST_KILL_QUIESCENCE_MS,
          {
            identityReader,
            isRootAlive: () => !processExited,
          },
        );
        if (!quiescent) {
          appendLogLine({
            event: "post_kill_quiescence_timeout",
            timeout_ms: POST_KILL_QUIESCENCE_MS,
            descendant_count: identities.length,
          });
        }
      }
    };

    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      cancellationTeardown = teardownChildTree().then<TeardownOutcome, TeardownOutcome>(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );
      void cancellationTeardown.then((outcome) => {
        if (outcome.ok) return;
        // A bug in teardown must neither strand the outer promise nor leave the
        // owned root running. The controlled child anchors this emergency kill.
        const childPid = child.pid;
        if (childPid !== undefined && !processExited) {
          if (process.platform !== "win32") trySignalPid(-childPid, "SIGKILL");
          try {
            child.kill("SIGKILL");
          } catch {
            // Best-effort; settlement still surfaces the teardown failure.
          }
        }
        settle(
          "reject",
          new RuntimeError(
            "CLI_CANCELLATION_TEARDOWN_FAILED",
            "kimi cancellation teardown failed",
            "cli-client.cancellation",
          ),
        );
      });
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    // Re-check `aborted` AFTER attaching the listener. `await mkdir` above
    // is the first synchronous yield point after the pre-spawn aborted
    // check — if abort fired during that await, the signal is already in
    // an aborted state by the time we reach addEventListener, which does
    // NOT re-fire for already-aborted signals (per the AbortSignal spec).
    // Without this re-check the spawned child is orphaned: SIGTERM/SIGKILL
    // is never sent and the process keeps holding the SQLite row + model
    // tokens. Audit report 28 (Codex H1) tracked this fix.
    if (opts.signal?.aborted === true) {
      onAbort();
    }

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
      const sessionId = announcedSessionId ?? extractSessionIdFromStderr(stderrTail);
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
        goalSummary: announcedGoalSummary,
        systemVersion: announcedSystemVersion,
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
        // First-announce-wins across both channels: once a session id is
        // pinned (from the stdout meta record or an earlier stderr line),
        // never let a later stderr line overwrite it.
        if (announcedSessionId === undefined) {
          const nextSessionId = extractSessionIdFromStderr(stderrTail + chunk);
          if (nextSessionId !== undefined) {
            announcedSessionId = nextSessionId;
          }
        }
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

/**
 * Run `kimi -p` under a budget that also tells the subprocess to die
 * when the budget expires.
 *
 * Why this exists separately from `withTimeout`:
 *
 *   The generic `withTimeout` (runtime/kimi-timeouts.ts) only rejects
 *   the outer Promise — it has no handle on the kimi child process.
 *   review/ask/review-gate previously wrapped `runCliPrompt` with
 *   `withTimeout` and let the orphaned subprocess keep running until
 *   it crashed or finished on its own. The reviewers (reports 17 +
 *   18) flagged this as critical for review_gate in particular: the
 *   8 s budget fires inside Claude Code's Stop hook, the parent
 *   returns "allow stop", and a runaway kimi keeps holding the
 *   SQLite row + model tokens. Subsequent `/kimi:cancel` can't reach
 *   it because `kimi_pid` is null.
 *
 * Behavior:
 *
 *   - Owns an internal AbortController. If the caller passes
 *     `opts.signal`, both signals are linked — abort on either side
 *     aborts the internal controller.
 *   - When the budget expires, abort the internal controller, await the
 *     subprocess/tree teardown, then reject with
 *     `RuntimeError("RESPONSE_TIMEOUT", …)` matching the legacy
 *     `withTimeout` code shape.
 *   - Result success path is unchanged from `runCliPrompt`.
 */
export async function runCliPromptWithBudget(
  opts: CliClientOptions,
  budgetMs: number,
  stage: string,
): Promise<CliClientResult> {
  const controller = new AbortController();
  if (opts.signal?.aborted === true) {
    controller.abort();
  }
  const onParentAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onParentAbort, { once: true });

  let timeoutFired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  timer = setTimeout(() => {
    timeoutFired = true;
    controller.abort();
  }, budgetMs);
  timer.unref();

  const timeoutError = (raceDetected = false) =>
    new RuntimeError(
      "RESPONSE_TIMEOUT",
      `${stage} timed out after ${budgetMs}ms${raceDetected ? " (race detected post-result)" : ""}.`,
      stage,
      {
        details: {
          budget_ms: budgetMs,
          command_label: opts.commandLabel ?? null,
        },
      },
    );

  try {
    let result: CliClientResult;
    try {
      // Deliberately do not race this promise against an early timeout
      // rejection. The timer aborts it, and runCliPrompt owns the complete
      // child/descendant teardown before it can settle.
      result = await runCliPrompt({ ...opts, signal: controller.signal });
    } catch (error) {
      if (timeoutFired) throw timeoutError();
      throw error;
    }
    if (timeoutFired) {
      // The timer and close can become runnable in the same event-loop turn.
      // Teardown has still completed because runCliPrompt settled first.
      throw timeoutError(true);
    }
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onParentAbort);
  }
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
  // NOTE: `opts.thinking === false` is intentionally NOT translated into a
  // `--no-thinking` argv flag. kimi-code 0.1.1 rejects unknown options and
  // has no per-spawn thinking control — the Round 2 multi-agent review
  // caught this. The option stays in CliClientOptions for future wiring
  // when upstream adds the flag (see field doc).

  // -p accepts the prompt as the option value. We pass it as a separate argv
  // entry so prompts with leading dashes or whitespace are not interpreted as
  // additional flags.
  args.push("-p", opts.prompt);
  return args;
}

function buildEnv(opts: CliClientOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...opts.env };
  env.KIMI_CODE_HOME = resolveKimiHome(opts.env, opts.cwd);
  if (opts.commandLabel !== undefined) {
    env.KIMI_PLUGIN_CC_CMD = opts.commandLabel;
  }
  if (opts.swarmMaxConcurrency !== undefined) {
    // kimi-code 0.18.0+ caps AgentSwarm's normal-phase concurrency at this
    // value; older binaries ignore it. See the field doc on CliClientOptions.
    env.KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY = String(opts.swarmMaxConcurrency);
  }
  if (opts.swarmWriteWorkspaceRoot !== undefined) {
    // Trusted allowlist root for the swarm-write PreToolUse hook (v1.4). Forge-
    // proof (env on the spawned process; the model can't set it). See field doc.
    env.KIMI_PLUGIN_CC_WORKSPACE_ROOT = opts.swarmWriteWorkspaceRoot;
  }
  return env;
}

function appendToTail(tail: string, chunk: string, maxBytes: number): string {
  const combined = tail + chunk;
  if (combined.length <= maxBytes) return combined;
  return combined.slice(combined.length - maxBytes);
}

function truncateChars(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function isErrnoException(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
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

async function raceWithValueTimeout<T, TTimeout>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutValue: TTimeout,
): Promise<T | TTimeout> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<TTimeout>((resolve) => {
        timer = setTimeout(() => resolve(timeoutValue), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
