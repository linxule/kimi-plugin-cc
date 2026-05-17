// Wire protocol version advertised to kimi-cli on the `initialize` handshake. Bumped to
// "1.10" alongside the StepRetry event kimi-cli 1.42.0 added. Centralized so every
// command-side initialize call agrees on a single value.
export const KIMI_WIRE_PROTOCOL_VERSION = "1.10";

export interface InitializeParams {
  protocol_version: string;
  client?: {
    name: string;
    version?: string;
  };
  capabilities?: {
    supports_question?: boolean;
    supports_plan_mode?: boolean;
  };
}

export interface InitializeResult {
  protocol_version: string;
  server: {
    name: string;
    version: string;
  };
  capabilities?: {
    supports_question?: boolean;
  };
}

export interface PromptResult {
  status: "finished" | "cancelled" | "max_steps_reached";
  steps?: number;
}

export interface CancelResult extends Record<string, never> {}

export interface ApprovalRequestPayload {
  id: string;
  tool_call_id?: string | null;
  sender: string;
  action: string;
  description: string;
  display: unknown[];
  source_kind?: string | null;
  source_id?: string | null;
  agent_id?: string | null;
  subagent_type?: string | null;
  source_description?: string | null;
}

export interface ApprovalDecision {
  response: "approve" | "approve_for_session" | "reject";
  feedback?: string;
}

export interface WireNotification {
  jsonrpc: "2.0";
  method: "event";
  params: {
    type: string;
    payload: Record<string, unknown>;
  };
}

export interface WireRequest {
  jsonrpc: "2.0";
  method: "request";
  id: string;
  params: {
    type: "ApprovalRequest" | "ToolCallRequest" | "QuestionRequest" | "HookRequest";
    payload: Record<string, unknown>;
  };
}

export type IncomingWireMessage = WireNotification | WireRequest;

/**
 * Returns true if the event is a reasoning-only `ContentPart` (i.e.
 * `params.type === "ContentPart"` carrying `payload.type === "think"`).
 *
 * Lives next to the wire types because the predicate is determined by
 * the wire schema, not by any downstream consumer: if kimi-cli adds a
 * new reasoning subtype, the update belongs here in lockstep with the
 * `WireNotification` shape, not in a downstream watchdog. Every other
 * event type (StepBegin, StepRetry, text ContentPart, ToolCall,
 * ToolResult, StatusUpdate, TurnEnd, ...) is "forward progress" from
 * the watchdog's perspective and should return false.
 *
 * Used by `ThinkStallGuard.observeEvent` to route think-only payloads
 * to the duplicate-hash window and everything else to the
 * forward-progress reset path.
 */
export function isThinkOnlyEvent(type: string, payload: Record<string, unknown>): boolean {
  if (type !== "ContentPart") {
    return false;
  }
  return payload.type === "think";
}

// Emitted by kimi-cli when a step's LLM call fails with a retryable error and tenacity is
// about to sleep before re-running the attempt. The retried step reuses the same step
// number, so any text streamed before the retry must be discarded.
export interface StepRetryPayload {
  n: number;
  next_attempt: number;
  max_attempts: number;
  wait_s: number;
  error_type: string;
  status_code?: number | null;
}

export interface StepCapture {
  step: number;
  textParts: string[];
}

export interface CompletedTurn {
  finalText: string;
  steps: StepCapture[];
  promptResult: PromptResult;
}
