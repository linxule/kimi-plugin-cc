import { describe, expect, test } from "bun:test";

import { parseDurationMs, parsePursueArgs } from "../../runtime/parsing.js";
import { buildGoalPrompt, classifyGoalExit } from "../../runtime/commands/pursue.js";
import { RuntimeError } from "../../runtime/errors.js";

describe("parseDurationMs", () => {
  test("parses unit suffixes", () => {
    expect(parseDurationMs("90s", "--budget")).toBe(90_000);
    expect(parseDurationMs("30m", "--budget")).toBe(1_800_000);
    expect(parseDurationMs("1h", "--budget")).toBe(3_600_000);
  });

  test("treats a bare integer as minutes", () => {
    expect(parseDurationMs("45", "--budget")).toBe(2_700_000);
  });

  test("rejects malformed and non-positive durations", () => {
    expect(() => parseDurationMs("abc", "--budget")).toThrow(RuntimeError);
    expect(() => parseDurationMs("0m", "--budget")).toThrow(RuntimeError);
    expect(() => parseDurationMs("-5", "--budget")).toThrow(RuntimeError);
    expect(() => parseDurationMs("30x", "--budget")).toThrow(RuntimeError);
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
  test("prefixes /goal and passes the objective through", () => {
    expect(buildGoalPrompt("fix the build")).toBe("/goal fix the build");
  });

  test("appends a soft turn instruction when --turns is set", () => {
    const prompt = buildGoalPrompt("fix the build", 5);
    expect(prompt.startsWith("/goal fix the build")).toBe(true);
    expect(prompt).toContain("at most 5 turns");
    expect(prompt).toContain("SetGoalBudget");
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
