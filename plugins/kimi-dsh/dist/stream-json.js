// Stream-JSON parser for `kimi -p --output-format stream-json`.
//
// Canonical record shapes (verified against kimi-code source at
// apps/kimi-code/src/cli/prompt-render.ts — `PromptJsonWriter` emits one JSON
// object per line via `JSON.stringify(message) + '\n'`):
//
//   {"role":"assistant","content":"..."}
//   {"role":"assistant","content":"...","tool_calls":[{type,id,function:{name,arguments}}]}
//   {"role":"assistant","tool_calls":[...]}
//   {"role":"tool","tool_call_id":"...","content":"..."}
//   {"role":"meta","type":"session.resume_hint","session_id":"session_<uuid>","command":"kimi -r session_<uuid>","content":"To resume this session: kimi -r session_<uuid>"}
//   {"role":"meta","type":"turn.step.retrying","failed_attempt":1,"next_attempt":2,"max_attempts":3,"delay_ms":300,"error_name":"APIProviderRateLimitError","error_message":"...","status_code":429}
//   {"role":"meta","type":"system.version","version":"0.24.2"} // native-v2 marker; required first on native-v2 plans and filtered after capture
//
//   {"type":"error","code":"session.occupied","message":"...","details":{...}} // 2.3.0; stdout-only refusal, exit 4
//
// Notes on what does and does not appear here:
//   - session.resume_hint is emitted once at session end. Legacy 0.1.x sent
//     the resume hint to stderr; stream-json uses this stdout meta record.
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
 *   - `flush()` — at end of stream, parse a valid trailing JSON record even
 *     without a final newline; malformed trailing input becomes diagnostic.
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
    if (role === undefined && parsed["type"] === "goal.summary") {
        return validateGoalSummary(parsed, line);
    }
    if (role === undefined && parsed["type"] === "error") {
        if (typeof parsed["code"] !== "string" || parsed["code"].length === 0 ||
            typeof parsed["message"] !== "string" || parsed["message"].length === 0 ||
            (parsed["details"] !== undefined && !isRecord(parsed["details"]))) {
            return { malformedLine: line, malformedReason: "error record field has unexpected type" };
        }
        // Keep bounded diagnostic fields only; holder metadata is not needed and
        // must not become a session-id source or be copied into persisted errors.
        return { cliError: {
                type: "error",
                code: parsed["code"].slice(0, 200),
                message: parsed["message"].slice(0, 4000),
            } };
    }
    if (typeof role === "string" && role.length > 0) {
        return { unknownRecord: { role, raw: parsed } };
    }
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
    if (type === "turn.step.retrying") {
        const failedAttempt = parsed["failed_attempt"];
        const nextAttempt = parsed["next_attempt"];
        const maxAttempts = parsed["max_attempts"];
        const delayMs = parsed["delay_ms"];
        const errorName = parsed["error_name"];
        const errorMessage = parsed["error_message"];
        const statusCode = parsed["status_code"];
        if (typeof failedAttempt !== "number" ||
            !Number.isFinite(failedAttempt) ||
            typeof nextAttempt !== "number" ||
            !Number.isFinite(nextAttempt) ||
            typeof maxAttempts !== "number" ||
            !Number.isFinite(maxAttempts) ||
            typeof delayMs !== "number" ||
            !Number.isFinite(delayMs) ||
            typeof errorName !== "string" ||
            typeof errorMessage !== "string" ||
            (statusCode !== undefined &&
                (typeof statusCode !== "number" || !Number.isFinite(statusCode)))) {
            return {
                malformedLine: line,
                malformedReason: "meta.turn.step.retrying field has unexpected type",
            };
        }
        const record = {
            role: "meta",
            type: "turn.step.retrying",
            failedAttempt,
            nextAttempt,
            maxAttempts,
            delayMs,
            errorName,
            errorMessage,
            ...(typeof statusCode === "number" && { statusCode }),
        };
        return { record };
    }
    if (type === "system.version") {
        const version = parsed["version"];
        if (typeof version !== "string" || version.length === 0) {
            return {
                malformedLine: line,
                malformedReason: "meta.system.version.version not non-empty string",
            };
        }
        const record = {
            role: "meta",
            type: "system.version",
            version,
        };
        return { record };
    }
    // Unknown meta types are diagnostic-only and nonfatal.
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
    const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    const pattern = new RegExp(`^To resume this session:\\s+kimi\\s+-r\\s+(session_${uuid}|${uuid})\\s*$`, "im");
    return stderr.match(pattern)?.[1];
}
function makeOversizePreview(line) {
    return `${line.slice(0, 200)}[truncated]`;
}
