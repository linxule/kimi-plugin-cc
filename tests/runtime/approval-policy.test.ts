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

  describe.each(["ask", "review", "challenge", "review_gate"] as const)("%s label", (label) => {
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

  describe("swarm label (read-only fan-out)", () => {
    test("allows read-only tools", async () => {
      for (const tool of ["Read", "Grep", "Glob"]) {
        const decision = await decideHookOutcome(
          { tool_name: tool, tool_input: {} },
          { commandLabel: "swarm" },
        );
        expect(decision.decision).toBe("allow");
      }
    });

    test("allows AgentSwarm (the coordinator must be able to fan out)", async () => {
      const decision = await decideHookOutcome(
        { tool_name: "AgentSwarm", tool_input: { description: "review", items: ["a", "b"] } },
        { commandLabel: "swarm" },
      );
      expect(decision.decision).toBe("allow");
    });

    test.each(["Bash", "Write", "Edit", "WebFetch", "Task"])(
      "denies write/shell tool %s with a swarm reason",
      async (tool) => {
        const decision = await decideHookOutcome(
          { tool_name: tool, tool_input: {} },
          { commandLabel: "swarm" },
        );
        expect(decision.decision).toBe("deny");
        expect(decision.reason).toContain("swarm");
        expect(decision.reason).toContain(tool);
      },
    );

    test("denies the singular Agent tool (swarm is the fan-out surface, not arbitrary delegation)", async () => {
      const decision = await decideHookOutcome(
        { tool_name: "Agent", tool_input: {} },
        { commandLabel: "swarm" },
      );
      expect(decision.decision).toBe("deny");
      expect(decision.reason).toContain("swarm");
    });

    test("denies missing tool_name with placeholder", async () => {
      const decision = await decideHookOutcome({ tool_input: {} }, { commandLabel: "swarm" });
      expect(decision.decision).toBe("deny");
      expect(decision.reason).toContain("<unspecified>");
    });
  });

  describe("swarm-write label (write-capable fan-out, v1.4)", () => {
    test("allows read-only tools and AgentSwarm", async () => {
      for (const tool of ["Read", "Grep", "Glob", "AgentSwarm"]) {
        const decision = await decideHookOutcome(
          { tool_name: tool, tool_input: {} },
          { commandLabel: "swarm-write", swarmWriteWorkspaceRoot: "/wt" },
        );
        expect(decision.decision).toBe("allow");
      }
    });

    test("denies the singular Agent tool", async () => {
      const decision = await decideHookOutcome(
        { tool_name: "Agent", tool_input: {} },
        { commandLabel: "swarm-write", swarmWriteWorkspaceRoot: "/wt" },
      );
      expect(decision.decision).toBe("deny");
    });

    test("confines writes to the TRUSTED env root, NOT the hook payload cwd", async () => {
      // The load-bearing safety property: even if the payload cwd is the user's
      // real repo, the evaluator is called with the trusted worktree root from
      // ctx.swarmWriteWorkspaceRoot (forge-proof env), never input.cwd.
      let seenRoot: string | undefined;
      const decision = await decideHookOutcome(
        { tool_name: "Write", tool_input: { file_path: "x" }, cwd: "/users/real-repo" },
        {
          commandLabel: "swarm-write",
          swarmWriteWorkspaceRoot: "/plugin/worktrees/swarm-write-abc",
          rescueEvaluator: async (workspaceRoot) => {
            seenRoot = workspaceRoot;
            return { decision: "allow" };
          },
        },
      );
      expect(seenRoot).toBe("/plugin/worktrees/swarm-write-abc");
      expect(seenRoot).not.toBe("/users/real-repo");
      expect(decision.decision).toBe("allow");
    });

    test("delegates write/edit/shell to the rescue evaluator (forwards deny)", async () => {
      const decision = await decideHookOutcome(
        { tool_name: "Bash", tool_input: { command: "rm -rf /" } },
        {
          commandLabel: "swarm-write",
          swarmWriteWorkspaceRoot: "/wt",
          rescueEvaluator: async () => ({ decision: "deny", reason: "destructive command" }),
        },
      );
      expect(decision).toEqual({ decision: "deny", reason: "destructive command" });
    });

    test.each(["Write", "Edit", "Bash"])(
      "fail-CLOSES on a missing trusted workspace root (%s denied)",
      async (tool) => {
        const decision = await decideHookOutcome(
          { tool_name: tool, tool_input: { file_path: "x", command: "ls" } },
          {
            commandLabel: "swarm-write",
            // No swarmWriteWorkspaceRoot — misconfiguration.
            rescueEvaluator: async () => ({ decision: "allow" }),
          },
        );
        expect(decision.decision).toBe("deny");
        expect(decision.reason).toContain("no trusted workspace root");
      },
    );
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
