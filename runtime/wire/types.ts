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

export interface StepCapture {
  step: number;
  textParts: string[];
}

export interface CompletedTurn {
  finalText: string;
  steps: StepCapture[];
  promptResult: PromptResult;
}
