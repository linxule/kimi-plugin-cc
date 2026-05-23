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
      background: false,
      wait: false,
      resume: true,
      resumeTarget: "foo",
      fresh: false,
      model: undefined,
      thinking: true,
      prompt: undefined,
    });
  });

  test("parseAskArgs treats -r as bare resume and preserves following prompt text", () => {
    const parsed = parseAskArgs(["-r", "my question"]);

    expect(parsed).toEqual({
      background: false,
      wait: false,
      resume: true,
      resumeTarget: undefined,
      fresh: false,
      model: undefined,
      thinking: true,
      prompt: "my question",
    });
  });

  test("parseAskArgs rejects bare --resume without a target", () => {
    expect(() => parseAskArgs(["--resume"])).toThrow(
      "--resume requires a job-id or session-id. Use -r to resume the latest ask session for this repo.",
    );
  });

  test("parseAskArgs rejects --resume followed by another flag", () => {
    expect(() => parseAskArgs(["--resume", "--fresh"])).toThrow(
      "--resume requires a job-id or session-id. Use -r to resume the latest ask session for this repo.",
    );
  });

  test("parseAskArgs rejects prompt text after --resume <id>", () => {
    expect(() => parseAskArgs(["--resume", "What", "changed?"])).toThrow(
      "--resume only accepts a job-id or session-id. Use -r to resume the latest ask session with a prompt.",
    );
  });

  test("parseAskArgs rejects --fresh and --resume together", () => {
    expect(() => parseAskArgs(["--fresh", "-r"])).toThrow(
      "ask does not allow --fresh and --resume together.",
    );
  });

  test("parseReviewArgs preserves adversarial focus text after known flags", () => {
    const parsed = parseReviewArgs(["--base", "main", "--thinking", "focus", "on", "rollback"]);

    expect(parsed.base).toBe("main");
    expect(parsed.thinking).toBeTrue();
    expect(parsed.focus).toBe("focus on rollback");
  });

  test("parseReviewArgs hard-fails on unknown flags in flag-position", () => {
    // v0.3.6: warn-and-swallow was producing invisible-to-agent corruption
    // when wrappers invented flags like `--file` / `--context`. The bloated
    // focus blob made Kimi spin inside the 10-min timeout, looking like a
    // hang. Now any flag-shaped token that isn't in the known set throws
    // INVALID_ARGS, with the supported list and `--` escape hatch in the
    // error message. Applies to review/challenge only — ask/rescue still
    // warn-and-swallow since their trailing position is free-form prose.
    expect(() => parseReviewArgs(["--from", "HEAD~2", "--to", "HEAD"], "review")).toThrow(
      /Unknown flag --from for review.*Use `--` before flag-shaped focus text/s,
    );
    expect(() => parseReviewArgs(["--file", "/tmp/x.md"], "challenge")).toThrow(
      /Unknown flag --file for challenge/,
    );
  });

  test("parseReviewArgs `--` sentinel still escapes flag-shaped focus text", () => {
    // The escape hatch documented in the error message must actually work.
    // After `--`, all remaining tokens are joined verbatim as focus, even
    // ones that look like flags.
    const parsed = parseReviewArgs(["--base", "main", "--", "--file", "/tmp/x.md"], "review");

    expect(parsed.base).toBe("main");
    expect(parsed.focus).toBe("--file /tmp/x.md");
  });

  test("parseAskArgs `--` sentinel suppresses unknown-flag warning for tokens after it", () => {
    // The warning fires only when a flag-shaped token appears BEFORE the
    // `--` sentinel. `parseAskArgs` already had a `--` separator and the
    // v0.3.0 warning shouldn't undercut its escape-hatch role.
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: typeof process.stderr.write }).write = ((
      chunk: string | Uint8Array,
    ) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;

    try {
      const parsed = parseAskArgs(["--", "--mystery", "tail"]);
      expect(parsed.prompt).toBe("--mystery tail");
    } finally {
      (process.stderr as { write: typeof process.stderr.write }).write = original;
    }

    expect(writes.join("")).not.toContain("unknown flag");
  });

  test("parseAskArgs warns on unknown flags but keeps trailing text as the prompt", () => {
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: typeof process.stderr.write }).write = ((
      chunk: string | Uint8Array,
    ) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;

    try {
      const parsed = parseAskArgs(["--mystery", "tail"]);
      expect(parsed.prompt).toBe("--mystery tail");
    } finally {
      (process.stderr as { write: typeof process.stderr.write }).write = original;
    }

    expect(writes.join("")).toContain("unknown flag --mystery for ask");
  });

  test("parseRescueArgs handles explicit resume targets and flags", () => {
    const parsed = parseRescueArgs(["--resume", "job-123", "--background"]);

    expect(parsed.resume).toBeTrue();
    expect(parsed.resumeTarget).toBe("job-123");
    expect(parsed.background).toBeTrue();
    expect(parsed.prompt).toBeUndefined();
  });

  test("parseRescueArgs treats -r as bare resume and preserves following prompt text", () => {
    const parsed = parseRescueArgs(["-r", "continue", "work"]);

    expect(parsed.resume).toBeTrue();
    expect(parsed.resumeTarget).toBeUndefined();
    expect(parsed.prompt).toBe("continue work");
  });

  test("parseRescueArgs rejects bare --resume without a target", () => {
    expect(() => parseRescueArgs(["--resume"])).toThrow(
      "--resume requires a job-id or session-id. Use -r to resume the latest rescue session for this repo.",
    );
  });

  test("parseRescueArgs rejects --resume followed by another flag", () => {
    expect(() => parseRescueArgs(["--resume", "--fresh"])).toThrow(
      "--resume requires a job-id or session-id. Use -r to resume the latest rescue session for this repo.",
    );
  });

  test("parseRescueArgs rejects prompt text after --resume <id>", () => {
    expect(() => parseRescueArgs(["--resume", "What", "changed?"])).toThrow(
      "--resume only accepts a job-id or session-id. Use -r to resume the latest rescue session with a prompt.",
    );
  });

  test("parseJobLookupArgs accepts an optional type filter and job id", () => {
    const parsed = parseJobLookupArgs(["--type", "rescue", "job-123"]);

    expect(parsed.type).toBe("rescue");
    expect(parsed.jobId).toBe("job-123");
  });
});
