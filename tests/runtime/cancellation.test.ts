import { describe, expect, test } from "bun:test";
import process from "node:process";

import { createCancellationHandlers } from "../../runtime/cancellation.js";
import type { WireClient } from "../../runtime/wire/client.js";

/**
 * Tests for the v0.3.1 cancellation helper. Pre-v0.3.2 there were zero
 * direct tests (Claude reviewer flagged this gap). The eager
 * fire-on-attach path is a behavior expansion over v0.3.0's "cancelled
 * during start" handling, so it gets explicit coverage here.
 */

interface MockStats {
  beginCancellationCalls: number;
  cancelCalls: number;
  terminateChildCalls: NodeJS.Signals[];
}

interface MockWireClient {
  stats: MockStats;
  client: WireClient;
}

function makeMockClient(): MockWireClient {
  // Stats live in a shared object — earlier version of this test destructured
  // them into the return object, which snapshotted the initial values and
  // hid all subsequent mutations from the assertions.
  const stats: MockStats = {
    beginCancellationCalls: 0,
    cancelCalls: 0,
    terminateChildCalls: [],
  };
  const client = {
    beginCancellation: () => {
      stats.beginCancellationCalls += 1;
    },
    cancel: async () => {
      stats.cancelCalls += 1;
      return {} as never;
    },
    terminateChild: (signal: NodeJS.Signals = "SIGTERM") => {
      stats.terminateChildCalls.push(signal);
    },
  } as unknown as WireClient;
  return { stats, client };
}

describe("createCancellationHandlers", () => {
  test("attachClient before cancel does not fire wire-side cancel", async () => {
    const mock = makeMockClient();
    const handlers = createCancellationHandlers({ escalationMs: 50 });
    try {
      handlers.attachClient(mock.client);
      expect(handlers.cancelling).toBeFalse();
      // Allow event-loop microtasks to settle in case cancel() was scheduled.
      await new Promise((resolve) => setImmediate(resolve));
      expect(mock.stats.cancelCalls).toBe(0);
      expect(mock.stats.beginCancellationCalls).toBe(0);
    } finally {
      handlers.dispose();
    }
  });

  test("SIGTERM after attachClient fires beginCancellation + cancel + scheduled SIGTERM escalation", async () => {
    const mock = makeMockClient();
    const handlers = createCancellationHandlers({ escalationMs: 30 });
    try {
      handlers.attachClient(mock.client);
      process.emit("SIGTERM");
      expect(handlers.cancelling).toBeTrue();
      // beginCancellation + cancel fire synchronously.
      expect(mock.stats.beginCancellationCalls).toBe(1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(mock.stats.cancelCalls).toBe(1);
      // Escalation timer fires after escalationMs.
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(mock.stats.terminateChildCalls).toEqual(["SIGTERM"]);
    } finally {
      handlers.dispose();
    }
  });

  test("SIGTERM before attachClient latches cancelling; attachClient then eagerly fires the wire-side cancel", async () => {
    // The "cancel landed during start" path Claude flagged as
    // behaviorally new in v0.3.1 — pre-v0.3.1 the synthetic throw was
    // the only path; v0.3.1+ also fans the cancel out to the wire.
    const mock = makeMockClient();
    const handlers = createCancellationHandlers({ escalationMs: 30 });
    try {
      process.emit("SIGTERM");
      expect(handlers.cancelling).toBeTrue();
      expect(mock.stats.cancelCalls).toBe(0);
      handlers.attachClient(mock.client);
      expect(mock.stats.beginCancellationCalls).toBe(1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(mock.stats.cancelCalls).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(mock.stats.terminateChildCalls).toEqual(["SIGTERM"]);
    } finally {
      handlers.dispose();
    }
  });

  test("clearEscalation prevents the SIGTERM escalation from firing", async () => {
    const mock = makeMockClient();
    const handlers = createCancellationHandlers({ escalationMs: 30 });
    try {
      handlers.attachClient(mock.client);
      process.emit("SIGTERM");
      handlers.clearEscalation();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(mock.stats.terminateChildCalls).toEqual([]);
    } finally {
      handlers.dispose();
    }
  });

  test("sequential create+dispose × 50 keeps SIGTERM/SIGINT listener counts at baseline (Kimi adversarial stress)", () => {
    // v0.3.3 (Kimi adversarial): the v0.2.x bug class was signal
    // listeners leaking after job termination. The unit test verifies
    // exactly one create/dispose pair, which doesn't catch a per-iter
    // leak. This stress test loops 50 times and asserts that both
    // counts return to baseline after all handlers dispose.
    //
    // Codex audit risk #5: Node's default maxListeners is 10, so 50
    // concurrent registrations trigger MaxListenersExceededWarning
    // noise in CI logs. Raise the limit temporarily for the test
    // window so we exercise the real handler count without polluting
    // output. Restore on the way out.
    const priorSigtermMax = process.getMaxListeners();
    process.setMaxListeners(Math.max(priorSigtermMax, 100));
    const sigtermBase = process.listenerCount("SIGTERM");
    const sigintBase = process.listenerCount("SIGINT");
    const handlers = [];
    try {
      for (let i = 0; i < 50; i += 1) {
        handlers.push(createCancellationHandlers({ escalationMs: 50 }));
      }
      expect(process.listenerCount("SIGTERM")).toBe(sigtermBase + 50);
      expect(process.listenerCount("SIGINT")).toBe(sigintBase + 50);
      for (const h of handlers) {
        h.dispose();
      }
      expect(process.listenerCount("SIGTERM")).toBe(sigtermBase);
      expect(process.listenerCount("SIGINT")).toBe(sigintBase);
    } finally {
      process.setMaxListeners(priorSigtermMax);
    }
  });

  test("dispose is idempotent and removes the SIGTERM/SIGINT listeners", () => {
    const before = process.listenerCount("SIGTERM");
    const handlers = createCancellationHandlers({ escalationMs: 50 });
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    handlers.dispose();
    handlers.dispose(); // second dispose is a no-op
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  test("scheduleEscalation only runs once even if SIGTERM fires twice", async () => {
    const mock = makeMockClient();
    const handlers = createCancellationHandlers({ escalationMs: 30 });
    try {
      handlers.attachClient(mock.client);
      process.emit("SIGTERM");
      process.emit("SIGTERM");
      await new Promise((resolve) => setImmediate(resolve));
      expect(mock.stats.beginCancellationCalls).toBe(1);
      expect(mock.stats.cancelCalls).toBe(1);
    } finally {
      handlers.dispose();
    }
  });
});
