import { RuntimeError } from "../errors.js";
const passthroughOutput = "passthrough";
const parsedOutput = "parsed";
const DEFAULT_ESCALATION_MS = 1_500;
/**
 * Build the cancellation config from a short prefix. The prefix is
 * both the title-cased noun ("Ask"/"Rescue"/...) and the SCREAMING
 * uppercase error-code stem ("ASK_"/"RESCUE_"/...). Centralizes the
 * pattern that ask/rescue/review used to inline in three near-identical
 * variants.
 */
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
/**
 * Single source of truth for per-command behavior. Keyed by
 * `ManagedCommandType` — only commands that actually run the
 * managed-cancellation flow participate. `setup` and `task` are
 * intentionally NOT here: they don't go through the SIGTERM/cancel
 * path that this registry configures, so adding placeholder entries
 * for them would be type-system noise without behavior.
 *
 * Casing note: `ask`, `rescue`, and `review_gate` carry capitalized
 * `displayName` values matching their pre-registry hardcoded strings
 * ("Ask cancelled...", "Rescue failed.", "review_gate cancelled..."
 * for the lowercased compound noun). `review` and `challenge` carry
 * lowercase displayName values to match their pre-registry pattern
 * (the old code interpolated `${commandType}` directly). Mixed casing
 * is established prior art — the registry preserves it rather than
 * homogenizing.
 */
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
    review_gate: {
        outputMode: parsedOutput,
        cancellation: makeCancellationConfig({ displayName: "review_gate", errorCodeStem: "REVIEW_GATE" }),
    },
};
/**
 * Convenience accessor for managed commands (review/challenge/rescue/
 * review_gate/ask). Identical to direct lookup, with a defensive
 * runtime guard: TypeScript narrows `commandType` to `ManagedCommandType`,
 * but a stale SQLite row, corrupted job artifact, or future command
 * type added without a registry entry could still reach here at
 * runtime. A bare `COMMAND_REGISTRY[commandType]` would return
 * `undefined` and surface as an unclassified `TypeError` at the
 * destructure call site. Throwing a classified `RuntimeError` here
 * keeps the failure path within the command-layer error model so
 * /kimi:status and /kimi:result render it correctly.
 */
export function getManagedCommandConfig(commandType) {
    const config = COMMAND_REGISTRY[commandType];
    if (!config) {
        throw new RuntimeError("UNKNOWN_COMMAND_TYPE", `No registry entry for command type "${String(commandType)}". This indicates a stale job record or an unregistered command.`, "commands.registry");
    }
    return config;
}
