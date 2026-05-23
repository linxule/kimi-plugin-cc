import { describe, expect, test } from "bun:test";

import { RuntimeError } from "../../runtime/errors.js";
import { classifyManagedCommandFailure, summarizeKimiAvailabilityWarning } from "../../runtime/kimi-errors.js";

describe("classifyManagedCommandFailure", () => {
  test("returns the original error when classification does not recognize it", () => {
    const original = new Error("something unrelated");
    const result = classifyManagedCommandFailure(original, "rescue", "job-xyz");
    expect(result).toBe(original);
  });

  test("collapses to `${commandType}.runtime` stage by default", () => {
    const inner = new RuntimeError(
      "TIMEOUT",
      "rescue.initialize timed out after 15000ms.",
      "rescue.initialize",
    );
    const result = classifyManagedCommandFailure(inner, "rescue", "job-xyz");
    expect(result).toBeInstanceOf(RuntimeError);
    expect((result as RuntimeError).code).toBe("RESCUE_KIMI_TIMEOUT");
    expect((result as RuntimeError).stage).toBe("rescue.runtime");
  });

  test("preserveStage keeps the deepest RuntimeError stage for rescue", () => {
    const inner = new RuntimeError(
      "TIMEOUT",
      "rescue.initialize timed out after 15000ms.",
      "rescue.initialize",
    );
    const result = classifyManagedCommandFailure(inner, "rescue", "job-xyz", {
      preserveStage: true,
    });
    expect(result).toBeInstanceOf(RuntimeError);
    expect((result as RuntimeError).code).toBe("RESCUE_KIMI_TIMEOUT");
    expect((result as RuntimeError).stage).toBe("rescue.initialize");
  });

  test("preserveStage preserves wire.start when WIRE_SPAWN_FAILED is the inner cause", () => {
    const inner = new RuntimeError(
      "WIRE_SPAWN_FAILED",
      "Failed to spawn kimi.",
      "wire.start",
    );
    const result = classifyManagedCommandFailure(inner, "rescue", "job-xyz", {
      preserveStage: true,
    });
    expect(result).toBeInstanceOf(RuntimeError);
    expect((result as RuntimeError).code).toBe("RESCUE_KIMI_BINARY_UNAVAILABLE");
    expect((result as RuntimeError).stage).toBe("wire.start");
  });

  test("preserveStage only kicks in when the inner error is a RuntimeError", () => {
    const inner = new Error("Failed to start kimi: ENOENT");
    const result = classifyManagedCommandFailure(inner, "rescue", "job-xyz", {
      preserveStage: true,
    });
    expect(result).toBeInstanceOf(RuntimeError);
    // Falls back to the default stage because inner is a plain Error, not a RuntimeError.
    expect((result as RuntimeError).stage).toBe("rescue.runtime");
  });

  test("distinguishes startup, initialize, and response timeouts per command type", () => {
    // v0.3.0 task #10: separate codes for "Kimi never started" vs "Kimi
    // started but never responded" so users can tell apart a dead binary
    // from a thinking-on finalization hang.
    const startup = classifyManagedCommandFailure(
      new RuntimeError("STARTUP_TIMEOUT", "review.start timed out after 10000ms.", "review.start"),
      "review",
      "job-xyz",
    ) as RuntimeError;
    expect(startup.code).toBe("REVIEW_KIMI_STARTUP_TIMEOUT");

    const init = classifyManagedCommandFailure(
      new RuntimeError(
        "INITIALIZE_TIMEOUT",
        "ask.initialize timed out after 15000ms.",
        "ask.initialize",
      ),
      "ask",
      "job-xyz",
    ) as RuntimeError;
    expect(init.code).toBe("ASK_KIMI_INITIALIZE_TIMEOUT");

    const response = classifyManagedCommandFailure(
      new RuntimeError(
        "RESPONSE_TIMEOUT",
        "review.prompt timed out after 600000ms.",
        "review.prompt",
      ),
      "review",
      "job-xyz",
    ) as RuntimeError;
    expect(response.code).toBe("REVIEW_KIMI_RESPONSE_TIMEOUT");
  });

  test("legacy `TIMEOUT` code still maps to `${COMMAND}_KIMI_TIMEOUT` for back-compat", () => {
    const legacy = classifyManagedCommandFailure(
      new RuntimeError("TIMEOUT", "ask.start timed out after 10000ms.", "ask.start"),
      "ask",
      "job-xyz",
    ) as RuntimeError;
    expect(legacy.code).toBe("ASK_KIMI_TIMEOUT");
  });

  test("plain Error with `timed out` substring falls through the legacy string-match branch", () => {
    const plain = classifyManagedCommandFailure(
      new Error("Kimi initialize timed out"),
      "review",
      "job-xyz",
    ) as RuntimeError;
    expect(plain.code).toBe("REVIEW_KIMI_TIMEOUT");
  });

  test("MAX_STEPS_REACHED is mapped to a command-prefixed code", () => {
    // Managed commands map MAX_STEPS_REACHED to a command-prefixed code
    // for parity with the timeout codes (which already prefix as
    // `${PREFIX}_KIMI_*_TIMEOUT`).
    const ask = classifyManagedCommandFailure(
      new RuntimeError(
        "MAX_STEPS_REACHED",
        "Kimi reached its step budget (50 steps) before finalizing this turn.",
        "wire.prompt",
      ),
      "ask",
      "job-xyz",
    ) as RuntimeError;
    expect(ask.code).toBe("ASK_KIMI_MAX_STEPS_REACHED");

    const review = classifyManagedCommandFailure(
      new RuntimeError("MAX_STEPS_REACHED", "Kimi reached step budget.", "wire.prompt"),
      "review",
      "job-xyz",
    ) as RuntimeError;
    expect(review.code).toBe("REVIEW_KIMI_MAX_STEPS_REACHED");
  });

  test("ask, review, challenge, and review_gate default behavior is unchanged (preserveStage opt-in)", () => {
    const inner = new RuntimeError(
      "TIMEOUT",
      "initialize timed out.",
      "some.inner.stage",
    );
    const askResult = classifyManagedCommandFailure(inner, "ask", "job-xyz");
    expect((askResult as RuntimeError).stage).toBe("ask.runtime");

    const reviewResult = classifyManagedCommandFailure(inner, "review", "job-xyz");
    expect((reviewResult as RuntimeError).stage).toBe("review.runtime");

    const challengeResult = classifyManagedCommandFailure(inner, "challenge", "job-xyz");
    expect((challengeResult as RuntimeError).stage).toBe("challenge.runtime");

    const gateResult = classifyManagedCommandFailure(inner, "review_gate", "job-xyz");
    expect((gateResult as RuntimeError).stage).toBe("review_gate.runtime");
  });
});

describe("summarizeKimiAvailabilityWarning", () => {
  test.each([
    {
      error: new Error("LLM is not set"),
      expected: "Kimi review gate is not configured for model access; allowing stop.",
    },
    {
      error: new RuntimeError("WIRE_SPAWN_FAILED", "Failed to spawn kimi.", "wire.start"),
      expected: "Kimi review gate could not find the Kimi CLI; allowing stop.",
    },
    {
      error: new RuntimeError("WIRE_PROCESS_EXITED", "exited", "wire.process"),
      expected: "Kimi review gate could not start a usable Wire session; allowing stop.",
    },
    {
      error: new RuntimeError("STARTUP_TIMEOUT", "startup timed out", "wire.start"),
      expected: "Kimi review gate did not respond during startup; allowing stop.",
    },
    {
      error: new RuntimeError("INITIALIZE_TIMEOUT", "initialize timed out", "wire.initialize"),
      expected: "Kimi review gate did not complete Wire initialization; allowing stop.",
    },
    {
      error: new RuntimeError("RESPONSE_TIMEOUT", "prompt timed out", "wire.prompt"),
      expected: "Kimi review gate did not return a final response; allowing stop.",
    },
    {
      error: new RuntimeError("MAX_STEPS_REACHED", "max steps", "wire.prompt"),
      expected: "Kimi review gate exhausted its step budget; allowing stop.",
    },
    {
      error: new Error("operation timed out"),
      expected: "Kimi review gate timed out; allowing stop.",
    },
  ])("returns an explicit warning for $expected", ({ error, expected }) => {
    expect(summarizeKimiAvailabilityWarning(error, "review_gate")).toBe(expected);
  });
});
