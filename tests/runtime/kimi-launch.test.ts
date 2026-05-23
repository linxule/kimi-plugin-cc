/**
 * Unit tests for buildAndStartWireClient / buildAndStartWithFactory.
 *
 * We test via the buildAndStartWithFactory seam, which accepts a client
 * factory function. This avoids mock.module patching of shared modules that
 * would leak across the test suite.
 */
import { describe, expect, mock, test } from "bun:test";

import { RuntimeError } from "../../runtime/errors.js";
import { buildAndStartWithFactory, buildWireClient } from "../../runtime/kimi-launch.js";
import { rejectAllApprovals } from "../../runtime/wire/approval-dispatcher.js";
import type { WireClient } from "../../runtime/wire/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTimeoutError(stage: string): RuntimeError {
  return new RuntimeError("TIMEOUT", `${stage} timed out after 10000ms.`, stage);
}

function makeSpawnError(): RuntimeError {
  return new RuntimeError("WIRE_SPAWN_FAILED", "kimi not found", "wire.start");
}

type FakeClient = {
  readonly startCallCount: number;
  readonly closeCallCount: number;
  readonly startFn: ReturnType<typeof mock>;
  readonly closeFn: ReturnType<typeof mock>;
} & Pick<WireClient, "start" | "close" | "getChildPid">;

function makeFakeClient(startBehavior: () => Promise<void>): FakeClient {
  let startCount = 0;
  let closeCount = 0;

  const startFn = mock(async () => {
    startCount++;
    return startBehavior();
  });
  const closeFn = mock(async () => {
    closeCount++;
  });

  return {
    get startCallCount() {
      return startCount;
    },
    get closeCallCount() {
      return closeCount;
    },
    startFn,
    closeFn,
    start: startFn as unknown as WireClient["start"],
    close: closeFn as unknown as WireClient["close"],
    getChildPid: () => 12345,
  };
}

function makeEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildAndStartWithFactory", () => {
  test("attempt 1 succeeds — client returned, no retry", async () => {
    const fake1 = makeFakeClient(async () => {});
    let callCount = 0;
    const factory = () => {
      callCount++;
      return fake1 as unknown as WireClient;
    };

    const result = await buildAndStartWithFactory(factory, makeEnv(), 10_000, "test.start");

    expect(result).toBe(fake1 as unknown as WireClient);
    expect(callCount).toBe(1);
    expect(fake1.startCallCount).toBe(1);
    expect(fake1.closeCallCount).toBe(0); // not closed on success
  });

  test("attempt 1 times out, attempt 2 succeeds — second client returned", async () => {
    const fake1 = makeFakeClient(async () => {
      throw makeTimeoutError("test.start");
    });
    const fake2 = makeFakeClient(async () => {});
    const clients = [fake1, fake2];
    let callCount = 0;
    const factory = () => clients[callCount++] as unknown as WireClient;

    const result = await buildAndStartWithFactory(factory, makeEnv(), 10_000, "test.start");

    expect(result).toBe(fake2 as unknown as WireClient);
    expect(callCount).toBe(2); // factory called twice — two spawns
    expect(fake1.startCallCount).toBe(1);
    expect(fake1.closeCallCount).toBe(1); // cleaned up after attempt 1
    expect(fake2.startCallCount).toBe(1);
    expect(fake2.closeCallCount).toBe(0); // not closed on success
  });

  test("attempt 1 times out, attempt 2 times out — error thrown with TIMEOUT code and original stage", async () => {
    const fake1 = makeFakeClient(async () => {
      throw makeTimeoutError("test.start");
    });
    const fake2 = makeFakeClient(async () => {
      throw makeTimeoutError("test.start");
    });
    const clients = [fake1, fake2];
    let callCount = 0;
    const factory = () => clients[callCount++] as unknown as WireClient;

    let thrown: unknown;
    try {
      await buildAndStartWithFactory(factory, makeEnv(), 10_000, "test.start");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(RuntimeError);
    const err = thrown as RuntimeError;
    expect(err.code).toBe("TIMEOUT");
    expect(err.stage).toBe("test.start");
    expect(callCount).toBe(2);
    expect(fake1.closeCallCount).toBe(1);
    expect(fake2.closeCallCount).toBe(1);
  });

  test("attempt 1 fails with non-timeout error — re-thrown immediately, no retry", async () => {
    const fake1 = makeFakeClient(async () => {
      throw makeSpawnError();
    });
    let callCount = 0;
    const factory = () => {
      callCount++;
      return fake1 as unknown as WireClient;
    };

    let thrown: unknown;
    try {
      await buildAndStartWithFactory(factory, makeEnv(), 10_000, "test.start");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(RuntimeError);
    const err = thrown as RuntimeError;
    expect(err.code).toBe("WIRE_SPAWN_FAILED");
    expect(callCount).toBe(1); // factory called only once
    expect(fake1.closeCallCount).toBe(1);
  });

  test("attempt 1 times out on a different stage — not retried (only own stage triggers retry)", async () => {
    // A TIMEOUT error whose stage doesn't match the caller's stage should not retry.
    // This guards against retrying on initialize/prompt timeouts if they somehow bubble up.
    const fake1 = makeFakeClient(async () => {
      throw makeTimeoutError("some.other.stage");
    });
    let callCount = 0;
    const factory = () => {
      callCount++;
      return fake1 as unknown as WireClient;
    };

    let thrown: unknown;
    try {
      await buildAndStartWithFactory(factory, makeEnv(), 10_000, "test.start");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(RuntimeError);
    const err = thrown as RuntimeError;
    expect(err.code).toBe("TIMEOUT");
    expect(err.stage).toBe("some.other.stage");
    expect(callCount).toBe(1);
    expect(fake1.closeCallCount).toBe(1);
  });

  test("KIMI_PLUGIN_CC_DISABLE_START_RETRY=1 — attempt 1 timeout, no retry", async () => {
    const fake1 = makeFakeClient(async () => {
      throw makeTimeoutError("test.start");
    });
    let callCount = 0;
    const factory = () => {
      callCount++;
      return fake1 as unknown as WireClient;
    };

    let thrown: unknown;
    try {
      await buildAndStartWithFactory(
        factory,
        makeEnv({ KIMI_PLUGIN_CC_DISABLE_START_RETRY: "1" }),
        10_000,
        "test.start",
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(RuntimeError);
    const err = thrown as RuntimeError;
    expect(err.code).toBe("TIMEOUT");
    expect(callCount).toBe(1); // no retry
    expect(fake1.closeCallCount).toBe(1);
  });

  test("shouldRetry callback returns false — attempt 1 timeout, no retry", async () => {
    // Simulates the caller being mid-cancellation: signal fired during startup,
    // so the caller doesn't want the helper to spawn a second kimi process.
    const fake1 = makeFakeClient(async () => {
      throw makeTimeoutError("test.start");
    });
    let callCount = 0;
    const factory = () => {
      callCount++;
      return fake1 as unknown as WireClient;
    };

    let thrown: unknown;
    try {
      await buildAndStartWithFactory(factory, makeEnv(), 10_000, "test.start", {
        shouldRetry: () => false,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(RuntimeError);
    const err = thrown as RuntimeError;
    expect(err.code).toBe("TIMEOUT");
    expect(err.stage).toBe("test.start");
    expect(callCount).toBe(1); // shouldRetry=false short-circuits retry
    expect(fake1.closeCallCount).toBe(1);
  });

  test("shouldRetry callback returns true — attempt 1 timeout, retry proceeds", async () => {
    // Confirms the gate is opt-in; truthy returns let the retry happen.
    const fake1 = makeFakeClient(async () => {
      throw makeTimeoutError("test.start");
    });
    const fake2 = makeFakeClient(async () => {});
    const clients = [fake1, fake2];
    let callCount = 0;
    const factory = () => clients[callCount++] as unknown as WireClient;

    const result = await buildAndStartWithFactory(factory, makeEnv(), 10_000, "test.start", {
      shouldRetry: () => true,
    });

    expect(result).toBe(fake2 as unknown as WireClient);
    expect(callCount).toBe(2);
  });
});

describe("buildWireClient env validation", () => {
  test("absent watchdog env vars keep WireClient defaults", () => {
    expect(() =>
      buildWireClient({
        cwd: process.cwd(),
        env: {},
        sessionId: "session",
        agentFile: "agent.yaml",
        logPath: "/tmp/kimi-plugin-cc-test.log",
        approvalPolicy: rejectAllApprovals("test"),
      }),
    ).not.toThrow();
  });

  test.each([
    ["KIMI_PLUGIN_CC_THINK_STALL_MS", ""],
    ["KIMI_PLUGIN_CC_THINK_STALL_MS", "-1"],
    ["KIMI_PLUGIN_CC_THINK_STALL_MS", "1.5"],
    ["KIMI_PLUGIN_CC_THINK_LOOP_DUPLICATES", "abc"],
  ])("throws INVALID_ENV for malformed %s=%s", (name, value) => {
    expect(() =>
      buildWireClient({
        cwd: process.cwd(),
        env: { [name]: value },
        sessionId: "session",
        agentFile: "agent.yaml",
        logPath: "/tmp/kimi-plugin-cc-test.log",
        approvalPolicy: rejectAllApprovals("test"),
      }),
    ).toThrow(RuntimeError);

    try {
      buildWireClient({
        cwd: process.cwd(),
        env: { [name]: value },
        sessionId: "session",
        agentFile: "agent.yaml",
        logPath: "/tmp/kimi-plugin-cc-test.log",
        approvalPolicy: rejectAllApprovals("test"),
      });
    } catch (error) {
      expect((error as RuntimeError).code).toBe("INVALID_ENV");
      expect((error as RuntimeError).details).toMatchObject({ env_var: name, value });
    }
  });
});
