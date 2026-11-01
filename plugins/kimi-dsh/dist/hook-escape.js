import { decideHookOutcomePure } from "./hooks/approval-policy.js";
// Upstream decorates results it still delivers verbatim otherwise (2.2.0,
// `agent/toolDedupe/toolDedupeService.ts`): the repeat breaker appends one
// `\n\n<system-reminder>…</system-reminder>` block from the 3rd identical call
// (`appendReminder`, also for vetoed results — `finalizeToolResult` runs the
// `onDidExecuteTool` hooks on every settled result), and at the 12th call it
// replaces the result with a fixed "not executed" text (`HANDOFF_VETO_TEXT`).
// Both still mean the hook's veto stood. Re-verify each certification.
const REMINDER_SUFFIX = /^(?:\n\n<system-reminder>[\s\S]*?<\/system-reminder>)+$/;
const HANDOFF_VETO_PREFIX = "This turn was ended by the repeat breaker after the same tool call was issued ";
/** True when `content` is the hook's denial, possibly carrying upstream's repeat-breaker decoration. */
export function carriesDenial(content, reason) {
    if (content === reason)
        return true;
    if (content.startsWith(reason) && REMINDER_SUFFIX.test(content.slice(reason.length)))
        return true;
    return content.startsWith(HANDOFF_VETO_PREFIX);
}
/** Detection evidence, never enforcement. Results arrive after a tool may have
 * executed, and the stream carries no outcome field: a result other than the
 * managed denial is also what upstream emits for calls it rejected BEFORE the
 * hook ran (unknown tool, disabled tool, invalid args, sensitive path, per-tool
 * resolve errors) and what a coexisting hook or permission policy emits when it
 * blocks first. So an escape is reported — logged, persisted, shown — and the
 * run continues; failing the job needs positive execution evidence this stream
 * does not provide. Filesystem policy is never replayed here. */
export function createHookEscapeMonitor(ctx) {
    const pending = new Map();
    return {
        observe(record) {
            if (!ctx.commandLabel)
                return;
            if (record.role === "assistant") {
                for (const call of record.tool_calls ?? []) {
                    let args;
                    try {
                        args = JSON.parse(call.function.arguments);
                    }
                    catch {
                        args = {};
                    }
                    if (typeof args !== "object" || args === null || Array.isArray(args))
                        args = {};
                    const result = decideHookOutcomePure({
                        hook_event_name: "PreToolUse", tool_name: call.function.name,
                        tool_input: args, tool_call_id: call.id, cwd: ctx.cwd,
                    }, ctx);
                    if (!("evaluator" in result) && result.decision === "deny") {
                        pending.set(call.id, { reason: result.reason, tool_name: call.function.name });
                    }
                }
            }
            else if (record.role === "tool") {
                const denied = pending.get(record.tool_call_id);
                if (denied) {
                    pending.delete(record.tool_call_id);
                    if (!carriesDenial(record.content, denied.reason)) {
                        return { tool_call_id: record.tool_call_id, tool_name: denied.tool_name,
                            kind: "mismatch", content_excerpt: record.content.slice(0, 200) };
                    }
                }
            }
        },
        /** Every denied call still without a result; call once at settlement. */
        settle() {
            const unresolved = [...pending.entries()].map(([tool_call_id, { tool_name }]) => ({ tool_call_id, tool_name, kind: "unresolved" }));
            pending.clear();
            return unresolved;
        },
    };
}
