import { RuntimeError } from "./errors.js";

export interface KimiFlagState {
  model?: string;
  thinking?: boolean;
}

export interface AskArgs extends KimiFlagState {
  fresh: boolean;
  resume: boolean;
  resumeTarget?: string;
  prompt?: string;
}

export interface ReviewArgs extends KimiFlagState {
  base?: string;
  background: boolean;
  wait: boolean;
  focus?: string;
}

export interface RescueArgs extends KimiFlagState {
  background: boolean;
  wait: boolean;
  fresh: boolean;
  resume: boolean;
  resumeTarget?: string;
  prompt?: string;
}

export interface JobLookupArgs {
  jobId?: string;
  type?: Exclude<
    import("./types.js").ManagedCommandType,
    never
  >;
}

export function parseAskArgs(argv: string[]): AskArgs {
  let model: string | undefined;
  let thinking: boolean | undefined;
  let fresh = false;
  let resume = false;
  let resumeTarget: string | undefined;
  let explicitResumeTarget = false;
  let trailingTokens: string[] | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      trailingTokens = argv.slice(index + 1);
      break;
    }

    if (!token.startsWith("-")) {
      trailingTokens = argv.slice(index);
      break;
    }

    switch (token) {
      case "-m":
      case "--model": {
        const value = argv[index + 1];
        if (!value) {
          throw new RuntimeError("INVALID_ARGS", `${token} requires a model value.`, "args.parse");
        }
        model = value;
        index += 1;
        break;
      }
      case "--fresh":
        fresh = true;
        break;
      case "-r":
        resume = true;
        break;
      case "--resume": {
        const value = argv[index + 1];
        if (!value || value.startsWith("-")) {
          throw new RuntimeError(
            "INVALID_ARGS",
            "--resume requires a job-id or session-id. Use -r to resume the latest ask session for this repo.",
            "ask.parse",
          );
        }
        resume = true;
        resumeTarget = value;
        explicitResumeTarget = true;
        index += 1;
        break;
      }
      case "--thinking":
        thinking = true;
        break;
      case "--no-thinking":
        thinking = false;
        break;
      default:
        trailingTokens = argv.slice(index);
        index = argv.length;
        break;
    }
  }

  if (fresh && resume) {
    throw new RuntimeError(
      "INVALID_ARGS",
      "ask does not allow --fresh and --resume together.",
      "ask.parse",
    );
  }

  if (explicitResumeTarget && trailingTokens?.length) {
    throw new RuntimeError(
      "INVALID_ARGS",
      "--resume only accepts a job-id or session-id. Use -r to resume the latest ask session with a prompt.",
      "ask.parse",
    );
  }

  return {
    fresh,
    resume,
    resumeTarget,
    model,
    thinking,
    prompt: trailingTokens?.join(" "),
  };
}

export function parseReviewArgs(argv: string[]): ReviewArgs {
  const parsed = parseKnownFlags(
    argv,
    new Set(["--base", "--background", "--wait", "-m", "--model", "--thinking", "--no-thinking"]),
  );

  return {
    base: parsed.base,
    background: parsed.background,
    wait: parsed.wait,
    model: parsed.model,
    thinking: parsed.thinking,
    focus: parsed.trailingText,
  };
}

export function parseRescueArgs(argv: string[]): RescueArgs {
  let model: string | undefined;
  let thinking: boolean | undefined;
  let background = false;
  let wait = false;
  let fresh = false;
  let resume = false;
  let resumeTarget: string | undefined;
  let explicitResumeTarget = false;
  let trailingTokens: string[] | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      trailingTokens = argv.slice(index + 1);
      break;
    }

    if (!token.startsWith("-")) {
      trailingTokens = argv.slice(index);
      break;
    }

    switch (token) {
      case "-m":
      case "--model": {
        const value = argv[index + 1];
        if (!value) {
          throw new RuntimeError("INVALID_ARGS", `${token} requires a model value.`, "args.parse");
        }
        model = value;
        index += 1;
        break;
      }
      case "--background":
        background = true;
        break;
      case "--wait":
        wait = true;
        break;
      case "--fresh":
        fresh = true;
        break;
      case "-r":
        resume = true;
        break;
      case "--resume": {
        const value = argv[index + 1];
        if (!value || value.startsWith("-")) {
          throw new RuntimeError(
            "INVALID_ARGS",
            "--resume requires a job-id or session-id. Use -r to resume the latest rescue session for this repo.",
            "rescue.parse",
          );
        }
        resume = true;
        resumeTarget = value;
        explicitResumeTarget = true;
        index += 1;
        break;
      }
      case "--thinking":
        thinking = true;
        break;
      case "--no-thinking":
        thinking = false;
        break;
      default:
        trailingTokens = argv.slice(index);
        index = argv.length;
        break;
    }
  }

  if (fresh && resume) {
    throw new RuntimeError(
      "INVALID_ARGS",
      "rescue does not allow --fresh and --resume together.",
      "rescue.parse",
    );
  }

  if (explicitResumeTarget && trailingTokens?.length) {
    throw new RuntimeError(
      "INVALID_ARGS",
      "--resume only accepts a job-id or session-id. Use -r to resume the latest rescue session with a prompt.",
      "rescue.parse",
    );
  }

  return {
    background,
    wait,
    fresh,
    resume,
    resumeTarget,
    model,
    thinking,
    prompt: trailingTokens?.join(" "),
  };
}

export function parseJobLookupArgs(argv: string[]): JobLookupArgs {
  let type: JobLookupArgs["type"];
  let jobId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--type") {
      const value = argv[index + 1];
      if (!value || !isManagedCommandType(value)) {
        throw new RuntimeError(
          "INVALID_ARGS",
          "--type requires one of review, challenge, rescue, review_gate, ask.",
          "args.parse",
        );
      }
      type = value;
      index += 1;
      continue;
    }

    if (token.startsWith("-")) {
      throw new RuntimeError("INVALID_ARGS", `Unknown flag: ${token}`, "args.parse");
    }

    if (jobId) {
      throw new RuntimeError(
        "INVALID_ARGS",
        "Only one optional job id may be supplied.",
        "args.parse",
      );
    }

    jobId = token;
  }

  return {
    jobId,
    type,
  };
}

interface ParsedKnownFlags extends KimiFlagState {
  base?: string;
  background: boolean;
  wait: boolean;
  trailingText?: string;
}

function isManagedCommandType(value: string): value is import("./types.js").ManagedCommandType {
  return (
    value === "review" ||
    value === "challenge" ||
    value === "rescue" ||
    value === "review_gate" ||
    value === "ask"
  );
}

function parseKnownFlags(argv: string[], knownFlags: Set<string>): ParsedKnownFlags {
  let model: string | undefined;
  let thinking: boolean | undefined;
  let base: string | undefined;
  let background = false;
  let wait = false;
  let trailingTokens: string[] | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      trailingTokens = argv.slice(index + 1);
      break;
    }

    if (!knownFlags.has(token)) {
      trailingTokens = argv.slice(index);
      break;
    }

    switch (token) {
      case "-m":
      case "--model": {
        const value = argv[index + 1];
        if (!value) {
          throw new RuntimeError("INVALID_ARGS", `${token} requires a model value.`, "args.parse");
        }
        model = value;
        index += 1;
        break;
      }
      case "--base": {
        const value = argv[index + 1];
        if (!value) {
          throw new RuntimeError("INVALID_ARGS", "--base requires a ref value.", "args.parse");
        }
        if (value.startsWith("-")) {
          throw new RuntimeError(
            "INVALID_ARGS",
            "--base value cannot start with '-'; pass a branch, tag, or commit ref.",
            "args.parse",
          );
        }
        base = value;
        index += 1;
        break;
      }
      case "--background":
        background = true;
        break;
      case "--wait":
        wait = true;
        break;
      case "--thinking":
        thinking = true;
        break;
      case "--no-thinking":
        thinking = false;
        break;
      default:
        trailingTokens = argv.slice(index);
        index = argv.length;
        break;
    }
  }

  return {
    base,
    background,
    wait,
    model,
    thinking,
    trailingText: trailingTokens?.join(" "),
  };
}
