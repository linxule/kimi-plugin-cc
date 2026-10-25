import { RuntimeError } from "../errors.js";
import { ResponseTimeoutError } from "../cli-client.js";
import { observedExecutionFields } from "../kimi-engine.js";
import { resolveKimiHome } from "../kimi-home.js";
import { recoverSessionIdFromStore } from "../session-recovery.js";
import { formatBudgetDuration } from "../render.js";
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
 * Warn when kimi finishes without announcing a session ID. The job keeps
 * `kimi_session_id` NULL, so resume is unavailable.
 *
 * This warning belongs on human stderr; load-bearing state remains in SQLite.
 * Review-gate intentionally skips it because a Stop hook has no resume
 * semantics and should not warn on every assistant turn.
 */
export function warnIfSessionIdMissing(result, commandLabel, jobId, stderr) {
    if (result.sessionId !== undefined && result.sessionId.length > 0) {
        return;
    }
    stderr.write(`[${commandLabel}] kimi did not announce a session id for job ${jobId}. ` +
        `Resume will not work for this job. Replay from the stored stream log is unaffected. ` +
        `If this happens repeatedly, check kimi-code's session.resume_hint record (and the legacy stderr resume announcement) and report upstream.\n`);
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
        const tail = result.cliError?.message ?? result.stderrTail.trim();
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
                ...(result.cliError !== undefined && { cli_error: result.cliError }),
                stderr_tail_len: result.stderrTail.length,
            },
        });
    }
}
/** Timeout-only capture. Cancellation takes precedence, including while the
 * asynchronous store scan is in flight. No title sync on failure. */
export async function captureTimeoutPartialOutput(classified, store, job, env, cancellationSignal) {
    if (cancellationSignal?.aborted)
        return undefined;
    const timeout = classified.cause;
    if (!(timeout instanceof ResponseTimeoutError) || !timeout.partialResult)
        return undefined;
    const result = timeout.partialResult;
    let sessionId = result.sessionId;
    let source = sessionId
        ? sessionId === job.kimi_session_id
            ? job.kimi_session_id_source
            : "announced"
        : null;
    const details = classified instanceof RuntimeError ? classified.details : timeout.details;
    details.kimi_session_id_source = job.kimi_session_id_source;
    // The persisted plan is plugin-owned. Recovery never runs on cancellation,
    // v1, successful turns, teardown rejection, or an already-known resume id.
    if (!sessionId && !job.kimi_session_id && job.intended_engine === "native-v2") {
        // Without the system.version marker the row has no proven engine, and
        // resume would refuse the id as lineage-unknown; do not advertise one.
        if (result.observedEngine === null) {
            details.session_recovery = "engine_unobserved";
        }
        else {
            const recovered = await recoverSessionIdFromStore({
                kimiHome: resolveKimiHome(env, job.cwd), cwd: job.cwd,
                spawnedAt: result.spawnedAt, settledAt: result.settledAt, promptDigest: job.prompt_digest,
                store, jobId: job.job_id,
            });
            sessionId = recovered.sessionId;
            if (sessionId)
                source = "recovered_session_dir";
            else
                details.session_recovery = recovered.reason;
        }
    }
    if (cancellationSignal?.aborted)
        return undefined;
    // Best-effort metadata only. The row is still `running`, and a session id
    // written here can collide with `jobs_running_session_idx` when a resume of
    // the same session was started while this job ran. A store error must never
    // prevent markJobFailed from running — the partial artifact matters more
    // than the metadata, so swallow and fall through.
    try {
        store.updateRunningJob(job.job_id, observedExecutionFields(result));
        if (sessionId) {
            const updated = source === "recovered_session_dir"
                ? store.claimRecoveredSessionId(job.job_id, sessionId)
                : store.updateRunningJob(job.job_id, { kimi_session_id: sessionId, kimi_session_id_source: source });
            if (updated?.kimi_session_id === sessionId && updated.kimi_session_id_source === source) {
                details.kimi_session_id = sessionId;
                details.kimi_session_id_source = source;
            }
            else
                details[source === "recovered_session_dir" ? "session_recovery" : "session_id_persistence"] = "persistence_failed";
        }
    }
    catch {
        // `session_recovery` describes only the recovery branch; an announced id or
        // the provenance update failing is a different fact.
        details[source === "recovered_session_dir" ? "session_recovery" : "session_id_persistence"] = "persistence_failed";
        // Diagnostics stay in the stream log; the failure transition proceeds.
    }
    return {
        text: reassembleProseFromRecords(result.records),
        toolCalls: result.records.some((record) => record.role === "tool" ||
            (record.role === "assistant" && Array.isArray(record.tool_calls) &&
                record.tool_calls.length > 0)),
        recordCount: result.records.length,
        budgetMs: timeout.details.budget_ms,
    };
}
/** One-line human summary of hook-escape findings, or undefined when none. */
export function describeHookEscapes(result) {
    const escapes = result.hookEscapes ?? [];
    if (escapes.length === 0)
        return undefined;
    const first = escapes[0];
    return `safety hook notice: ${escapes.length} policy-denied tool call(s) did not come back as the managed hook's denial (first: ${first.tool_name} ${first.kind}). Detection evidence only — the call may have been rejected upstream before the hook ran, blocked by another hook, or executed because the hook drifted. Run /kimi:setup --check; details in \`result <jobId> --json\` (hook_escapes).`;
}
export function warnHookEscapes(result, commandType, stderr) {
    const note = describeHookEscapes(result);
    if (note !== undefined)
        stderr.write(`[${commandType}] ${note}\n`);
}
export function warnInheritedBudget(job, stderr) {
    if (job.budget_source === "inherited" && job.budget_ms !== null) {
        stderr.write(`[${job.command_type}] budget ${formatBudgetDuration(job.budget_ms)} inherited from job ${job.resumed_from_job_id}; pass --budget to override\n`);
    }
}
