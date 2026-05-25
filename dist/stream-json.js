// Stream-JSON parser for `kimi -p --output-format stream-json`.
//
// Canonical record shapes (verified against kimi-code source at
// apps/kimi-code/src/cli/run-prompt.ts:456-475 — `PromptJsonWriter` emits one
// JSON object per line via `JSON.stringify(message) + '\n'`):
//
//   {"role":"assistant","content":"..."}
//   {"role":"assistant","content":"...","tool_calls":[{type,id,function:{name,arguments}}]}
//   {"role":"assistant","tool_calls":[...]}
//   {"role":"tool","tool_call_id":"...","content":"..."}
//
// Notes on what does and does not appear here:
//   - hook.result events arrive as role:"assistant" with the block rendered as
//     plain text (see formatHookResultPlain in run-prompt.ts:641). Our
//     PreToolUse hook's deny reason therefore surfaces in the assistant
//     stream, not on a separate channel.
//   - thinking.delta events are silently discarded by the CLI's
//     PromptJsonWriter (line 495: `writeThinkingDelta(): void {}`).
//   - tool.progress events are written to stderr only (run-prompt.ts:358-364),
//     never entering stream-json.
//   - assistant messages are only emitted when content OR tool_calls are
//     non-empty (run-prompt.ts:537-545); we still defend against the empty
//     case for resilience.
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
    return {
        malformedLine: line,
        malformedReason: `unknown role: ${JSON.stringify(role)}`,
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
 * Match kimi-code's stderr session announce line (run-prompt.ts:137):
 *   `To resume this session: kimi -r <uuid>\n`
 * Returns the captured session id, or undefined if no match.
 */
export function extractSessionIdFromStderr(stderr) {
    const pattern = /^To resume this session:\s+kimi\s+-r\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/im;
    return stderr.match(pattern)?.[1];
}
function makeOversizePreview(line) {
    return `${line.slice(0, 200)}[truncated]`;
}
