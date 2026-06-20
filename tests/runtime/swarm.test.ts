import { describe, expect, test } from "bun:test";

import { parseSwarmArgs } from "../../runtime/parsing.js";
import {
  buildSwarmPrompt,
  buildSwarmWritePrompt,
  resolveSwarmMaxConcurrency,
  resolveSwarmWriteMaxConcurrency,
  SWARM_DEFAULT_MAX_CONCURRENCY,
  SWARM_WRITE_DEFAULT_MAX_CONCURRENCY,
} from "../../runtime/commands/swarm.js";
import { RuntimeError } from "../../runtime/errors.js";

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

describe("buildSwarmPrompt", () => {
  test("instructs the model to use AgentSwarm and stay read-only", () => {
    const prompt = buildSwarmPrompt("review the parser");
    expect(prompt).toContain("AgentSwarm");
    expect(prompt).toContain("READ-ONLY");
    expect(prompt).toContain("review the parser");
    // No write surface: subagents are told read tools only.
    expect(prompt).toContain("Read, Grep, Glob");
  });

  test("steers to the read-only explore subagent profile (defense-in-depth)", () => {
    const prompt = buildSwarmPrompt("review the parser");
    expect(prompt).toContain("explore");
    // The explore profile has no file-editing tools — a second layer beneath the hook.
    expect(prompt).toContain("file-editing tools");
  });

  test("includes a soft cap clause when --cap is set", () => {
    const prompt = buildSwarmPrompt("audit the routes", 4);
    expect(prompt).toContain("at most 4 subagents");
    expect(prompt).toContain("soft cap");
  });

  test("omits the cap number when --cap is unset", () => {
    const prompt = buildSwarmPrompt("audit the routes");
    expect(prompt).not.toContain("at most");
    expect(prompt).toContain("one subagent per distinct target");
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
