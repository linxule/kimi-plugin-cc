import { RuntimeError } from "./errors.js";

/**
 * Unknown flag-shaped tokens hard-fail instead of being absorbed into prose.
 * Parsing still switches to prose at the first non-flag token or after `--`.
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

export const ASK_SUPPORTED_FLAGS =
  "-m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>, --background, --wait, --fresh, -r, --resume <job-id|session-id>";
export const RESCUE_SUPPORTED_FLAGS =
  "-m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>, --background, --wait, --fresh, -r, --resume <job-id|session-id>";

export const REVIEW_SUPPORTED_FLAGS = "--base <ref>, -m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>";
export const JOB_LOOKUP_SUPPORTED_FLAGS = "--type <review|challenge|rescue|review_gate|ask>, --json";

export const SETUP_SUPPORTED_FLAGS = "--check, --uninstall, --all (with --uninstall), --enable-review-gate, --disable-review-gate, --models [--json] (without other setup flags)";
export const RECOVER_SWARM_SUPPORTED_FLAGS = "--apply";
export const REPAIR_SESSIONS_SUPPORTED_FLAGS = "--apply, --all";
export const REPLAY_SUPPORTED_FLAGS = "none (one job-id required)";

/** Validate syntax only; upstream per-model supportEfforts remains authoritative. */
export function validateThinkingEffort(value: string | undefined, stage = "args.parse", lowercase = true): string {
  const effort = lowercase ? value?.toLowerCase() : value;
  if (!effort || !/^[a-z][a-z0-9-]{0,31}$/.test(effort)) {
    throw new RuntimeError("INVALID_ARGS", "--thinking requires an effort matching [a-z][a-z0-9-]{0,31} (e.g. off, low, medium, high).", stage);
  }
  return effort;
}

export interface KimiFlagState {
  model?: string;
  thinkingEffort?: string;
}

export interface AskArgs extends KimiFlagState {
  help?: boolean;
  budgetMs?: number;
  background: boolean;
  wait: boolean;
  fresh: boolean;
  resume: boolean;
  resumeTarget?: string;
  prompt?: string;
}

export interface ReviewArgs extends KimiFlagState {
  budgetMs?: number;
  base?: string;
  background: boolean;
  wait: boolean;
  focus?: string;
}

export interface RescueArgs extends KimiFlagState {
  help?: boolean;
  budgetMs?: number;
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
   * objective as a stop instruction, never a request to mutate the denied goal budget.
   */
  turns?: number;
  objective?: string;
}

export const PURSUE_SUPPORTED_FLAGS = "-m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>, --turns <N>";

export interface SwarmArgs extends KimiFlagState {
  /**
   * Hard wall-clock ceiling in ms — the hard bound on total runtime. Undefined
   * means "apply the command default" (swarm.ts owns the default so parsing
   * stays timeout-free).
   */
  budgetMs?: number;
  /**
   * SOFT cap on TOTAL subagent count — a hint injected into the coordinator
   * prompt (buildSwarmPrompt). NOT hook-enforceable (the hook is stateless and
   * can't count subagents), so the model may exceed it. For a HARD bound on how
   * many subagents run AT ONCE, see `maxConcurrency`; the always-on hard bound
   * on the whole run is the wall-clock `--budget`.
   */
  cap?: number;
  /**
   * Concurrent-subagent ceiling exported as
   * KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY and enforced on kimi-code 0.18.0+;
   * older binaries ignore it. Distinct from `cap`: concurrency (how many run
   * simultaneously) ≠ total count (how many run over the whole life of the
   * swarm). See runtime/cli-client.ts buildKimiCliEnvironment.
   *
   * Undefined here means "apply the command default" — swarm.ts owns it
   * (resolveSwarmMaxConcurrency → SWARM_DEFAULT_MAX_CONCURRENCY) so parsing
   * stays policy-free, mirroring `budgetMs`. The setting is always supplied;
   * pre-0.18 read-only swarms retain only the wall-clock hard bound.
   */
  maxConcurrency?: number;
  /**
   * Optional write mode. By default the swarm is read-only. When true, the
   * coordinator spawns in an ephemeral throwaway git worktree off HEAD and
   * `coder` subagents edit there; the result is a reviewable patch for the user
   * (see runtime/commands/swarm.ts and docs/safety.md). Write mode requires
   * kimi-code >= 0.18.0, a git repo with a born HEAD, and the PreToolUse hook.
   */
  write?: boolean;
  objective?: string;
}

export const SWARM_SUPPORTED_FLAGS =
  "-m/--model <name>, --thinking <off|low|medium|high>, --budget <30m|1h|90s>, --cap <N>, --max-concurrency <N>, --write";

/**
 * Parser for /kimi:swarm. Foreground-only: no --background/--fresh/--resume.
 * Trailing tokens are the objective.
 */
export function parseSwarmArgs(argv: string[]): SwarmArgs {
  let model: string | undefined;
  let thinkingEffort: string | undefined;
  let budgetMs: number | undefined;
  let cap: number | undefined;
  let maxConcurrency: number | undefined;
  let write = false;
  let trailingTokens: string[] | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--thinking" || token.startsWith("--thinking=")) {
      thinkingEffort = validateThinkingEffort(token === "--thinking" ? argv[++index] : token.slice("--thinking=".length));
      continue;
    }
    if (token === "--no-thinking" || token.startsWith("--no-thinking=")) {
      throw new RuntimeError("INVALID_ARGS", "--no-thinking is unsupported; use --thinking off", "args.parse");
    }

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
          throw new RuntimeError("INVALID_ARGS", `${token} requires a model value.`, "swarm.parse");
        }
        if (value.startsWith("-")) {
          throw new RuntimeError(
            "INVALID_ARGS",
            `${token} value cannot start with '-'; pass a model name`,
            "swarm.parse",
          );
        }
        model = value;
        index += 1;
        break;
      }
      case "--write":
        write = true;
        break;
      case "--budget": {
        const value = argv[index + 1];
        if (!value || value.startsWith("-")) {
          throw new RuntimeError(
            "INVALID_ARGS",
            "--budget requires a duration (e.g. 30m, 1h, 90s).",
            "swarm.parse",
          );
        }
        budgetMs = parseDurationMs(value, "--budget", "swarm.parse", "safety");
        index += 1;
        break;
      }
      case "--cap": {
        cap = parsePositiveIntFlag("--cap", argv[index + 1]);
        index += 1;
        break;
      }
      case "--max-concurrency": {
        maxConcurrency = parsePositiveIntFlag("--max-concurrency", argv[index + 1]);
        index += 1;
        break;
      }
      default:
        if (looksLikeFlag(token)) {
          throw new RuntimeError(
            "INVALID_ARGS",
            `Unknown flag ${token} for swarm. Supported flags: ${SWARM_SUPPORTED_FLAGS}. Use \`--\` before flag-shaped objective text to pass it through.`,
            "swarm.parse",
          );
        }
        trailingTokens = argv.slice(index);
        index = argv.length;
        break;
    }
  }

  return {
    budgetMs,
    cap,
    maxConcurrency,
    write,
    model,
    thinkingEffort,
    objective: trailingTokens?.join(" "),
  };
}

/**
 * Shared positive-integer flag parser for swarm's `--cap` / `--max-concurrency`.
 * Both must be a strict positive integer; `--max-concurrency` in particular maps
 * to kimi-code's `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY`, whose upstream resolver
 * THROWS on a non-positive-integer — so the same `Number.isInteger && > 0`
 * predicate guarantees every accepted value round-trips through `String()`.
 */
function parsePositiveIntFlag(flag: string, value: string | undefined): number {
  if (!value || value.startsWith("-")) {
    throw new RuntimeError("INVALID_ARGS", `${flag} requires a positive integer.`, "swarm.parse");
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new RuntimeError("INVALID_ARGS", `${flag} must be a positive integer.`, "swarm.parse");
  }
  return parsed;
}

/**
 * Upper bound for any `--budget` duration. The budget is the SOLE hard
 * wall-clock bound on the plugin's autonomous/fan-out surfaces (pursue, swarm),
 * so a typo'd or absurd value (`999999h`, a pasted nanosecond count) would
 * effectively disable that bound — defeating the one guarantee these modes rest
 * on. 24h is far above any legitimate budget (pursue defaults to 45m, swarm to
 * 30m) yet still finite, so the AbortController always fires. Above it we
 * hard-fail INVALID_ARGS rather than silently clamp — a wrapper LLM passing a
 * runaway budget should see the rejection, not a quietly-different value.
 */
export const MAX_DURATION_MS = 24 * 60 * 60 * 1_000;

/**
 * Parse a duration token (`30m`, `1h`, `90s`, or a bare integer = minutes)
 * into milliseconds. Throws INVALID_ARGS on a malformed, non-positive, or
 * absurdly large value (> {@link MAX_DURATION_MS}).
 */
export function parseDurationMs(
  token: string,
  flag: string,
  stage: string,
  budgetKind: "safety" | "response",
): number {
  const limitReason = budgetKind === "safety"
    ? "the budget is a safety ceiling, not a scheduler"
    : "the budget is a response-time limit; a timed-out job is still a safe failure";
  const match = /^(\d+)(s|m|h)?$/.exec(token.trim());
  if (!match) {
    throw new RuntimeError(
      "INVALID_ARGS",
      `${flag} expects a duration like 30m, 1h, or 90s (bare number = minutes); got "${token}".`,
      stage,
    );
  }
  const value = Number(match[1]);
  const unit = match[2] ?? "m";
  if (!Number.isFinite(value) || value <= 0) {
    throw new RuntimeError("INVALID_ARGS", `${flag} must be a positive duration.`, stage);
  }
  const unitMs = unit === "s" ? 1_000 : unit === "h" ? 3_600_000 : 60_000;
  const ms = value * unitMs;
  if (ms > MAX_DURATION_MS) {
    throw new RuntimeError(
      "INVALID_ARGS",
      `${flag} must be at most 24h (got "${token}"); ${limitReason}.`,
      stage,
    );
  }
  return ms;
}

/**
 * Parser for /kimi:pursue (autonomous goal mode). Foreground-only in the
 * prototype: no --background/--fresh/--resume (the goalId/sessionId split makes
 * session resume unreliable — see pursue.ts). Trailing tokens are the objective.
 */
export function parsePursueArgs(argv: string[]): PursueArgs {
  let model: string | undefined;
  let thinkingEffort: string | undefined;
  let budgetMs: number | undefined;
  let turns: number | undefined;
  let trailingTokens: string[] | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--thinking" || token.startsWith("--thinking=")) {
      thinkingEffort = validateThinkingEffort(token === "--thinking" ? argv[++index] : token.slice("--thinking=".length));
      continue;
    }
    if (token === "--no-thinking" || token.startsWith("--no-thinking=")) {
      throw new RuntimeError("INVALID_ARGS", "--no-thinking is unsupported; use --thinking off", "args.parse");
    }

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
        budgetMs = parseDurationMs(value, "--budget", "pursue.parse", "safety");
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
    thinkingEffort,
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

const VALUE_TAKING_FLAGS = new Set(["--thinking", "-m", "--model", "--budget", "--resume", "--base", "--cap", "--max-concurrency", "--turns", "--type"]);

/**
 * `--help` / `-h` counts only inside the leading flag region: before `--`
 * and before the first prose token. The value of a value-taking flag is
 * skipped, so `-m kimi -h` is still a help request (`kimi` is a value, not
 * prose) and `--budget --help` asks for help rather than failing on a bad
 * duration. Once prose starts (`ask what does du -h print`), nothing after it
 * is a flag — the whole remainder is the prompt.
 */
export function hasHelpFlag(argv: string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") return false;
    if (token === "--help" || token === "-h") return true;
    if (!token.startsWith("-")) return false;
    if (VALUE_TAKING_FLAGS.has(token)) {
      const value = argv[index + 1];
      if (value === "--help" || value === "-h") return true;
      index += 1;
    }
  }
  return false;
}

export function parseAskArgs(argv: string[]): AskArgs {
  if (hasHelpFlag(argv)) return { help: true, background: false, wait: false, fresh: false, resume: false };
  let budgetMs: number | undefined;
  let model: string | undefined;
  let thinkingEffort: string | undefined;
  let background = false;
  let wait = false;
  let fresh = false;
  let resume = false;
  let resumeTarget: string | undefined;
  let explicitResumeTarget = false;
  let trailingTokens: string[] | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--thinking" || token.startsWith("--thinking=")) {
      thinkingEffort = validateThinkingEffort(token === "--thinking" ? argv[++index] : token.slice("--thinking=".length));
      continue;
    }
    if (token === "--no-thinking" || token.startsWith("--no-thinking=")) {
      throw new RuntimeError("INVALID_ARGS", "--no-thinking is unsupported; use --thinking off", "args.parse");
    }

    if (token === "--") {
      trailingTokens = argv.slice(index + 1);
      break;
    }

    if (!token.startsWith("-")) {
      trailingTokens = argv.slice(index);
      break;
    }

    switch (token) {
      case "--budget": {
        const value = argv[index + 1];
        if (!value || value.startsWith("-")) {
          throw new RuntimeError("INVALID_ARGS", "--budget requires a duration (e.g. 30m, 1h, 90s).", "ask.parse");
        }
        budgetMs = parseDurationMs(value, "--budget", "ask.parse", "response");
        index += 1;
        break;
      }
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
    budgetMs,
    background,
    wait,
    fresh,
    resume,
    resumeTarget,
    model,
    thinkingEffort,
    prompt: trailingTokens?.join(" "),
  };
}

export function parseReviewArgs(argv: string[], commandName: string = "review"): ReviewArgs {
  const parsed = parseKnownFlags(
    argv,
    new Set(["--budget", "--base", "--background", "--wait", "-m", "--model"]),
    commandName,
  );

  return {
    budgetMs: parsed.budgetMs,
    base: parsed.base,
    background: parsed.background,
    wait: parsed.wait,
    model: parsed.model,
    thinkingEffort: parsed.thinkingEffort,
    focus: parsed.trailingText,
  };
}

export function parseRescueArgs(argv: string[]): RescueArgs {
  if (hasHelpFlag(argv)) return { help: true, background: false, wait: false, fresh: false, resume: false };
  let budgetMs: number | undefined;
  let model: string | undefined;
  let thinkingEffort: string | undefined;
  let background = false;
  let wait = false;
  let fresh = false;
  let resume = false;
  let resumeTarget: string | undefined;
  let explicitResumeTarget = false;
  let trailingTokens: string[] | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--thinking" || token.startsWith("--thinking=")) {
      thinkingEffort = validateThinkingEffort(token === "--thinking" ? argv[++index] : token.slice("--thinking=".length));
      continue;
    }
    if (token === "--no-thinking" || token.startsWith("--no-thinking=")) {
      throw new RuntimeError("INVALID_ARGS", "--no-thinking is unsupported; use --thinking off", "args.parse");
    }

    if (token === "--") {
      trailingTokens = argv.slice(index + 1);
      break;
    }

    if (!token.startsWith("-")) {
      trailingTokens = argv.slice(index);
      break;
    }

    switch (token) {
      case "--budget": {
        const value = argv[index + 1];
        if (!value || value.startsWith("-")) {
          throw new RuntimeError("INVALID_ARGS", "--budget requires a duration (e.g. 30m, 1h, 90s).", "rescue.parse");
        }
        budgetMs = parseDurationMs(value, "--budget", "rescue.parse", "response");
        index += 1;
        break;
      }
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
    budgetMs,
    background,
    wait,
    fresh,
    resume,
    resumeTarget,
    model,
    thinkingEffort,
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
        `Unknown flag ${token}. Supported flags: ${JOB_LOOKUP_SUPPORTED_FLAGS}.`,
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
  budgetMs?: number;
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
  let budgetMs: number | undefined;
  let model: string | undefined;
  let thinkingEffort: string | undefined;
  let base: string | undefined;
  let background = false;
  let wait = false;
  let trailingTokens: string[] | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--thinking" || token.startsWith("--thinking=")) {
      thinkingEffort = validateThinkingEffort(token === "--thinking" ? argv[++index] : token.slice("--thinking=".length));
      continue;
    }
    if (token === "--no-thinking" || token.startsWith("--no-thinking=")) {
      throw new RuntimeError("INVALID_ARGS", "--no-thinking is unsupported; use --thinking off", "args.parse");
    }

    if (token === "--") {
      trailingTokens = argv.slice(index + 1);
      break;
    }

    if (!knownFlags.has(token)) {
      if (looksLikeFlag(token)) {
        throw new RuntimeError(
          "INVALID_ARGS",
          `Unknown flag ${token} for ${commandName}. Supported flags: ${REVIEW_SUPPORTED_FLAGS}. Use \`--\` before flag-shaped focus text to pass it through.`,
          "args.parse",
        );
      }
      trailingTokens = argv.slice(index);
      break;
    }

    switch (token) {
      case "--budget": {
        const value = argv[index + 1];
        if (!value || value.startsWith("-")) {
          throw new RuntimeError("INVALID_ARGS", "--budget requires a duration (e.g. 30m, 1h, 90s).", `${commandName}.parse`);
        }
        budgetMs = parseDurationMs(value, "--budget", `${commandName}.parse`, "response");
        index += 1;
        break;
      }
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
    }
  }

  return {
    budgetMs,
    base,
    background,
    wait,
    model,
    thinkingEffort,
    trailingText: trailingTokens?.join(" "),
  };
}
