import { describe, expect, test } from "bun:test";
import path from "node:path";

import { ApprovalDispatcher, rejectAllApprovals } from "../../runtime/wire/approval-dispatcher.js";
import { WireClient } from "../../runtime/wire/client.js";
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
      protocol_version: "1.9",
      client: { name: "test-client", version: "0.1.0" },
    });
    await run(client);
  } finally {
    await client.close();
    await cleanupTestPath(pluginDataRoot);
  }
}

describe("WireClient interrupted-turn handling", () => {
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
        protocol_version: "1.9",
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
});
