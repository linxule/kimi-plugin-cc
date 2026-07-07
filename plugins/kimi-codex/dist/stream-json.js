// Stream-JSON parser for `kimi -p --output-format stream-json`.
//
// Canonical record shapes (verified against kimi-code source at
// apps/kimi-code/src/cli/run-prompt.ts — `PromptJsonWriter` emits one JSON
// object per line via `JSON.stringify(message) + '\n'`):
//
//   {"role":"assistant","content":"..."}
//   {"role":"assistant","content":"...","tool_calls":[{type,id,function:{name,arguments}}]}
//   {"role":"assistant","tool_calls":[...]}
//   {"role":"tool","tool_call_id":"...","content":"..."}
//   {"role":"meta","type":"session.resume_hint","session_id":"session_<uuid>","command":"kimi -r session_<uuid>","content":"To resume this session: kimi -r session_<uuid>"}
//
// Notes on what does and does not appear here:
//   - The session.resume_hint meta record is NEW in kimi-code 0.2.0
//     (introduced at run-prompt.ts:477-505 in 0.2.0; the writer region —
//     `PromptJsonResumeMetaMessage` / `writeResumeHint` / `PromptJsonWriter` —
//     sits at apps/kimi-code/src/cli/run-prompt.ts:567-696 as of 0.9.0 and is
//     verified stable through 0.23.1. 2026-05-27 audit covered 0.4.0,
//     2026-05-28 audit covered 0.5.0 (run-prompt.ts zero-byte diff across
//     both), 2026-05-31 audit covered 0.6.0, 2026-06-03 audit covered
//     0.7.0/0.8.0/0.9.0 in one cumulative pass, 2026-06-09 audit covered
//     0.10.0/0.11.0/0.12.0 in one cumulative 0.9.0→0.12.0 pass, 2026-06-12 audit
//     covered 0.12.1/0.13.0/0.13.1/0.14.0/0.14.1 in one cumulative 0.12.0→0.14.1
//     pass (records/ dir empty diff; the 0.13/0.14 packages/protocol/ REST+WS
//     control API is a separate transport — run-prompt.ts imports none of it,
//     `-p` stdout stays the direct PromptJsonWriter), 2026-06-13 audit covered
//     the 0.14.2 patch (records/ + the PromptJsonWriter/writeResumeHint region
//     both 0-byte; the patch is a repo-wide `.md`→`.md?raw` bundler-import
//     migration plus a Bash-tool stdout/stderr streaming callback, neither
//     touching the writer), and 2026-06-14 covered the 0.14.3 patch (all four
//     scoped diffs 0-byte; the entire patch is a TUI model-picker
//     provider-refresh change — PR #713 — off the `-p` path), and 2026-06-16
//     covered the 0.15.0 minor (permission/hooks/run-prompt/cli all 0-byte by
//     independent `git diff` byte-count; the only scoped change is records/ +
//     session/ persistence churn — PR #786 drops app_version/resumed from the
//     .records/ metadata artifact, a SessionSkillRegistry rename, a static
//     model-capability lookup — none of it on the `-p` stdout stream; plus an
//     additive `transport:'sse'` MCP config variant the plugin never writes),
//     and 2026-06-17 covered the 0.16.0 minor (permission/hooks/run-prompt all
//     0-byte; the only argv change registers a new `kimi vis` subcommand off
//     the `-p` path, and the records/replay/compaction/logging churn is
//     internal — not on the stdout stream; GREEN smoke 7/0 on the 0.16.0
//     binary), 2026-06-19 covered the 0.16.0→0.18.0 jump (0.17.0/0.17.1/0.18.0;
//     03-hooks.diff 0-byte, run-prompt.ts only a telemetry refactor outside the
//     writer, the sole permission change a NON-auto-mode GoalStartReviewAsk that
//     is dead on `-p`), and 2026-06-23 covered the 0.18.0→0.19.1 minor (the
//     writer + records/ 0-byte; the bumping feature #812 `--add-dir` touches
//     only an approve policy at the queue tail, structurally dead below the
//     `-p` auto-mode approve and still pre-empted by our index-0 hook even when
//     project-local `.kimi-code/local.toml` makes additionalDirs non-empty;
//     #963's new `turn.ended` reason:'filtered' is a failure REASON not a new
//     stdout record SHAPE;
//     GREEN smoke 9/0 on the operator's 0.19.1 binary —
//     .claude/kimi-code-research/reports/85-upstream-0191-surface.md), and
//     2026-06-26 covered the 0.19.1→0.20.0 minor (run-prompt.ts + options.ts +
//     records/ all 0-byte; #1040's new `warning` agent event is swallowed on `-p`
//     at run-prompt.ts:495 `case 'warning': return;`, so it never reaches this
//     parser; #1062's tool-result budget adds a `truncated` flag to tool-result
//     CONTENT, not the record SHAPE; the new runShellCommand RPC + kimi server/web
//     stack are off the `-p` path — report 88. Smoke NOT run this cert: the 0.20.0
//     `bun run smoke:real` was quota-blocked, 403 usage-limit, records:[] — an
//     operator-billing false alarm, not a compat break; certified on source audit;
//     the later 0.20.2 smoke ran GREEN 9/0 on 2026-06-29), and 2026-07-01
//     covered the 0.20.3→0.21.1 minor+patch (report 93; agent/records/ 0-byte,
//     run-prompt.ts writer/resume_hint/goal.summary unchanged, #1204 plugin
//     slash commands off the `-p` path, #1233 cleanup timeout after the writer
//     flush; GREEN smoke 9/0 on the operator's 0.21.1 binary), and 2026-07-05
//     covered the 0.21.1→0.22.3 minor+patch (reports 94/95; hook engine
//     unchanged, policy order still hook-first, writer shape compatible; 0.22.3's
//     prompt-mode background-drain happens after assistant-output flush and is
//     bounded by plugin budgets; shell-output caps and session-owned
//     media-originals do not alter the NDJSON record schema; GREEN smoke 9/0 on
//     a temp-installed 0.22.3 binary), and 2026-07-07 covered the
//     0.22.3→0.23.1 minor (report 96; hook engine unchanged, policy order still
//     hook-first, PromptJsonWriter-compatible scoped `run-prompt.ts` delta only
//     adds telemetry sessionId; `select_tools` is denied by our hook unless
//     deliberately allowlisted; observability records are persisted agent-log
//     records, not new stdout NDJSON shapes; GREEN smoke 9/0 on a temp-installed
//     0.23.1 binary).
//     NB: from 0.6.0 run-prompt.ts
//     is no longer a whole-file zero-byte diff — at 0.6.0 it gained a
//     resume-session workDir guard, and at 0.8.0 it gained headless goal
//     mode (`runHeadlessGoal`) — but both changes are OUTSIDE the
//     stream-json writer, which every audit confirmed byte-identical by
//     content/blob SHA. Goal mode also writes a `{"type":"goal.summary",...}`
//     line (no `role` field) before the resume hint when the prompt is
//     `/goal`-prefixed (on 0.8–0.11 the `goal-command` experimental flag must
//     also be on; 0.12.0 removed that gate — PR #569 — so the `/goal` prefix
//     alone triggers it). Read-only commands never trigger it (their trimmed
//     prompt never starts with `/goal`); the v1.1 /kimi:pursue command is
//     the intentional consumer — it is recognized as a first-class record on
//     the dedicated `StreamJsonOutcome.goalSummary` channel (see
//     GoalSummaryRecord below), NOT routed to the malformed channel. See
//     reports 47-65, 72-76).
//     The hint is emitted once per prompt run at session END
//     (after runPromptTurn settles), not at session start. In 0.1.x the
//     resume hint went to stderr only; 0.2.0+ emits a structured
//     stream-json record on stdout when `--output-format stream-json` is
//     selected (text-output mode still writes the stderr line). Our
//     cli-client consumes the meta record's `session_id` for resume/replay
//     routing.
//   - hook.result events arrive as role:"assistant" with the block rendered as
//     plain text (see formatHookResultPlain in run-prompt.ts). Our
//     PreToolUse hook's deny reason therefore surfaces in the assistant
//     stream, not on a separate channel.
//   - thinking.delta events are silently discarded by the CLI's
//     PromptJsonWriter (`writeThinkingDelta(): void {}`).
//   - tool.progress events are written to stderr only, never entering
//     stream-json.
//   - assistant messages are only emitted when content OR tool_calls are
//     non-empty; we still defend against the empty case for resilience.
export const MAX_STREAM_JSON_LINE_BYTES = 1_048_576;
/**
 * Stateful line-buffer parser. Hold partial-line bytes across chunk boundaries.
 *
 * Lifecycle:
 *   - `push(chunk)` — consume bytes; returns outcomes for any complete lines
 *     that finished within this chunk.
 *   - `flush()` — at end of stream, force-parse the trailing buffer if any.
 *     Stream-json emits a newline after every record (run-prompt.ts:573), so
 *     a non-empty flush remainder indicates an unfinished record (likely an
 *     interrupted spawn).
 *
 * Outcomes are non-throwing — malformed lines surface via `malformedLine` /
 * `malformedReason` so callers can route them to a diagnostics log without
 * crashing the parser. Blank lines (between records, or trailing whitespace)
 * are skipped silently.
 */
export class StreamJsonParser {
    buffer = "";
    push(chunk) {
        this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const outcomes = this.drainCompleteLines();
        if (this.buffer.indexOf("\n") === -1 &&
            Buffer.byteLength(this.buffer, "utf8") > MAX_STREAM_JSON_LINE_BYTES) {
            outcomes.push({
                malformedLine: makeOversizePreview(this.buffer),
                malformedReason: `stream-json line exceeded ${MAX_STREAM_JSON_LINE_BYTES} bytes without newline`,
            });
            this.buffer = "";
        }
        return outcomes;
    }
    flush() {
        const remainder = this.buffer;
        this.buffer = "";
        if (remainder.length === 0)
            return [];
        if (remainder.replace(/\r/g, "").length === 0)
            return [];
        return [parseLine(remainder)];
    }
    drainCompleteLines() {
        const out = [];
        let newlineIndex = this.buffer.indexOf("\n");
        while (newlineIndex !== -1) {
            const line = this.buffer.slice(0, newlineIndex);
            this.buffer = this.buffer.slice(newlineIndex + 1);
            // Skip blank lines (the writer doesn't emit them, but tolerate
            // CRLF-doubled or trailing whitespace defensively).
            if (line.replace(/\r/g, "").length > 0) {
                out.push(parseLine(line));
            }
            newlineIndex = this.buffer.indexOf("\n");
        }
        return out;
    }
}
function parseLine(line) {
    const cleaned = line.endsWith("\r") ? line.slice(0, -1) : line;
    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    }
    catch (err) {
        return {
            malformedLine: line,
            malformedReason: `json parse: ${err.message}`,
        };
    }
    if (!isRecord(parsed)) {
        return { malformedLine: line, malformedReason: "not a JSON object" };
    }
    const role = parsed["role"];
    if (role === "assistant") {
        return validateAssistant(parsed, line);
    }
    if (role === "tool") {
        return validateToolResult(parsed, line);
    }
    if (role === "meta") {
        return validateMeta(parsed, line);
    }
    // Role-less goal-mode summary (kimi-code 0.8.0+). Keyed by `type`, not
    // `role`, so it's surfaced on the dedicated goalSummary outcome channel.
    if (role === undefined && parsed["type"] === "goal.summary") {
        return validateGoalSummary(parsed, line);
    }
    // H3 forward-compat: a non-empty string role we don't model (a role a future
    // kimi-code adds). Surface it out-of-band on the unknownRecord channel —
    // tolerated, not malformed — so the parser keeps working and the diagnostic
    // log distinguishes "new upstream role" from a genuinely broken line. It
    // never enters records[] (see UnknownRoleRecord + the consumer sweep).
    if (typeof role === "string" && role.length > 0) {
        return { unknownRecord: { role, raw: parsed } };
    }
    // Genuinely malformed: no `role` at all (and not a recognized role-less typed
    // record like goal.summary), or a non-string role. Surface as malformed.
    return {
        malformedLine: line,
        malformedReason: `unknown role: ${JSON.stringify(role)}`,
    };
}
function validateGoalSummary(parsed, line) {
    // Each field is `T | null` upstream (null when no goal snapshot exists). A
    // missing field is tolerated as null; a present-but-wrong-typed field is
    // malformed (so a shape change surfaces in diagnostics rather than silently
    // coercing). Mirrors the defensive posture of validateMeta.
    const asStringOrNull = (v) => v === undefined || v === null ? null : typeof v === "string" ? v : undefined;
    const asNumberOrNull = (v) => v === undefined || v === null
        ? null
        : typeof v === "number" && Number.isFinite(v)
            ? v
            : undefined;
    const goalId = asStringOrNull(parsed["goalId"]);
    const status = asStringOrNull(parsed["status"]);
    const reason = asStringOrNull(parsed["reason"]);
    const turnsUsed = asNumberOrNull(parsed["turnsUsed"]);
    const tokensUsed = asNumberOrNull(parsed["tokensUsed"]);
    const wallClockMs = asNumberOrNull(parsed["wallClockMs"]);
    if (goalId === undefined ||
        status === undefined ||
        reason === undefined ||
        turnsUsed === undefined ||
        tokensUsed === undefined ||
        wallClockMs === undefined) {
        return { malformedLine: line, malformedReason: "goal.summary field has unexpected type" };
    }
    const goalSummary = {
        type: "goal.summary",
        goalId,
        status,
        reason,
        turnsUsed,
        tokensUsed,
        wallClockMs,
    };
    return { goalSummary };
}
function validateMeta(parsed, line) {
    const type = parsed["type"];
    if (type === "session.resume_hint") {
        const sessionId = parsed["session_id"];
        if (typeof sessionId !== "string" || sessionId.length === 0) {
            return {
                malformedLine: line,
                malformedReason: "meta.session.resume_hint.session_id not non-empty string",
            };
        }
        const record = {
            role: "meta",
            type: "session.resume_hint",
            sessionId,
        };
        return { record };
    }
    // Unknown meta types are forward-compatible — surface them via the
    // malformed channel for diagnostics, but don't crash. kimi-code may add
    // new meta types in 0.3.x and our wrapper should keep working.
    return {
        malformedLine: line,
        malformedReason: `unknown meta.type: ${JSON.stringify(type)}`,
    };
}
function validateAssistant(parsed, line) {
    const content = parsed["content"];
    if (content !== undefined && typeof content !== "string") {
        return { malformedLine: line, malformedReason: "assistant.content not string" };
    }
    const toolCallsRaw = parsed["tool_calls"];
    let toolCalls;
    if (toolCallsRaw !== undefined) {
        if (!Array.isArray(toolCallsRaw)) {
            return { malformedLine: line, malformedReason: "assistant.tool_calls not array" };
        }
        toolCalls = [];
        for (const candidate of toolCallsRaw) {
            const validated = validateToolCall(candidate);
            if (validated === undefined) {
                return {
                    malformedLine: line,
                    malformedReason: "assistant.tool_calls entry invalid",
                };
            }
            toolCalls.push(validated);
        }
    }
    if (content === undefined && (toolCalls === undefined || toolCalls.length === 0)) {
        return {
            malformedLine: line,
            malformedReason: "assistant has neither content nor tool_calls",
        };
    }
    const record = {
        role: "assistant",
        ...(content !== undefined && { content }),
        ...(toolCalls !== undefined && { tool_calls: toolCalls }),
    };
    return { record };
}
function validateToolCall(candidate) {
    if (!isRecord(candidate))
        return undefined;
    if (candidate["type"] !== "function")
        return undefined;
    const id = candidate["id"];
    if (typeof id !== "string" || id.length === 0)
        return undefined;
    const fn = candidate["function"];
    if (!isRecord(fn))
        return undefined;
    const name = fn["name"];
    const args = fn["arguments"];
    if (typeof name !== "string" || typeof args !== "string")
        return undefined;
    return { type: "function", id, function: { name, arguments: args } };
}
function validateToolResult(parsed, line) {
    const toolCallId = parsed["tool_call_id"];
    if (typeof toolCallId !== "string" || toolCallId.length === 0) {
        return {
            malformedLine: line,
            malformedReason: "tool.tool_call_id not non-empty string",
        };
    }
    const content = parsed["content"];
    if (typeof content !== "string") {
        return { malformedLine: line, malformedReason: "tool.content not string" };
    }
    const record = {
        role: "tool",
        tool_call_id: toolCallId,
        content,
    };
    return { record };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Match kimi-code's stderr session announce line. In stream-json mode this
 * is a 0.1.x compatibility fallback only — kimi 0.2.0+ emits the resume
 * hint as a `role: meta, type: session.resume_hint` record on stdout (see
 * SessionResumeHintRecord above and apps/kimi-code/src/cli/run-prompt.ts).
 *
 * The pattern accepts both 0.1.x bare-UUID format and 0.2.0+ `session_<uuid>`
 * format so the fallback survives mixed-version environments. The captured
 * token is whatever appears after `kimi -r ` — we treat it as an opaque
 * session identifier and round-trip it verbatim via `kimi -r <token>`.
 *
 * Returns the captured session id, or undefined if no match.
 */
export function extractSessionIdFromStderr(stderr) {
    // The accepted shapes are tightly anchored — both alternations require
    // a full UUID payload. The `session_` prefix is the 0.2.0+ form; the
    // bare UUID is the 0.1.x form. Without the anchoring, a malformed or
    // hostile stderr line could pin `session_--------` (8 dashes) or any
    // 8+ char hex-dash token as the captured session id, weakening the
    // "anchored full-UUID regex" safety invariant documented in AGENTS.md.
    // Review-smoke (kimi 0.2.0 on the alpha.5 candidate) flagged the loose
    // form; this is the post-review tightening.
    const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    const pattern = new RegExp(`^To resume this session:\\s+kimi\\s+-r\\s+(session_${uuid}|${uuid})\\s*$`, "im");
    return stderr.match(pattern)?.[1];
}
function makeOversizePreview(line) {
    return `${line.slice(0, 200)}[truncated]`;
}
