import { describe, expect, test } from "bun:test";

import { parseAskArgs, parseJobLookupArgs, parseRescueArgs, parseReviewArgs } from "../../runtime/parsing.js";

describe("argument parsing", () => {
  test("parseAskArgs preserves text after the -- sentinel", () => {
    const parsed = parseAskArgs(["--no-thinking", "--", "--literal", "question"]);

    expect(parsed.thinking).toBeFalse();
    expect(parsed.prompt).toBe("--literal question");
    expect(parsed.resume).toBeFalse();
    expect(parsed.fresh).toBeFalse();
  });

  test("parseAskArgs treats unknown flags as prompt text start", () => {
    const parsed = parseAskArgs(["-m", "kimi-k2", "--mystery", "tail"]);

    expect(parsed.model).toBe("kimi-k2");
    expect(parsed.prompt).toBe("--mystery tail");
    expect(parsed.resume).toBeFalse();
    expect(parsed.fresh).toBeFalse();
  });

  test("parseAskArgs handles explicit resume targets", () => {
    const parsed = parseAskArgs(["--resume", "foo"]);

    expect(parsed).toEqual({
      resume: true,
      resumeTarget: "foo",
      fresh: false,
      model: undefined,
      thinking: undefined,
      prompt: undefined,
    });
  });

  test("parseAskArgs treats -r as bare resume and preserves following prompt text", () => {
    const parsed = parseAskArgs(["-r", "my question"]);

    expect(parsed).toEqual({
      resume: true,
      resumeTarget: undefined,
      fresh: false,
      model: undefined,
      thinking: undefined,
      prompt: "my question",
    });
  });

  test("parseAskArgs rejects --fresh and --resume together", () => {
    expect(() => parseAskArgs(["--fresh", "--resume"])).toThrow(
      "ask does not allow --fresh and --resume together.",
    );
  });

  test("parseReviewArgs preserves adversarial focus text after known flags", () => {
    const parsed = parseReviewArgs(["--base", "main", "--thinking", "focus", "on", "rollback"]);

    expect(parsed.base).toBe("main");
    expect(parsed.thinking).toBeTrue();
    expect(parsed.focus).toBe("focus on rollback");
  });

  test("parseRescueArgs handles explicit resume targets and prompt text", () => {
    const parsed = parseRescueArgs(["--resume", "job-123", "--background", "continue", "work"]);

    expect(parsed.resume).toBeTrue();
    expect(parsed.resumeTarget).toBe("job-123");
    expect(parsed.background).toBeTrue();
    expect(parsed.prompt).toBe("continue work");
  });

  test("parseJobLookupArgs accepts an optional type filter and job id", () => {
    const parsed = parseJobLookupArgs(["--type", "rescue", "job-123"]);

    expect(parsed.type).toBe("rescue");
    expect(parsed.jobId).toBe("job-123");
  });
});
