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
import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { RuntimeError, formatError } from "./errors.js";
import { StreamJsonParser, extractSessionIdFromStderr, } from "./stream-json.js";
import { collectDescendants } from "./process-tree.js";
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
export async function runCliPrompt(opts) {
    // Pre-aborted signal: refuse to spawn at all.
    if (opts.signal?.aborted === true) {
        throw new RuntimeError("CLI_ABORTED", "kimi subprocess request cancelled before spawn", "cli-client.pre-spawn", { details: { command: opts.command } });
    }
    const args = buildArgs(opts);
    const env = buildEnv(opts);
    if (opts.logPath !== undefined) {
        await mkdir(path.dirname(opts.logPath), { recursive: true }).catch(() => {
            // Best-effort; if mkdir fails the appendFile below will error and be
            // swallowed by the log chain (diagnostics are non-blocking).
        });
    }
    let child;
    try {
        child = spawn(opts.command, args, {
            cwd: opts.cwd,
            env,
            stdio: "pipe",
            // POSIX gets a fresh process group so cancellation reaches kimi's
            // descendants; Windows has no negative-pid process-group signaling.
            detached: process.platform !== "win32",
        });
    }
    catch (err) {
        throw new RuntimeError("CLI_SPAWN_FAILED", `Failed to spawn kimi: ${formatError(err)}`, "cli-client.spawn", err instanceof Error
            ? { cause: err, details: { command: opts.command, args } }
            : { details: { command: opts.command, args } });
    }
    // Pre-attach an 'error' listener immediately. Bun (and Node) can emit
    // 'error' asynchronously between spawn returning and our Promise body
    // attaching the real listener — without a handler in place, EventEmitter
    // crashes the process. Capture into an array (not a single slot) so two
    // back-to-back errors don't lose the first; we replay the first one when
    // the real handler installs. The replacement is atomic across two
    // synchronous statements (flag-flip + .on attach), so no async work can
    // interleave between them.
    const earlyErrors = [];
    let earlyErrorHandled = false;
    child.on("error", function earlyErrorListener(err) {
        if (earlyErrorHandled)
            return;
        earlyErrors.push(err);
    });
    const parser = new StreamJsonParser();
    const records = [];
    const malformed = [];
    // Rolling stderr tail — keep only the trailing STDERR_TAIL_BYTES so a
    // long-running kimi process emitting megabytes of stderr (tool.progress,
    // thinking deltas) doesn't grow our RSS unboundedly.
    let stderrTail = "";
    let announcedSessionId;
    let logChain = Promise.resolve();
    const appendLogLine = (payload) => {
        if (opts.logPath === undefined)
            return;
        const line = `${JSON.stringify({ ts: new Date().toISOString(), ...payload })}\n`;
        logChain = logChain.then(() => appendFile(opts.logPath, line, "utf8").catch(() => {
            // Diagnostics best-effort; never crash on log failure.
        }));
    };
    appendLogLine({
        event: "spawn",
        command: opts.command,
        args,
        cwd: opts.cwd,
        command_label: opts.commandLabel ?? null,
    });
    const invokeOnRecord = (record) => {
        if (opts.onRecord === undefined)
            return;
        try {
            opts.onRecord(record);
        }
        catch {
            // Caller-supplied callback must never destabilize the parse loop.
        }
    };
    const consumeOutcomes = (outcomes) => {
        for (const outcome of outcomes) {
            if (outcome.record !== undefined) {
                records.push(outcome.record);
                appendLogLine({ event: "record", record: outcome.record });
                invokeOnRecord(outcome.record);
            }
            else if (outcome.malformedLine !== undefined) {
                const entry = {
                    line: truncateChars(outcome.malformedLine, 200),
                    reason: outcome.malformedReason ?? "unknown",
                };
                malformed.push(entry);
                appendLogLine({ event: "malformed", ...entry });
            }
        }
    };
    const errorDetails = () => ({
        command: opts.command,
        args,
        command_label: opts.commandLabel ?? null,
    });
    return await new Promise((resolve, reject) => {
        let settled = false;
        let aborted = false;
        const settle = (kind, payload) => {
            if (settled)
                return;
            settled = true;
            opts.signal?.removeEventListener("abort", onAbort);
            if (kind === "resolve")
                resolve(payload);
            else
                reject(payload);
        };
        const escalationMs = opts.escalationMs ?? DEFAULT_ESCALATION_MS;
        let escalationTimer;
        // Separate flag from `settled` because the close handler clears the
        // timer BEFORE awaiting the log drain and only calls settle()
        // afterward. Without `processClosed`, a timer callback already
        // queued at close time could observe `settled === false` and fire
        // a redundant SIGKILL during the drain window.
        let processClosed = false;
        // Descendants captured at SIGTERM time, reused for SIGKILL. Critical:
        // by the time SIGKILL fires (1500ms later), kimi may have died from
        // SIGTERM while bash grandchildren ignored it. Bash reparents to
        // launchd (PPID=1), so a fresh PPID-walk from kimi's pid returns
        // empty and the SIGKILL escalation would miss the surviving
        // grandchildren entirely. Snapshot once, signal twice.
        let descendantSnapshot;
        const signalChildTree = async (signal) => {
            if (child.pid === undefined)
                return;
            if (process.platform === "win32") {
                // Descendant reaping is not implemented on win32; cancel may leave grandchildren alive.
                try {
                    child.kill(signal);
                }
                catch {
                    // Best-effort.
                }
                return;
            }
            // First call (SIGTERM) populates the snapshot before kimi dies.
            // Second call (SIGKILL) reuses it so a reparented bash subprocess
            // still gets the kill signal.
            if (descendantSnapshot === undefined) {
                descendantSnapshot = await (opts.descendantCollector ?? collectDescendants)(child.pid);
            }
            const pids = [child.pid, ...descendantSnapshot];
            for (const pid of pids) {
                try {
                    process.kill(pid, signal);
                }
                catch (err) {
                    const ignored = isErrnoException(err, "ESRCH") || isErrnoException(err, "EPERM");
                    void ignored;
                }
            }
            // Group-kill each pid as defense-in-depth. Each kimi-code Bash tool
            // subprocess spawns with `detached: true` (per kimi-code 0.1.1
            // LocalKaos), so every descendant is itself a session leader with
            // its own pgrp. A pgrp kill on each catches *its* unenumerated
            // children (e.g. a bash command's own pipeline kids that spawned
            // after our enumeration). ESRCH/EPERM are silently skipped.
            for (const pid of pids) {
                try {
                    process.kill(-pid, signal);
                }
                catch (err) {
                    const ignored = isErrnoException(err, "ESRCH") || isErrnoException(err, "EPERM");
                    void ignored;
                }
            }
        };
        const onAbort = () => {
            aborted = true;
            void signalChildTree("SIGTERM");
            // Escalate to SIGKILL if the process doesn't exit promptly.
            // v0.4 had this on the wire-client side; v1 inherits the same
            // 1500ms default so a stuck-kimi rescue/ask/review feels
            // identical post-cutover. Skipped when escalationMs is
            // non-finite (Infinity) so tests can opt out.
            if (Number.isFinite(escalationMs)) {
                escalationTimer = setTimeout(() => {
                    if (processClosed || settled)
                        return;
                    void signalChildTree("SIGKILL");
                }, escalationMs);
                escalationTimer.unref();
            }
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
            settle("reject", new RuntimeError("CLI_PROCESS_ERROR", `kimi subprocess error: ${formatError(err)}`, "cli-client.process", err instanceof Error
                ? { cause: err, details: errorDetails() }
                : { details: errorDetails() }));
        });
        if (earlyErrors.length > 0) {
            const captured = earlyErrors[0];
            queueMicrotask(() => {
                appendLogLine({
                    event: "process_error",
                    message: formatError(captured),
                    early: true,
                    additional_count: earlyErrors.length - 1,
                });
                settle("reject", new RuntimeError("CLI_PROCESS_ERROR", `kimi subprocess error: ${formatError(captured)}`, "cli-client.process", { cause: captured, details: errorDetails() }));
            });
        }
        child.on("close", async (exitCode, signal) => {
            // Mark closed BEFORE clearing the timer so a callback already
            // queued in the same tick observes `processClosed === true`
            // and short-circuits. Without this, the log-drain await below
            // opens a window where the timer can fire a redundant SIGKILL
            // on an already-dead pid (which may have been recycled by the OS).
            processClosed = true;
            if (escalationTimer !== undefined) {
                clearTimeout(escalationTimer);
                escalationTimer = undefined;
            }
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
            child.stdout.on("data", (chunk) => {
                consumeOutcomes(parser.push(chunk));
            });
            child.stderr.on("data", (chunk) => {
                const nextSessionId = extractSessionIdFromStderr(stderrTail + chunk);
                if (nextSessionId !== undefined) {
                    announcedSessionId = nextSessionId;
                }
                stderrTail = appendToTail(stderrTail, chunk, STDERR_TAIL_BYTES);
            });
            child.stdin.end();
        }
        catch (err) {
            settle("reject", new RuntimeError("CLI_PROCESS_ERROR", `kimi subprocess stream setup failed: ${formatError(err)}`, "cli-client.streams", err instanceof Error
                ? { cause: err, details: errorDetails() }
                : { details: errorDetails() }));
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
export function requireSessionId(result, context) {
    if (result.sessionId !== undefined && result.sessionId.length > 0) {
        return result.sessionId;
    }
    throw new RuntimeError("CLI_NO_SESSION_ID", "kimi subprocess completed without announcing a session id; replay and resume will be unavailable", "cli-client.session-id", {
        details: {
            command_label: context.commandLabel ?? null,
            exit_code: result.exitCode,
            signal: result.signal,
            aborted: result.aborted,
            stderr_tail_len: result.stderrTail.length,
        },
    });
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
 *   - When the budget expires, abort the internal controller and
 *     reject with `RuntimeError("RESPONSE_TIMEOUT", …)` matching the
 *     legacy `withTimeout` code shape.
 *   - Result success path is unchanged from `runCliPrompt`.
 */
export async function runCliPromptWithBudget(opts, budgetMs, stage) {
    const controller = new AbortController();
    if (opts.signal?.aborted === true) {
        controller.abort();
    }
    const onParentAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onParentAbort, { once: true });
    let timeoutFired = false;
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            timeoutFired = true;
            controller.abort();
            reject(new RuntimeError("RESPONSE_TIMEOUT", `${stage} timed out after ${budgetMs}ms.`, stage, {
                details: {
                    budget_ms: budgetMs,
                    command_label: opts.commandLabel ?? null,
                },
            }));
        }, budgetMs);
        timer.unref();
    });
    try {
        const runPromise = runCliPrompt({ ...opts, signal: controller.signal });
        const result = await Promise.race([runPromise, timeoutPromise]);
        if (timeoutFired) {
            // Defensive — Promise.race might have observed the result first
            // even though the timer fired in the same microtask tick. The
            // controller was already aborted, so the subprocess is on its
            // way down; surface the timeout to the caller.
            throw new RuntimeError("RESPONSE_TIMEOUT", `${stage} timed out after ${budgetMs}ms (race detected post-result).`, stage);
        }
        return result;
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onParentAbort);
    }
}
function buildArgs(opts) {
    const args = [...(opts.prefixArgs ?? [])];
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
function buildEnv(opts) {
    const env = { ...opts.env };
    if (opts.commandLabel !== undefined) {
        env.KIMI_PLUGIN_CC_CMD = opts.commandLabel;
    }
    return env;
}
function appendToTail(tail, chunk, maxBytes) {
    const combined = tail + chunk;
    if (combined.length <= maxBytes)
        return combined;
    return combined.slice(combined.length - maxBytes);
}
function truncateChars(value, maxChars) {
    return value.length <= maxChars ? value : value.slice(0, maxChars);
}
function isErrnoException(err, code) {
    return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
function raceWithTimeout(promise, timeoutMs) {
    let timer;
    const timeoutPromise = new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
    });
    return Promise.race([
        promise.then(() => { }, () => { }),
        timeoutPromise,
    ]).finally(() => {
        if (timer !== undefined)
            clearTimeout(timer);
    });
}
