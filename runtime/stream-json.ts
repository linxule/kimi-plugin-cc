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
//   - tool.updated output/status events are written to stderr only, never
//     entering stream-json.
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
 * Meta record announcing the session id for resume at session end.
 * Legacy 0.1.x used stderr; stream-json uses this stdout record.
 *
 * Session ids are opaque tokens: store them verbatim and pass them back via
 * `kimi -r <token>`; never assume a bare UUID.
 */
export interface SessionResumeHintRecord {
  readonly role: "meta";
  readonly type: "session.resume_hint";
  readonly sessionId: string;
}

/**
 * Provider-retry metadata emitted by kimi-code 0.23.5+ in stream-json mode.
 * It is wrapper metadata rather than assistant/tool output, so cli-client
 * filters it through the same meta-record boundary as session.resume_hint.
 *
 * Source: apps/kimi-code/src/cli/run-prompt.ts::PromptJsonWriter.writeRetrying
 * at @moonshot-ai/kimi-code@0.23.5. Wire fields are snake_case; the parser
 * normalizes them to the runtime's camelCase convention.
 */
export interface TurnStepRetryingRecord {
  readonly role: "meta";
  readonly type: "turn.step.retrying";
  readonly failedAttempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

/**
 * Native agent-core-v2 version marker, emitted once before assistant/tool output.
 * Native-v2 plans require it as the first stream-json record and require its
 * version to equal the probed certified version; legacy-v1 plans refuse it.
 * It is captured out-of-band and filtered from consumer records.
 */
export interface SystemVersionRecord {
  readonly role: "meta";
  readonly type: "system.version";
  readonly version: string;
}

export type StreamJsonRecord =
  | AssistantRecord
  | ToolResultRecord
  | SessionResumeHintRecord
  | TurnStepRetryingRecord
  | SystemVersionRecord;

/**
 * Goal-summary record emitted by kimi-code 0.8.0+ headless goal mode
 * (`kimi -p "/goal -- <objective>"`) at the END of a goal run, immediately before
 * the session.resume_hint. Unlike assistant/tool/meta records it carries NO
 * `role` field — it is keyed by `type: "goal.summary"`.
 *
 * It is OUT-OF-BAND metadata for our wrapper (the /kimi:pursue job store
 * consumes turns/tokens/wallClock/status), not consumer-facing prose. To keep
 * the role-keyed `StreamJsonRecord` union — and its `.role` consumers
 * (reassembleProseFromRecords, onRecord callbacks) — untouched, it is surfaced
 * on a dedicated `StreamJsonOutcome.goalSummary` channel rather than via the
 * record union. cli-client captures the first one and filters it, mirroring how
 * the resume-hint meta record is captured out-of-band.
 *
 * The `/goal` prefix triggers the record. Releases 0.8–0.11 additionally require
 * the `goal-command` experimental flag; 0.12+ do not. All fields are nullable
 * upstream (null when no goal snapshot exists).
 *
 * Source: apps/kimi-code/src/cli/goal-prompt.ts::goalSummaryJson (GoalSummary),
 * verified at @moonshot-ai/kimi-code@0.9.0.
 */
export interface GoalSummaryRecord {
  readonly type: "goal.summary";
  readonly goalId: string | null;
  readonly status: string | null;
  readonly reason: string | null;
  readonly turnsUsed: number | null;
  readonly tokensUsed: number | null;
  readonly wallClockMs: number | null;
}

/**
 * An object line with an unmodeled string role. Unknown roles are forward-
 * compatible diagnostics, not malformed output, and stay out of records[] so
 * role-keyed prose consumers remain stable. The raw object is preserved.
 */
export interface UnknownRoleRecord {
  readonly role: string;
  readonly raw: Record<string, unknown>;
}

/** Role-less print-mode refusal (2.3.0); not model prose or session lineage. */
export interface CliErrorRecord {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
}

export interface StreamJsonOutcome {
  readonly cliError?: CliErrorRecord;
  readonly record?: StreamJsonRecord;
  /** Out-of-band goal-mode summary (role-less); see GoalSummaryRecord. */
  readonly goalSummary?: GoalSummaryRecord;
  /** Out-of-band unknown-role record (H3 forward-compat); see UnknownRoleRecord. */
  readonly unknownRecord?: UnknownRoleRecord;
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
 *   - `flush()` — at end of stream, parse a valid trailing JSON record even
 *     without a final newline; malformed trailing input becomes diagnostic.
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
  if (role === undefined && parsed["type"] === "goal.summary") {
    return validateGoalSummary(parsed, line);
  }
  if (role === undefined && parsed["type"] === "error") {
    if (
      typeof parsed["code"] !== "string" || parsed["code"].length === 0 ||
      typeof parsed["message"] !== "string" || parsed["message"].length === 0 ||
      (parsed["details"] !== undefined && !isRecord(parsed["details"]))
    ) {
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

function validateGoalSummary(parsed: Record<string, unknown>, line: string): StreamJsonOutcome {
  // Each field is `T | null` upstream (null when no goal snapshot exists). A
  // missing field is tolerated as null; a present-but-wrong-typed field is
  // malformed (so a shape change surfaces in diagnostics rather than silently
  // coercing). Mirrors the defensive posture of validateMeta.
  const asStringOrNull = (v: unknown): string | null | undefined =>
    v === undefined || v === null ? null : typeof v === "string" ? v : undefined;
  const asNumberOrNull = (v: unknown): number | null | undefined =>
    v === undefined || v === null
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

  if (
    goalId === undefined ||
    status === undefined ||
    reason === undefined ||
    turnsUsed === undefined ||
    tokensUsed === undefined ||
    wallClockMs === undefined
  ) {
    return { malformedLine: line, malformedReason: "goal.summary field has unexpected type" };
  }

  const goalSummary: GoalSummaryRecord = {
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
  if (type === "turn.step.retrying") {
    const failedAttempt = parsed["failed_attempt"];
    const nextAttempt = parsed["next_attempt"];
    const maxAttempts = parsed["max_attempts"];
    const delayMs = parsed["delay_ms"];
    const errorName = parsed["error_name"];
    const errorMessage = parsed["error_message"];
    const statusCode = parsed["status_code"];
    if (
      typeof failedAttempt !== "number" ||
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
        (typeof statusCode !== "number" || !Number.isFinite(statusCode)))
    ) {
      return {
        malformedLine: line,
        malformedReason: "meta.turn.step.retrying field has unexpected type",
      };
    }
    const record: TurnStepRetryingRecord = {
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
    const record: SystemVersionRecord = {
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
