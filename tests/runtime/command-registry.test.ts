import { describe, expect, test } from "bun:test";

import { RuntimeError } from "../../runtime/errors.js";
import {
  COMMAND_REGISTRY,
  getManagedCommandConfig,
} from "../../runtime/commands/registry.js";
import type { ManagedCommandType } from "../../runtime/types.js";

/**
 * Pins the per-command cancellation surface that ask/rescue/review/
 * review_gate present to callers. Asserts the EXACT error-code strings
 * and message templates the registry produces, so a future refactor
 * (e.g., a "polish the displayName" pass) can't silently change what
 * downstream `error.code === "..."` checks observe.
 *
 * Notable invariants this test locks in:
 *
 * 1. Each managed command has a `_CANCELLED` runtime code AND a
 *    distinct `_CANCELLED_DURING_START` startup code. Pre-v0.3.5
 *    `review` and `challenge` collapsed both to `REVIEW_CANCELLED` /
 *    `CHALLENGE_CANCELLED`; v0.3.5 aligns them with the ask/rescue
 *    convention. This test pins the new codes.
 *
 * 2. Mixed casing in displayName is INTENTIONAL: `ask`/`rescue`/
 *    `review_gate` carry Title-case names ("Ask cancelled...");
 *    `review`/`challenge` carry lowercase ("review cancelled...").
 *    This matches the pre-v0.3.5 user-visible strings exactly.
 */

const managedTypes: readonly ManagedCommandType[] = [
  "ask",
  "review",
  "challenge",
  "rescue",
  "review_gate",
] as const;

describe("COMMAND_REGISTRY", () => {
  test("only managed command types appear in the registry", () => {
    // Narrowing to ManagedCommandType means setup/task are NOT keys.
    // If a future contributor tries to add them, this assertion fires.
    expect(Object.keys(COMMAND_REGISTRY).sort()).toEqual(
      [...managedTypes].sort(),
    );
  });

  test.each([...managedTypes])(
    "%s has distinct _CANCELLED and _CANCELLED_DURING_START codes",
    (commandType) => {
      const cancel = COMMAND_REGISTRY[commandType].cancellation;
      expect(cancel.errorCodes.cancelled).toMatch(/_CANCELLED$/);
      expect(cancel.errorCodes.cancelledDuringStart).toMatch(/_CANCELLED_DURING_START$/);
      expect(cancel.errorCodes.cancelled).not.toBe(
        cancel.errorCodes.cancelledDuringStart,
      );
    },
  );

  test("ask cancellation codes and messages match the pre-registry hardcoded values", () => {
    const cancel = COMMAND_REGISTRY.ask.cancellation;
    expect(cancel.errorCodes.cancelled).toBe("ASK_CANCELLED");
    expect(cancel.errorCodes.cancelledDuringStart).toBe("ASK_CANCELLED_DURING_START");
    expect(cancel.cancelMessages.duringStart).toBe("Ask cancelled during startup.");
    expect(cancel.cancelMessages.default).toBe("Ask cancelled by user request.");
    expect(cancel.cancelledSummary).toBe("Ask cancelled by user request.");
    expect(cancel.failedSummary).toBe("Ask failed.");
  });

  test("rescue cancellation codes and messages match the pre-registry hardcoded values", () => {
    const cancel = COMMAND_REGISTRY.rescue.cancellation;
    expect(cancel.errorCodes.cancelled).toBe("RESCUE_CANCELLED");
    expect(cancel.errorCodes.cancelledDuringStart).toBe("RESCUE_CANCELLED_DURING_START");
    expect(cancel.cancelMessages.duringStart).toBe("Rescue cancelled during startup.");
    expect(cancel.cancelMessages.default).toBe("Rescue cancelled by user request.");
  });

  test("review uses lowercase displayName matching the pre-registry `${commandType}` interpolation", () => {
    // The OLD review.ts code interpolated `${commandType}` directly
    // (lowercase), producing "review cancelled by user request." not
    // "Review cancelled...". The registry preserves this casing so
    // existing user-visible messages stay byte-identical.
    const cancel = COMMAND_REGISTRY.review.cancellation;
    expect(cancel.errorCodes.cancelled).toBe("REVIEW_CANCELLED");
    expect(cancel.errorCodes.cancelledDuringStart).toBe("REVIEW_CANCELLED_DURING_START");
    expect(cancel.cancelMessages.duringStart).toBe("review cancelled during startup.");
    expect(cancel.cancelMessages.afterPrompt).toBe(
      "review cancelled by user request after prompt completion.",
    );
    expect(cancel.cancelMessages.afterArtifact).toBe(
      "review cancelled by user request after artifact write.",
    );
    expect(cancel.cancelMessages.default).toBe("review cancelled by user request.");
    expect(cancel.cancelledSummary).toBe("review cancelled by user request.");
    expect(cancel.failedSummary).toBe("review failed.");
  });

  test("challenge uses lowercase displayName matching the pre-registry `${commandType}` interpolation", () => {
    const cancel = COMMAND_REGISTRY.challenge.cancellation;
    expect(cancel.errorCodes.cancelled).toBe("CHALLENGE_CANCELLED");
    expect(cancel.errorCodes.cancelledDuringStart).toBe("CHALLENGE_CANCELLED_DURING_START");
    expect(cancel.cancelMessages.duringStart).toBe("challenge cancelled during startup.");
    expect(cancel.cancelMessages.default).toBe("challenge cancelled by user request.");
    expect(cancel.failedSummary).toBe("challenge failed.");
  });

  test("review_gate cancellation codes use the lowercased compound noun", () => {
    const cancel = COMMAND_REGISTRY.review_gate.cancellation;
    expect(cancel.errorCodes.cancelled).toBe("REVIEW_GATE_CANCELLED");
    expect(cancel.errorCodes.cancelledDuringStart).toBe("REVIEW_GATE_CANCELLED_DURING_START");
    expect(cancel.cancelMessages.default).toBe("review_gate cancelled by user request.");
    expect(cancel.cancelledSummary).toBe("review_gate cancelled by user request.");
  });

  test("outputMode discriminant: review_gate is parsed; everything else is passthrough", () => {
    expect(COMMAND_REGISTRY.ask.outputMode).toBe("passthrough");
    expect(COMMAND_REGISTRY.review.outputMode).toBe("passthrough");
    expect(COMMAND_REGISTRY.challenge.outputMode).toBe("passthrough");
    expect(COMMAND_REGISTRY.rescue.outputMode).toBe("passthrough");
    expect(COMMAND_REGISTRY.review_gate.outputMode).toBe("parsed");
  });

  test.each([...managedTypes])(
    "getManagedCommandConfig(%s) returns the same entry as direct registry lookup",
    (commandType) => {
      expect(getManagedCommandConfig(commandType)).toBe(COMMAND_REGISTRY[commandType]);
    },
  );

  test("escalationMs is uniform across all managed commands (1500ms)", () => {
    for (const commandType of managedTypes) {
      expect(COMMAND_REGISTRY[commandType].cancellation.escalationMs).toBe(1_500);
    }
  });

  test("getManagedCommandConfig throws UNKNOWN_COMMAND_TYPE for an unregistered key at runtime", () => {
    // TypeScript narrows the parameter to ManagedCommandType, but at
    // runtime a corrupted SQLite row, stale artifact, or a future
    // command type added without a registry entry could still flow
    // here. The defensive guard converts the otherwise-unclassified
    // `TypeError: Cannot destructure property 'outputMode' of undefined`
    // into a classified RuntimeError that the command-layer error path
    // can render through /kimi:status and /kimi:result.
    const bogus = "phantom_command" as unknown as ManagedCommandType;
    expect(() => getManagedCommandConfig(bogus)).toThrow(RuntimeError);
    try {
      getManagedCommandConfig(bogus);
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeError);
      expect((error as RuntimeError).code).toBe("UNKNOWN_COMMAND_TYPE");
      expect((error as RuntimeError).message).toContain("phantom_command");
    }
  });
});
