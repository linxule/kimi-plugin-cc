import { RuntimeError } from "../errors.js";
import type { ManagedCommandType } from "../types.js";

/**
 * Discriminant for how the command's Kimi output is consumed.
 *
 * - `passthrough`: the prose `finalText` is rendered verbatim into the
 *   artifact. review/challenge/ask/rescue all use this since v0.2.3
 *   dropped their JSON schemas.
 * - `parsed`: the command JSON.parses the output and validates it
 *   against a structured schema. review_gate is currently the only
 *   parsed command (JSON allow/block decision).
 *
 * The discriminant exists so a future caller can type-narrow on it
 * instead of inferring intent from the command-type string. The
 * runtime invariant (review/challenge/ask/rescue are prose
 * pass-through) is now enforced at the registry layer.
 */
export type CommandOutputMode = "passthrough" | "parsed";

/**
 * Per-command cancellation policy. Captured once here so the
 * boilerplate in ask/rescue/review can't drift on error codes,
 * messages, or escalation timing.
 */
export interface CommandCancellationConfig {
  /**
   * Milliseconds to wait after `client.cancel()` before escalating to
   * SIGTERM on the wire child. All managed commands currently use
   * 1500ms; the registry exists so per-command tuning is possible
   * without searching the codebase.
   */
  readonly escalationMs: number;
  /** Error codes used when wrapping cancel events. */
  readonly errorCodes: {
    readonly cancelledDuringStart: string;
    readonly cancelled: string;
  };
  /** Canonical user-visible cancel messages at each phase. */
  readonly cancelMessages: {
    readonly duringStart: string;
    readonly afterPrompt: string;
    readonly afterArtifact: string;
    readonly default: string;
  };
  /** Summary string written to the cancelled job record. */
  readonly cancelledSummary: string;
  /** Summary string written to a failed job record. */
  readonly failedSummary: string;
}

export interface CommandConfig {
  readonly outputMode: CommandOutputMode;
  readonly cancellation: CommandCancellationConfig;
}

const passthroughOutput: CommandOutputMode = "passthrough";
const parsedOutput: CommandOutputMode = "parsed";

const DEFAULT_ESCALATION_MS = 1_500;

/**
 * Build the cancellation config from a short prefix. The prefix is
 * both the title-cased noun ("Ask"/"Rescue"/...) and the SCREAMING
 * uppercase error-code stem ("ASK_"/"RESCUE_"/...). Centralizes the
 * pattern that ask/rescue/review used to inline in three near-identical
 * variants.
 */
function makeCancellationConfig(prefix: {
  /** Capitalized noun used in user-visible messages, e.g. "Ask". */
  readonly displayName: string;
  /** Uppercase stem used in error codes, e.g. "ASK". */
  readonly errorCodeStem: string;
}): CommandCancellationConfig {
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
export const COMMAND_REGISTRY: Readonly<Record<ManagedCommandType, CommandConfig>> = {
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
export function getManagedCommandConfig(commandType: ManagedCommandType): CommandConfig {
  const config = COMMAND_REGISTRY[commandType];
  if (!config) {
    throw new RuntimeError(
      "UNKNOWN_COMMAND_TYPE",
      `No registry entry for command type "${String(commandType)}". This indicates a stale job record or an unregistered command.`,
      "commands.registry",
    );
  }
  return config;
}
