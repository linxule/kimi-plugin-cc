import { RuntimeError } from "../errors.js";
/**
 * Reassemble prose final text from cli-client records.
 *
 * The v0.4 wire client returned a single `finalText` field as the
 * canonical assistant prose. Stream-json instead emits a sequence of
 * records, three of which can carry assistant prose:
 *
 *   - `{role:"assistant", content:"..."}`           — text token
 *   - `{role:"assistant", tool_calls:[...]}`        — no text
 *   - `{role:"tool", tool_call_id:"...", content}`  — tool output, ignore
 *
 * We concatenate every assistant `content` field in arrival order. The
 * order is preserved by stream-json's NDJSON contract — kimi-code emits
 * one record per line, parser preserves emission order, runtime
 * pushes to `records[]` in the same order.
 *
 * Two correctness notes:
 *
 *   1. Empty assistant records (assistant tool_calls without prose)
 *      contribute zero characters but still appear in `records`. We
 *      skip them without inserting a separator, otherwise back-to-back
 *      tool calls would inject blank lines.
 *
 *   2. We do NOT trim individual content fragments. kimi-code emits
 *      tokens that may include leading/trailing whitespace as part of
 *      the model's intended formatting. Only the final concatenated
 *      string is whitespace-managed by the caller's render layer.
 */
export function reassembleProseFromRecords(records) {
    let out = "";
    for (const record of records) {
        if (record.role !== "assistant")
            continue;
        if (typeof record.content !== "string")
            continue;
        out += record.content;
    }
    return out;
}
/**
 * Loud-fail warning when kimi finished a job but never announced a
 * session id on stderr. We persist `kimi_session_id` as NULL in that
 * case (the row is unresumable), and the user is silently surprised
 * later when `-r` or `/kimi:replay` returns nothing.
 *
 * The right surface is human-readable stderr per the LLM-caller
 * discipline invariant — load-bearing context still goes via the SQLite
 * row (`kimi_session_id IS NULL`), but the user sees this warning
 * inline immediately after the prompt completes so they know resume is
 * unavailable for this job.
 *
 * Called at the end of every command that captures sessionId (review,
 * challenge, ask, rescue). Review-gate intentionally skips: it's a Stop
 * hook with no resume semantics and we don't want a runtime warning to
 * leak into Claude Code's transcript on every assistant turn.
 */
export function warnIfSessionIdMissing(result, commandLabel, jobId, stderr) {
    if (result.sessionId !== undefined && result.sessionId.length > 0) {
        return;
    }
    stderr.write(`[${commandLabel}] kimi did not announce a session id for job ${jobId}. ` +
        `Resume and replay will not work for this job. ` +
        `If this happens repeatedly, check kimi-code's stderr format (the " To resume this session" line) and report upstream.\n`);
}
/**
 * Translate a cli-client `CliClientResult` into the kind of error
 * surface ask/review/rescue commands have always thrown when the
 * underlying transport reported a failure.
 *
 * Order matters: a non-zero exit code may carry no records (process
 * died early) or may carry partial records (model started but kimi
 * crashed). Either way, we surface the exit-code failure first because
 * trying to render a half-stream as `finalText` produces confusing
 * downstream errors.
 *
 * `stage` is used as both the RuntimeError stage and a prefix-free
 * label for code namespacing — callers should pass values like
 * "ask.runtime" / "review.runtime" / "review_gate.runtime".
 */
export function assertCliResultSuccess(result, stage) {
    if (result.aborted) {
        // Aborted-by-our-signal is a cancellation, not a failure. The
        // caller's outer handler checks `handlers.cancelling` and wraps
        // into the canonical *_CANCELLED RuntimeError; we just need to
        // bail without claiming the records are a complete response.
        throw new RuntimeError("CLI_ABORTED", "kimi subprocess was cancelled before completing the response", stage, {
            details: {
                exit_code: result.exitCode,
                signal: result.signal,
                record_count: result.records.length,
                stderr_tail_len: result.stderrTail.length,
            },
        });
    }
    if (result.exitCode !== 0) {
        const tail = result.stderrTail.trim();
        throw new RuntimeError("CLI_NONZERO_EXIT", [
            `kimi subprocess exited with code ${result.exitCode}`,
            result.signal ? ` (signal ${result.signal})` : "",
            tail.length > 0 ? `:\n${tail}` : ".",
        ].join(""), stage, {
            details: {
                exit_code: result.exitCode,
                signal: result.signal,
                record_count: result.records.length,
                malformed_count: result.malformed.length,
                stderr_tail_len: result.stderrTail.length,
            },
        });
    }
}
