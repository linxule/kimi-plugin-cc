import { describe, expect, test } from "bun:test";

import { buildKimiCliEnvironment } from "../../runtime/cli-client.js";
import { decideHookOutcome, decideHookOutcomePure } from "../../runtime/hooks/approval-policy.js";
import type { KimiExecutionPlan } from "../../runtime/kimi-engine.js";
import {
  BOUNDED_SWARM_POLICY, SWARM_CHILD_TIMEOUT_MS, SWARM_POLICY_ENV, SWARM_WAVE_SIZE_ENV,
  usesBoundedSwarmPolicy,
} from "../../runtime/swarm-policy.js";

const input = { description: "inspect targets", items: ["one", "two"] };
const context = { commandLabel: "swarm", swarmPolicy: BOUNDED_SWARM_POLICY, swarmWaveSize: "4" };

function plan(overrides: Partial<KimiExecutionPlan> = {}): KimiExecutionPlan {
  return {
    schemaVersion: 1, operationKind: "swarm", intendedEngine: "native-v2", command: "kimi",
    prefixArgs: [], kimiVersion: "2.6.2", certification: "certified", resumedFromJobId: null,
    safetyProfile: "native-v2-no-plan/1", ...overrides,
  };
}

describe("bounded swarm environment", () => {
  test("selects only the exact engine, version and swarm operation", () => {
    for (const operationKind of ["swarm", "swarm-write"] as const) {
      expect(usesBoundedSwarmPolicy(plan({ operationKind }))).toBe(true);
      for (const kimiVersion of ["2.5.3", "2.6.0", "2.6.3", "2.6.2+local", "2.6.2-rc.1", null]) {
        expect(usesBoundedSwarmPolicy(plan({ operationKind, kimiVersion }))).toBe(false);
      }
      expect(usesBoundedSwarmPolicy(plan({ operationKind, intendedEngine: "legacy-v1" }))).toBe(false);
    }
    for (const operationKind of ["ask", "review", "challenge", "rescue", "pursue", "review_gate"] as const) {
      expect(usesBoundedSwarmPolicy(plan({ operationKind }))).toBe(false);
    }
  });

  test.each([1, 2, 4])("overwrites forged ambient admission and child timeout at concurrency %i", (limit) => {
    for (const operationKind of ["swarm", "swarm-write"] as const) {
      const ambient = Object.freeze({
        KIMI_CODE_HOME: "/isolated/kimi", [SWARM_POLICY_ENV]: "forged", [SWARM_WAVE_SIZE_ENV]: "999",
        KIMI_CODE_SWARM_TIMEOUT_MS: "3000", KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: "999",
      });
      const env = buildKimiCliEnvironment({
        cwd: "/isolated/workspace", env: ambient, executionPlan: plan({ operationKind }),
        commandLabel: operationKind, swarmMaxConcurrency: limit,
      });
      expect(env[SWARM_POLICY_ENV]).toBe(BOUNDED_SWARM_POLICY);
      expect(env[SWARM_WAVE_SIZE_ENV]).toBe(String(limit));
      expect(env.KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY).toBe(String(limit));
      expect(env.KIMI_CODE_SWARM_TIMEOUT_MS).toBe(String(SWARM_CHILD_TIMEOUT_MS));
      expect(env.KIMI_PLUGIN_CC_OPERATION).toBe(operationKind);
      expect(ambient[SWARM_POLICY_ENV]).toBe("forged");
    }
  });

  test("removes ambient plugin admission overlays from other operations and versions", () => {
    for (const executionPlan of [plan({ kimiVersion: "2.5.3" }), plan({ kimiVersion: "2.6.0" }),
      plan({ intendedEngine: "legacy-v1" }), plan({ operationKind: "rescue" }), plan({ operationKind: "ask" })]) {
      const env = buildKimiCliEnvironment({
        cwd: "/isolated/workspace", env: { KIMI_CODE_HOME: "/isolated/kimi",
          [SWARM_POLICY_ENV]: BOUNDED_SWARM_POLICY, [SWARM_WAVE_SIZE_ENV]: "1", KIMI_CODE_SWARM_TIMEOUT_MS: "3000" },
        executionPlan, commandLabel: executionPlan.operationKind,
      });
      expect(env[SWARM_POLICY_ENV]).toBeUndefined();
      expect(env[SWARM_WAVE_SIZE_ENV]).toBeUndefined();
      expect(env.KIMI_CODE_SWARM_TIMEOUT_MS).toBe("3000");
    }
  });

  test.each([undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "refuses missing or invalid trusted concurrency %s", (swarmMaxConcurrency) => {
      expect(() => buildKimiCliEnvironment({ cwd: "/isolated/workspace", env: {}, executionPlan: plan(),
        commandLabel: "swarm", swarmMaxConcurrency })).toThrow("positive safe-integer concurrency");
    },
  );
  test.each([undefined, "", "review", "rescue", "swarm-write"])("refuses mismatched hook label %s", (commandLabel) => {
    expect(() => buildKimiCliEnvironment({ cwd: "/isolated/workspace", env: {}, executionPlan: plan(),
      commandLabel, swarmMaxConcurrency: 4 })).toThrow("exact operation label");
  });
});

describe("managed wave admission", () => {
  test.each(["swarm", "swarm-write"])("counts fresh and resumed entries for %s", async (commandLabel) => {
    const ctx = { ...context, commandLabel };
    for (const args of [input, { ...input, fork: false, resume_agent_ids: { "agent-0": "resume one", "agent-1": "resume two" } },
      { description: "resume", resume_agent_ids: { "agent-0": "resume one" } }]) {
      expect(await decideHookOutcome({ tool_name: "AgentSwarm", tool_input: args }, ctx)).toEqual({ decision: "allow" });
    }
    const mixed = { ...input, resume_agent_ids: { "agent-0": "one", "agent-1": "two", "agent-2": "three" } };
    const decision = await decideHookOutcome({ tool_name: "AgentSwarm", tool_input: mixed }, ctx);
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain("5 new and resumed entries");
    expect(decision.reason).toContain("sequential waves of at most 4");
  });

  test.each([undefined, "", "0", "-1", "1.5", "NaN", "Infinity", "04", "1e2", "9007199254740992"])(
    "fails closed on malformed or absent trusted width %s", async (swarmWaveSize) => {
      const decision = await decideHookOutcome({ tool_name: "AgentSwarm", tool_input: input }, { ...context, swarmWaveSize });
      expect(decision.decision).toBe("deny");
      expect(decision.reason).toContain("trusted wave size");
    },
  );
  test.each([undefined, "", "unknown", "bounded-waves/2"])("rejects unsupported policy %s", async (swarmPolicy) => {
    const decision = await decideHookOutcome({ tool_name: "AgentSwarm", tool_input: input }, { ...context, swarmPolicy });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain("swarm policy");
  });

  test.each([
    undefined, null, [], "input", new Date(), {},
    { ...input, description: " " }, { ...input, items: "one" }, { ...input, items: ["one", ""] },
    { ...input, items: [], resume_agent_ids: {} }, { ...input, resume_agent_ids: [] },
    { ...input, resume_agent_ids: { "": "resume" } }, { ...input, resume_agent_ids: { "agent-0": 1 } },
    { ...input, fork: true }, { ...input, fork: "false" }, { ...input, unreviewed: true },
    { ...input, model: 1 }, { ...input, prompt_template: "" }, { ...input, subagent_type: [] },
  ])("rejects malformed or forked admission %#", async (tool_input) => {
    expect((await decideHookOutcome({ tool_name: "AgentSwarm", tool_input }, context)).decision).toBe("deny");
  });

  test("concurrency one denies both delegation tools before the write evaluator", async () => {
    for (const commandLabel of ["swarm", "swarm-write"]) {
      for (const tool_name of ["Agent", "AgentSwarm"]) {
        let evaluated = false;
        const result = await decideHookOutcome({ tool_name, tool_input: input }, {
          ...context, commandLabel, swarmWaveSize: "1", trustedWorkspaceRoot: "/isolated/worktree",
          rescueEvaluator: async () => { evaluated = true; return { decision: "allow" }; },
        });
        expect(result.decision).toBe("deny");
        expect(evaluated).toBe(false);
      }
      expect(await decideHookOutcome({ tool_name: "Read", tool_input: {} }, {
        ...context, commandLabel, swarmWaveSize: "1",
      })).toEqual({ decision: "allow" });
    }
  });

  test.each(["swarm", "swarm-write"])("bounded %s rejects background Bash before evaluation", async (commandLabel) => {
    for (const swarmWaveSize of ["1", "4"]) {
      let evaluated = false;
      const ctx = { ...context, commandLabel, swarmWaveSize, trustedWorkspaceRoot: "/isolated/worktree",
        rescueEvaluator: async () => { evaluated = true; return { decision: "allow" as const }; } };
      const request = { tool_name: "Bash", tool_input: { command: "git status", run_in_background: true } };
      const result = await decideHookOutcome(request, ctx);
      const pure = decideHookOutcomePure(request, ctx);
      if ("evaluator" in pure) throw new Error("background Bash must be denied before evaluation");
      expect(result).toEqual(pure);
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("foreground");
      expect(result.reason).toContain("explicit background commands are disabled");
      expect(evaluated).toBe(false);
    }
  });

  test("foreground Bash and legacy background Bash retain the rescue evaluation boundary", async () => {
    for (const ctx of [
      { ...context, commandLabel: "swarm-write", trustedWorkspaceRoot: "/isolated/worktree" },
      { commandLabel: "swarm-write", trustedWorkspaceRoot: "/isolated/worktree" },
    ]) {
      const run_in_background = !("swarmPolicy" in ctx);
      let evaluated = false;
      const result = await decideHookOutcome({ tool_name: "Bash", tool_input: { command: "git status", run_in_background } }, {
        ...ctx, rescueEvaluator: async () => { evaluated = true; return { decision: "deny", reason: "evaluator-owned decision" }; },
      });
      expect(result).toEqual({ decision: "deny", reason: "evaluator-owned decision" });
      expect(evaluated).toBe(true);
    }
  });

  test("a fresh singleton gives regrouping guidance while a single resume stays allowed", async () => {
    const singleton = await decideHookOutcome({ tool_name: "AgentSwarm", tool_input: { ...input, items: ["one"] } }, context);
    expect(singleton.decision).toBe("deny");
    expect(singleton.reason).toContain("fresh-only waves require at least two entries");
    expect(singleton.reason).toContain("resume an existing child");
    expect(await decideHookOutcome({ tool_name: "AgentSwarm", tool_input: {
      description: "finish remaining work", resume_agent_ids: { "agent-0": "finish last target" },
    } }, context)).toEqual({ decision: "allow" });
  });

  test("single-worker writes still require the trusted worktree evaluator", async () => {
    let root = "";
    const result = await decideHookOutcome({ tool_name: "Write", tool_input: { path: "one" }, cwd: "/forged/root" }, {
      ...context, commandLabel: "swarm-write", swarmWaveSize: "1", trustedWorkspaceRoot: "/isolated/worktree",
      rescueEvaluator: async (trustedRoot) => { root = trustedRoot; return { decision: "allow" }; },
    });
    expect(result).toEqual({ decision: "allow" });
    expect(root).toBe("/isolated/worktree");
  });

  test.each(["Write", "Edit", "Bash"])("single-worker read denial for %s gives direct-work guidance", async (tool_name) => {
    const request = { tool_name, tool_input: {} };
    const ctx = { ...context, swarmWaveSize: "1" };
    const decision = await decideHookOutcome(request, ctx);
    const pure = decideHookOutcomePure(request, ctx);
    if ("evaluator" in pure) throw new Error("read-only denial must not reach a write evaluator");
    expect(decision).toEqual(pure);
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain("Read, Grep, or Glob");
    expect(decision.reason).toContain("Complete the review yourself; delegation is denied.");
    expect(decision.reason).not.toMatch(/coordinator|fan out|subagents/);
  });

  test("does not grant swarm access to other operations or alter legacy admission", async () => {
    for (const commandLabel of ["ask", "review", "challenge", "review_gate", "rescue"]) {
      expect((await decideHookOutcome({ tool_name: "AgentSwarm", tool_input: input }, {
        ...context, commandLabel,
      })).decision).toBe("deny");
    }
    expect(await decideHookOutcome({ tool_name: "AgentSwarm", tool_input: input }, {
      commandLabel: "swarm",
    })).toEqual({ decision: "allow" });
  });
});
