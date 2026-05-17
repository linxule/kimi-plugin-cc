import process from "node:process";
import { RuntimeError } from "./errors.js";
/**
 * Tokens like `--foo` or `-x` that aren't in a command's known-flags set are
 * almost certainly typos (e.g. `--from HEAD~2` instead of `--base HEAD~2`).
 * The historical behavior — silently treating them as free-form trailing
 * prompt — produced misleading runs (Kimi exploring the repo, hitting the
 * step budget, or returning empty findings). v0.3.0 emits an advisory
 * warning to stderr but does not fail the command, so users with legitimate
 * `--foo`-shaped content in their question can still use `--` to silence it.
 */
function looksLikeFlag(token) {
    if (!token.startsWith("-")) {
        return false;
    }
    if (token.startsWith("--") && token.length > 2) {
        return true;
    }
    // Short flag: a single dash followed by exactly one letter (`-r`, `-m`).
    return /^-[a-zA-Z]$/.test(token);
}
function warnUnknownFlag(commandName, token) {
    process.stderr.write(`[kimi-plugin-cc] warning: unknown flag ${token} for ${commandName}; treating as prompt/focus text. Use \`--\` to silence this warning.\n`);
}
export function parseAskArgs(argv) {
    let model;
    // Thinking is on by default across ask/review/challenge/rescue. Users opt out
    // with --no-thinking. The review-gate path sets thinking: false explicitly in
    // its runtime caller, so this default does not affect the gate.
    let thinking = true;
    let background = false;
    let wait = false;
    let fresh = false;
    let resume = false;
    let resumeTarget;
    let explicitResumeTarget = false;
    let trailingTokens;
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
                    throw new RuntimeError("INVALID_ARGS", "--resume requires a job-id or session-id. Use -r to resume the latest ask session for this repo.", "ask.parse");
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
                if (looksLikeFlag(token)) {
                    warnUnknownFlag("ask", token);
                }
                trailingTokens = argv.slice(index);
                index = argv.length;
                break;
        }
    }
    if (fresh && resume) {
        throw new RuntimeError("INVALID_ARGS", "ask does not allow --fresh and --resume together.", "ask.parse");
    }
    if (explicitResumeTarget && trailingTokens?.length) {
        throw new RuntimeError("INVALID_ARGS", "--resume only accepts a job-id or session-id. Use -r to resume the latest ask session with a prompt.", "ask.parse");
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
export function parseReviewArgs(argv, commandName = "review") {
    const parsed = parseKnownFlags(argv, new Set(["--base", "--background", "--wait", "-m", "--model", "--thinking", "--no-thinking"]), commandName);
    return {
        base: parsed.base,
        background: parsed.background,
        wait: parsed.wait,
        model: parsed.model,
        thinking: parsed.thinking,
        focus: parsed.trailingText,
    };
}
export function parseRescueArgs(argv) {
    let model;
    let thinking = true;
    let background = false;
    let wait = false;
    let fresh = false;
    let resume = false;
    let resumeTarget;
    let explicitResumeTarget = false;
    let trailingTokens;
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
                    throw new RuntimeError("INVALID_ARGS", "--resume requires a job-id or session-id. Use -r to resume the latest rescue session for this repo.", "rescue.parse");
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
                if (looksLikeFlag(token)) {
                    warnUnknownFlag("rescue", token);
                }
                trailingTokens = argv.slice(index);
                index = argv.length;
                break;
        }
    }
    if (fresh && resume) {
        throw new RuntimeError("INVALID_ARGS", "rescue does not allow --fresh and --resume together.", "rescue.parse");
    }
    if (explicitResumeTarget && trailingTokens?.length) {
        throw new RuntimeError("INVALID_ARGS", "--resume only accepts a job-id or session-id. Use -r to resume the latest rescue session with a prompt.", "rescue.parse");
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
export function parseJobLookupArgs(argv) {
    let type;
    let jobId;
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === "--type") {
            const value = argv[index + 1];
            if (!value || !isManagedCommandType(value)) {
                throw new RuntimeError("INVALID_ARGS", "--type requires one of review, challenge, rescue, review_gate, ask.", "args.parse");
            }
            type = value;
            index += 1;
            continue;
        }
        if (token.startsWith("-")) {
            throw new RuntimeError("INVALID_ARGS", `Unknown flag: ${token}`, "args.parse");
        }
        if (jobId) {
            throw new RuntimeError("INVALID_ARGS", "Only one optional job id may be supplied.", "args.parse");
        }
        jobId = token;
    }
    return {
        jobId,
        type,
    };
}
function isManagedCommandType(value) {
    return (value === "review" ||
        value === "challenge" ||
        value === "rescue" ||
        value === "review_gate" ||
        value === "ask");
}
function parseKnownFlags(argv, knownFlags, commandName) {
    let model;
    let thinking = true;
    let base;
    let background = false;
    let wait = false;
    let trailingTokens;
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === "--") {
            trailingTokens = argv.slice(index + 1);
            break;
        }
        if (!knownFlags.has(token)) {
            if (looksLikeFlag(token)) {
                warnUnknownFlag(commandName, token);
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
                    throw new RuntimeError("INVALID_ARGS", "--base value cannot start with '-'; pass a branch, tag, or commit ref.", "args.parse");
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
            // The early `if (!knownFlags.has(token))` gate above means we only
            // reach this switch with tokens that ARE in knownFlags, and every
            // member is handled above. A `default` arm would be unreachable.
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
