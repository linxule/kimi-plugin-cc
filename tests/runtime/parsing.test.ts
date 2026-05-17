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

  test("parseReviewArgs warns on unknown flags but still preserves them as focus text", () => {
    // v0.3.0 task #11: typos like `--from HEAD~2 --to HEAD` (instead of
    // `--base HEAD~2`) used to silently become focus text and waste a
    // long Kimi run. Now an advisory warning is emitted to stderr, but
    // behavior is unchanged so legitimate `--foo`-shaped focus text
    // still works after a `--` separator.
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: typeof process.stderr.write }).write = ((
      chunk: string | Uint8Array,
    ) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;

    try {
      const parsed = parseReviewArgs(["--from", "HEAD~2", "--to", "HEAD"], "review");
      expect(parsed.base).toBeUndefined();
      expect(parsed.focus).toBe("--from HEAD~2 --to HEAD");
    } finally {
      (process.stderr as { write: typeof process.stderr.write }).write = original;
    }

    const joined = writes.join("");
    expect(joined).toContain("unknown flag --from for review");
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
