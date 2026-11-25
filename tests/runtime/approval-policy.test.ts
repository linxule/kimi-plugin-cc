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

  test.each(
    (["ask", "review", "challenge", "review_gate", "rescue", "swarm", "swarm-write"] as const).flatMap(
      (label) => [
        [label, "EnterPlanMode"],
        [label, "ExitPlanMode"],
      ],
    ),
  )("denies %s / %s before any write evaluator", async (label, tool) => {
    let evaluatorCalled = false;
    const decision = await decideHookOutcome(
      { tool_name: tool, tool_input: {} },
      {
        commandLabel: label,
        trustedWorkspaceRoot: "/wt",
        rescueEvaluator: async () => {
          evaluatorCalled = true;
          return { decision: "allow" };
        },
      },
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain(tool);
    expect(evaluatorCalled).toBe(false);
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
          { commandLabel: "swarm-write", trustedWorkspaceRoot: "/wt" },
        );
        expect(decision.decision).toBe("allow");
      }
    });

    test("denies the singular Agent tool", async () => {
      const decision = await decideHookOutcome(
        { tool_name: "Agent", tool_input: {} },
        { commandLabel: "swarm-write", trustedWorkspaceRoot: "/wt" },
      );
      expect(decision.decision).toBe("deny");
    });

    test("confines writes to the TRUSTED env root, NOT the hook payload cwd", async () => {
      // The load-bearing safety property: even if the payload cwd is the user's
      // real repo, the evaluator is called with the trusted worktree root from
      // ctx.trustedWorkspaceRoot (forge-proof env), never input.cwd.
      let seenRoot: string | undefined;
      const decision = await decideHookOutcome(
        { tool_name: "Write", tool_input: { file_path: "x" }, cwd: "/users/real-repo" },
        {
          commandLabel: "swarm-write",
          trustedWorkspaceRoot: "/plugin/worktrees/swarm-write-abc",
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
          trustedWorkspaceRoot: "/wt",
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
            // No trustedWorkspaceRoot — misconfiguration.
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
        { commandLabel: "rescue", trustedWorkspaceRoot: "/workspace" },
      );
      expect(decision.decision).toBe("deny");
      expect(decision.reason).toContain("rescue evaluator not configured");
    });
  });

  describe("rescue label with injected evaluator", () => {
    test("delegates with the trusted env root and ignores input.cwd", async () => {
      const decision = await decideHookOutcome(
        { tool_name: "Bash", tool_input: { command: "git status" }, cwd: "/workspace" },
        {
          commandLabel: "rescue",
          trustedWorkspaceRoot: "/trusted/workspace",
          rescueEvaluator: async (workspaceRoot, toolName, toolInput) => {
            expect(workspaceRoot).toBe("/trusted/workspace");
            expect(toolName).toBe("Bash");
            expect(toolInput).toEqual({ command: "git status" });
            return { decision: "allow" };
          },
        },
      );
      expect(decision).toEqual({ decision: "allow" });
    });

    test("denies a write when the trusted root is missing", async () => {
      const decision = await decideHookOutcome(
        { tool_name: "Write", tool_input: { path: "/tmp/x" }, cwd: "/payload" },
        {
          commandLabel: "rescue",
          rescueEvaluator: async () => ({ decision: "allow" }),
        },
      );
      expect(decision.decision).toBe("deny");
      expect(decision.reason).toContain("no trusted workspace root");
    });

    test("forwards deny decisions from evaluator", async () => {
      const decision = await decideHookOutcome(
        { tool_name: "Bash", tool_input: { command: "rm -rf /" }, cwd: "/w" },
        {
          commandLabel: "rescue",
          trustedWorkspaceRoot: "/w",
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

describe("pursue goal metadata", () => {
  const pursue = { commandLabel: "rescue", operationKind: "pursue", trustedWorkspaceRoot: "/workspace" };

  test.each([
    ["GetGoal", {}],
    ["UpdateGoal", { status: "complete" }],
    ["UpdateGoal", { status: "blocked" }],
  ] as const)("allows exact terminal metadata %s %j only for pursue", async (tool_name, tool_input) => {
    expect(await decideHookOutcome({ tool_name, tool_input }, pursue)).toEqual({ decision: "allow" });
    for (const commandLabel of ["ask", "review", "challenge", "review_gate", "swarm", "swarm-write", "unknown"]) {
      expect((await decideHookOutcome({ tool_name, tool_input }, { ...pursue, commandLabel })).decision).toBe("deny");
    }
    for (const operationKind of [undefined, "", "rescue", "review", "swarm", "unknown"]) {
      expect((await decideHookOutcome({ tool_name, tool_input }, { ...pursue, operationKind })).decision).toBe("deny");
    }
    for (const trustedWorkspaceRoot of [undefined, "", "  "]) {
      expect((await decideHookOutcome({ tool_name, tool_input }, { ...pursue, trustedWorkspaceRoot })).decision).toBe("deny");
    }
  });

  test("rejects malformed, extra-field and forbidden goal mutations before the rescue evaluator", async () => {
    let evaluatorCalls = 0;
    const ctx = { ...pursue, rescueEvaluator: async () => { evaluatorCalls++; return { decision: "allow" as const }; } };
    const cases: Array<[string, unknown]> = [
      ["UpdateGoal", { status: "active" }], ["UpdateGoal", { status: "paused" }],
      ["UpdateGoal", { status: "complete", objective: "replace the goal" }],
      ["UpdateGoal", { status: "complete", token_budget: 100 }],
      ["UpdateGoal", { status: "blocked", reason: "extra field" }],
      ["UpdateGoal", {}], ["UpdateGoal", null], ["UpdateGoal", []], ["UpdateGoal", "complete"],
      ["UpdateGoal", { status: true }], ["UpdateGoal", Object.create({ status: "complete" })],
      ["GetGoal", { status: "complete" }], ["GetGoal", null], ["GetGoal", []], ["GetGoal", undefined],
      ["CreateGoal", {}], ["CreateGoal", { objective: "new objective" }],
      ["SetGoalBudget", {}], ["SetGoalBudget", { turns: 1 }],
      ["EnterPlanMode", {}], ["ExitPlanMode", {}],
    ];
    for (const [tool_name, tool_input] of cases) {
      expect((await decideHookOutcome({ tool_name, tool_input }, ctx)).decision).toBe("deny");
    }
    expect(evaluatorCalls).toBe(0);
  });

  test("denies SetGoalBudget with actionable outer-budget guidance", async () => {
    let evaluatorCalled = false;
    const decision = await decideHookOutcome(
      { tool_name: "SetGoalBudget", tool_input: { turns: 10 } },
      {
        ...pursue,
        rescueEvaluator: async () => {
          evaluatorCalled = true;
          return { decision: "allow" };
        },
      },
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain("outer plugin wall-clock budget already applies");
    expect(decision.reason).toContain("continue the current goal without retrying SetGoalBudget");
    expect(evaluatorCalled).toBe(false);
  });

  test("keeps SetGoalBudget denial generic outside pursue", async () => {
    const decision = await decideHookOutcome(
      { tool_name: "SetGoalBudget", tool_input: { turns: 10 } },
      { commandLabel: "ask" },
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain("requires a pursue run");
    expect(decision.reason).not.toContain("continue the current goal");
  });

  test("preserves the rescue evaluator for writes and shell commands", async () => {
    const calls: unknown[] = [];
    for (const tool_name of ["Write", "Edit", "Bash"]) {
      const tool_input = { path: "file", command: "git status" };
      const result = await decideHookOutcome({ tool_name, tool_input, cwd: "/forged" }, {
        ...pursue,
        rescueEvaluator: async (root, tool, args) => {
          calls.push([root, tool, args]);
          return { decision: "deny", reason: "existing write boundary" };
        },
      });
      expect(result).toEqual({ decision: "deny", reason: "existing write boundary" });
      expect(calls.at(-1)).toEqual(["/workspace", tool_name, tool_input]);
    }
  });
});

test("pure policy plus evaluator matches async policy across the fixture matrix", async () => {
  const { decideHookOutcomePure, READ_ONLY_TOOLS } = await import("../../runtime/hooks/approval-policy.js");
  for (const commandLabel of [undefined, "", "unknown", "ask", "review", "challenge", "review_gate", "swarm", "rescue", "swarm-write"]) {
    for (const operationKind of [undefined, "rescue", "pursue"]) {
      for (const trustedWorkspaceRoot of [undefined, "", "/workspace"]) {
        for (const tool_name of [undefined, ...READ_ONLY_TOOLS, "Write", "Edit", "Bash", "Agent", "AgentSwarm", "EnterPlanMode", "ExitPlanMode", "GetGoal", "UpdateGoal", "CreateGoal", "SetGoalBudget"]) {
          for (const tool_input of [{}, { status: "complete" }, { status: "blocked" }, { status: "active" }, null, []]) {
            const input = { tool_name, tool_input };
            const rescueEvaluator = async () => ({ decision: "deny" as const, reason: "fixture evaluator denial" });
            const ctx = { commandLabel, operationKind, trustedWorkspaceRoot, rescueEvaluator };
            const pure = decideHookOutcomePure(input, ctx);
            const expected = "evaluator" in pure ? await rescueEvaluator() : pure;
            expect(await decideHookOutcome(input, ctx)).toEqual(expected);
          }
        }
      }
    }
  }
});

describe("write labels refuse a trusted root containing a backslash", () => {
  test.each([
    ["rescue", "Write"], ["rescue", "Read"], ["rescue", "Bash"],
    ["swarm-write", "Write"], ["swarm-write", "Read"], ["swarm-write", "AgentSwarm"],
  ])("%s denies %s", async (commandLabel, tool) => {
    const decision = await decideHookOutcome(
      { tool_name: tool, tool_input: { path: "x", command: "ls" } },
      {
        commandLabel,
        trustedWorkspaceRoot: "/work/a\\b",
        rescueEvaluator: async () => ({ decision: "allow" }),
      },
    );
    expect(decision).toEqual({
      decision: "deny",
      reason: expect.stringContaining("contains a backslash, which kimi-code reads as a path separator"),
    });
  });

  test("a plain root still reaches the evaluator", async () => {
    const decision = await decideHookOutcome(
      { tool_name: "Write", tool_input: { path: "x" } },
      { commandLabel: "rescue", trustedWorkspaceRoot: "/work/ab", rescueEvaluator: async () => ({ decision: "allow" }) },
    );
    expect(decision).toEqual({ decision: "allow" });
  });
});
