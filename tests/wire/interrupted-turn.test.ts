import { describe, expect, test } from "bun:test";
import path from "node:path";

import { RuntimeError } from "../../runtime/errors.js";
import { ApprovalDispatcher, rejectAllApprovals } from "../../runtime/wire/approval-dispatcher.js";
import { WireClient } from "../../runtime/wire/client.js";
import { KIMI_WIRE_PROTOCOL_VERSION } from "../../runtime/wire/types.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

const repoRoot = process.cwd();

async function withMockClient(
  scenario: string,
  run: (client: WireClient) => Promise<void>,
): Promise<void> {
  const pluginDataRoot = await createTestPluginDataRoot(`wire-${scenario}`);
  const logPath = path.join(pluginDataRoot, "wire-log.jsonl");

  const client = new WireClient({
    cwd: repoRoot,
    command: "bun",
    args: ["run", "tests/helpers/mock-wire-server.ts", scenario],
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: pluginDataRoot,
    },
    logPath,
    approvalDispatcher: new ApprovalDispatcher(
      rejectAllApprovals("unexpected approval request in test"),
    ),
  });

  try {
    await client.start();
    await client.initialize({
      protocol_version: KIMI_WIRE_PROTOCOL_VERSION,
      client: { name: "test-client", version: "0.1.0" },
    });
    await run(client);
  } finally {
    await client.close();
    await cleanupTestPath(pluginDataRoot);
  }
}

describe("WireClient interrupted-turn handling", () => {
  test("think-stall watchdog cancels reasoning-only streams (KIMI_THINK_STALLED)", async () => {
    // The mock emits diversified think payloads (`chunk-${n++}`) so the
    // duplicate detector cannot win the race against the time-based
    // watchdog — otherwise this test would accidentally ride the loop
    // detector when its name promises the stall watchdog. The loop
    // detector has its own test below.
    const pluginDataRoot = await createTestPluginDataRoot("wire-think-stall");
    const logPath = path.join(pluginDataRoot, "wire-log.jsonl");

    const client = new WireClient({
      cwd: repoRoot,
      command: "bun",
      args: ["run", "tests/helpers/mock-wire-server.ts", "think-stall"],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: pluginDataRoot,
      },
      logPath,
      approvalDispatcher: new ApprovalDispatcher(
        rejectAllApprovals("unexpected approval request in test"),
      ),
      thinkStallMs: 250,
    });

    try {
      await client.start();
      await client.initialize({
        protocol_version: KIMI_WIRE_PROTOCOL_VERSION,
        client: { name: "test-client", version: "0.1.0" },
      });
      await expect(client.prompt("think please", "setup")).rejects.toThrow(
        "Kimi reasoning stream produced only `think` events",
      );
    } finally {
      await client.close();
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("loop detector fires KIMI_THINK_LOOP_DETECTED on consecutive identical think payloads", async () => {
    // Separate scenario from think-stall: asserts the duplicate-content
    // detector fires INDEPENDENTLY of the time-based watchdog.
    // thinkStallMs raised to a value the duplicate detector should
    // comfortably beat.
    const pluginDataRoot = await createTestPluginDataRoot("wire-think-loop");
    const logPath = path.join(pluginDataRoot, "wire-log.jsonl");

    const client = new WireClient({
      cwd: repoRoot,
      command: "bun",
      args: ["run", "tests/helpers/mock-wire-server.ts", "think-loop"],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: pluginDataRoot,
      },
      logPath,
      approvalDispatcher: new ApprovalDispatcher(
        rejectAllApprovals("unexpected approval request in test"),
      ),
      // 60s — comfortably beyond the duplicate detector window. If
      // the loop detector regresses, this test will hang and CI will
      // notice the time excess rather than masking it as a stall.
      thinkStallMs: 60_000,
      thinkLoopDuplicateThreshold: 8,
    });

    try {
      await client.start();
      await client.initialize({
        protocol_version: KIMI_WIRE_PROTOCOL_VERSION,
        client: { name: "test-client", version: "0.1.0" },
      });
      await expect(client.prompt("loop please", "setup")).rejects.toThrow(
        "consecutive identical `think` payloads",
      );
    } finally {
      await client.close();
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("concurrent prompt() rejects the second caller with WIRE_PROMPT_CONCURRENT", async () => {
    // Direct coverage for the prompt()-level concurrent-call guard.
    const pluginDataRoot = await createTestPluginDataRoot("wire-concurrent");
    const logPath = path.join(pluginDataRoot, "wire-log.jsonl");

    const client = new WireClient({
      cwd: repoRoot,
      command: "bun",
      args: ["run", "tests/helpers/mock-wire-server.ts", "think-stall"],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: pluginDataRoot,
      },
      logPath,
      approvalDispatcher: new ApprovalDispatcher(
        rejectAllApprovals("unexpected approval request in test"),
      ),
      thinkStallMs: 250,
    });

    try {
      await client.start();
      await client.initialize({
        protocol_version: KIMI_WIRE_PROTOCOL_VERSION,
        client: { name: "test-client", version: "0.1.0" },
      });
      const first = client.prompt("first", "setup").catch(() => {});
      // Yield one microtask so the first prompt assigns currentTurn.
      await new Promise((resolve) => setImmediate(resolve));
      // Assert the structured error code, not the message text — locks
      // in the contract callers actually check against.
      let secondError: unknown;
      try {
        await client.prompt("second", "setup");
      } catch (error) {
        secondError = error;
      }
      expect(secondError).toBeInstanceOf(RuntimeError);
      expect((secondError as RuntimeError).code).toBe("WIRE_PROMPT_CONCURRENT");
      await first;
    } finally {
      await client.close();
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("fails if the server returns finished without TurnEnd", async () => {
    await withMockClient("missing-turn-end", async (client) => {
      await expect(client.prompt("hello", "setup")).rejects.toThrow(
        "Wire turn finished without a TurnEnd event",
      );
    });
  });

  test("WireClient can issue a second prompt after a stall-cancelled first prompt (cancelInFlight reset)", async () => {
    // After the watchdog cancels a prompt, the next prompt on the SAME
    // client must run a fresh guard and see cancelInFlight=false. The
    // failure mode if the reset breaks: the second prompt's watchdog
    // calls maybeCancelInFlight, hits the coalescing gate, and never
    // delivers a cancel JSON-RPC, so the prompt hangs until the bun
    // test timeout. This test pins the reset semantics on the WireClient
    // surface; the per-prompt guard handles its own per-turn lifecycle.
    const pluginDataRoot = await createTestPluginDataRoot("wire-reuse");
    const logPath = path.join(pluginDataRoot, "wire-log.jsonl");

    const client = new WireClient({
      cwd: repoRoot,
      command: "bun",
      args: ["run", "tests/helpers/mock-wire-server.ts", "think-stall"],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: pluginDataRoot,
      },
      logPath,
      approvalDispatcher: new ApprovalDispatcher(
        rejectAllApprovals("unexpected approval request in test"),
      ),
      thinkStallMs: 200,
    });

    try {
      await client.start();
      await client.initialize({
        protocol_version: KIMI_WIRE_PROTOCOL_VERSION,
        client: { name: "test-client", version: "0.1.0" },
      });
      // First prompt: stalls and is cancelled by the watchdog.
      await expect(client.prompt("first", "setup")).rejects.toThrow(
        "Kimi reasoning stream produced only `think` events",
      );
      // Second prompt on the SAME client: must run a fresh guard and
      // see a clean cancelInFlight state. Should stall identically.
      // If cancelInFlight wasn't reset, the watchdog's cancel would
      // short-circuit and the test would hang at the prompt-timeout
      // wall clock.
      await expect(client.prompt("second", "setup")).rejects.toThrow(
        "Kimi reasoning stream produced only `think` events",
      );
    } finally {
      await client.close();
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("warnedUnknownThinkPayloadShape is one-shot PER WireClient instance, not per process", async () => {
    // Guards against a future "dedupe stderr noise" refactor that
    // could move the warn flag back to module scope. We construct two
    // independent WireClients, trigger the unknown-think-shape path
    // on each, and assert the warning string appears exactly twice in
    // captured stderr — once per instance. If the flag regresses to
    // module scope, the second instance would silently suppress its
    // warning and this test would see exactly one match.
    const originalWrite = process.stderr.write.bind(process.stderr);
    const writes: string[] = [];
    process.stderr.write = ((chunk: unknown) => {
      writes.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;

    const matchWarning = (s: string) =>
      s.includes("think ContentPart payload missing recognized text field");

    const makeClient = async (label: string) => {
      const pluginDataRoot = await createTestPluginDataRoot(`wire-warn-${label}`);
      const logPath = path.join(pluginDataRoot, "wire-log.jsonl");
      const client = new WireClient({
        cwd: repoRoot,
        command: "bun",
        args: ["run", "tests/helpers/mock-wire-server.ts", "unknown-think-shape"],
        env: {
          ...process.env,
          CLAUDE_PLUGIN_DATA: pluginDataRoot,
        },
        logPath,
        approvalDispatcher: new ApprovalDispatcher(
          rejectAllApprovals("unexpected approval request in test"),
        ),
      });
      return { client, pluginDataRoot };
    };

    const a = await makeClient("a");
    const b = await makeClient("b");
    try {
      await a.client.start();
      await a.client.initialize({
        protocol_version: KIMI_WIRE_PROTOCOL_VERSION,
        client: { name: "test-client", version: "0.1.0" },
      });
      await a.client.prompt("hello-a", "setup");

      await b.client.start();
      await b.client.initialize({
        protocol_version: KIMI_WIRE_PROTOCOL_VERSION,
        client: { name: "test-client", version: "0.1.0" },
      });
      await b.client.prompt("hello-b", "setup");

      const warnings = writes.filter(matchWarning);
      expect(warnings).toHaveLength(2);
    } finally {
      await a.client.close();
      await b.client.close();
      await cleanupTestPath(a.pluginDataRoot);
      await cleanupTestPath(b.pluginDataRoot);
      process.stderr.write = originalWrite;
    }
  });

  test("identical text ContentParts do NOT trip the loop detector (handleLine seam test)", async () => {
    // The per-guard unit tests can prove the loop detector fires on
    // identical hashes — but they cannot reach the routing policy in
    // WireClient.handleLine that decides observeThinkPart vs
    // observeForwardProgress. If isThinkOnlyEvent or the if-branch
    // inverted, identical text payloads would falsely trip the loop
    // detector. This test pins the routing end-to-end: 20 identical
    // `ContentPart{type:"text"}` payloads must complete cleanly,
    // never firing KIMI_THINK_LOOP_DETECTED.
    await withMockClient("text-loop", async (client) => {
      const completed = await client.prompt("text-loop please", "setup");
      // Final commit holds the trailing "identical-text" — verifies
      // the turn finished cleanly without any think-stall error.
      expect(completed.finalText).toContain("identical-text");
    });
  });

  test("fails cancelled turns instead of returning partial output", async () => {
    await withMockClient("cancelled", async (client) => {
      await expect(client.prompt("hello", "setup")).rejects.toThrow(
        "Wire turn ended with status 'cancelled'",
      );
    });
  });

  test("routes approval requests through the dispatcher hook", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("wire-approval");
    const logPath = path.join(pluginDataRoot, "wire-log.jsonl");
    const approvals: string[] = [];
    const client = new WireClient({
      cwd: repoRoot,
      command: "bun",
      args: ["run", "tests/helpers/mock-wire-server.ts", "approval-request"],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: pluginDataRoot,
      },
      logPath,
      approvalDispatcher: new ApprovalDispatcher(async (request, context) => {
        approvals.push(`${context.commandType}:${request.action}`);
        return {
          response: "reject",
          feedback: "blocked in test",
        };
      }),
    });

    try {
      await client.start();
      await client.initialize({
        protocol_version: KIMI_WIRE_PROTOCOL_VERSION,
        client: { name: "test-client", version: "0.1.0" },
      });

      const promptPromise = client.prompt("hello", "setup");

      await expect(promptPromise).rejects.toThrow("blocked in test");
      expect(approvals).toEqual(["setup:run shell command"]);
    } finally {
      await client.close();
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("cancellation flips in-flight approvals to reject", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("wire-approval-cancel");
    const logPath = path.join(pluginDataRoot, "wire-log.jsonl");
    const client = new WireClient({
      cwd: repoRoot,
      command: "bun",
      args: ["run", "tests/helpers/mock-wire-server.ts", "approval-cancel"],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: pluginDataRoot,
      },
      logPath,
      approvalDispatcher: new ApprovalDispatcher(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 150);
        });
        return {
          response: "approve",
        };
      }),
    });

    try {
      await client.start();
      await client.initialize({
        protocol_version: KIMI_WIRE_PROTOCOL_VERSION,
        client: { name: "test-client", version: "0.1.0" },
      });

      const promptPromise = client.prompt("hello", "rescue");
      setTimeout(() => {
        client.beginCancellation();
        void client.cancel().catch(() => {});
      }, 10);

      await expect(promptPromise).rejects.toThrow("Command cancellation is in progress.");
      const logText = await Bun.file(logPath).text();
      expect(logText).toContain("\"response\":\"reject\"");
    } finally {
      await client.close();
      await cleanupTestPath(pluginDataRoot);
    }
  });
});
