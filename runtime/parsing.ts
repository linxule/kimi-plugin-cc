import { RuntimeError } from "./errors.js";

/**
 * Tokens like `--foo` or `-x` that aren't in a command's known-flags set are
 * almost certainly typos (e.g. `--from HEAD~2` instead of `--base HEAD~2`)
 * or — for agent-mediated callers — hallucinated flag names (e.g. wrappers
 * inventing `--file` / `--context` because that shape is common in other
 * CLIs). The historical behavior — silently treating them as free-form
 * trailing prompt/focus text with an advisory stderr warning — produced
 * misleading runs (Kimi chewing on a bloated blob, or hitting the prompt
 * timeout). All command parsers now hard-fail on unknown flag-shaped tokens
 * while still preserving prose mode after the first non-flag token and the
 * `--` escape.
 */
function looksLikeFlag(token: string): boolean {
  if (!token.startsWith("-")) {
    return false;
  }
  if (token.startsWith("--") && token.length > 2) {
    return true;
  }
  // Short flag: a single dash followed by exactly one letter (`-r`, `-m`).
  return /^-[a-zA-Z]$/.test(token);
}

const ASK_SUPPORTED_FLAGS =
  "-m/--model <name>, --background, --wait, --fresh, -r, --resume <job-id|session-id>";
const RESCUE_SUPPORTED_FLAGS =
  "-m/--model <name>, --background, --wait, --fresh, -r, --resume <job-id|session-id>";

// Thinking-on is always-on for user-facing commands in v1.0. review-gate
// pins thinking=false via the cli-client options bag instead of an argv
// flag (see runtime/cli-client.ts::CliClientOptions). The parser rejects
// --thinking and --no-thinking with a hard error so a documented-removed
// flag doesn't get silently accepted as a no-op. Both bare (`--thinking`)
// and assignment (`--thinking=true`) forms are rejected — otherwise the
// assignment form would fall through to the generic "Unknown flag" path
// and a wrapper agent reading the error would think the cure is to drop
// the `=value` rather than the flag itself.
const THINKING_FLAG_REMOVED_MESSAGE =
  "--thinking / --no-thinking were removed in v1.0. Thinking is always on for user-facing commands.";

function isRemovedThinkingFlag(token: string): boolean {
  return (
    token === "--thinking" ||
    token === "--no-thinking" ||
    token.startsWith("--thinking=") ||
    token.startsWith("--no-thinking=")
  );
}

export interface KimiFlagState {
  model?: string;
  /**
   * Pre-v1.0 commands set this from argv; alpha.4 always returns true
   * for user-facing parsers (the row's metadata stays meaningful for
   * historical jobs). review-gate's runtime caller sets this to false
   * directly when populating the SQLite row.
   */
  thinking?: boolean;
}

export interface AskArgs extends KimiFlagState {
  background: boolean;
  wait: boolean;
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

export interface PursueArgs extends KimiFlagState {
  /**
   * Hard wall-clock ceiling in ms (the ONLY guaranteed bound on an
   * autonomous goal — see runtime/commands/pursue.ts). Undefined here means
   * "apply the command default" (pursue.ts owns the default so parsing stays
   * timeout-free).
   */
  budgetMs?: number;
  /**
   * Soft per-goal turn cap. NOT enforceable headless — injected into the
   * objective text as a model instruction so kimi calls SetGoalBudget itself.
   */
  turns?: number;
  objective?: string;
}

const PURSUE_SUPPORTED_FLAGS = "-m/--model <name>, --budget <30m|1h|90s>, --turns <N>";

/**
 * Parse a duration token (`30m`, `1h`, `90s`, or a bare integer = minutes)
 * into milliseconds. Throws INVALID_ARGS on a malformed or non-positive value.
 */
export function parseDurationMs(token: string, flag: string): number {
  const match = /^(\d+)(s|m|h)?$/.exec(token.trim());
  if (!match) {
    throw new RuntimeError(
      "INVALID_ARGS",
      `${flag} expects a duration like 30m, 1h, or 90s (bare number = minutes); got "${token}".`,
      "pursue.parse",
    );
  }
  const value = Number(match[1]);
  const unit = match[2] ?? "m";
  if (!Number.isFinite(value) || value <= 0) {
    throw new RuntimeError("INVALID_ARGS", `${flag} must be a positive duration.`, "pursue.parse");
  }
  const unitMs = unit === "s" ? 1_000 : unit === "h" ? 3_600_000 : 60_000;
  return value * unitMs;
}

/**
 * Parser for /kimi:pursue (autonomous goal mode). Foreground-only in the
 * prototype: no --background/--fresh/--resume (the goalId/sessionId split makes
 * session resume unreliable — see pursue.ts). Trailing tokens are the objective.
 */
export function parsePursueArgs(argv: string[]): PursueArgs {
  let model: string | undefined;
  const thinking: boolean | undefined = true;
  let budgetMs: number | undefined;
  let turns: number | undefined;
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
          throw new RuntimeError("INVALID_ARGS", `${token} requires a model value.`, "pursue.parse");
        }
        if (value.startsWith("-")) {
          throw new RuntimeError(
            "INVALID_ARGS",
            `${token} value cannot start with '-'; pass a model name`,
            "pursue.parse",
          );
        }
        model = value;
        index += 1;
        break;
      }
      case "--budget": {
        const value = argv[index + 1];
        if (!value || value.startsWith("-")) {
          throw new RuntimeError(
            "INVALID_ARGS",
            "--budget requires a duration (e.g. 30m, 1h, 90s).",
            "pursue.parse",
          );
        }
        budgetMs = parseDurationMs(value, "--budget");
        index += 1;
        break;
      }
      case "--turns": {
        const value = argv[index + 1];
        if (!value || value.startsWith("-")) {
          throw new RuntimeError("INVALID_ARGS", "--turns requires a positive integer.", "pursue.parse");
        }
        const parsedTurns = Number(value);
        if (!Number.isInteger(parsedTurns) || parsedTurns <= 0) {
          throw new RuntimeError("INVALID_ARGS", "--turns must be a positive integer.", "pursue.parse");
        }
        turns = parsedTurns;
        index += 1;
        break;
      }
      default:
        if (isRemovedThinkingFlag(token)) {
          throw new RuntimeError("INVALID_ARGS", THINKING_FLAG_REMOVED_MESSAGE, "pursue.parse");
        }
        if (looksLikeFlag(token)) {
          throw new RuntimeError(
            "INVALID_ARGS",
            `Unknown flag ${token} for pursue. Supported flags: ${PURSUE_SUPPORTED_FLAGS}. Use \`--\` before flag-shaped objective text to pass it through.`,
            "pursue.parse",
          );
        }
        trailingTokens = argv.slice(index);
        index = argv.length;
        break;
    }
  }

  return {
    budgetMs,
    turns,
    model,
    thinking,
    objective: trailingTokens?.join(" "),
  };
}

export interface JobLookupArgs {
  jobId?: string;
  type?: Exclude<
    import("./types.js").ManagedCommandType,
    never
  >;
  json: boolean;
}

export function parseAskArgs(argv: string[]): AskArgs {
  let model: string | undefined;
  // Thinking is on by default across ask/review/challenge/rescue. The
  // parser rejects --thinking / --no-thinking; review-gate's runtime
  // caller pins thinking=false via CliClientOptions instead.
  let thinking: boolean | undefined = true;
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
        if (value.startsWith("-")) {
          throw new RuntimeError(
            "INVALID_ARGS",
            `${token} value cannot start with '-'; pass a model name`,
            "args.parse",
          );
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
      default:
        if (isRemovedThinkingFlag(token)) {
          throw new RuntimeError(
            "INVALID_ARGS",
            THINKING_FLAG_REMOVED_MESSAGE,
            "args.parse",
          );
        }
        if (looksLikeFlag(token)) {
          throw new RuntimeError(
            "INVALID_ARGS",
            `Unknown flag ${token} for ask. Supported flags: ${ASK_SUPPORTED_FLAGS}. Use \`--\` before flag-shaped prompt text to pass it through.`,
            "args.parse",
          );
        }
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

export function parseReviewArgs(argv: string[], commandName: string = "review"): ReviewArgs {
  const parsed = parseKnownFlags(
    argv,
    new Set(["--base", "--background", "--wait", "-m", "--model"]),
    commandName,
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
  let thinking: boolean | undefined = true;
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
        if (value.startsWith("-")) {
          throw new RuntimeError(
            "INVALID_ARGS",
            `${token} value cannot start with '-'; pass a model name`,
            "args.parse",
          );
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
      default:
        if (isRemovedThinkingFlag(token)) {
          throw new RuntimeError(
            "INVALID_ARGS",
            THINKING_FLAG_REMOVED_MESSAGE,
            "args.parse",
          );
        }
        if (looksLikeFlag(token)) {
          throw new RuntimeError(
            "INVALID_ARGS",
            `Unknown flag ${token} for rescue. Supported flags: ${RESCUE_SUPPORTED_FLAGS}. Use \`--\` before flag-shaped prompt text to pass it through.`,
            "args.parse",
          );
        }
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
  let json = false;

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

    if (token === "--json") {
      json = true;
      continue;
    }

    if (token.startsWith("-")) {
      throw new RuntimeError(
        "INVALID_ARGS",
        `Unknown flag ${token}. Supported flags: --type <review|challenge|rescue|review_gate|ask>, --json.`,
        "args.parse",
      );
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
    json,
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

function parseKnownFlags(
  argv: string[],
  knownFlags: Set<string>,
  commandName: string,
): ParsedKnownFlags {
  let model: string | undefined;
  let thinking: boolean | undefined = true;
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
      if (isRemovedThinkingFlag(token)) {
        throw new RuntimeError("INVALID_ARGS", THINKING_FLAG_REMOVED_MESSAGE, "args.parse");
      }
      if (looksLikeFlag(token)) {
        // Wrapper agents routinely hallucinate flags like `--file` /
        // `--context` because that shape is common in other CLIs. Silently
        // slurping them into focus text produced a bloated prompt that
        // looked like a hang. Hard-fail with the supported list inline so
        // the error message itself is the correction.
        throw new RuntimeError(
          "INVALID_ARGS",
          `Unknown flag ${token} for ${commandName}. Supported flags: --base <ref>, -m/--model <name>. Use \`--\` before flag-shaped focus text to pass it through.`,
          "args.parse",
        );
      }
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
        if (value.startsWith("-")) {
          throw new RuntimeError(
            "INVALID_ARGS",
            `${token} value cannot start with '-'; pass a model name`,
            "args.parse",
          );
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
      // The early `if (!knownFlags.has(token))` gate above means we only
      // reach this switch with tokens that ARE in knownFlags, and every
      // member is handled above. A `default` arm would be unreachable.
      // --thinking and --no-thinking are NOT in knownFlags any more (v1.0
      // removed them); the early gate above hard-fails on them with
      // THINKING_FLAG_REMOVED_MESSAGE.
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
