import type { RuntimeCommandType } from "../types.js";
import type { ApprovalDecision, ApprovalRequestPayload } from "./types.js";

export interface ApprovalDispatchContext {
  commandType: RuntimeCommandType;
}

export type ApprovalPolicy = (
  request: ApprovalRequestPayload,
  context: ApprovalDispatchContext,
) => Promise<ApprovalDecision> | ApprovalDecision;

export class ApprovalDispatcher {
  constructor(private readonly policy: ApprovalPolicy) {}

  async handle(
    request: ApprovalRequestPayload,
    context: ApprovalDispatchContext,
  ): Promise<ApprovalDecision> {
    return this.policy(request, context);
  }
}

export function rejectAllApprovals(feedback: string): ApprovalPolicy {
  return async () => ({
    response: "reject",
    feedback,
  });
}
