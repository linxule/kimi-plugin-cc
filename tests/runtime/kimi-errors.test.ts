import { describe, expect, test } from "bun:test";

import { RuntimeError } from "../../runtime/errors.js";
import { classifyManagedCommandFailure } from "../../runtime/kimi-errors.js";

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
