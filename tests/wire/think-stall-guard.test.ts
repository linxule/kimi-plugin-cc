import { describe, expect, test } from "bun:test";

import { ThinkStallGuard } from "../../runtime/wire/think-stall-guard.js";

function thinkPayload(text: string): Record<string, unknown> {
  return { type: "think", text };
}

describe("ThinkStallGuard", () => {
  test("starts unstalled and reports null reason until something latches", () => {
    const guard = new ThinkStallGuard({
      thinkStallMs: 60_000,
      thinkLoopDuplicateThreshold: 8,
      onCancel: () => {},
    });
    try {
      expect(guard.stallReason).toBeNull();
      expect(guard.stallError()).toBeNull();
    } finally {
      guard.dispose();
    }
  });

  test("latches `stall` and invokes onCancel when only think events arrive past the deadline", async () => {
    let cancelCount = 0;
    const guard = new ThinkStallGuard({
      thinkStallMs: 50,
      thinkLoopDuplicateThreshold: 0, // disable loop detector to isolate stall
      onCancel: () => {
        cancelCount += 1;
      },
    });
    try {
      // Even feeding diverse think payloads should NOT count as forward
      // progress — the time-based watchdog should fire regardless.
      guard.observeThinkPart(thinkPayload("alpha"));
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(guard.stallReason).toBe("stall");
      expect(cancelCount).toBe(1);
      const err = guard.stallError();
      expect(err).not.toBeNull();
      expect(err?.code).toBe("KIMI_THINK_STALLED");
      expect(err?.message).toContain("over 50ms");
    } finally {
      guard.dispose();
    }
  });

  test("observeForwardProgress re-arms the timer and clears the hash window", async () => {
    let cancelCount = 0;
    const guard = new ThinkStallGuard({
      thinkStallMs: 80,
      thinkLoopDuplicateThreshold: 3,
      onCancel: () => {
        cancelCount += 1;
      },
    });
    try {
      // Accumulate 2 identical hashes (one short of threshold), then a
      // non-think event clears them. Two more identical hashes after
      // the reset should NOT trip the loop detector.
      guard.observeThinkPart(thinkPayload("looped"));
      guard.observeThinkPart(thinkPayload("looped"));
      guard.observeForwardProgress();
      guard.observeThinkPart(thinkPayload("looped"));
      guard.observeThinkPart(thinkPayload("looped"));
      expect(guard.stallReason).toBeNull();
      expect(cancelCount).toBe(0);
      // The re-arm in observeForwardProgress should keep the timer
      // alive past the original 80ms deadline.
      await new Promise((resolve) => setTimeout(resolve, 50));
      guard.observeForwardProgress();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(guard.stallReason).toBeNull();
    } finally {
      guard.dispose();
    }
  });

  test("latches `loop` and invokes onCancel once on N consecutive identical think payloads", () => {
    let cancelCount = 0;
    const guard = new ThinkStallGuard({
      thinkStallMs: 60_000,
      thinkLoopDuplicateThreshold: 4,
      onCancel: () => {
        cancelCount += 1;
      },
    });
    try {
      for (let i = 0; i < 4; i += 1) {
        guard.observeThinkPart(thinkPayload("stuck-payload"));
      }
      expect(guard.stallReason).toBe("loop");
      expect(cancelCount).toBe(1);
      const err = guard.stallError();
      expect(err?.code).toBe("KIMI_THINK_LOOP_DETECTED");
      expect(err?.message).toContain("4 consecutive identical");
      // Subsequent observations are no-ops; cancelCount stays at 1.
      guard.observeThinkPart(thinkPayload("stuck-payload"));
      guard.observeForwardProgress();
      expect(cancelCount).toBe(1);
    } finally {
      guard.dispose();
    }
  });

  test("diverse think payloads do not trigger the loop detector", () => {
    let cancelCount = 0;
    const guard = new ThinkStallGuard({
      thinkStallMs: 60_000,
      thinkLoopDuplicateThreshold: 3,
      onCancel: () => {
        cancelCount += 1;
      },
    });
    try {
      for (let i = 0; i < 30; i += 1) {
        guard.observeThinkPart(thinkPayload(`chunk-${i}`));
      }
      expect(guard.stallReason).toBeNull();
      expect(cancelCount).toBe(0);
    } finally {
      guard.dispose();
    }
  });

  test("thinkStallMs <= 0 disables the time-based watchdog", async () => {
    let cancelCount = 0;
    const guard = new ThinkStallGuard({
      thinkStallMs: 0,
      thinkLoopDuplicateThreshold: 0,
      onCancel: () => {
        cancelCount += 1;
      },
    });
    try {
      guard.observeThinkPart(thinkPayload("only-think"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(guard.stallReason).toBeNull();
      expect(cancelCount).toBe(0);
    } finally {
      guard.dispose();
    }
  });

  test("thinkLoopDuplicateThreshold <= 0 disables the duplicate detector", () => {
    let cancelCount = 0;
    const guard = new ThinkStallGuard({
      thinkStallMs: 60_000,
      thinkLoopDuplicateThreshold: 0,
      onCancel: () => {
        cancelCount += 1;
      },
    });
    try {
      for (let i = 0; i < 50; i += 1) {
        guard.observeThinkPart(thinkPayload("dup"));
      }
      expect(guard.stallReason).toBeNull();
      expect(cancelCount).toBe(0);
    } finally {
      guard.dispose();
    }
  });

  test("dispose clears the timer; later expirations cannot latch a stall", async () => {
    let cancelCount = 0;
    const guard = new ThinkStallGuard({
      thinkStallMs: 50,
      thinkLoopDuplicateThreshold: 0,
      onCancel: () => {
        cancelCount += 1;
      },
    });
    guard.dispose();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(guard.stallReason).toBeNull();
    expect(cancelCount).toBe(0);
  });

  test("dispose is idempotent", () => {
    const guard = new ThinkStallGuard({
      thinkStallMs: 60_000,
      thinkLoopDuplicateThreshold: 8,
      onCancel: () => {},
    });
    guard.dispose();
    expect(() => guard.dispose()).not.toThrow();
  });

  test("onCancel throw does not escape the guard", () => {
    const guard = new ThinkStallGuard({
      thinkStallMs: 60_000,
      thinkLoopDuplicateThreshold: 2,
      onCancel: () => {
        throw new Error("cancel callback exploded");
      },
    });
    try {
      expect(() => {
        guard.observeThinkPart(thinkPayload("dup"));
        guard.observeThinkPart(thinkPayload("dup"));
      }).not.toThrow();
      expect(guard.stallReason).toBe("loop");
    } finally {
      guard.dispose();
    }
  });

  test("payload missing text field skips loop-detection and invokes onUnknownPayloadShape per observation", () => {
    // The guard delegates suppression to the caller via the callback —
    // unlike the v0.3.4-prerelease design that owned a process-wide
    // flag, the guard now fires the callback on EVERY unrecognized
    // payload and the caller (WireClient) handles one-shot semantics.
    // That keeps the guard pure and lets the suppression scope match
    // its sibling `warnedUnknownContentPartSubtypes` (per-WireClient).
    let unknownCount = 0;
    const guard = new ThinkStallGuard({
      thinkStallMs: 60_000,
      thinkLoopDuplicateThreshold: 2,
      onCancel: () => {},
      onUnknownPayloadShape: () => {
        unknownCount += 1;
      },
    });
    try {
      guard.observeThinkPart({ type: "think", delta: "no-text-field" });
      guard.observeThinkPart({ type: "think", delta: "still-no-text" });
      expect(guard.stallReason).toBeNull();
      expect(unknownCount).toBe(2);
    } finally {
      guard.dispose();
    }
  });

  test("payload missing text field is a no-op when no onUnknownPayloadShape callback is provided", () => {
    // Callback is optional — the guard must not crash when a caller
    // (e.g., a future consumer) omits the telemetry hook.
    const guard = new ThinkStallGuard({
      thinkStallMs: 60_000,
      thinkLoopDuplicateThreshold: 2,
      onCancel: () => {},
    });
    try {
      expect(() => {
        guard.observeThinkPart({ type: "think", delta: "no-text-field" });
      }).not.toThrow();
      expect(guard.stallReason).toBeNull();
    } finally {
      guard.dispose();
    }
  });
});
