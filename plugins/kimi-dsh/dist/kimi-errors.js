import { RuntimeError, formatError } from "./errors.js";
const BUDGET_CEILING_MS = 24 * 60 * 60 * 1_000;
function formatBudgetMs(ms) {
    if (ms % 3_600_000 === 0)
        return `${ms / 3_600_000}h`;
    if (ms % 60_000 === 0)
        return `${ms / 60_000}m`;
    return `${Math.ceil(ms / 1_000)}s`;
}
/**
 * Suggest a concrete next budget from the one that just expired: double it,
 * capped at the 24h ceiling. At the ceiling there is nothing left to raise,
 * so the only honest advice is to narrow the prompt.
 */
function budgetAdvice(budgetMs) {
    if (budgetMs === undefined || !Number.isFinite(budgetMs) || budgetMs <= 0)
        return "raise the budget (`--budget <dur>`, at most 24h)";
    if (budgetMs >= BUDGET_CEILING_MS)
        return "note the budget is already at the 24h ceiling, so narrowing the prompt is the only remaining lever";
    return `raise the budget (e.g. \`--budget ${formatBudgetMs(Math.min(budgetMs * 2, BUDGET_CEILING_MS))}\`)`;
}
export function classifyManagedCommandFailure(error, commandType, jobId, options) {
    const classification = classifyKimiAvailability(error);
    if (!classification) {
        return error instanceof Error ? error : new Error(String(error));
    }
    if (classification.kind === "response_timeout" && commandType !== "review_gate" && options?.background !== undefined) {
        const foregroundAdvice = !options?.background && (commandType === "ask" || commandType === "rescue")
            ? " Or run with --background so the caller's shell timeout is not the limit."
            : "";
        classification.nextStep = `Narrow the prompt or ${budgetAdvice(options.budgetMs)}. Partial output, if any, is in the artifact (\`result ${jobId}\`).${foregroundAdvice}`;
    }
    const label = formatCommandLabel(commandType);
    const stage = options?.preserveStage && error instanceof RuntimeError
        ? error.stage
        : `${commandType}.runtime`;
    // Thread the cause's code and message into `details` so the underlying
    // failure survives the wrap on every channel (formatError renders details
    // as a JSON line; normalizeJobError persists them in the job row). Without
    // this, a CLI_NONZERO_EXIT whose message embeds kimi's stderr tail (e.g.
    // `auth.login_required` on 2026-08-08) was reduced to the generic
    // "run /kimi:setup" advice with the real cause reachable only as `cause`,
    // which no output channel serializes — an LLM caller could not diagnose it.
    const details = { availability: classification.kind };
    if (error instanceof RuntimeError) {
        details.cause_code = error.code;
        for (const key of ["spawn_code", "spawn_errno", "spawn_message"]) {
            if (error.details[key] !== undefined)
                details[key] = key === "spawn_message" && typeof error.details[key] === "string"
                    ? truncateCauseMessageForDetails(error.details[key]) : error.details[key];
        }
        if (error.code === "RESPONSE_TIMEOUT") {
            for (const key of ["budget_ms", "record_count", "partial_output_chars", "aborted", "settled_post_abort", "hook_escapes"]) {
                if (error.details[key] !== undefined)
                    details[key] = error.details[key];
            }
            if (details.budget_ms === undefined && options?.budgetMs !== undefined)
                details.budget_ms = options.budgetMs;
        }
    }
    if (error instanceof Error && error.message.length > 0) {
        details.cause_message = truncateCauseMessageForDetails(error.message);
    }
    return new RuntimeError(mapAvailabilityCode(classification.kind, commandType), `${label} could not run because ${classification.summary} ${classification.nextStep} Job ${jobId} was persisted as failed.`, stage, error instanceof Error ? { cause: error, details } : { details });
}
/**
 * Cap the cause message carried in `details` so a large stderr tail cannot
 * bloat the SQLite job row or the rendered details JSON line. Keep the TAIL
 * end: for a crashed subprocess the informative lines (kimi's own `error:`
 * output) are the trailing bytes of stderr, which cli-helpers appends last.
 */
const CAUSE_MESSAGE_DETAILS_MAX = 2000;
function truncateCauseMessageForDetails(message) {
    if (message.length <= CAUSE_MESSAGE_DETAILS_MAX) {
        return message;
    }
    return `…${message.slice(-CAUSE_MESSAGE_DETAILS_MAX)}`;
}
export function summarizeKimiAvailabilityWarning(error, commandType) {
    const classification = classifyKimiAvailability(error);
    if (!classification) {
        return null;
    }
    if (classification.kind === "auth_unavailable") {
        return `Kimi ${formatCommandLabel(commandType).toLowerCase()} is not configured for model access; allowing stop.`;
    }
    if (classification.kind === "binary_unavailable") {
        return `Kimi ${formatCommandLabel(commandType).toLowerCase()} could not find the Kimi CLI; allowing stop.`;
    }
    if (classification.kind === "startup_failed") {
        return `Kimi ${formatCommandLabel(commandType).toLowerCase()} could not start a usable Kimi subprocess; allowing stop.`;
    }
    switch (classification.kind) {
        case "startup_timeout":
            return `Kimi ${formatCommandLabel(commandType).toLowerCase()} did not respond during startup; allowing stop.`;
        case "initialize_timeout":
            return `Kimi ${formatCommandLabel(commandType).toLowerCase()} did not complete session initialization; allowing stop.`;
        case "response_timeout":
            return `Kimi ${formatCommandLabel(commandType).toLowerCase()} did not return a final response; allowing stop.`;
        case "max_steps_reached":
            return `Kimi ${formatCommandLabel(commandType).toLowerCase()} exhausted its step budget; allowing stop.`;
        case "timeout":
            return `Kimi ${formatCommandLabel(commandType).toLowerCase()} timed out; allowing stop.`;
    }
}
export function classifySetupFailure(error) {
    return classifyKimiAvailability(error);
}
function classifyKimiAvailability(error) {
    const message = formatError(error);
    // kimi-code's managed OAuth store emits `auth.login_required: OAuth
    // provider "managed:kimi-code" requires login…` on stderr when the token
    // is missing or expired (observed on 0.34.0 after an out-of-band binary
    // upgrade invalidated the token). The line reaches us inside the
    // CLI_NONZERO_EXIT message because cli-helpers embeds the stderr tail.
    // This MUST precede the code-based CLI_NONZERO_EXIT branch below, which
    // would otherwise misclassify a logged-out CLI as startup_failed and
    // point the user at /kimi:setup — which cannot fix auth.
    if (message.includes("auth.login_required")) {
        return {
            kind: "auth_unavailable",
            summary: "the local Kimi CLI is logged out (its OAuth login is missing or expired).",
            nextStep: "Run `kimi login` to re-authenticate, then retry. `/kimi:setup` does not repair auth.",
            runtimeProbe: "ok",
            authProbe: "failed",
        };
    }
    if (message.includes("LLM is not set") || message.includes("LLM service error")) {
        return {
            kind: "auth_unavailable",
            summary: "local Kimi authentication or model configuration is not usable.",
            nextStep: "Run `/kimi:setup`, then `kimi login` or fix the local Kimi model configuration and retry.",
            runtimeProbe: "ok",
            authProbe: "failed",
        };
    }
    if (error instanceof RuntimeError &&
        (error.code === "CLI_SPAWN_FAILED" || error.code === "CLI_PROCESS_ERROR")) {
        const spawnCode = error.details.spawn_code;
        const binaryUnavailable = typeof spawnCode === "string" && ["ENOENT", "EACCES", "ENOEXEC"].includes(spawnCode);
        if (typeof spawnCode === "string" && !binaryUnavailable) {
            return {
                kind: "startup_failed",
                summary: "the Kimi subprocess could not be started or used.",
                nextStep: "Check the underlying process error; shorten the prompt or environment if an argument-size limit was exceeded, then retry.",
                runtimeProbe: "failed",
                authProbe: "failed",
            };
        }
        // Keep opaque synchronous failures and legacy async ENOENT diagnostics compatible.
        if (binaryUnavailable || error.code === "CLI_SPAWN_FAILED" || /\bENOENT\b/.test(message)) {
            return {
                kind: "binary_unavailable",
                summary: "the Kimi CLI is missing from PATH or not executable in this environment.",
                nextStep: "Run `/kimi:setup` to verify the install, then expose `kimi` on PATH and retry.",
                runtimeProbe: "failed",
                authProbe: "failed",
            };
        }
    }
    // v1.0 cli-client surfaces non-ENOENT process errors and non-zero
    // exits as CLI_PROCESS_ERROR / CLI_NONZERO_EXIT. Treat both as
    // startup-failed for classifier purposes — the next step is the same
    // (run /kimi:setup) and the distinction between "kimi crashed during
    // init" vs "kimi exited with status 1" is post-hoc.
    if (error instanceof RuntimeError &&
        (error.code === "CLI_PROCESS_ERROR" || error.code === "CLI_NONZERO_EXIT")) {
        return {
            kind: "startup_failed",
            summary: "the Kimi CLI exited before completing the requested operation.",
            nextStep: "Run `/kimi:setup` to verify local Kimi health, then retry.",
            runtimeProbe: "failed",
            authProbe: "failed",
        };
    }
    if (error instanceof RuntimeError && error.code === "MAX_STEPS_REACHED") {
        return {
            kind: "max_steps_reached",
            summary: "Kimi exhausted its step budget before finalizing the turn.",
            nextStep: "Retry with a more focused prompt or a higher step budget.",
            runtimeProbe: "ok",
            authProbe: "ok",
        };
    }
    if (error instanceof RuntimeError) {
        // STARTUP_TIMEOUT and INITIALIZE_TIMEOUT predate the v1.0 subprocess
        // transport (the v0.4 Wire client had a three-phase startup). The
        // v1.0 cli-client only emits RESPONSE_TIMEOUT, so these branches are
        // defensive — callers that synthesize the old codes (or load v0.4
        // job rows from SQLite) still get a useful classification.
        if (error.code === "STARTUP_TIMEOUT") {
            return {
                kind: "startup_timeout",
                summary: "the Kimi CLI did not respond during startup.",
                nextStep: "Run `/kimi:setup` to verify local Kimi health, then retry.",
                runtimeProbe: "failed",
                authProbe: "failed",
            };
        }
        if (error.code === "INITIALIZE_TIMEOUT") {
            return {
                kind: "initialize_timeout",
                summary: "the Kimi session started but did not finish initializing in time.",
                nextStep: "Run `/kimi:setup` to verify local Kimi configuration and retry.",
                runtimeProbe: "failed",
                authProbe: "failed",
            };
        }
        if (error.code === "RESPONSE_TIMEOUT") {
            return {
                kind: "response_timeout",
                summary: "Kimi started and accepted the prompt but never returned a final response.",
                nextStep: "Narrow the prompt or raise the budget (`--budget <dur>`, at most 24h). Check the job artifact (`result <jobId>`) for any captured partial output. Backgrounding does not extend the runtime budget.",
                runtimeProbe: "ok",
                authProbe: "ok",
            };
        }
    }
    if (message.includes("timed out")) {
        return {
            kind: "timeout",
            summary: "the Kimi runtime did not become ready within the expected time budget.",
            nextStep: "Run `/kimi:setup` to check local Kimi auth and network health, then retry.",
            runtimeProbe: "failed",
            authProbe: "failed",
        };
    }
    return null;
}
function mapAvailabilityCode(kind, commandType) {
    const prefix = commandType.toUpperCase();
    switch (kind) {
        case "auth_unavailable":
            return `${prefix}_KIMI_AUTH_UNAVAILABLE`;
        case "binary_unavailable":
            return `${prefix}_KIMI_BINARY_UNAVAILABLE`;
        case "startup_failed":
            return `${prefix}_KIMI_STARTUP_FAILED`;
        case "startup_timeout":
            return `${prefix}_KIMI_STARTUP_TIMEOUT`;
        case "initialize_timeout":
            return `${prefix}_KIMI_INITIALIZE_TIMEOUT`;
        case "response_timeout":
            return `${prefix}_KIMI_RESPONSE_TIMEOUT`;
        case "timeout":
            return `${prefix}_KIMI_TIMEOUT`;
        case "max_steps_reached":
            return `${prefix}_KIMI_MAX_STEPS_REACHED`;
    }
}
function formatCommandLabel(commandType) {
    switch (commandType) {
        case "challenge":
            return "challenge";
        case "review_gate":
            return "review gate";
        default:
            return commandType.replaceAll("_", " ");
    }
}
