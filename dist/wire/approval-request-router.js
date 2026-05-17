import { RuntimeError, formatError } from "../errors.js";
/**
 * ApprovalRequestRouter handles the approval-dispatch slice of the Wire
 * protocol: validating the payload, querying the ApprovalDispatcher, and
 * writing the JSON-RPC response back to the child process.
 *
 * WireClient delegates here from handleLine → handleWireRequest so the
 * transport class stays closer to "JSON-RPC framing + child process holding".
 *
 * State that spans the full prompt lifecycle (approvalFailure, rejectApprovals,
 * currentCommandType) remains on WireClient — the router reads live values
 * via ApprovalRouterContext getters and writes outcomes back via the returned
 * ApprovalRouteResult.
 */
export class ApprovalRequestRouter {
    approvalDispatcher;
    constructor(approvalDispatcher) {
        this.approvalDispatcher = approvalDispatcher;
    }
    /**
     * Handle a single inbound Wire request message. Returns an ApprovalRouteResult
     * whose `failure` field is non-null when the approval was rejected, the payload
     * was malformed, or the dispatcher threw.
     *
     * The caller (WireClient) is responsible for:
     *  - Checking whether `this.child` is still alive before calling
     *  - Recording result.failure on `this.approvalFailure`
     */
    async route(message, context, writeResponse) {
        try {
            const failure = await this.dispatch(message, context, writeResponse);
            return { failure };
        }
        catch (error) {
            const failure = error instanceof RuntimeError
                ? error
                : new RuntimeError("APPROVAL_DISPATCHER_FAILED", `Approval dispatcher threw: ${formatError(error)}`, "wire.approval", error instanceof Error ? { cause: error } : undefined);
            const errorResponse = {
                jsonrpc: "2.0",
                id: message.id,
                error: {
                    code: -32603,
                    message: failure.message,
                },
            };
            try {
                await writeResponse(errorResponse);
            }
            catch {
                // stdin may be closed during cancellation; ignore write failures here.
            }
            return { failure };
        }
    }
    /**
     * Inner dispatch — throws on payload errors or unexpected dispatcher failures.
     * Returns a RuntimeError when the approval is rejected (so prompt() can surface
     * it), null when it was approved.
     */
    async dispatch(message, context, writeResponse) {
        if (message.params.type !== "ApprovalRequest") {
            const errorFrame = {
                jsonrpc: "2.0",
                id: message.id,
                error: {
                    code: -32601,
                    message: `${message.params.type} is not supported by the plugin runtime.`,
                },
            };
            await writeResponse(errorFrame);
            return null;
        }
        if (!context.getCurrentCommandType()) {
            throw new RuntimeError("WIRE_PROTOCOL_ERROR", "Received an ApprovalRequest outside an active command turn.", "wire.approval");
        }
        const payload = parseApprovalRequestPayload(message.params.payload);
        // Fast-reject path: cancellation is already in progress.
        const cancelDecision = context.getRejectApprovals()
            ? { response: "reject", feedback: "Command cancellation is in progress." }
            : await this.approvalDispatcher.handle(payload, {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                commandType: context.getCurrentCommandType(),
            });
        // Second reject guard: rejectApprovals may have flipped mid-await
        // (e.g. beginCancellation() called while dispatcher was awaiting the policy).
        const finalDecision = context.getRejectApprovals() && cancelDecision.response !== "reject"
            ? { response: "reject", feedback: "Command cancellation is in progress." }
            : cancelDecision;
        const response = {
            jsonrpc: "2.0",
            id: message.id,
            result: {
                request_id: payload.id,
                response: finalDecision.response,
                ...(finalDecision.feedback ? { feedback: finalDecision.feedback } : {}),
            },
        };
        await writeResponse(response);
        if (finalDecision.response === "reject") {
            return new RuntimeError("APPROVAL_REJECTED", finalDecision.feedback ?? `Approval rejected for ${payload.action}.`, "wire.approval");
        }
        return null;
    }
}
export function parseApprovalRequestPayload(payload) {
    if (typeof payload.id !== "string" ||
        typeof payload.sender !== "string" ||
        typeof payload.action !== "string" ||
        typeof payload.description !== "string" ||
        !Array.isArray(payload.display)) {
        throw new RuntimeError("WIRE_PROTOCOL_ERROR", "Received an ApprovalRequest with an invalid payload shape.", "wire.approval");
    }
    return payload;
}
