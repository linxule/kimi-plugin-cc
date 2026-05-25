import { describe, expect, test } from "bun:test";

import { decideHookOutcome } from "../../runtime/hooks/approval-policy.js";

describe("decideHookOutcome", () => {
  describe("out-of-plugin context", () => {
    test("allows everything when commandLabel is undefined", () => {
      expect(
        decideHookOutcome({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }, {}),
      ).toEqual({ decision: "allow" });
    });

    test("allows everything when commandLabel is empty string", () => {
      expect(
        decideHookOutcome({ tool_name: "Write", tool_input: { file_path: "/tmp/x" } }, { commandLabel: "" }),
      ).toEqual({ decision: "allow" });
    });
  });

  describe("ask label", () => {
    test("allows every tool — including write/exec", () => {
      const tools = ["Bash", "Write", "Edit", "Read", "Grep", "Glob"];
      for (const tool of tools) {
        expect(
          decideHookOutcome({ tool_name: tool, tool_input: {} }, { commandLabel: "ask" }).decision,
        ).toBe("allow");
      }
    });
  });

  describe.each(["review", "challenge", "review_gate"] as const)("%s label", (label) => {
    test("allows read-only tools", () => {
      for (const tool of ["Read", "Grep", "Glob"]) {
        expect(
          decideHookOutcome({ tool_name: tool, tool_input: {} }, { commandLabel: label }).decision,
        ).toBe("allow");
      }
    });

    test.each(["Bash", "Write", "Edit", "Task", "WebFetch"])("denies %s with a reason", (tool) => {
      const decision = decideHookOutcome(
        { tool_name: tool, tool_input: {} },
        { commandLabel: label },
      );
      expect(decision.decision).toBe("deny");
      expect(decision.reason).toBeDefined();
      expect(decision.reason).toContain(label);
      expect(decision.reason).toContain(tool);
    });

    test("denies missing tool_name with placeholder", () => {
      const decision = decideHookOutcome({ tool_input: {} }, { commandLabel: label });
      expect(decision.decision).toBe("deny");
      expect(decision.reason).toContain("<unspecified>");
    });
  });

  describe("rescue label without evaluator (PR 2 stub)", () => {
    test("allows Read/Grep/Glob", () => {
      for (const tool of ["Read", "Grep", "Glob"]) {
        expect(
          decideHookOutcome({ tool_name: tool, tool_input: {} }, { commandLabel: "rescue" }).decision,
        ).toBe("allow");
      }
    });

    test.each(["Bash", "Write", "Edit"])("denies %s with PR-3 deferral message", (tool) => {
      const decision = decideHookOutcome(
        { tool_name: tool, tool_input: { command: "ls" } },
        { commandLabel: "rescue" },
      );
      expect(decision.decision).toBe("deny");
      expect(decision.reason).toContain("PR 3");
      expect(decision.reason).toContain(tool);
    });
  });

  describe("rescue label with injected evaluator (PR 3 integration point)", () => {
    test("delegates to evaluator", () => {
      const decision = decideHookOutcome(
        { tool_name: "Bash", tool_input: { command: "git status" } },
        {
          commandLabel: "rescue",
          rescueEvaluator: (toolName, toolInput) => {
            expect(toolName).toBe("Bash");
            expect(toolInput).toEqual({ command: "git status" });
            return { decision: "allow" };
          },
        },
      );
      expect(decision).toEqual({ decision: "allow" });
    });

    test("forwards deny decisions from evaluator", () => {
      const decision = decideHookOutcome(
        { tool_name: "Bash", tool_input: { command: "rm -rf /" } },
        {
          commandLabel: "rescue",
          rescueEvaluator: () => ({ decision: "deny", reason: "destructive command" }),
        },
      );
      expect(decision).toEqual({ decision: "deny", reason: "destructive command" });
    });
  });

  describe("unknown command label (defensive)", () => {
    test("allows Read/Grep/Glob", () => {
      for (const tool of ["Read", "Grep", "Glob"]) {
        expect(
          decideHookOutcome({ tool_name: tool, tool_input: {} }, { commandLabel: "future_cmd" })
            .decision,
        ).toBe("allow");
      }
    });

    test("denies non-read tools with conservative default", () => {
      const decision = decideHookOutcome(
        { tool_name: "Bash", tool_input: {} },
        { commandLabel: "future_cmd" },
      );
      expect(decision.decision).toBe("deny");
      expect(decision.reason).toContain("unrecognized command label");
      expect(decision.reason).toContain("future_cmd");
    });
  });
});
