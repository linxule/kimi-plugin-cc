import { describe, expect, test } from "bun:test";

import { ThinkStallGuard } from "../../runtime/wire/think-stall-guard.js";
import { isThinkOnlyEvent } from "../../runtime/wire/types.js";

// Helpers construct the (type, payload) tuples that observeEvent
// accepts — same shape WireClient hands to the guard from handleLine.
function observeThink(guard: ThinkStallGuard, text: string): void {
  guard.observeEvent("ContentPart", { type: "think", text });
}

function observeThinkRaw(guard: ThinkStallGuard, payload: Record<string, unknown>): void {
  guard.observeEvent("ContentPart", payload);
}

function observeProgress(guard: ThinkStallGuard): void {
  // Any non-think event counts as forward progress. StepBegin is the
  // canonical example, but TurnEnd, ToolCall, text ContentParts, etc.
  // all route through the same branch in observeEvent.
  guard.observeEvent("StepBegin", { n: 1 });
}

describe("ThinkStallGuard", () => {
  test("starts unstalled and reports null reason until something latches", () => {
    const guard = new ThinkStallGuard({
      thinkStallMs: 60_000,
      thinkLoopDuplicateThreshold: 8,
      onStallVerdict: () => {},
    });
    try {
      expect(guard.stallReason).toBeNull();
      expect(guard.stallError()).toBeNull();
    } finally {
      guard.dispose();
    }
  });

  test("latches `stall` and notifies onStallVerdict when only think events arrive past the deadline", async () => {
    const verdicts: string[] = [];
    const guard = new ThinkStallGuard({
      thinkStallMs: 50,
      thinkLoopDuplicateThreshold: 0, // disable loop detector to isolate stall
      onStallVerdict: (reason) => {
        verdicts.push(reason);
      },
    });
    try {
      // Even feeding diverse think payloads should NOT count as forward
      // progress — the time-based watchdog should fire regardless.
      observeThink(guard, "alpha");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(guard.stallReason).toBe("stall");
      expect(verdicts).toEqual(["stall"]);
      const err = guard.stallError();
      expect(err).not.toBeNull();
      expect(err?.code).toBe("KIMI_THINK_STALLED");
      expect(err?.message).toContain("over 50ms");
    } finally {
      guard.dispose();
    }
  });

  test("forward-progress events re-arm the timer and clear the hash window", async () => {
    const verdicts: string[] = [];
    const guard = new ThinkStallGuard({
      thinkStallMs: 80,
      thinkLoopDuplicateThreshold: 3,
      onStallVerdict: (reason) => {
        verdicts.push(reason);
      },
    });
    try {
      // Accumulate 2 identical hashes (one short of threshold), then a
      // non-think event clears them. Two more identical hashes after
      // the reset should NOT trip the loop detector.
      observeThink(guard, "looped");
      observeThink(guard, "looped");
      observeProgress(guard);
      observeThink(guard, "looped");
      observeThink(guard, "looped");
      expect(guard.stallReason).toBeNull();
      expect(verdicts).toHaveLength(0);
      // Forward-progress should also keep the timer alive past the
      // original 80ms deadline.
      await new Promise((resolve) => setTimeout(resolve, 50));
      observeProgress(guard);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(guard.stallReason).toBeNull();
    } finally {
      guard.dispose();
    }
  });

  test("latches `loop` and notifies onStallVerdict once on N consecutive identical think payloads", () => {
    const verdicts: string[] = [];
    const guard = new ThinkStallGuard({
      thinkStallMs: 60_000,
      thinkLoopDuplicateThreshold: 4,
      onStallVerdict: (reason) => {
        verdicts.push(reason);
      },
    });
    try {
      for (let i = 0; i < 4; i += 1) {
        observeThink(guard, "stuck-payload");
      }
      expect(guard.stallReason).toBe("loop");
      expect(verdicts).toEqual(["loop"]);
      const err = guard.stallError();
      expect(err?.code).toBe("KIMI_THINK_LOOP_DETECTED");
      expect(err?.message).toContain("4 consecutive identical");
      // Subsequent observations are no-ops; the verdict is one-shot.
      observeThink(guard, "stuck-payload");
      observeProgress(guard);
      expect(verdicts).toEqual(["loop"]);
    } finally {
      guard.dispose();
    }
  });

  test("diverse think payloads do not trigger the loop detector", () => {
    const verdicts: string[] = [];
    const guard = new ThinkStallGuard({
      thinkStallMs: 60_000,
      thinkLoopDuplicateThreshold: 3,
      onStallVerdict: (reason) => {
        verdicts.push(reason);
      },
    });
    try {
      for (let i = 0; i < 30; i += 1) {
        observeThink(guard, `chunk-${i}`);
      }
      expect(guard.stallReason).toBeNull();
      expect(verdicts).toHaveLength(0);
    } finally {
      guard.dispose();
    }
  });

  test("thinkStallMs <= 0 disables the time-based watchdog", async () => {
    const verdicts: string[] = [];
    const guard = new ThinkStallGuard({
      thinkStallMs: 0,
      thinkLoopDuplicateThreshold: 0,
      onStallVerdict: (reason) => {
        verdicts.push(reason);
      },
    });
    try {
      observeThink(guard, "only-think");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(guard.stallReason).toBeNull();
      expect(verdicts).toHaveLength(0);
    } finally {
      guard.dispose();
    }
  });

  test("thinkLoopDuplicateThreshold <= 0 disables the duplicate detector", () => {
    const verdicts: string[] = [];
    const guard = new ThinkStallGuard({
      thinkStallMs: 60_000,
      thinkLoopDuplicateThreshold: 0,
      onStallVerdict: (reason) => {
        verdicts.push(reason);
      },
    });
    try {
      for (let i = 0; i < 50; i += 1) {
        observeThink(guard, "dup");
      }
      expect(guard.stallReason).toBeNull();
      expect(verdicts).toHaveLength(0);
    } finally {
      guard.dispose();
    }
  });

  test("dispose clears the timer; later expirations cannot latch a stall", async () => {
    const verdicts: string[] = [];
    const guard = new ThinkStallGuard({
      thinkStallMs: 50,
      thinkLoopDuplicateThreshold: 0,
      onStallVerdict: (reason) => {
        verdicts.push(reason);
      },
    });
    guard.dispose();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(guard.stallReason).toBeNull();
    expect(verdicts).toHaveLength(0);
  });

  test("dispose is idempotent", () => {
    const guard = new ThinkStallGuard({
      thinkStallMs: 60_000,
      thinkLoopDuplicateThreshold: 8,
      onStallVerdict: () => {},
    });
    guard.dispose();
    expect(() => guard.dispose()).not.toThrow();
  });

  test("onStallVerdict throw does not escape the guard", () => {
    const guard = new ThinkStallGuard({
      thinkStallMs: 60_000,
      thinkLoopDuplicateThreshold: 2,
      onStallVerdict: () => {
        throw new Error("verdict callback exploded");
      },
    });
    try {
      expect(() => {
        observeThink(guard, "dup");
        observeThink(guard, "dup");
      }).not.toThrow();
      expect(guard.stallReason).toBe("loop");
    } finally {
      guard.dispose();
    }
  });

  test("payload missing text field skips loop-detection and invokes onUnknownPayloadShape per observation", () => {
    // The guard delegates suppression to the caller via the callback —
    // it fires the callback on EVERY unrecognized payload and the
    // caller (WireClient) handles one-shot semantics. That keeps the
    // guard pure and matches the per-WireClient scope of its sibling
    // `warnedUnknownContentPartSubtypes`.
    let unknownCount = 0;
    const guard = new ThinkStallGuard({
      thinkStallMs: 60_000,
      thinkLoopDuplicateThreshold: 2,
      onStallVerdict: () => {},
      onUnknownPayloadShape: () => {
        unknownCount += 1;
      },
    });
    try {
      observeThinkRaw(guard, { type: "think", delta: "no-text-field" });
      observeThinkRaw(guard, { type: "think", delta: "still-no-text" });
      expect(guard.stallReason).toBeNull();
      expect(unknownCount).toBe(2);
    } finally {
      guard.dispose();
    }
  });

  test("payload missing text field is a no-op when no onUnknownPayloadShape callback is provided", () => {
    const guard = new ThinkStallGuard({
      thinkStallMs: 60_000,
      thinkLoopDuplicateThreshold: 2,
      onStallVerdict: () => {},
    });
    try {
      expect(() => {
        observeThinkRaw(guard, { type: "think", delta: "no-text-field" });
      }).not.toThrow();
      expect(guard.stallReason).toBeNull();
    } finally {
      guard.dispose();
    }
  });

  test("observeEvent routes via isThinkOnlyEvent: non-ContentPart events count as forward progress", () => {
    // Pins the routing seam: StepBegin, ToolCall, TurnEnd, etc. must
    // all route to observeForwardProgress, NOT observeThinkPart. If
    // the routing inverts, 4 identical "StepBegin" events would
    // accumulate hashes and trip the loop detector — which would be
    // wrong.
    const verdicts: string[] = [];
    const guard = new ThinkStallGuard({
      thinkStallMs: 60_000,
      thinkLoopDuplicateThreshold: 3,
      onStallVerdict: (reason) => {
        verdicts.push(reason);
      },
    });
    try {
      for (let i = 0; i < 10; i += 1) {
        guard.observeEvent("StepBegin", { n: 1 });
        guard.observeEvent("ToolCall", { name: "shell" });
        guard.observeEvent("TurnEnd", {});
      }
      expect(guard.stallReason).toBeNull();
      expect(verdicts).toHaveLength(0);
    } finally {
      guard.dispose();
    }
  });

  describe("isThinkOnlyEvent (routing predicate)", () => {
    // Direct unit tests on the exported predicate so the routing rule
    // can be verified at the function level, independently of the
    // ThinkStallGuard.observeEvent integration. If a future refactor
    // changes the predicate's truth table, these tests catch it
    // synchronously instead of relying on the integration seam test.

    test("returns true for ContentPart with type:think", () => {
      expect(isThinkOnlyEvent("ContentPart", { type: "think", text: "x" })).toBeTrue();
    });

    test("returns false for ContentPart with type:text", () => {
      expect(isThinkOnlyEvent("ContentPart", { type: "text", text: "x" })).toBeFalse();
    });

    test("returns false for ContentPart with unknown subtype", () => {
      expect(isThinkOnlyEvent("ContentPart", { type: "speculation", text: "x" })).toBeFalse();
    });

    test("returns false for ContentPart with no `type` field", () => {
      expect(isThinkOnlyEvent("ContentPart", { text: "x" })).toBeFalse();
    });

    test("returns false for non-ContentPart event types", () => {
      expect(isThinkOnlyEvent("StepBegin", { n: 1 })).toBeFalse();
      expect(isThinkOnlyEvent("ToolCall", { type: "think" })).toBeFalse();
      expect(isThinkOnlyEvent("TurnEnd", {})).toBeFalse();
      expect(isThinkOnlyEvent("StatusUpdate", { type: "think" })).toBeFalse();
    });
  });

  test("observeEvent routes via isThinkOnlyEvent: text ContentPart counts as forward progress, not think", () => {
    // The `payload.type` discriminant matters even when wire type is
    // "ContentPart". 4 identical text ContentParts must NOT trip the
    // loop detector — that scenario is the integration seam test in
    // interrupted-turn.test.ts; this unit pins the same routing.
    const verdicts: string[] = [];
    const guard = new ThinkStallGuard({
      thinkStallMs: 60_000,
      thinkLoopDuplicateThreshold: 3,
      onStallVerdict: (reason) => {
        verdicts.push(reason);
      },
    });
    try {
      for (let i = 0; i < 10; i += 1) {
        guard.observeEvent("ContentPart", { type: "text", text: "identical" });
      }
      expect(guard.stallReason).toBeNull();
      expect(verdicts).toHaveLength(0);
    } finally {
      guard.dispose();
    }
  });
});
