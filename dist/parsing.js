import { RuntimeError } from "./errors.js";
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
export function parseReviewArgs(argv) {
    const parsed = parseKnownFlags(argv, new Set(["--base", "--background", "--wait", "-m", "--model", "--thinking", "--no-thinking"]));
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
function parseKnownFlags(argv, knownFlags) {
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
