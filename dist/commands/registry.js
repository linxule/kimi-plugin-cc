import { RuntimeError } from "../errors.js";
const passthroughOutput = "passthrough";
const DEFAULT_ESCALATION_MS = 1_500;
function makeCancellationConfig(prefix) {
    const { displayName, errorCodeStem } = prefix;
    return {
        escalationMs: DEFAULT_ESCALATION_MS,
        errorCodes: {
            cancelledDuringStart: `${errorCodeStem}_CANCELLED_DURING_START`,
            cancelled: `${errorCodeStem}_CANCELLED`,
        },
        cancelMessages: {
            duringStart: `${displayName} cancelled during startup.`,
            afterPrompt: `${displayName} cancelled by user request after prompt completion.`,
            afterArtifact: `${displayName} cancelled by user request after artifact write.`,
            default: `${displayName} cancelled by user request.`,
        },
        cancelledSummary: `${displayName} cancelled by user request.`,
        failedSummary: `${displayName} failed.`,
    };
}
export const COMMAND_REGISTRY = {
    ask: {
        outputMode: passthroughOutput,
        cancellation: makeCancellationConfig({ displayName: "Ask", errorCodeStem: "ASK" }),
    },
    review: {
        outputMode: passthroughOutput,
        cancellation: makeCancellationConfig({ displayName: "review", errorCodeStem: "REVIEW" }),
    },
    challenge: {
        outputMode: passthroughOutput,
        cancellation: makeCancellationConfig({ displayName: "challenge", errorCodeStem: "CHALLENGE" }),
    },
    rescue: {
        outputMode: passthroughOutput,
        cancellation: makeCancellationConfig({ displayName: "Rescue", errorCodeStem: "RESCUE" }),
    },
};
/**
 * Convenience accessor for managed commands (ask/review/challenge/rescue).
 * Identical to direct lookup, with a defensive runtime guard: TypeScript
 * narrows `commandType` to `ManagedCommandType`, but a stale SQLite row,
 * corrupted job artifact, or future command type added without a registry
 * entry could still reach here at runtime. Throwing a classified `RuntimeError`
 * keeps the failure path within the command-layer error model so `job status`
 * and `job result` render it correctly.
 */
export function getManagedCommandConfig(commandType) {
    const config = COMMAND_REGISTRY[commandType];
    if (!config) {
        throw new RuntimeError("UNKNOWN_COMMAND_TYPE", `No registry entry for command type "${String(commandType)}". This indicates a stale job record or an unregistered command.`, "commands.registry");
    }
    return config;
}
