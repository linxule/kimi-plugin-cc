import { RuntimeError, formatError } from "./errors.js";
export function classifyManagedCommandFailure(error, commandType, jobId) {
    const classification = classifyKimiAvailability(error);
    if (!classification) {
        return error instanceof Error ? error : new Error(String(error));
    }
    const label = formatCommandLabel(commandType);
    return new RuntimeError(mapAvailabilityCode(classification.kind, commandType), `${label} could not run because ${classification.summary} ${classification.nextStep} Job ${jobId} was persisted as failed.`, `${commandType}.runtime`, error instanceof Error ? { cause: error } : undefined);
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
        return `Kimi ${formatCommandLabel(commandType).toLowerCase()} could not start a usable Wire session; allowing stop.`;
    }
    return null;
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
    if (error instanceof RuntimeError &&
        error.code === "WIRE_SPAWN_FAILED") {
        return {
            kind: "binary_unavailable",
            summary: "the Kimi CLI is missing from PATH or not executable in this environment.",
            nextStep: "Run `/kimi:setup` to verify the install, then expose `kimi` on PATH and retry.",
            runtimeProbe: "failed",
            authProbe: "failed",
        };
    }
    if (message.includes("Failed to start kimi")) {
        return {
            kind: "startup_failed",
            summary: "the Kimi CLI reported a startup failure before the Wire session was ready.",
            nextStep: "Run `/kimi:setup` to inspect the local Kimi installation and retry.",
            runtimeProbe: "failed",
            authProbe: "failed",
        };
    }
    if (error instanceof RuntimeError &&
        error.code === "WIRE_PROCESS_EXITED") {
        return {
            kind: "startup_failed",
            summary: "the Kimi Wire process exited before the session initialized.",
            nextStep: "Run `/kimi:setup` to verify local Kimi health, then retry.",
            runtimeProbe: "failed",
            authProbe: "failed",
        };
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
    switch (kind) {
        case "auth_unavailable":
            return `${commandType.toUpperCase()}_KIMI_AUTH_UNAVAILABLE`;
        case "binary_unavailable":
            return `${commandType.toUpperCase()}_KIMI_BINARY_UNAVAILABLE`;
        case "startup_failed":
            return `${commandType.toUpperCase()}_KIMI_STARTUP_FAILED`;
        case "timeout":
            return `${commandType.toUpperCase()}_KIMI_TIMEOUT`;
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
