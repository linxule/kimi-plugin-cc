import { RuntimeError, formatError } from "./errors.js";
export function classifyManagedCommandFailure(error, commandType, jobId, options) {
    const classification = classifyKimiAvailability(error);
    if (!classification) {
        return error instanceof Error ? error : new Error(String(error));
    }
    const label = formatCommandLabel(commandType);
    const stage = options?.preserveStage && error instanceof RuntimeError
        ? error.stage
        : `${commandType}.runtime`;
    return new RuntimeError(mapAvailabilityCode(classification.kind, commandType), `${label} could not run because ${classification.summary} ${classification.nextStep} Job ${jobId} was persisted as failed.`, stage, error instanceof Error ? { cause: error } : undefined);
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
    if (message.includes("LLM is not set") || message.includes("LLM service error")) {
        return {
            kind: "auth_unavailable",
            summary: "local Kimi authentication or model configuration is not usable.",
            nextStep: "Run `/kimi:setup`, then `kimi login` or fix the local Kimi model configuration and retry.",
            runtimeProbe: "ok",
            authProbe: "failed",
        };
    }
    if (error instanceof RuntimeError && error.code === "CLI_SPAWN_FAILED") {
        return {
            kind: "binary_unavailable",
            summary: "the Kimi CLI is missing from PATH or not executable in this environment.",
            nextStep: "Run `/kimi:setup` to verify the install, then expose `kimi` on PATH and retry.",
            runtimeProbe: "failed",
            authProbe: "failed",
        };
    }
    // v1.0 cli-client surfaces async ENOENT (Bun) as CLI_PROCESS_ERROR with
    // "spawn ... ENOENT" in the message. Map that to binary_unavailable so
    // the failure message points users at /kimi:setup.
    if (error instanceof RuntimeError &&
        error.code === "CLI_PROCESS_ERROR" &&
        /\bENOENT\b/.test(message)) {
        return {
            kind: "binary_unavailable",
            summary: "the Kimi CLI is missing from PATH or not executable in this environment.",
            nextStep: "Run `/kimi:setup` to verify the install, then expose `kimi` on PATH and retry.",
            runtimeProbe: "failed",
            authProbe: "failed",
        };
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
                nextStep: "Reduce the prompt scope (or for /kimi:ask and /kimi:rescue, retry with --background to detach). If the response still hangs after a fresh run, check local Kimi version and report upstream.",
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
