import { describe, expect, test } from "bun:test";

import { MAX_DURATION_MS, parseSwarmArgs } from "../../runtime/parsing.js";
import {
  buildSwarmPrompt,
  buildSwarmWritePrompt,
  runSwarm,
  resolveSwarmMaxConcurrency,
  resolveSwarmWriteMaxConcurrency,
  SWARM_DEFAULT_MAX_CONCURRENCY,
  SWARM_WRITE_DEFAULT_MAX_CONCURRENCY,
  WORKTREE_ORPHAN_TTL_MS,
} from "../../runtime/commands/swarm.js";
import { RuntimeError } from "../../runtime/errors.js";
import type { CommandContext } from "../../runtime/types.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

function makeContext(cwd: string, env: NodeJS.ProcessEnv): CommandContext {
  return {
    cwd,
    env,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

describe("parseSwarmArgs", () => {
  test("captures the objective as trailing prose", () => {
    const args = parseSwarmArgs(["review", "the", "auth", "module", "for", "races"]);
    expect(args.objective).toBe("review the auth module for races");
    expect(args.budgetMs).toBeUndefined();
    expect(args.cap).toBeUndefined();
    expect(args.maxConcurrency).toBeUndefined();
  });

  test("parses --budget into ms and --cap into an integer (cap does NOT set maxConcurrency)", () => {
    const args = parseSwarmArgs(["--budget", "1h", "--cap", "6", "audit", "every", "route"]);
    expect(args.budgetMs).toBe(3_600_000);
    expect(args.cap).toBe(6);
    // --cap is the SOFT total-count hint only; it must NOT feed the hard
    // concurrency ceiling (that is --max-concurrency's job after the v1.2.7 split).
    expect(args.maxConcurrency).toBeUndefined();
    expect(args.objective).toBe("audit every route");
  });

  test("--cap and --max-concurrency are independent (soft total vs hard concurrency)", () => {
    const args = parseSwarmArgs(["--cap", "20", "--max-concurrency", "4", "sweep", "the", "repo"]);
    expect(args.cap).toBe(20);
    expect(args.maxConcurrency).toBe(4);
    expect(args.objective).toBe("sweep the repo");
  });

  test("--max-concurrency alone sets only the hard ceiling", () => {
    const args = parseSwarmArgs(["--max-concurrency", "3", "review", "x"]);
    expect(args.maxConcurrency).toBe(3);
    expect(args.cap).toBeUndefined();
  });

  test("rejects a non-positive or non-integer --max-concurrency", () => {
    expect(() => parseSwarmArgs(["--max-concurrency", "0", "x"])).toThrow(RuntimeError);
    expect(() => parseSwarmArgs(["--max-concurrency", "2.5", "x"])).toThrow(RuntimeError);
    expect(() => parseSwarmArgs(["--max-concurrency", "-1", "x"])).toThrow(RuntimeError);
    expect(() => parseSwarmArgs(["--max-concurrency", "audit", "x"])).toThrow(RuntimeError);
  });

  test("parses -m/--model", () => {
    expect(parseSwarmArgs(["-m", "k2", "do", "x"]).model).toBe("k2");
    expect(parseSwarmArgs(["--model", "k2", "do", "x"]).model).toBe("k2");
  });

  test("rejects unknown flags (no silent slurp into the objective)", () => {
    expect(() => parseSwarmArgs(["--background", "do", "x"])).toThrow(RuntimeError);
    expect(() => parseSwarmArgs(["--turns", "5", "do", "x"])).toThrow(RuntimeError);
    expect(() => parseSwarmArgs(["--apply", "do", "x"])).toThrow(RuntimeError);
  });

  test("--write is a recognized boolean flag (defaults off)", () => {
    expect(parseSwarmArgs(["review", "x"]).write).toBe(false);
    const w = parseSwarmArgs(["--write", "refactor", "the", "parser"]);
    expect(w.write).toBe(true);
    expect(w.objective).toBe("refactor the parser");
  });

  test("--write composes with --budget / --cap / --max-concurrency / -m", () => {
    const w = parseSwarmArgs([
      "--write",
      "--budget",
      "20m",
      "--cap",
      "5",
      "--max-concurrency",
      "2",
      "-m",
      "k2",
      "fix",
      "the",
      "tests",
    ]);
    expect(w.write).toBe(true);
    expect(w.budgetMs).toBe(1_200_000);
    expect(w.cap).toBe(5);
    expect(w.maxConcurrency).toBe(2);
    expect(w.model).toBe("k2");
    expect(w.objective).toBe("fix the tests");
  });

  test("rejects a non-positive or non-integer --cap", () => {
    expect(() => parseSwarmArgs(["--cap", "0", "x"])).toThrow(RuntimeError);
    expect(() => parseSwarmArgs(["--cap", "3.5", "x"])).toThrow(RuntimeError);
    expect(() => parseSwarmArgs(["--cap", "-2", "x"])).toThrow(RuntimeError);
  });

  test("-- escapes flag-shaped objective text", () => {
    const args = parseSwarmArgs(["--", "--look-at", "this"]);
    expect(args.objective).toBe("--look-at this");
  });

  test("no objective yields undefined (runSwarm surfaces the INVALID_ARGS)", () => {
    expect(parseSwarmArgs(["--budget", "30m"]).objective).toBeUndefined();
  });
});

describe("resolveSwarmMaxConcurrency", () => {
  test("applies the hard concurrency default when --max-concurrency is unset", () => {
    // v1.3: swarm is model-invocable via the kimi-swarm agent, so an
    // auto-dispatched fan-out must never run with an unbounded peak. The runtime
    // enforces a finite ceiling by construction rather than trusting agent prose.
    expect(resolveSwarmMaxConcurrency(undefined)).toBe(SWARM_DEFAULT_MAX_CONCURRENCY);
    expect(SWARM_DEFAULT_MAX_CONCURRENCY).toBe(4);
  });

  test("an explicit --max-concurrency overrides the default", () => {
    expect(resolveSwarmMaxConcurrency(8)).toBe(8);
    expect(resolveSwarmMaxConcurrency(1)).toBe(1);
  });
});

describe("resolveSwarmWriteMaxConcurrency", () => {
  test("write mode serializes by default (1), lower than read's 4", () => {
    // Disjoint-target partitioning is prompt-only and unenforceable; serialize
    // concurrent writers into the shared worktree until a real-binary smoke
    // proves clean concurrent disjoint patches.
    expect(resolveSwarmWriteMaxConcurrency(undefined)).toBe(SWARM_WRITE_DEFAULT_MAX_CONCURRENCY);
    expect(SWARM_WRITE_DEFAULT_MAX_CONCURRENCY).toBe(1);
    expect(SWARM_WRITE_DEFAULT_MAX_CONCURRENCY).toBeLessThan(SWARM_DEFAULT_MAX_CONCURRENCY);
  });

  test("an explicit --max-concurrency overrides the write default", () => {
    expect(resolveSwarmWriteMaxConcurrency(2)).toBe(2);
  });
});

describe("runSwarm hook gate", () => {
  test("refuses without the hook and names Claude Code and Codex repair commands", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("swarm-hook-gate-data");
    const workspace = await createTestPluginDataRoot("swarm-hook-gate-ws");
    const kimiHome = await createTestPluginDataRoot("swarm-hook-gate-home");
    try {
      const output = await runSwarm(
        ["review", "two", "targets"],
        makeContext(workspace, {
          ...process.env,
          CLAUDE_PLUGIN_DATA: pluginDataRoot,
          KIMI_CODE_HOME: kimiHome,
          KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: "1",
        }),
      );

      expect(output).toContain("SWARM_HOOK_NOT_INSTALLED");
      expect(output).toContain("Claude Code /kimi:setup");
      expect(output).toContain("Codex $kimi-setup");
      expect(output).not.toContain("KIMI_PLUGIN_CC_SKIP_HOOK_CHECK");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(workspace);
      await cleanupTestPath(kimiHome);
    }
  });
});

describe("runSwarm version gate (write fails CLOSED, read fails OPEN on an unconfirmable probe)", () => {
  // A nonexistent absolute path makes `kimi --version` fail with ENOENT, so the
  // probe returns {kind:"failed"} fast — the real "flaky probe" the gate must
  // resolve by mode. KIMI_PLUGIN_CC_SKIP_VERSION_PROBE is neutralized ("") so the
  // probe genuinely runs (some dev/CI envs export it as "1").
  const BROKEN_KIMI = "/definitely/does/not/exist/kimi-binary-xyz";

  test("--write REFUSES when the probe can't confirm >= 0.18.0 (the hard concurrency cap)", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("swarm-vgate-w-data");
    const workspace = await createTestPluginDataRoot("swarm-vgate-w-ws");
    const kimiHome = await createTestPluginDataRoot("swarm-vgate-w-home");
    try {
      let caught: unknown;
      try {
        await runSwarm(
          ["--write", "edit", "every", "handler"],
          makeContext(workspace, {
            ...process.env,
            CLAUDE_PLUGIN_DATA: pluginDataRoot,
            KIMI_CODE_HOME: kimiHome,
            KIMI_PLUGIN_CC_KIMI_BIN: BROKEN_KIMI,
            KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: "",
          }),
        );
      } catch (error) {
        caught = error;
      }
      // Fail CLOSED: without a confirmed >= 0.18.0 the env-based concurrency cap
      // can't be guaranteed, so a concurrent write fan-out must not launch.
      expect(caught).toBeInstanceOf(RuntimeError);
      expect((caught as RuntimeError).code).toBe("SWARM_UNSUPPORTED");
      expect((caught as RuntimeError).message).toContain("CONFIRMED kimi-code >= 0.18.0");
      expect((caught as RuntimeError).message).toContain("version probe failed");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(workspace);
      await cleanupTestPath(kimiHome);
    }
  });

  test("read-only swarm still runs past the gate (fail-open) — a broken probe surfaces the hook refusal, not the version gate", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("swarm-vgate-r-data");
    const workspace = await createTestPluginDataRoot("swarm-vgate-r-ws");
    const kimiHome = await createTestPluginDataRoot("swarm-vgate-r-home");
    try {
      const output = await runSwarm(
        ["review", "two", "targets"],
        makeContext(workspace, {
          ...process.env,
          CLAUDE_PLUGIN_DATA: pluginDataRoot,
          KIMI_CODE_HOME: kimiHome,
          KIMI_PLUGIN_CC_KIMI_BIN: BROKEN_KIMI,
          KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: "",
        }),
      );
      // Fail OPEN: a too-old read-only binary is only degraded (the read-only hook
      // still holds), so the gate lets the run reach the hook check.
      expect(output).toContain("SWARM_HOOK_NOT_INSTALLED");
      expect(output).not.toContain("SWARM_UNSUPPORTED");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(workspace);
      await cleanupTestPath(kimiHome);
    }
  });

  test("the orphan-sweep TTL exceeds the max --budget, so a live worktree is never reaped mid-run", () => {
    // The sweep's liveness signal is worktree-dir mtime, frozen at creation for a
    // run that edits only existing files. A live run lasts at most MAX_DURATION_MS
    // (the --budget hard cap), so the TTL must exceed it or a concurrent run's
    // sweep could force-remove a still-live worktree.
    expect(WORKTREE_ORPHAN_TTL_MS).toBeGreaterThan(MAX_DURATION_MS);
  });
});

describe("buildSwarmPrompt", () => {
  // v1.8.6: the prompt was slimmed after the kimi-code 0.26.0 (k3) coordinator
  // hung when over-prescribed. It now states the read-only goal + report shape
  // and trusts the model to fan out with its own subagent capability, while
  // still naming the tool constraint (Read/Grep/Glob only, Bash denied) so k3
  // doesn't stall on a denied preliminary shell call. Safety is unchanged — the
  // PreToolUse hook (swarm label) enforces read-only regardless of this prose.
  test("states the read-only goal and the objective", () => {
    const prompt = buildSwarmPrompt("review the parser");
    expect(prompt.toLowerCase()).toContain("read-only");
    expect(prompt).toContain("review the parser");
    // Names the available read tools so the model doesn't reach for shell.
    expect(prompt).toContain("Read");
    expect(prompt).toContain("Grep");
    expect(prompt).toContain("Glob");
  });

  test("names the Bash denial and steers the fan-out to be the first action (k3 anti-hang)", () => {
    const prompt = buildSwarmPrompt("review the parser");
    expect(prompt).toContain("Bash");
    expect(prompt).toContain("FIRST action");
    // Deliberately does NOT prescribe the internal AgentSwarm mechanics that
    // confused k3 — no subagent_type / prompt_template scaffolding.
    expect(prompt).not.toContain("subagent_type");
    expect(prompt).not.toContain("prompt_template");
  });

  test("includes a soft cap clause when --cap is set", () => {
    const prompt = buildSwarmPrompt("audit the routes", 4);
    expect(prompt).toContain("at most 4");
  });

  test("omits the cap number when --cap is unset", () => {
    const prompt = buildSwarmPrompt("audit the routes");
    expect(prompt).not.toContain("at most");
    // Still tells the model to fan the work out in parallel.
    expect(prompt.toLowerCase()).toContain("parallel");
  });
});

describe("buildSwarmWritePrompt", () => {
  test("steers to the write-capable coder profile and disjoint editing", () => {
    const prompt = buildSwarmWritePrompt("apply the rename across the package");
    expect(prompt).toContain("AgentSwarm");
    expect(prompt).toContain("coder");
    expect(prompt).toContain("DISJOINT");
    expect(prompt).toContain("apply the rename across the package");
  });

  test("forbids git mutation and nested swarm in-prompt", () => {
    const prompt = buildSwarmWritePrompt("fix the failing tests");
    expect(prompt).toContain("git");
    expect(prompt.toLowerCase()).toContain("nested");
    // Tells the model the human owns git / merge.
    expect(prompt.toLowerCase()).toContain("human owns");
  });

  test("does NOT claim read-only (it is the write path)", () => {
    const prompt = buildSwarmWritePrompt("refactor x");
    expect(prompt).not.toContain("READ-ONLY");
  });

  test("carries the soft cap clause like the read prompt", () => {
    expect(buildSwarmWritePrompt("x", 3)).toContain("at most 3 subagents");
    expect(buildSwarmWritePrompt("x")).toContain("one subagent per distinct target");
  });
});
