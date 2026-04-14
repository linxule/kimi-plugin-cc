import { describe, expect, mock, test } from "bun:test";

import { ApprovalDispatcher } from "../../runtime/wire/approval-dispatcher.js";

describe("ApprovalDispatcher", () => {
  test("delegates to the command-type policy hook", async () => {
    const policy = mock(async () => ({
      response: "reject" as const,
      feedback: "blocked",
    }));
    const dispatcher = new ApprovalDispatcher(policy);
    const request = {
      id: "approval-1",
      sender: "Shell",
      action: "run shell command",
      description: "Run ls",
      display: [],
    };

    const result = await dispatcher.handle(request, { commandType: "review" });

    expect(result).toEqual({
      response: "reject",
      feedback: "blocked",
    });
    expect(policy).toHaveBeenCalledWith(request, { commandType: "review" });
  });
});
