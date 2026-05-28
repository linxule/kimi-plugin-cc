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
//     (apps/kimi-code/src/cli/run-prompt.ts:477-505; verified byte-identical
//     through 0.5.0 — 2026-05-27 audit covered 0.4.0, 2026-05-28 audit
//     covered 0.5.0; run-prompt.ts has a zero-byte diff across both
//     intervals). The hint is emitted once per prompt run at session END
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

export interface ToolCall {
  readonly type: "function";
  readonly id: string;
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export interface AssistantRecord {
  readonly role: "assistant";
  readonly content?: string;
  readonly tool_calls?: ToolCall[];
}

export interface ToolResultRecord {
  readonly role: "tool";
  readonly tool_call_id: string;
  readonly content: string;
}

/**
 * Meta record emitted by kimi-code 0.2.0+ in stream-json mode to announce
 * the session id for resume/replay. In 0.1.x the same information went
 * to stderr as a plain "To resume this session: kimi -r <uuid>" line; the
 * stream-json move makes the announcement reliably parseable even when
 * stderr is captured at coarse granularity or muted by the caller.
 *
 * Source: apps/kimi-code/src/cli/run-prompt.ts::writeResumeHint.
 *
 * The session_id payload uses kimi-code 0.2.0's `session_<uuid>` token
 * shape; do NOT assume bare-UUID. The cli-client stores it verbatim and
 * passes it back via `kimi -r <token>` for resume.
 */
export interface SessionResumeHintRecord {
  readonly role: "meta";
  readonly type: "session.resume_hint";
  readonly sessionId: string;
}

export type StreamJsonRecord = AssistantRecord | ToolResultRecord | SessionResumeHintRecord;

export interface StreamJsonOutcome {
  readonly record?: StreamJsonRecord;
  readonly malformedLine?: string;
  readonly malformedReason?: string;
}

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
  private buffer = "";

  push(chunk: string | Buffer): StreamJsonOutcome[] {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const outcomes = this.drainCompleteLines();
    if (
      this.buffer.indexOf("\n") === -1 &&
      Buffer.byteLength(this.buffer, "utf8") > MAX_STREAM_JSON_LINE_BYTES
    ) {
      outcomes.push({
        malformedLine: makeOversizePreview(this.buffer),
        malformedReason: `stream-json line exceeded ${MAX_STREAM_JSON_LINE_BYTES} bytes without newline`,
      });
      this.buffer = "";
    }
    return outcomes;
  }

  flush(): StreamJsonOutcome[] {
    const remainder = this.buffer;
    this.buffer = "";
    if (remainder.length === 0) return [];
    if (remainder.replace(/\r/g, "").length === 0) return [];
    return [parseLine(remainder)];
  }

  private drainCompleteLines(): StreamJsonOutcome[] {
    const out: StreamJsonOutcome[] = [];
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

function parseLine(line: string): StreamJsonOutcome {
  const cleaned = line.endsWith("\r") ? line.slice(0, -1) : line;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return {
      malformedLine: line,
      malformedReason: `json parse: ${(err as Error).message}`,
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
  return {
    malformedLine: line,
    malformedReason: `unknown role: ${JSON.stringify(role)}`,
  };
}

function validateMeta(parsed: Record<string, unknown>, line: string): StreamJsonOutcome {
  const type = parsed["type"];
  if (type === "session.resume_hint") {
    const sessionId = parsed["session_id"];
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return {
        malformedLine: line,
        malformedReason: "meta.session.resume_hint.session_id not non-empty string",
      };
    }
    const record: SessionResumeHintRecord = {
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

function validateAssistant(parsed: Record<string, unknown>, line: string): StreamJsonOutcome {
  const content = parsed["content"];
  if (content !== undefined && typeof content !== "string") {
    return { malformedLine: line, malformedReason: "assistant.content not string" };
  }
  const toolCallsRaw = parsed["tool_calls"];
  let toolCalls: ToolCall[] | undefined;
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
  const record: AssistantRecord = {
    role: "assistant",
    ...(content !== undefined && { content }),
    ...(toolCalls !== undefined && { tool_calls: toolCalls }),
  };
  return { record };
}

function validateToolCall(candidate: unknown): ToolCall | undefined {
  if (!isRecord(candidate)) return undefined;
  if (candidate["type"] !== "function") return undefined;
  const id = candidate["id"];
  if (typeof id !== "string" || id.length === 0) return undefined;
  const fn = candidate["function"];
  if (!isRecord(fn)) return undefined;
  const name = fn["name"];
  const args = fn["arguments"];
  if (typeof name !== "string" || typeof args !== "string") return undefined;
  return { type: "function", id, function: { name, arguments: args } };
}

function validateToolResult(parsed: Record<string, unknown>, line: string): StreamJsonOutcome {
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
  const record: ToolResultRecord = {
    role: "tool",
    tool_call_id: toolCallId,
    content,
  };
  return { record };
}

function isRecord(value: unknown): value is Record<string, unknown> {
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
export function extractSessionIdFromStderr(stderr: string): string | undefined {
  // The accepted shapes are tightly anchored — both alternations require
  // a full UUID payload. The `session_` prefix is the 0.2.0+ form; the
  // bare UUID is the 0.1.x form. Without the anchoring, a malformed or
  // hostile stderr line could pin `session_--------` (8 dashes) or any
  // 8+ char hex-dash token as the captured session id, weakening the
  // "anchored full-UUID regex" safety invariant documented in AGENTS.md.
  // Review-smoke (kimi 0.2.0 on the alpha.5 candidate) flagged the loose
  // form; this is the post-review tightening.
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const pattern = new RegExp(
    `^To resume this session:\\s+kimi\\s+-r\\s+(session_${uuid}|${uuid})\\s*$`,
    "im",
  );
  return stderr.match(pattern)?.[1];
}

function makeOversizePreview(line: string): string {
  return `${line.slice(0, 200)}[truncated]`;
}
