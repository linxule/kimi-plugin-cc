import { describe, expect, test } from "bun:test";

import { RuntimeError } from "../../runtime/errors.js";
import { createTurnCapture, finalizeTurnCapture, observeTurnEvent } from "../../runtime/wire/turn-capture.js";

describe("finalizeTurnCapture", () => {
  test("returns the captured turn on a clean finished status", () => {
    const state = createTurnCapture();
    observeTurnEvent(state, "ContentPart", { type: "text", text: "hello" });
    observeTurnEvent(state, "TurnEnd", {});

    const completed = finalizeTurnCapture(state, { status: "finished" });
    expect(completed.finalText).toBe("hello");
    expect(completed.promptResult.status).toBe("finished");
  });

  test("throws MAX_STEPS_REACHED with step count when Kimi hits its budget", () => {
    // v0.3.0 task #14: previously this surfaced as TURN_INTERRUPTED with a
    // generic message; users couldn't tell apart "Kimi was cancelled" from
    // "Kimi exhausted its step budget". The new code includes the step
    // count in the message so the next-step hint is actionable.
    const state = createTurnCapture();
    observeTurnEvent(state, "ContentPart", { type: "text", text: "partial answer" });

    let captured: unknown;
    try {
      finalizeTurnCapture(state, { status: "max_steps_reached", steps: 50 });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(RuntimeError);
    expect((captured as RuntimeError).code).toBe("MAX_STEPS_REACHED");
    expect((captured as RuntimeError).message).toContain("50 steps");
  });

  test("throws TURN_INTERRUPTED for cancelled status (preserving legacy behavior)", () => {
    const state = createTurnCapture();

    let captured: unknown;
    try {
      finalizeTurnCapture(state, { status: "cancelled" });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(RuntimeError);
    expect((captured as RuntimeError).code).toBe("TURN_INTERRUPTED");
  });
});
