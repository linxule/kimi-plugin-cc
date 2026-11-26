import { describe, expect, test } from "bun:test";

import { MAX_DURATION_MS, parseDurationMs, parsePursueArgs } from "../../runtime/parsing.js";
import { assertGoalRunProvenance, buildGoalPrompt, classifyGoalExit } from "../../runtime/commands/pursue.js";
import { RuntimeError } from "../../runtime/errors.js";

describe("parseDurationMs", () => {
  test("parses unit suffixes", () => {
    expect(parseDurationMs("90s", "--budget", "pursue.parse", "safety")).toBe(90_000);
    expect(parseDurationMs("30m", "--budget", "pursue.parse", "safety")).toBe(1_800_000);
    expect(parseDurationMs("1h", "--budget", "pursue.parse", "safety")).toBe(3_600_000);
  });

  test("treats a bare integer as minutes", () => {
    expect(parseDurationMs("45", "--budget", "pursue.parse", "safety")).toBe(2_700_000);
  });

  test("rejects malformed and non-positive durations", () => {
    expect(() => parseDurationMs("abc", "--budget", "pursue.parse", "safety")).toThrow(RuntimeError);
    expect(() => parseDurationMs("0m", "--budget", "pursue.parse", "safety")).toThrow(RuntimeError);
    expect(() => parseDurationMs("-5", "--budget", "pursue.parse", "safety")).toThrow(RuntimeError);
    expect(() => parseDurationMs("30x", "--budget", "pursue.parse", "safety")).toThrow(RuntimeError);
  });

  test("accepts a duration at the 24h ceiling", () => {
    expect(parseDurationMs("24h", "--budget", "pursue.parse", "safety")).toBe(MAX_DURATION_MS);
    expect(parseDurationMs("1440", "--budget", "pursue.parse", "safety")).toBe(MAX_DURATION_MS); // 1440 min = 24h
    expect(parseDurationMs("86400s", "--budget", "pursue.parse", "safety")).toBe(MAX_DURATION_MS);
  });

  test("rejects absurdly large durations above the 24h ceiling", () => {
    // The budget is the SOLE hard wall-clock bound on pursue/swarm; a runaway
    // value would effectively disable it, so it must hard-fail, not clamp.
    expect(() => parseDurationMs("25h", "--budget", "pursue.parse", "safety")).toThrow(RuntimeError);
    expect(() => parseDurationMs("1441", "--budget", "pursue.parse", "safety")).toThrow(RuntimeError); // 1441 min > 24h
    expect(() => parseDurationMs("999999h", "--budget", "pursue.parse", "safety")).toThrow(RuntimeError);
    expect(() => parseDurationMs("86401s", "--budget", "pursue.parse", "safety")).toThrow(RuntimeError);
  });
});

describe("parsePursueArgs", () => {
  test("captures the objective as trailing prose", () => {
    const args = parsePursueArgs(["fix", "the", "flaky", "checkout", "test"]);
    expect(args.objective).toBe("fix the flaky checkout test");
    expect(args.budgetMs).toBeUndefined();
    expect(args.turns).toBeUndefined();
  });

  test("parses --budget into ms and --turns into an integer", () => {
    const args = parsePursueArgs(["--budget", "1h", "--turns", "12", "refactor", "the", "parser"]);
    expect(args.budgetMs).toBe(3_600_000);
    expect(args.turns).toBe(12);
    expect(args.objective).toBe("refactor the parser");
  });

  test("parses -m/--model", () => {
    expect(parsePursueArgs(["-m", "k2", "do", "x"]).model).toBe("k2");
    expect(parsePursueArgs(["--model", "k2", "do", "x"]).model).toBe("k2");
  });

  test("rejects unknown flags (no silent slurp into the objective)", () => {
    expect(() => parsePursueArgs(["--background", "do", "x"])).toThrow(RuntimeError);
    expect(() => parsePursueArgs(["--resume", "abc", "do", "x"])).toThrow(RuntimeError);
  });

  test("rejects a non-integer --turns", () => {
    expect(() => parsePursueArgs(["--turns", "3.5", "x"])).toThrow(RuntimeError);
    expect(() => parsePursueArgs(["--turns", "0", "x"])).toThrow(RuntimeError);
  });

  test("-- escapes flag-shaped objective text", () => {
    const args = parsePursueArgs(["--", "--make-it-work", "please"]);
    expect(args.objective).toBe("--make-it-work please");
  });

  test("no objective yields undefined (runPursue surfaces the INVALID_ARGS)", () => {
    expect(parsePursueArgs(["--budget", "30m"]).objective).toBeUndefined();
  });
});

describe("buildGoalPrompt", () => {
  test("prefixes /goal with the objective delimiter", () => {
    expect(buildGoalPrompt("fix the build")).toBe("/goal -- fix the build");
  });

  test.each([
    "status the deployment",
    "pause the rollout",
    "replace the old parser",
    "next inspect the queue",
    "--fix-the-build please",
  ])("preserves a reserved initial-word objective: %s", (objective) => {
    expect(buildGoalPrompt(objective)).toBe(`/goal -- ${objective}`);
  });

  test("keeps --turns soft and does not mistake its stop for completion", () => {
    const prompt = buildGoalPrompt("fix the build", 5);
    expect(prompt.startsWith("/goal -- fix the build")).toBe(true);
    expect(prompt).toContain("at most 5 turns");
    expect(prompt).toContain("soft instruction");
    expect(prompt).toContain("plugin owns the outer wall-clock budget");
    expect(prompt).toContain("do not call SetGoalBudget");
    expect(prompt).toContain("Unfinished work at the soft stop is not completion");
  });

  test("normalizes whitespace before applying the upstream objective limit", () => {
    const normalized = "x".repeat(3990);
    expect(buildGoalPrompt(`${normalized}                    `)).toBe(`/goal -- ${normalized}`);
  });

  test("accounts for the 4000-character objective limit including turn guidance", () => {
    expect(() => buildGoalPrompt("x".repeat(4000))).not.toThrow();
    expect(() => buildGoalPrompt("x".repeat(4001))).toThrow("pursue objective exceeds Kimi's 4000-character goal limit; shorten the objective.");

    const objective = "x".repeat(3800);
    const turnGuidanceLength = buildGoalPrompt(objective, 5).length - buildGoalPrompt(objective).length;
    expect(() => buildGoalPrompt("x".repeat(4000 - turnGuidanceLength), 5)).not.toThrow();
    expect(() => buildGoalPrompt("x".repeat(4001 - turnGuidanceLength), 5)).toThrow(/omit --turns/);
  });
});

describe("classifyGoalExit", () => {
  test("maps the headless goal exit codes", () => {
    expect(classifyGoalExit(0)).toBe("complete");
    expect(classifyGoalExit(3)).toBe("blocked");
    expect(classifyGoalExit(6)).toBe("paused");
  });

  test("any other exit code is a genuine failure (unknown)", () => {
    expect(classifyGoalExit(1)).toBe("unknown");
    expect(classifyGoalExit(2)).toBe("unknown");
    expect(classifyGoalExit(143)).toBe("unknown");
  });
});

// Kimi second-round finding 2: a goal-terminal exit (3/6) skips
// assertCliResultSuccess, so a v2 plan must independently require the marker.
describe("assertGoalRunProvenance", () => {
  const base = { exitCode: 3, observedEngine: null, aborted: false } as const;

  test("native-v2 plan + silent goal-terminal exit → CLI_ENGINE_PROVENANCE_MISMATCH", () => {
    let threw: unknown;
    try {
      assertGoalRunProvenance({ intendedEngine: "native-v2" }, { ...base, systemVersion: undefined });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(RuntimeError);
    expect((threw as RuntimeError).code).toBe("CLI_ENGINE_PROVENANCE_MISMATCH");
    expect((threw as RuntimeError).details).toMatchObject({
      intended_engine: "native-v2",
      exit_code: 3,
      retryable_after_setup: false,
    });
  });

  test("native-v2 plan with the marker → ok", () => {
    expect(() =>
      assertGoalRunProvenance(
        { intendedEngine: "native-v2" },
        { ...base, observedEngine: "native-v2", systemVersion: "2.8.0" },
      ),
    ).not.toThrow();
  });

  test("aborted (budget) results are handled by the caller, not here", () => {
    expect(() =>
      assertGoalRunProvenance({ intendedEngine: "native-v2" }, { ...base, aborted: true, systemVersion: undefined }),
    ).not.toThrow();
  });

  test("legacy-v1 plan never requires the marker", () => {
    expect(() =>
      assertGoalRunProvenance({ intendedEngine: "legacy-v1" }, { ...base, systemVersion: undefined }),
    ).not.toThrow();
  });
});
