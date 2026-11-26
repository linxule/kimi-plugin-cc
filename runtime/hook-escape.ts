import { decideHookOutcomePure, type PolicyContext } from "./hooks/approval-policy.js";
import type { StreamJsonRecord } from "./stream-json.js";

export interface HookEscape {
  tool_call_id: string;
  tool_name: string;
  /** `mismatch`: the result was not the managed hook's denial — hook drift, a pre-hook
   * upstream rejection, or another hook/policy that blocked first with its own text.
   * `unresolved`: the run settled before any result for the denied call arrived. */
  kind: "mismatch" | "unresolved";
  content_excerpt?: string;
}

// Upstream decorates results it still delivers verbatim otherwise
// (`agent/toolDedupe/toolDedupeService.ts`): the repeat breaker appends
// `\n\n<system-reminder>…</system-reminder>` blocks from the 3rd identical
// call (`appendReminder`, also for vetoed results — `finalizeToolResult` runs
// the `onDidExecuteTool` hooks on every settled result). Through 2.5.3 a
// twelfth identical call also starts a text-only handoff step, and every tool
// call attempted in that step, whatever the tool, gets a fixed "not executed"
// text (`HANDOFF_VETO_TEXT`) in place of its result. From 2.6.0 that phase and
// its text are gone: the breaker appends reminders and then stops the turn.
// Both shapes still mean the hook's veto stood. Re-verify each certification.
const REMINDER_SUFFIX = /^(?:\n\n<system-reminder>[\s\S]*?<\/system-reminder>)+$/;
const HANDOFF_VETO_PREFIX = "This turn was ended by the repeat breaker after the same tool call was issued ";

/**
 * True when this kimi-code release can emit the handoff text: every release
 * before 2.6.0, and any version this cannot read (an unprobed binary), where
 * staying lenient avoids a false report.
 */
export function emitsHandoffVeto(kimiVersion: string | null | undefined): boolean {
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(kimiVersion ?? "");
  if (match === null) return true;
  const major = Number(match[1]);
  return major < 2 || (major === 2 && Number(match[2]) < 6);
}

/** True when `content` is the hook's denial, possibly carrying upstream's repeat-breaker decoration. */
export function carriesDenial(content: string, reason: string, handoffVeto = true): boolean {
  if (content === reason) return true;
  if (content.startsWith(reason) && REMINDER_SUFFIX.test(content.slice(reason.length))) return true;
  return handoffVeto && content.startsWith(HANDOFF_VETO_PREFIX);
}

/** Detection evidence, never enforcement. Results arrive after a tool may have
 * executed, and the stream carries no outcome field: a result other than the
 * managed denial is also what upstream emits for calls it rejected BEFORE the
 * hook ran (unknown tool, disabled tool, invalid args, sensitive path, per-tool
 * resolve errors) and what a coexisting hook or permission policy emits when it
 * blocks first. So an escape is reported — logged, persisted, shown — and the
 * run continues; failing the job needs positive execution evidence this stream
 * does not provide. Filesystem policy is never replayed here. */
export function createHookEscapeMonitor(
  ctx: Omit<PolicyContext, "rescueEvaluator"> & { cwd: string; kimiVersion?: string | null },
) {
  const pending = new Map<string, { reason: string; tool_name: string }>();
  const handoffVeto = emitsHandoffVeto(ctx.kimiVersion);
  return {
    observe(record: StreamJsonRecord): HookEscape | undefined {
      if (!ctx.commandLabel) return;
      if (record.role === "assistant") {
        for (const call of record.tool_calls ?? []) {
          let args: unknown;
          try { args = JSON.parse(call.function.arguments); } catch { args = {}; }
          if (typeof args !== "object" || args === null || Array.isArray(args)) args = {};
          const result = decideHookOutcomePure({
            hook_event_name: "PreToolUse", tool_name: call.function.name,
            tool_input: args, tool_call_id: call.id, cwd: ctx.cwd,
          }, ctx);
          if (!("evaluator" in result) && result.decision === "deny") {
            pending.set(call.id, { reason: result.reason!, tool_name: call.function.name });
          }
        }
      } else if (record.role === "tool") {
        const denied = pending.get(record.tool_call_id);
        if (denied) {
          pending.delete(record.tool_call_id);
          if (!carriesDenial(record.content, denied.reason, handoffVeto)) {
            return { tool_call_id: record.tool_call_id, tool_name: denied.tool_name,
              kind: "mismatch", content_excerpt: record.content.slice(0, 200) };
          }
        }
      }
    },
    /** Every denied call still without a result; call once at settlement. */
    settle(): HookEscape[] {
      const unresolved = [...pending.entries()].map(([tool_call_id, { tool_name }]) =>
        ({ tool_call_id, tool_name, kind: "unresolved" as const }));
      pending.clear();
      return unresolved;
    },
  };
}
