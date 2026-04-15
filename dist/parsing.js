import { RuntimeError } from "./errors.js";
export function parseAskArgs(argv) {
    const parsed = parseKnownFlags(argv, new Set(["-m", "--model", "--thinking", "--no-thinking"]));
    if (!parsed.trailingText) {
        throw new RuntimeError("INVALID_ARGS", "ask requires a question after the flags.", "ask.parse");
    }
    return {
        model: parsed.model,
        thinking: parsed.thinking,
        prompt: parsed.trailingText,
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
    let thinking;
    let background = false;
    let wait = false;
    let fresh = false;
    let resume = false;
    let resumeTarget;
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
            case "--resume": {
                resume = true;
                const value = argv[index + 1];
                if (value && !value.startsWith("-")) {
                    resumeTarget = value;
                    index += 1;
                }
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
                throw new RuntimeError("INVALID_ARGS", "--type requires one of review, adversarial_review, rescue, review_gate, ask.", "args.parse");
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
        value === "adversarial_review" ||
        value === "rescue" ||
        value === "review_gate" ||
        value === "ask");
}
function parseKnownFlags(argv, knownFlags) {
    let model;
    let thinking;
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
