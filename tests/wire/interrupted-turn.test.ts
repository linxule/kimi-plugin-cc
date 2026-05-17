import { describe, expect, test } from "bun:test";
import path from "node:path";

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
    // v0.3.1 task #41 (revised in v0.3.3 by Claude H2): the mock now
    // emits diversified think payloads (`chunk-${n++}`) so the duplicate
    // detector cannot win the race against the time-based watchdog.
    // Pre-v0.3.3 the mock emitted identical payloads, so this test
    // accidentally rode the loop detector when the test name promised
    // the stall watchdog. The loop detector has its own test below.
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
    // v0.3.3 (Claude M2): separate scenario from think-stall, asserts
    // the duplicate-content detector fires INDEPENDENTLY of the
    // time-based watchdog. thinkStallMs raised to a value that the
    // duplicate detector should comfortably beat.
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
    // v0.3.3 (Claude M2): direct coverage for the v0.3.2 guard.
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
      await expect(client.prompt("second", "setup")).rejects.toThrow(
        "Wire client cannot run two prompts concurrently",
      );
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
