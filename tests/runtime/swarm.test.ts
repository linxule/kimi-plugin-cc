import { describe, expect, test } from "bun:test";

import { parseSwarmArgs } from "../../runtime/parsing.js";
import {
  buildSwarmPrompt,
  resolveSwarmMaxConcurrency,
  SWARM_DEFAULT_MAX_CONCURRENCY,
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
    expect(() => parseSwarmArgs(["--write", "do", "x"])).toThrow(RuntimeError);
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
