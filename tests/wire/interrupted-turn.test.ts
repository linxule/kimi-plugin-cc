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
    // v0.3.1 task #41: kimi-cli 1.44.0 thinking-on enters indefinite
    // reasoning-only loops where the upstream HTTP stream never
    // terminates. Client-side watchdog detects only-`think`-events for
    // thinkStallMs, sends cancel, finalizes the pending prompt with
    // KIMI_THINK_STALLED instead of waiting for the global timeout.
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
      // 250ms — keeps the test fast while still exercising the timer arm /
      // disarm / cancel-flow. Real default is 120_000.
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
