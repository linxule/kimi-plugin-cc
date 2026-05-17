import { describe, expect, test } from "bun:test";

import { RuntimeError } from "../../runtime/errors.js";
import { ApprovalDispatcher, rejectAllApprovals } from "../../runtime/wire/approval-dispatcher.js";
import {
  ApprovalRequestRouter,
  parseApprovalRequestPayload,
} from "../../runtime/wire/approval-request-router.js";
import type { ApprovalRouterContext } from "../../runtime/wire/approval-request-router.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(
  type: string,
  payload: Record<string, unknown>,
  id = "req-1",
) {
  return { id, params: { type, payload } };
}

const validApprovalPayload: Record<string, unknown> = {
  id: "ap-1",
  sender: "kimi-agent",
  action: "run shell command",
  description: "ls /tmp",
  display: [{ label: "command", value: "ls /tmp" }],
};

function makeContext(overrides?: {
  currentCommandType?: import("../../runtime/types.js").RuntimeCommandType | undefined;
  rejectApprovals?: boolean;
}): ApprovalRouterContext {
  const commandType = overrides && "currentCommandType" in overrides ? overrides.currentCommandType : "rescue";
  const rejectApprovals = overrides?.rejectApprovals ?? false;
  return {
    getCurrentCommandType: () => commandType,
    getRejectApprovals: () => rejectApprovals,
  };
}

type Frame = object;

function makeWriteFn(frames: Frame[]) {
  return async (frame: Frame) => {
    frames.push(frame);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ApprovalRequestRouter", () => {
  test("routes a valid ApprovalRequest through the dispatcher and writes a result frame", async () => {
    const approved: string[] = [];
    const dispatcher = new ApprovalDispatcher(async (req, ctx) => {
      approved.push(`${ctx.commandType}:${req.action}`);
      return { response: "approve" };
    });

    const router = new ApprovalRequestRouter(dispatcher);
    const written: Frame[] = [];
    const msg = makeMessage("ApprovalRequest", validApprovalPayload);

    const result = await router.route(msg, makeContext(), makeWriteFn(written));

    expect(result.failure).toBeNull();
    expect(approved).toEqual(["rescue:run shell command"]);
    expect(written).toHaveLength(1);
    const frame = written[0] as { result: { response: string; request_id: string } };
    expect(frame.result.response).toBe("approve");
    expect(frame.result.request_id).toBe("ap-1");
  });

  test("returns a RuntimeError (APPROVAL_REJECTED) and writes a reject result when dispatcher rejects", async () => {
    const dispatcher = new ApprovalDispatcher(
      rejectAllApprovals("not allowed in test"),
    );

    const router = new ApprovalRequestRouter(dispatcher);
    const written: Frame[] = [];
    const msg = makeMessage("ApprovalRequest", validApprovalPayload);

    const result = await router.route(msg, makeContext(), makeWriteFn(written));

    expect(result.failure).toBeInstanceOf(RuntimeError);
    expect((result.failure as RuntimeError).code).toBe("APPROVAL_REJECTED");
    expect((result.failure as RuntimeError).message).toContain("not allowed in test");
    const frame = written[0] as { result: { response: string } };
    expect(frame.result.response).toBe("reject");
  });

  test("short-circuits to reject without calling the dispatcher when rejectApprovals=true", async () => {
    let dispatcherCalled = false;
    const dispatcher = new ApprovalDispatcher(async () => {
      dispatcherCalled = true;
      return { response: "approve" };
    });

    const router = new ApprovalRequestRouter(dispatcher);
    const written: Frame[] = [];
    const msg = makeMessage("ApprovalRequest", validApprovalPayload);

    const result = await router.route(
      msg,
      makeContext({ rejectApprovals: true }),
      makeWriteFn(written),
    );

    expect(dispatcherCalled).toBe(false);
    expect(result.failure).toBeInstanceOf(RuntimeError);
    expect((result.failure as RuntimeError).code).toBe("APPROVAL_REJECTED");
    const frame = written[0] as { result: { response: string } };
    expect(frame.result.response).toBe("reject");
  });

  test("wraps a dispatcher throw in APPROVAL_DISPATCHER_FAILED and writes a JSON-RPC error frame", async () => {
    const dispatcher = new ApprovalDispatcher(async () => {
      throw new Error("policy engine exploded");
    });

    const router = new ApprovalRequestRouter(dispatcher);
    const written: Frame[] = [];
    const msg = makeMessage("ApprovalRequest", validApprovalPayload);

    const result = await router.route(msg, makeContext(), makeWriteFn(written));

    expect(result.failure).toBeInstanceOf(RuntimeError);
    expect((result.failure as RuntimeError).code).toBe("APPROVAL_DISPATCHER_FAILED");
    expect((result.failure as RuntimeError).message).toContain("policy engine exploded");
    // The error response sent back to the peer must be a JSON-RPC error frame.
    const frame = written[0] as { error: { code: number } };
    expect(frame.error.code).toBe(-32603);
  });

  test("rejects unsupported request types with -32601 and returns null failure", async () => {
    const dispatcher = new ApprovalDispatcher(
      rejectAllApprovals("should not be called"),
    );
    const router = new ApprovalRequestRouter(dispatcher);
    const written: Frame[] = [];
    const msg = makeMessage("ToolCallRequest", { some: "payload" });

    const result = await router.route(msg, makeContext(), makeWriteFn(written));

    expect(result.failure).toBeNull();
    const frame = written[0] as { error: { code: number; message: string } };
    expect(frame.error.code).toBe(-32601);
    expect(frame.error.message).toContain("ToolCallRequest");
  });

  test("raises WIRE_PROTOCOL_ERROR when ApprovalRequest arrives outside an active turn", async () => {
    const dispatcher = new ApprovalDispatcher(async () => ({ response: "approve" }));
    const router = new ApprovalRequestRouter(dispatcher);
    const written: Frame[] = [];
    const msg = makeMessage("ApprovalRequest", validApprovalPayload);

    const result = await router.route(
      msg,
      makeContext({ currentCommandType: undefined }),
      makeWriteFn(written),
    );

    expect(result.failure).toBeInstanceOf(RuntimeError);
    expect((result.failure as RuntimeError).code).toBe("WIRE_PROTOCOL_ERROR");
    // A JSON-RPC error frame must still be written so the peer is unblocked.
    const frame = written[0] as { error: { code: number } };
    expect(frame.error.code).toBe(-32603);
  });

  test("reads rejectApprovals live via getter — sees mid-await flip", async () => {
    // Validates that the getter pattern (not a value snapshot) is used.
    // We construct a context where the getter changes its return value
    // after the dispatcher has been invoked, simulating beginCancellation()
    // firing mid-await.
    let rejectApprovals = false;
    let dispatcherReturned = false;

    const dispatcher = new ApprovalDispatcher(async () => {
      // Flip the flag while the dispatcher is "running" (synchronously after
      // the await boundary resolves, before control returns to the router).
      rejectApprovals = true;
      dispatcherReturned = true;
      return { response: "approve" };
    });

    const router = new ApprovalRequestRouter(dispatcher);
    const written: Frame[] = [];
    const msg = makeMessage("ApprovalRequest", validApprovalPayload);

    const context: ApprovalRouterContext = {
      getCurrentCommandType: () => "rescue",
      getRejectApprovals: () => rejectApprovals,
    };

    const result = await router.route(msg, context, makeWriteFn(written));

    expect(dispatcherReturned).toBe(true);
    // Even though the dispatcher returned "approve", the post-await guard
    // should have seen rejectApprovals=true and overridden to reject.
    expect(result.failure).toBeInstanceOf(RuntimeError);
    expect((result.failure as RuntimeError).code).toBe("APPROVAL_REJECTED");
    const frame = written[0] as { result: { response: string } };
    expect(frame.result.response).toBe("reject");
  });
});

// ---------------------------------------------------------------------------
// parseApprovalRequestPayload unit tests
// ---------------------------------------------------------------------------

describe("parseApprovalRequestPayload", () => {
  test("accepts a well-formed payload", () => {
    const parsed = parseApprovalRequestPayload(validApprovalPayload);
    expect(parsed.id).toBe("ap-1");
    expect(parsed.action).toBe("run shell command");
  });

  test("throws WIRE_PROTOCOL_ERROR when required fields are missing", () => {
    expect(() =>
      parseApprovalRequestPayload({ id: "x", sender: "s", action: "a", description: "d" /* missing display */ }),
    ).toThrow("invalid payload shape");
  });
});
