import { describe, expect, test } from "bun:test";

import { decideHookOutcome } from "../../runtime/hooks/approval-policy.js";

describe("decideHookOutcome", () => {
  describe("out-of-plugin context", () => {
    test("allows everything when commandLabel is undefined", async () => {
      await expect(
        decideHookOutcome({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }, {}),
      ).resolves.toEqual({ decision: "allow" });
    });

    test("allows everything when commandLabel is empty string", async () => {
      await expect(
        decideHookOutcome(
          { tool_name: "Write", tool_input: { file_path: "/tmp/x" } },
          { commandLabel: "" },
        ),
      ).resolves.toEqual({ decision: "allow" });
    });
  });

  describe("ask label", () => {
    test("allows every tool — including write/exec", async () => {
      const tools = ["Bash", "Write", "Edit", "Read", "Grep", "Glob"];
      for (const tool of tools) {
        const decision = await decideHookOutcome(
          { tool_name: tool, tool_input: {} },
          { commandLabel: "ask" },
        );
        expect(decision.decision).toBe("allow");
      }
    });
  });

  describe.each(["review", "challenge", "review_gate"] as const)("%s label", (label) => {
    test("allows read-only tools", async () => {
      for (const tool of ["Read", "Grep", "Glob"]) {
        const decision = await decideHookOutcome(
          { tool_name: tool, tool_input: {} },
          { commandLabel: label },
        );
        expect(decision.decision).toBe("allow");
      }
    });

    test.each(["Bash", "Write", "Edit", "Task", "WebFetch"])("denies %s with a reason", async (tool) => {
      const decision = await decideHookOutcome(
        { tool_name: tool, tool_input: {} },
        { commandLabel: label },
      );
      expect(decision.decision).toBe("deny");
      expect(decision.reason).toBeDefined();
      expect(decision.reason).toContain(label);
      expect(decision.reason).toContain(tool);
    });

    test("denies missing tool_name with placeholder", async () => {
      const decision = await decideHookOutcome({ tool_input: {} }, { commandLabel: label });
      expect(decision.decision).toBe("deny");
      expect(decision.reason).toContain("<unspecified>");
    });
  });

  describe("rescue label without evaluator (stub)", () => {
    test("allows Read/Grep/Glob", async () => {
      for (const tool of ["Read", "Grep", "Glob"]) {
        const decision = await decideHookOutcome(
          { tool_name: tool, tool_input: {} },
          { commandLabel: "rescue" },
        );
        expect(decision.decision).toBe("allow");
      }
    });

    test.each(["Bash", "Write", "Edit"])("denies %s with stub message", async (tool) => {
      const decision = await decideHookOutcome(
        { tool_name: tool, tool_input: { command: "ls" } },
        { commandLabel: "rescue" },
      );
      expect(decision.decision).toBe("deny");
      expect(decision.reason).toContain("rescue evaluator not configured");
    });
  });

  describe("rescue label with injected evaluator", () => {
    test("delegates to evaluator with workspaceRoot from input.cwd", async () => {
      const decision = await decideHookOutcome(
        { tool_name: "Bash", tool_input: { command: "git status" }, cwd: "/workspace" },
        {
          commandLabel: "rescue",
          rescueEvaluator: async (workspaceRoot, toolName, toolInput) => {
            expect(workspaceRoot).toBe("/workspace");
            expect(toolName).toBe("Bash");
            expect(toolInput).toEqual({ command: "git status" });
            return { decision: "allow" };
          },
        },
      );
      expect(decision).toEqual({ decision: "allow" });
    });

    test("falls back to process.cwd() when input.cwd is missing", async () => {
      const decision = await decideHookOutcome(
        { tool_name: "Read", tool_input: {} },
        {
          commandLabel: "rescue",
          rescueEvaluator: async (workspaceRoot) => {
            expect(workspaceRoot).toBe(process.cwd());
            return { decision: "allow" };
          },
        },
      );
      expect(decision.decision).toBe("allow");
    });

    test("forwards deny decisions from evaluator", async () => {
      const decision = await decideHookOutcome(
        { tool_name: "Bash", tool_input: { command: "rm -rf /" }, cwd: "/w" },
        {
          commandLabel: "rescue",
          rescueEvaluator: async () => ({ decision: "deny", reason: "destructive command" }),
        },
      );
      expect(decision).toEqual({ decision: "deny", reason: "destructive command" });
    });
  });

  describe("unknown command label (defensive)", () => {
    test("allows Read/Grep/Glob", async () => {
      for (const tool of ["Read", "Grep", "Glob"]) {
        const decision = await decideHookOutcome(
          { tool_name: tool, tool_input: {} },
          { commandLabel: "future_cmd" },
        );
        expect(decision.decision).toBe("allow");
      }
    });

    test("denies non-read tools with conservative default", async () => {
      const decision = await decideHookOutcome(
        { tool_name: "Bash", tool_input: {} },
        { commandLabel: "future_cmd" },
      );
      expect(decision.decision).toBe("deny");
      expect(decision.reason).toContain("unrecognized command label");
      expect(decision.reason).toContain("future_cmd");
    });
  });
});
