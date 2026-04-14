import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { ApprovalDispatcher, rejectAllApprovals } from "../../runtime/wire/approval-dispatcher.js";
import { WireClient } from "../../runtime/wire/client.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

const hasKimi = spawnSync("sh", ["-lc", "command -v kimi >/dev/null 2>&1"], {
  cwd: process.cwd(),
}).status === 0;
const runLiveTest = process.env.KIMI_PLUGIN_CC_LIVE_TEST === "1";

describe("WireClient live Kimi integration", () => {
  test.if(hasKimi && runLiveTest)("initializes a real kimi --wire process", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("live-kimi");
    const logPath = path.join(pluginDataRoot, "wire-log.jsonl");
    const client = new WireClient({
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: pluginDataRoot,
      },
      logPath,
      approvalDispatcher: new ApprovalDispatcher(
        rejectAllApprovals("integration test does not allow approvals"),
      ),
    });

    try {
      await client.start();
      const result = await client.initialize({
        protocol_version: "1.9",
        client: { name: "kimi-plugin-cc-tests", version: "0.1.0" },
      });

      expect(result.server.name.length).toBeGreaterThan(0);
      expect(result.server.version.length).toBeGreaterThan(0);
      expect(result.protocol_version.length).toBeGreaterThan(0);
    } finally {
      await client.close();
      await cleanupTestPath(pluginDataRoot);
    }
  });
});
