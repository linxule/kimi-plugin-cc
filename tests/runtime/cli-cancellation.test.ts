import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createCliCancellationHandlers } from "../../runtime/cli-cancellation.js";

describe("createCliCancellationHandlers", () => {
  const baselineSigterm: NodeJS.SignalsListener[] = [];
  const baselineSigint: NodeJS.SignalsListener[] = [];

  beforeEach(() => {
    baselineSigterm.push(...(process.listeners("SIGTERM") as NodeJS.SignalsListener[]));
    baselineSigint.push(...(process.listeners("SIGINT") as NodeJS.SignalsListener[]));
  });

  afterEach(() => {
    // Defensive — every test must dispose, but if one didn't, scrub
    // listeners back to baseline so a later test isn't polluted.
    for (const listener of process.listeners("SIGTERM") as NodeJS.SignalsListener[]) {
      if (!baselineSigterm.includes(listener)) {
        process.off("SIGTERM", listener);
      }
    }
    for (const listener of process.listeners("SIGINT") as NodeJS.SignalsListener[]) {
      if (!baselineSigint.includes(listener)) {
        process.off("SIGINT", listener);
      }
    }
    baselineSigterm.length = 0;
    baselineSigint.length = 0;
  });

  test("starts not cancelling and exposes a non-aborted signal", () => {
    const handlers = createCliCancellationHandlers();
    try {
      expect(handlers.cancelling).toBe(false);
      expect(handlers.signal.aborted).toBe(false);
    } finally {
      handlers.dispose();
    }
  });

  test("registers SIGTERM listener that flips cancelling and aborts the signal", () => {
    const handlers = createCliCancellationHandlers();
    try {
      const listeners = process.listeners("SIGTERM") as NodeJS.SignalsListener[];
      // Find the listener that didn't exist before (avoid invoking
      // process.emit('SIGTERM') globally which would call ALL listeners,
      // including the test harness's own).
      const newListener = listeners.find((l) => !baselineSigterm.includes(l));
      expect(newListener).toBeDefined();
      newListener!("SIGTERM" as NodeJS.Signals);
      expect(handlers.cancelling).toBe(true);
      expect(handlers.signal.aborted).toBe(true);
    } finally {
      handlers.dispose();
    }
  });

  test("registers SIGINT listener with same semantics", () => {
    const handlers = createCliCancellationHandlers();
    try {
      const listeners = process.listeners("SIGINT") as NodeJS.SignalsListener[];
      const newListener = listeners.find((l) => !baselineSigint.includes(l));
      expect(newListener).toBeDefined();
      newListener!("SIGINT" as NodeJS.Signals);
      expect(handlers.cancelling).toBe(true);
      expect(handlers.signal.aborted).toBe(true);
    } finally {
      handlers.dispose();
    }
  });

  test("dispose removes process listeners", () => {
    const handlers = createCliCancellationHandlers();
    const beforeDispose = (process.listeners("SIGTERM") as NodeJS.SignalsListener[]).length;
    handlers.dispose();
    const afterDispose = (process.listeners("SIGTERM") as NodeJS.SignalsListener[]).length;
    expect(afterDispose).toBe(beforeDispose - 1);
  });

  test("dispose is idempotent", () => {
    const handlers = createCliCancellationHandlers();
    handlers.dispose();
    expect(() => handlers.dispose()).not.toThrow();
  });

  test("multiple signals only set cancelling once", () => {
    const handlers = createCliCancellationHandlers();
    try {
      const listeners = process.listeners("SIGTERM") as NodeJS.SignalsListener[];
      const newListener = listeners.find((l) => !baselineSigterm.includes(l));
      newListener!("SIGTERM" as NodeJS.Signals);
      newListener!("SIGTERM" as NodeJS.Signals);
      newListener!("SIGTERM" as NodeJS.Signals);
      expect(handlers.cancelling).toBe(true);
    } finally {
      handlers.dispose();
    }
  });
});
