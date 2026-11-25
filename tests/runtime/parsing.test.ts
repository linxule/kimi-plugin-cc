import { describe, expect, test } from "bun:test";

import { RuntimeError } from "../../runtime/errors.js";
import { parseAskArgs, parsePursueArgs, parseSwarmArgs, parseJobLookupArgs, parseRescueArgs, parseReviewArgs } from "../../runtime/parsing.js";

describe("argument parsing", () => {
  test("parseAskArgs preserves text after the -- sentinel", () => {
    const parsed = parseAskArgs(["--fresh", "--", "--literal", "question"]);

    expect(parsed.thinkingEffort).toBeUndefined();
    expect(parsed.fresh).toBeTrue();
    expect(parsed.prompt).toBe("--literal question");
    expect(parsed.resume).toBeFalse();
  });



  test("parseAskArgs rejects unknown flag-shaped tokens in flag-position", () => {
    expect(() => parseAskArgs(["-m", "kimi-k2", "--mystery", "tail"])).toThrow(
      /Unknown flag --mystery for ask.*Supported flags:.*Use `--` before flag-shaped prompt text/s,
    );
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
      thinkingEffort: undefined,
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
      thinkingEffort: undefined,
      prompt: "my question",
    });
  });

  test("parseAskArgs preserves trailing-mode prose with flag-shaped tokens", () => {
    const parsed = parseAskArgs(["explain", "git", "log", "-1"]);

    expect(parsed.prompt).toBe("explain git log -1");
  });

  test("parseAskArgs `--` sentinel passes through flag-shaped prompt text", () => {
    const parsed = parseAskArgs(["--", "--mystery", "foo"]);

    expect(parsed.prompt).toBe("--mystery foo");
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

  test("parseAskArgs rejects --model followed by another flag", () => {
    expect(() => parseAskArgs(["--model", "--background", "question"])).toThrow(RuntimeError);

    try {
      parseAskArgs(["--model", "--background", "question"]);
    } catch (error) {
      expect((error as RuntimeError).code).toBe("INVALID_ARGS");
      expect((error as RuntimeError).message).toBe(
        "--model value cannot start with '-'; pass a model name",
      );
    }
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
    const parsed = parseReviewArgs(["--base", "main", "focus", "on", "rollback"]);

    expect(parsed.base).toBe("main");
    expect(parsed.thinkingEffort).toBeUndefined();
    expect(parsed.focus).toBe("focus on rollback");
  });






  test("parseReviewArgs rejects --model followed by another flag", () => {
    expect(() => parseReviewArgs(["--model", "--background", "focus"])).toThrow(RuntimeError);

    try {
      parseReviewArgs(["--model", "--background", "focus"]);
    } catch (error) {
      expect((error as RuntimeError).code).toBe("INVALID_ARGS");
      expect((error as RuntimeError).message).toBe(
        "--model value cannot start with '-'; pass a model name",
      );
    }
  });

  test("parseReviewArgs hard-fails on unknown flags in flag-position", () => {
    // v0.3.6: warn-and-swallow was producing invisible-to-agent corruption
    // when wrappers invented flags like `--file` / `--context`. The bloated
    // focus blob made Kimi spin inside the 10-min timeout, looking like a
    // hang. Now any flag-shaped token that isn't in the known set throws
    // INVALID_ARGS, with the supported list and `--` escape hatch in the
    // error message.
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

  test("parseAskArgs hard-fails on unknown flag-shaped tokens at position 0", () => {
    expect(() => parseAskArgs(["--mystery", "tail"])).toThrow(
      /Unknown flag --mystery for ask.*Supported flags:.*Use `--` before flag-shaped prompt text/s,
    );
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

  test("parseRescueArgs preserves trailing-mode prose with flag-shaped tokens", () => {
    const parsed = parseRescueArgs(["explain", "git", "log", "-1"]);

    expect(parsed.prompt).toBe("explain git log -1");
  });

  test("parseRescueArgs `--` sentinel passes through flag-shaped prompt text", () => {
    const parsed = parseRescueArgs(["--", "--mystery", "foo"]);

    expect(parsed.prompt).toBe("--mystery foo");
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

  test("parseRescueArgs rejects --model followed by another flag", () => {
    expect(() => parseRescueArgs(["--model", "--background", "task"])).toThrow(RuntimeError);

    try {
      parseRescueArgs(["--model", "--background", "task"]);
    } catch (error) {
      expect((error as RuntimeError).code).toBe("INVALID_ARGS");
      expect((error as RuntimeError).message).toBe(
        "--model value cannot start with '-'; pass a model name",
      );
    }
  });

  test("parseRescueArgs rejects unknown flag-shaped tokens in flag-position", () => {
    expect(() => parseRescueArgs(["--mystery", "tail"])).toThrow(
      /Unknown flag --mystery for rescue.*Supported flags:.*Use `--` before flag-shaped prompt text/s,
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
    expect(parsed.json).toBeFalse();
  });

  test("parseJobLookupArgs accepts --json", () => {
    const parsed = parseJobLookupArgs(["job-123", "--json"]);

    expect(parsed.jobId).toBe("job-123");
    expect(parsed.json).toBeTrue();
  });

  test("parseJobLookupArgs unknown flag error includes supported flags", () => {
    expect(() => parseJobLookupArgs(["--kind", "rescue"])).toThrow(
      "Unknown flag --kind. Supported flags: --type <review|challenge|rescue|review_gate|ask>, --json.",
    );
  });
});

for (const [name, parse] of [["ask", parseAskArgs], ["rescue", parseRescueArgs], ["review", parseReviewArgs], ["challenge", (args: string[]) => parseReviewArgs(args, "challenge")]] as const) {
  describe(`${name} per-job budget`, () => {
    test.each([["30m", 1_800_000], ["1h", 3_600_000], ["90s", 90_000], ["15", 900_000], ["24h", 86_400_000]])("parses %s", (duration, expected) => {
      expect(parse(["--budget", String(duration), "scope"]).budgetMs).toBe(expected as number);
    });
    test("omission keeps the command default and -- escapes prompt text", () => {
      expect(parse(["scope"]).budgetMs).toBeUndefined();
      expect(parse(["--", "--budget", "25h"]).budgetMs).toBeUndefined();
    });
    test.each([[], ["0"], ["-1"], ["25h"], ["nope"], ["--fresh"]])("rejects invalid duration %j", (...value) => {
      expect(() => parse(["--budget", ...value])).toThrow(RuntimeError);
      try { parse(["--budget", ...value]); } catch (error) {
        expect(error).toMatchObject({ code: "INVALID_ARGS", stage: `${name}.parse` });
      }
    });
  });
}

for (const [name, parse] of [["ask", parseAskArgs], ["rescue", parseRescueArgs], ["review", parseReviewArgs], ["challenge", (args: string[]) => parseReviewArgs(args, "challenge")], ["pursue", parsePursueArgs], ["swarm", parseSwarmArgs]] as const) {
  test(`${name} budget errors have command stage and policy-specific advice`, () => {
    for (const value of ["invalid", "0", "25h", "--background"]) {
      let caught: unknown;
      try { parse(["--budget", value]); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ code: "INVALID_ARGS", stage: `${name}.parse` });
      const message = (caught as Error).message;
      if (value === "--background") expect(message).toBe("--budget requires a duration (e.g. 30m, 1h, 90s).");
      if (value === "25h") expect(message).toContain(name === "swarm" || name === "pursue"
        ? "the budget is a safety ceiling, not a scheduler"
        : "the budget is a response-time limit; a timed-out job is still a safe failure");
    }
  });
}

for (const parse of [parseAskArgs, parseRescueArgs]) {
  test(`${parse.name} handles help before validation or trailing-text slurp`, () => {
    for (const args of [["--help"], ["-h"], ["--budget", "--help"], ["-m", "kimi", "-h"], ["--unknown", "-h"]]) {
      expect(parse(args).help).toBe(true);
      expect(parse(args).prompt).toBeUndefined();
    }
    expect(parse(["--", "--help"]).help).toBeUndefined();
    expect(parse(["--", "--help"]).prompt).toBe("--help");
    // Prose ends the flag region: a later -h/--help is prompt text, not a help request.
    expect(parse(["what", "does", "du", "-h", "print"]).help).toBeUndefined();
    expect(parse(["what", "does", "du", "-h", "print"]).prompt).toBe("what does du -h print");
    expect(parse(["prose", "--help"]).help).toBeUndefined();
  });
}

for (const parse of [parseAskArgs, parseRescueArgs, parseReviewArgs, (a: string[]) => parseReviewArgs(a, "challenge"), parsePursueArgs, parseSwarmArgs]) {
  test("thinking syntax matrix: " + parse.name, () => {
    for (const effort of ["off", "LOW", "medium", "high", "future-effort2", "a".repeat(32)]) {
      for (const args of [["--thinking", effort], ["--thinking=" + effort]]) {
        expect(parse(args).thinkingEffort).toBe(effort.toLowerCase());
      }
    }
    for (const args of [["--thinking"], ["--thinking", "--budget"], ["--thinking="], ["--thinking", "a".repeat(33)], ["--thinking", "1high"], ["--thinking", "a_b"], ["--thinking", "high low"]]) {
      expect(() => parse(args)).toThrow(RuntimeError);
    }
    for (const flag of ["--no-thinking", "--no-thinking=false"]) {
      expect(() => parse([flag])).toThrow("use --thinking off");
    }
    expect(parse([]).thinkingEffort).toBeUndefined();
    expect(parse(["--", "--thinking", "off"]).thinkingEffort).toBeUndefined();
    expect(parse(["prose", "--thinking", "off"]).thinkingEffort).toBeUndefined();
  });
}

// Characterization of every parser's observable outcome: error code, stage and
// message, or the returned fields in key order. formatError renders `stage`, so
// stages are output and differ by flag and command on purpose.
type ParserOutcome =
  | { ok: Array<[string, unknown]> }
  | { error: [string, string, string] };

const CHARACTERIZED_PARSERS: Record<string, (argv: string[]) => object> = {
  ask: parseAskArgs,
  rescue: parseRescueArgs,
  review: (argv) => parseReviewArgs(argv),
  challenge: (argv) => parseReviewArgs(argv, "challenge"),
  pursue: parsePursueArgs,
  swarm: parseSwarmArgs,
};

const PARSER_OUTCOMES: Array<[string, string[], ParserOutcome]> = [
  ["ask", ["-m"], { error: ["INVALID_ARGS", "args.parse", "-m requires a model value."] }],
  ["ask", ["--model"], { error: ["INVALID_ARGS", "args.parse", "--model requires a model value."] }],
  ["ask", ["-m",""], { error: ["INVALID_ARGS", "args.parse", "-m requires a model value."] }],
  ["ask", ["--model",""], { error: ["INVALID_ARGS", "args.parse", "--model requires a model value."] }],
  ["ask", ["-m","-x"], { error: ["INVALID_ARGS", "args.parse", "-m value cannot start with '-'; pass a model name"] }],
  ["ask", ["--model","--x"], { error: ["INVALID_ARGS", "args.parse", "--model value cannot start with '-'; pass a model name"] }],
  ["ask", ["--mystery"], { error: ["INVALID_ARGS", "args.parse", "Unknown flag --mystery for ask. Supported flags: -m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>, --background, --wait, --fresh, -r, --resume <job-id|session-id>. Use `--` before flag-shaped prompt text to pass it through."] }],
  ["ask", ["-z"], { error: ["INVALID_ARGS", "args.parse", "Unknown flag -z for ask. Supported flags: -m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>, --background, --wait, --fresh, -r, --resume <job-id|session-id>. Use `--` before flag-shaped prompt text to pass it through."] }],
  ["ask", ["--mystery","tail"], { error: ["INVALID_ARGS", "args.parse", "Unknown flag --mystery for ask. Supported flags: -m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>, --background, --wait, --fresh, -r, --resume <job-id|session-id>. Use `--` before flag-shaped prompt text to pass it through."] }],
  ["ask", ["--thinking"], { error: ["INVALID_ARGS", "args.parse", "--thinking requires an effort matching [a-z][a-z0-9-]{0,31} (e.g. off, low, medium, high)."] }],
  ["ask", ["--thinking","BAD!"], { error: ["INVALID_ARGS", "args.parse", "--thinking requires an effort matching [a-z][a-z0-9-]{0,31} (e.g. off, low, medium, high)."] }],
  ["ask", ["--thinking=bad value"], { error: ["INVALID_ARGS", "args.parse", "--thinking requires an effort matching [a-z][a-z0-9-]{0,31} (e.g. off, low, medium, high)."] }],
  ["ask", ["--no-thinking"], { error: ["INVALID_ARGS", "args.parse", "--no-thinking is unsupported; use --thinking off"] }],
  ["ask", ["--no-thinking=x"], { error: ["INVALID_ARGS", "args.parse", "--no-thinking is unsupported; use --thinking off"] }],
  ["ask", ["--budget"], { error: ["INVALID_ARGS", "ask.parse", "--budget requires a duration (e.g. 30m, 1h, 90s)."] }],
  ["ask", ["--budget","0"], { error: ["INVALID_ARGS", "ask.parse", "--budget must be a positive duration."] }],
  ["ask", ["--budget","25h"], { error: ["INVALID_ARGS", "ask.parse", "--budget must be at most 24h (got \"25h\"); the budget is a response-time limit; a timed-out job is still a safe failure."] }],
  ["ask", ["--budget","x"], { error: ["INVALID_ARGS", "ask.parse", "--budget expects a duration like 30m, 1h, or 90s (bare number = minutes); got \"x\"."] }],
  ["ask", ["--budget","--wait"], { error: ["INVALID_ARGS", "ask.parse", "--budget requires a duration (e.g. 30m, 1h, 90s)."] }],
  ["ask", ["--thinking=HIGH","-m","k2","--budget","30m","--","-5","text"], { ok: [["budgetMs", 1800000], ["background", false], ["wait", false], ["fresh", false], ["resume", false], ["resumeTarget", undefined], ["model", "k2"], ["thinkingEffort", "high"], ["prompt", "-5 text"]] }],
  ["ask", ["--thinking","low","-5","prose"], { ok: [["budgetMs", undefined], ["background", false], ["wait", false], ["fresh", false], ["resume", false], ["resumeTarget", undefined], ["model", undefined], ["thinkingEffort", "low"], ["prompt", "-5 prose"]] }],
  ["ask", ["-","prose"], { ok: [["budgetMs", undefined], ["background", false], ["wait", false], ["fresh", false], ["resume", false], ["resumeTarget", undefined], ["model", undefined], ["thinkingEffort", undefined], ["prompt", "- prose"]] }],
  ["ask", ["plain","--mystery"], { ok: [["budgetMs", undefined], ["background", false], ["wait", false], ["fresh", false], ["resume", false], ["resumeTarget", undefined], ["model", undefined], ["thinkingEffort", undefined], ["prompt", "plain --mystery"]] }],
  ["ask", [], { ok: [["budgetMs", undefined], ["background", false], ["wait", false], ["fresh", false], ["resume", false], ["resumeTarget", undefined], ["model", undefined], ["thinkingEffort", undefined], ["prompt", undefined]] }],
  ["ask", ["--resume"], { error: ["INVALID_ARGS", "ask.parse", "--resume requires a job-id or session-id. Use -r to resume the latest ask session for this repo."] }],
  ["ask", ["--resume","-x"], { error: ["INVALID_ARGS", "ask.parse", "--resume requires a job-id or session-id. Use -r to resume the latest ask session for this repo."] }],
  ["ask", ["--fresh","-r"], { error: ["INVALID_ARGS", "ask.parse", "ask does not allow --fresh and --resume together."] }],
  ["ask", ["--fresh","--resume","id"], { error: ["INVALID_ARGS", "ask.parse", "ask does not allow --fresh and --resume together."] }],
  ["ask", ["--resume","id","tail"], { error: ["INVALID_ARGS", "ask.parse", "--resume only accepts a job-id or session-id. Use -r to resume the latest ask session with a prompt."] }],
  ["ask", ["--fresh","-r","--mystery"], { error: ["INVALID_ARGS", "args.parse", "Unknown flag --mystery for ask. Supported flags: -m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>, --background, --wait, --fresh, -r, --resume <job-id|session-id>. Use `--` before flag-shaped prompt text to pass it through."] }],
  ["ask", ["-r","prompt"], { ok: [["budgetMs", undefined], ["background", false], ["wait", false], ["fresh", false], ["resume", true], ["resumeTarget", undefined], ["model", undefined], ["thinkingEffort", undefined], ["prompt", "prompt"]] }],
  ["ask", ["--resume","id"], { ok: [["budgetMs", undefined], ["background", false], ["wait", false], ["fresh", false], ["resume", true], ["resumeTarget", "id"], ["model", undefined], ["thinkingEffort", undefined], ["prompt", undefined]] }],
  ["ask", ["--background","--wait","prompt"], { ok: [["budgetMs", undefined], ["background", true], ["wait", true], ["fresh", false], ["resume", false], ["resumeTarget", undefined], ["model", undefined], ["thinkingEffort", undefined], ["prompt", "prompt"]] }],
  ["ask", ["--help"], { ok: [["help", true], ["background", false], ["wait", false], ["fresh", false], ["resume", false]] }],
  ["ask", ["-m","k","-h"], { ok: [["help", true], ["background", false], ["wait", false], ["fresh", false], ["resume", false]] }],
  ["rescue", ["-m"], { error: ["INVALID_ARGS", "args.parse", "-m requires a model value."] }],
  ["rescue", ["--model"], { error: ["INVALID_ARGS", "args.parse", "--model requires a model value."] }],
  ["rescue", ["-m",""], { error: ["INVALID_ARGS", "args.parse", "-m requires a model value."] }],
  ["rescue", ["--model",""], { error: ["INVALID_ARGS", "args.parse", "--model requires a model value."] }],
  ["rescue", ["-m","-x"], { error: ["INVALID_ARGS", "args.parse", "-m value cannot start with '-'; pass a model name"] }],
  ["rescue", ["--model","--x"], { error: ["INVALID_ARGS", "args.parse", "--model value cannot start with '-'; pass a model name"] }],
  ["rescue", ["--mystery"], { error: ["INVALID_ARGS", "args.parse", "Unknown flag --mystery for rescue. Supported flags: -m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>, --background, --wait, --fresh, -r, --resume <job-id|session-id>. Use `--` before flag-shaped prompt text to pass it through."] }],
  ["rescue", ["-z"], { error: ["INVALID_ARGS", "args.parse", "Unknown flag -z for rescue. Supported flags: -m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>, --background, --wait, --fresh, -r, --resume <job-id|session-id>. Use `--` before flag-shaped prompt text to pass it through."] }],
  ["rescue", ["--mystery","tail"], { error: ["INVALID_ARGS", "args.parse", "Unknown flag --mystery for rescue. Supported flags: -m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>, --background, --wait, --fresh, -r, --resume <job-id|session-id>. Use `--` before flag-shaped prompt text to pass it through."] }],
  ["rescue", ["--thinking"], { error: ["INVALID_ARGS", "args.parse", "--thinking requires an effort matching [a-z][a-z0-9-]{0,31} (e.g. off, low, medium, high)."] }],
  ["rescue", ["--thinking","BAD!"], { error: ["INVALID_ARGS", "args.parse", "--thinking requires an effort matching [a-z][a-z0-9-]{0,31} (e.g. off, low, medium, high)."] }],
  ["rescue", ["--thinking=bad value"], { error: ["INVALID_ARGS", "args.parse", "--thinking requires an effort matching [a-z][a-z0-9-]{0,31} (e.g. off, low, medium, high)."] }],
  ["rescue", ["--no-thinking"], { error: ["INVALID_ARGS", "args.parse", "--no-thinking is unsupported; use --thinking off"] }],
  ["rescue", ["--no-thinking=x"], { error: ["INVALID_ARGS", "args.parse", "--no-thinking is unsupported; use --thinking off"] }],
  ["rescue", ["--budget"], { error: ["INVALID_ARGS", "rescue.parse", "--budget requires a duration (e.g. 30m, 1h, 90s)."] }],
  ["rescue", ["--budget","0"], { error: ["INVALID_ARGS", "rescue.parse", "--budget must be a positive duration."] }],
  ["rescue", ["--budget","25h"], { error: ["INVALID_ARGS", "rescue.parse", "--budget must be at most 24h (got \"25h\"); the budget is a response-time limit; a timed-out job is still a safe failure."] }],
  ["rescue", ["--budget","x"], { error: ["INVALID_ARGS", "rescue.parse", "--budget expects a duration like 30m, 1h, or 90s (bare number = minutes); got \"x\"."] }],
  ["rescue", ["--budget","--wait"], { error: ["INVALID_ARGS", "rescue.parse", "--budget requires a duration (e.g. 30m, 1h, 90s)."] }],
  ["rescue", ["--thinking=HIGH","-m","k2","--budget","30m","--","-5","text"], { ok: [["budgetMs", 1800000], ["background", false], ["wait", false], ["fresh", false], ["resume", false], ["resumeTarget", undefined], ["model", "k2"], ["thinkingEffort", "high"], ["prompt", "-5 text"]] }],
  ["rescue", ["--thinking","low","-5","prose"], { ok: [["budgetMs", undefined], ["background", false], ["wait", false], ["fresh", false], ["resume", false], ["resumeTarget", undefined], ["model", undefined], ["thinkingEffort", "low"], ["prompt", "-5 prose"]] }],
  ["rescue", ["-","prose"], { ok: [["budgetMs", undefined], ["background", false], ["wait", false], ["fresh", false], ["resume", false], ["resumeTarget", undefined], ["model", undefined], ["thinkingEffort", undefined], ["prompt", "- prose"]] }],
  ["rescue", ["plain","--mystery"], { ok: [["budgetMs", undefined], ["background", false], ["wait", false], ["fresh", false], ["resume", false], ["resumeTarget", undefined], ["model", undefined], ["thinkingEffort", undefined], ["prompt", "plain --mystery"]] }],
  ["rescue", [], { ok: [["budgetMs", undefined], ["background", false], ["wait", false], ["fresh", false], ["resume", false], ["resumeTarget", undefined], ["model", undefined], ["thinkingEffort", undefined], ["prompt", undefined]] }],
  ["rescue", ["--resume"], { error: ["INVALID_ARGS", "rescue.parse", "--resume requires a job-id or session-id. Use -r to resume the latest rescue session for this repo."] }],
  ["rescue", ["--resume","-x"], { error: ["INVALID_ARGS", "rescue.parse", "--resume requires a job-id or session-id. Use -r to resume the latest rescue session for this repo."] }],
  ["rescue", ["--fresh","-r"], { error: ["INVALID_ARGS", "rescue.parse", "rescue does not allow --fresh and --resume together."] }],
  ["rescue", ["--fresh","--resume","id"], { error: ["INVALID_ARGS", "rescue.parse", "rescue does not allow --fresh and --resume together."] }],
  ["rescue", ["--resume","id","tail"], { error: ["INVALID_ARGS", "rescue.parse", "--resume only accepts a job-id or session-id. Use -r to resume the latest rescue session with a prompt."] }],
  ["rescue", ["--fresh","-r","--mystery"], { error: ["INVALID_ARGS", "args.parse", "Unknown flag --mystery for rescue. Supported flags: -m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>, --background, --wait, --fresh, -r, --resume <job-id|session-id>. Use `--` before flag-shaped prompt text to pass it through."] }],
  ["rescue", ["-r","prompt"], { ok: [["budgetMs", undefined], ["background", false], ["wait", false], ["fresh", false], ["resume", true], ["resumeTarget", undefined], ["model", undefined], ["thinkingEffort", undefined], ["prompt", "prompt"]] }],
  ["rescue", ["--resume","id"], { ok: [["budgetMs", undefined], ["background", false], ["wait", false], ["fresh", false], ["resume", true], ["resumeTarget", "id"], ["model", undefined], ["thinkingEffort", undefined], ["prompt", undefined]] }],
  ["rescue", ["--background","--wait","prompt"], { ok: [["budgetMs", undefined], ["background", true], ["wait", true], ["fresh", false], ["resume", false], ["resumeTarget", undefined], ["model", undefined], ["thinkingEffort", undefined], ["prompt", "prompt"]] }],
  ["rescue", ["--help"], { ok: [["help", true], ["background", false], ["wait", false], ["fresh", false], ["resume", false]] }],
  ["rescue", ["-m","k","-h"], { ok: [["help", true], ["background", false], ["wait", false], ["fresh", false], ["resume", false]] }],
  ["review", ["-m"], { error: ["INVALID_ARGS", "args.parse", "-m requires a model value."] }],
  ["review", ["--model"], { error: ["INVALID_ARGS", "args.parse", "--model requires a model value."] }],
  ["review", ["-m",""], { error: ["INVALID_ARGS", "args.parse", "-m requires a model value."] }],
  ["review", ["--model",""], { error: ["INVALID_ARGS", "args.parse", "--model requires a model value."] }],
  ["review", ["-m","-x"], { error: ["INVALID_ARGS", "args.parse", "-m value cannot start with '-'; pass a model name"] }],
  ["review", ["--model","--x"], { error: ["INVALID_ARGS", "args.parse", "--model value cannot start with '-'; pass a model name"] }],
  ["review", ["--mystery"], { error: ["INVALID_ARGS", "args.parse", "Unknown flag --mystery for review. Supported flags: --base <ref>, -m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>. Use `--` before flag-shaped focus text to pass it through."] }],
  ["review", ["-z"], { error: ["INVALID_ARGS", "args.parse", "Unknown flag -z for review. Supported flags: --base <ref>, -m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>. Use `--` before flag-shaped focus text to pass it through."] }],
  ["review", ["--mystery","tail"], { error: ["INVALID_ARGS", "args.parse", "Unknown flag --mystery for review. Supported flags: --base <ref>, -m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>. Use `--` before flag-shaped focus text to pass it through."] }],
  ["review", ["--thinking"], { error: ["INVALID_ARGS", "args.parse", "--thinking requires an effort matching [a-z][a-z0-9-]{0,31} (e.g. off, low, medium, high)."] }],
  ["review", ["--thinking","BAD!"], { error: ["INVALID_ARGS", "args.parse", "--thinking requires an effort matching [a-z][a-z0-9-]{0,31} (e.g. off, low, medium, high)."] }],
  ["review", ["--thinking=bad value"], { error: ["INVALID_ARGS", "args.parse", "--thinking requires an effort matching [a-z][a-z0-9-]{0,31} (e.g. off, low, medium, high)."] }],
  ["review", ["--no-thinking"], { error: ["INVALID_ARGS", "args.parse", "--no-thinking is unsupported; use --thinking off"] }],
  ["review", ["--no-thinking=x"], { error: ["INVALID_ARGS", "args.parse", "--no-thinking is unsupported; use --thinking off"] }],
  ["review", ["--budget"], { error: ["INVALID_ARGS", "review.parse", "--budget requires a duration (e.g. 30m, 1h, 90s)."] }],
  ["review", ["--budget","0"], { error: ["INVALID_ARGS", "review.parse", "--budget must be a positive duration."] }],
  ["review", ["--budget","25h"], { error: ["INVALID_ARGS", "review.parse", "--budget must be at most 24h (got \"25h\"); the budget is a response-time limit; a timed-out job is still a safe failure."] }],
  ["review", ["--budget","x"], { error: ["INVALID_ARGS", "review.parse", "--budget expects a duration like 30m, 1h, or 90s (bare number = minutes); got \"x\"."] }],
  ["review", ["--budget","--wait"], { error: ["INVALID_ARGS", "review.parse", "--budget requires a duration (e.g. 30m, 1h, 90s)."] }],
  ["review", ["--thinking=HIGH","-m","k2","--budget","30m","--","-5","text"], { ok: [["budgetMs", 1800000], ["base", undefined], ["background", false], ["wait", false], ["model", "k2"], ["thinkingEffort", "high"], ["focus", "-5 text"]] }],
  ["review", ["--thinking","low","-5","prose"], { ok: [["budgetMs", undefined], ["base", undefined], ["background", false], ["wait", false], ["model", undefined], ["thinkingEffort", "low"], ["focus", "-5 prose"]] }],
  ["review", ["-","prose"], { ok: [["budgetMs", undefined], ["base", undefined], ["background", false], ["wait", false], ["model", undefined], ["thinkingEffort", undefined], ["focus", "- prose"]] }],
  ["review", ["plain","--mystery"], { ok: [["budgetMs", undefined], ["base", undefined], ["background", false], ["wait", false], ["model", undefined], ["thinkingEffort", undefined], ["focus", "plain --mystery"]] }],
  ["review", [], { ok: [["budgetMs", undefined], ["base", undefined], ["background", false], ["wait", false], ["model", undefined], ["thinkingEffort", undefined], ["focus", undefined]] }],
  ["review", ["--base"], { error: ["INVALID_ARGS", "args.parse", "--base requires a ref value."] }],
  ["review", ["--base","-x"], { error: ["INVALID_ARGS", "args.parse", "--base value cannot start with '-'; pass a branch, tag, or commit ref."] }],
  ["review", ["--base","main","--background","--wait","focus"], { ok: [["budgetMs", undefined], ["base", "main"], ["background", true], ["wait", true], ["model", undefined], ["thinkingEffort", undefined], ["focus", "focus"]] }],
  ["review", ["--fresh"], { error: ["INVALID_ARGS", "args.parse", "Unknown flag --fresh for review. Supported flags: --base <ref>, -m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>. Use `--` before flag-shaped focus text to pass it through."] }],
  ["challenge", ["-m"], { error: ["INVALID_ARGS", "args.parse", "-m requires a model value."] }],
  ["challenge", ["--model"], { error: ["INVALID_ARGS", "args.parse", "--model requires a model value."] }],
  ["challenge", ["-m",""], { error: ["INVALID_ARGS", "args.parse", "-m requires a model value."] }],
  ["challenge", ["--model",""], { error: ["INVALID_ARGS", "args.parse", "--model requires a model value."] }],
  ["challenge", ["-m","-x"], { error: ["INVALID_ARGS", "args.parse", "-m value cannot start with '-'; pass a model name"] }],
  ["challenge", ["--model","--x"], { error: ["INVALID_ARGS", "args.parse", "--model value cannot start with '-'; pass a model name"] }],
  ["challenge", ["--mystery"], { error: ["INVALID_ARGS", "args.parse", "Unknown flag --mystery for challenge. Supported flags: --base <ref>, -m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>. Use `--` before flag-shaped focus text to pass it through."] }],
  ["challenge", ["-z"], { error: ["INVALID_ARGS", "args.parse", "Unknown flag -z for challenge. Supported flags: --base <ref>, -m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>. Use `--` before flag-shaped focus text to pass it through."] }],
  ["challenge", ["--mystery","tail"], { error: ["INVALID_ARGS", "args.parse", "Unknown flag --mystery for challenge. Supported flags: --base <ref>, -m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>. Use `--` before flag-shaped focus text to pass it through."] }],
  ["challenge", ["--thinking"], { error: ["INVALID_ARGS", "args.parse", "--thinking requires an effort matching [a-z][a-z0-9-]{0,31} (e.g. off, low, medium, high)."] }],
  ["challenge", ["--thinking","BAD!"], { error: ["INVALID_ARGS", "args.parse", "--thinking requires an effort matching [a-z][a-z0-9-]{0,31} (e.g. off, low, medium, high)."] }],
  ["challenge", ["--thinking=bad value"], { error: ["INVALID_ARGS", "args.parse", "--thinking requires an effort matching [a-z][a-z0-9-]{0,31} (e.g. off, low, medium, high)."] }],
  ["challenge", ["--no-thinking"], { error: ["INVALID_ARGS", "args.parse", "--no-thinking is unsupported; use --thinking off"] }],
  ["challenge", ["--no-thinking=x"], { error: ["INVALID_ARGS", "args.parse", "--no-thinking is unsupported; use --thinking off"] }],
  ["challenge", ["--budget"], { error: ["INVALID_ARGS", "challenge.parse", "--budget requires a duration (e.g. 30m, 1h, 90s)."] }],
  ["challenge", ["--budget","0"], { error: ["INVALID_ARGS", "challenge.parse", "--budget must be a positive duration."] }],
  ["challenge", ["--budget","25h"], { error: ["INVALID_ARGS", "challenge.parse", "--budget must be at most 24h (got \"25h\"); the budget is a response-time limit; a timed-out job is still a safe failure."] }],
  ["challenge", ["--budget","x"], { error: ["INVALID_ARGS", "challenge.parse", "--budget expects a duration like 30m, 1h, or 90s (bare number = minutes); got \"x\"."] }],
  ["challenge", ["--budget","--wait"], { error: ["INVALID_ARGS", "challenge.parse", "--budget requires a duration (e.g. 30m, 1h, 90s)."] }],
  ["challenge", ["--thinking=HIGH","-m","k2","--budget","30m","--","-5","text"], { ok: [["budgetMs", 1800000], ["base", undefined], ["background", false], ["wait", false], ["model", "k2"], ["thinkingEffort", "high"], ["focus", "-5 text"]] }],
  ["challenge", ["--thinking","low","-5","prose"], { ok: [["budgetMs", undefined], ["base", undefined], ["background", false], ["wait", false], ["model", undefined], ["thinkingEffort", "low"], ["focus", "-5 prose"]] }],
  ["challenge", ["-","prose"], { ok: [["budgetMs", undefined], ["base", undefined], ["background", false], ["wait", false], ["model", undefined], ["thinkingEffort", undefined], ["focus", "- prose"]] }],
  ["challenge", ["plain","--mystery"], { ok: [["budgetMs", undefined], ["base", undefined], ["background", false], ["wait", false], ["model", undefined], ["thinkingEffort", undefined], ["focus", "plain --mystery"]] }],
  ["challenge", [], { ok: [["budgetMs", undefined], ["base", undefined], ["background", false], ["wait", false], ["model", undefined], ["thinkingEffort", undefined], ["focus", undefined]] }],
  ["challenge", ["--base"], { error: ["INVALID_ARGS", "args.parse", "--base requires a ref value."] }],
  ["challenge", ["--base","-x"], { error: ["INVALID_ARGS", "args.parse", "--base value cannot start with '-'; pass a branch, tag, or commit ref."] }],
  ["challenge", ["--base","main","--background","--wait","focus"], { ok: [["budgetMs", undefined], ["base", "main"], ["background", true], ["wait", true], ["model", undefined], ["thinkingEffort", undefined], ["focus", "focus"]] }],
  ["challenge", ["--fresh"], { error: ["INVALID_ARGS", "args.parse", "Unknown flag --fresh for challenge. Supported flags: --base <ref>, -m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>. Use `--` before flag-shaped focus text to pass it through."] }],
  ["pursue", ["-m"], { error: ["INVALID_ARGS", "pursue.parse", "-m requires a model value."] }],
  ["pursue", ["--model"], { error: ["INVALID_ARGS", "pursue.parse", "--model requires a model value."] }],
  ["pursue", ["-m",""], { error: ["INVALID_ARGS", "pursue.parse", "-m requires a model value."] }],
  ["pursue", ["--model",""], { error: ["INVALID_ARGS", "pursue.parse", "--model requires a model value."] }],
  ["pursue", ["-m","-x"], { error: ["INVALID_ARGS", "pursue.parse", "-m value cannot start with '-'; pass a model name"] }],
  ["pursue", ["--model","--x"], { error: ["INVALID_ARGS", "pursue.parse", "--model value cannot start with '-'; pass a model name"] }],
  ["pursue", ["--mystery"], { error: ["INVALID_ARGS", "pursue.parse", "Unknown flag --mystery for pursue. Supported flags: -m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>, --turns <N>. Use `--` before flag-shaped objective text to pass it through."] }],
  ["pursue", ["-z"], { error: ["INVALID_ARGS", "pursue.parse", "Unknown flag -z for pursue. Supported flags: -m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>, --turns <N>. Use `--` before flag-shaped objective text to pass it through."] }],
  ["pursue", ["--mystery","tail"], { error: ["INVALID_ARGS", "pursue.parse", "Unknown flag --mystery for pursue. Supported flags: -m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>, --turns <N>. Use `--` before flag-shaped objective text to pass it through."] }],
  ["pursue", ["--thinking"], { error: ["INVALID_ARGS", "args.parse", "--thinking requires an effort matching [a-z][a-z0-9-]{0,31} (e.g. off, low, medium, high)."] }],
  ["pursue", ["--thinking","BAD!"], { error: ["INVALID_ARGS", "args.parse", "--thinking requires an effort matching [a-z][a-z0-9-]{0,31} (e.g. off, low, medium, high)."] }],
  ["pursue", ["--thinking=bad value"], { error: ["INVALID_ARGS", "args.parse", "--thinking requires an effort matching [a-z][a-z0-9-]{0,31} (e.g. off, low, medium, high)."] }],
  ["pursue", ["--no-thinking"], { error: ["INVALID_ARGS", "args.parse", "--no-thinking is unsupported; use --thinking off"] }],
  ["pursue", ["--no-thinking=x"], { error: ["INVALID_ARGS", "args.parse", "--no-thinking is unsupported; use --thinking off"] }],
  ["pursue", ["--budget"], { error: ["INVALID_ARGS", "pursue.parse", "--budget requires a duration (e.g. 30m, 1h, 90s)."] }],
  ["pursue", ["--budget","0"], { error: ["INVALID_ARGS", "pursue.parse", "--budget must be a positive duration."] }],
  ["pursue", ["--budget","25h"], { error: ["INVALID_ARGS", "pursue.parse", "--budget must be at most 24h (got \"25h\"); the budget is a safety ceiling, not a scheduler."] }],
  ["pursue", ["--budget","x"], { error: ["INVALID_ARGS", "pursue.parse", "--budget expects a duration like 30m, 1h, or 90s (bare number = minutes); got \"x\"."] }],
  ["pursue", ["--budget","--wait"], { error: ["INVALID_ARGS", "pursue.parse", "--budget requires a duration (e.g. 30m, 1h, 90s)."] }],
  ["pursue", ["--thinking=HIGH","-m","k2","--budget","30m","--","-5","text"], { ok: [["budgetMs", 1800000], ["turns", undefined], ["model", "k2"], ["thinkingEffort", "high"], ["objective", "-5 text"]] }],
  ["pursue", ["--thinking","low","-5","prose"], { ok: [["budgetMs", undefined], ["turns", undefined], ["model", undefined], ["thinkingEffort", "low"], ["objective", "-5 prose"]] }],
  ["pursue", ["-","prose"], { ok: [["budgetMs", undefined], ["turns", undefined], ["model", undefined], ["thinkingEffort", undefined], ["objective", "- prose"]] }],
  ["pursue", ["plain","--mystery"], { ok: [["budgetMs", undefined], ["turns", undefined], ["model", undefined], ["thinkingEffort", undefined], ["objective", "plain --mystery"]] }],
  ["pursue", [], { ok: [["budgetMs", undefined], ["turns", undefined], ["model", undefined], ["thinkingEffort", undefined], ["objective", undefined]] }],
  ["pursue", ["--turns"], { error: ["INVALID_ARGS", "pursue.parse", "--turns requires a positive integer."] }],
  ["pursue", ["--turns","-1"], { error: ["INVALID_ARGS", "pursue.parse", "--turns requires a positive integer."] }],
  ["pursue", ["--turns","0"], { error: ["INVALID_ARGS", "pursue.parse", "--turns must be a positive integer."] }],
  ["pursue", ["--turns","1.5"], { error: ["INVALID_ARGS", "pursue.parse", "--turns must be a positive integer."] }],
  ["pursue", ["--turns","abc"], { error: ["INVALID_ARGS", "pursue.parse", "--turns must be a positive integer."] }],
  ["pursue", ["--turns","1e2"], { ok: [["budgetMs", undefined], ["turns", 100], ["model", undefined], ["thinkingEffort", undefined], ["objective", undefined]] }],
  ["pursue", ["--turns","3","obj"], { ok: [["budgetMs", undefined], ["turns", 3], ["model", undefined], ["thinkingEffort", undefined], ["objective", "obj"]] }],
  ["swarm", ["-m"], { error: ["INVALID_ARGS", "swarm.parse", "-m requires a model value."] }],
  ["swarm", ["--model"], { error: ["INVALID_ARGS", "swarm.parse", "--model requires a model value."] }],
  ["swarm", ["-m",""], { error: ["INVALID_ARGS", "swarm.parse", "-m requires a model value."] }],
  ["swarm", ["--model",""], { error: ["INVALID_ARGS", "swarm.parse", "--model requires a model value."] }],
  ["swarm", ["-m","-x"], { error: ["INVALID_ARGS", "swarm.parse", "-m value cannot start with '-'; pass a model name"] }],
  ["swarm", ["--model","--x"], { error: ["INVALID_ARGS", "swarm.parse", "--model value cannot start with '-'; pass a model name"] }],
  ["swarm", ["--mystery"], { error: ["INVALID_ARGS", "swarm.parse", "Unknown flag --mystery for swarm. Supported flags: -m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>, --cap <N>, --max-concurrency <N>, --write. Use `--` before flag-shaped objective text to pass it through."] }],
  ["swarm", ["-z"], { error: ["INVALID_ARGS", "swarm.parse", "Unknown flag -z for swarm. Supported flags: -m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>, --cap <N>, --max-concurrency <N>, --write. Use `--` before flag-shaped objective text to pass it through."] }],
  ["swarm", ["--mystery","tail"], { error: ["INVALID_ARGS", "swarm.parse", "Unknown flag --mystery for swarm. Supported flags: -m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>, --cap <N>, --max-concurrency <N>, --write. Use `--` before flag-shaped objective text to pass it through."] }],
  ["swarm", ["--thinking"], { error: ["INVALID_ARGS", "args.parse", "--thinking requires an effort matching [a-z][a-z0-9-]{0,31} (e.g. off, low, medium, high)."] }],
  ["swarm", ["--thinking","BAD!"], { error: ["INVALID_ARGS", "args.parse", "--thinking requires an effort matching [a-z][a-z0-9-]{0,31} (e.g. off, low, medium, high)."] }],
  ["swarm", ["--thinking=bad value"], { error: ["INVALID_ARGS", "args.parse", "--thinking requires an effort matching [a-z][a-z0-9-]{0,31} (e.g. off, low, medium, high)."] }],
  ["swarm", ["--no-thinking"], { error: ["INVALID_ARGS", "args.parse", "--no-thinking is unsupported; use --thinking off"] }],
  ["swarm", ["--no-thinking=x"], { error: ["INVALID_ARGS", "args.parse", "--no-thinking is unsupported; use --thinking off"] }],
  ["swarm", ["--budget"], { error: ["INVALID_ARGS", "swarm.parse", "--budget requires a duration (e.g. 30m, 1h, 90s)."] }],
  ["swarm", ["--budget","0"], { error: ["INVALID_ARGS", "swarm.parse", "--budget must be a positive duration."] }],
  ["swarm", ["--budget","25h"], { error: ["INVALID_ARGS", "swarm.parse", "--budget must be at most 24h (got \"25h\"); the budget is a safety ceiling, not a scheduler."] }],
  ["swarm", ["--budget","x"], { error: ["INVALID_ARGS", "swarm.parse", "--budget expects a duration like 30m, 1h, or 90s (bare number = minutes); got \"x\"."] }],
  ["swarm", ["--budget","--wait"], { error: ["INVALID_ARGS", "swarm.parse", "--budget requires a duration (e.g. 30m, 1h, 90s)."] }],
  ["swarm", ["--thinking=HIGH","-m","k2","--budget","30m","--","-5","text"], { ok: [["budgetMs", 1800000], ["cap", undefined], ["maxConcurrency", undefined], ["write", false], ["model", "k2"], ["thinkingEffort", "high"], ["objective", "-5 text"]] }],
  ["swarm", ["--thinking","low","-5","prose"], { ok: [["budgetMs", undefined], ["cap", undefined], ["maxConcurrency", undefined], ["write", false], ["model", undefined], ["thinkingEffort", "low"], ["objective", "-5 prose"]] }],
  ["swarm", ["-","prose"], { ok: [["budgetMs", undefined], ["cap", undefined], ["maxConcurrency", undefined], ["write", false], ["model", undefined], ["thinkingEffort", undefined], ["objective", "- prose"]] }],
  ["swarm", ["plain","--mystery"], { ok: [["budgetMs", undefined], ["cap", undefined], ["maxConcurrency", undefined], ["write", false], ["model", undefined], ["thinkingEffort", undefined], ["objective", "plain --mystery"]] }],
  ["swarm", [], { ok: [["budgetMs", undefined], ["cap", undefined], ["maxConcurrency", undefined], ["write", false], ["model", undefined], ["thinkingEffort", undefined], ["objective", undefined]] }],
  ["swarm", ["--cap"], { error: ["INVALID_ARGS", "swarm.parse", "--cap requires a positive integer."] }],
  ["swarm", ["--cap","-1"], { error: ["INVALID_ARGS", "swarm.parse", "--cap requires a positive integer."] }],
  ["swarm", ["--cap","0"], { error: ["INVALID_ARGS", "swarm.parse", "--cap must be a positive integer."] }],
  ["swarm", ["--cap","1.5"], { error: ["INVALID_ARGS", "swarm.parse", "--cap must be a positive integer."] }],
  ["swarm", ["--cap","abc"], { error: ["INVALID_ARGS", "swarm.parse", "--cap must be a positive integer."] }],
  ["swarm", ["--cap","1e2"], { ok: [["budgetMs", undefined], ["cap", 100], ["maxConcurrency", undefined], ["write", false], ["model", undefined], ["thinkingEffort", undefined], ["objective", undefined]] }],
  ["swarm", ["--max-concurrency"], { error: ["INVALID_ARGS", "swarm.parse", "--max-concurrency requires a positive integer."] }],
  ["swarm", ["--max-concurrency","-1"], { error: ["INVALID_ARGS", "swarm.parse", "--max-concurrency requires a positive integer."] }],
  ["swarm", ["--max-concurrency","0"], { error: ["INVALID_ARGS", "swarm.parse", "--max-concurrency must be a positive integer."] }],
  ["swarm", ["--max-concurrency","1.5"], { error: ["INVALID_ARGS", "swarm.parse", "--max-concurrency must be a positive integer."] }],
  ["swarm", ["--max-concurrency","abc"], { error: ["INVALID_ARGS", "swarm.parse", "--max-concurrency must be a positive integer."] }],
  ["swarm", ["--max-concurrency","1e2"], { ok: [["budgetMs", undefined], ["cap", undefined], ["maxConcurrency", 100], ["write", false], ["model", undefined], ["thinkingEffort", undefined], ["objective", undefined]] }],
  ["swarm", ["--write","--cap","2","--max-concurrency","3","obj"], { ok: [["budgetMs", undefined], ["cap", 2], ["maxConcurrency", 3], ["write", true], ["model", undefined], ["thinkingEffort", undefined], ["objective", "obj"]] }],
];

describe("parser outcome characterization", () => {
  test.each(PARSER_OUTCOMES)("%s %j", (command, argv, expected) => {
    let actual: ParserOutcome;
    try {
      actual = { ok: Object.entries(CHARACTERIZED_PARSERS[command]!([...argv])) };
    } catch (error) {
      if (!(error instanceof RuntimeError)) throw error;
      actual = { error: [error.code, error.stage, error.message] };
    }
    expect(actual).toStrictEqual(expected);
  });
});
