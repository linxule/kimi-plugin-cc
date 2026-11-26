import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { JobStore } from "../../runtime/job-store.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import { createMcpFixture, McpClient, modernMeta } from "../helpers/mcp.js";

describe("MCP real-node hook enforcement", () => {
  test("a mock-backed kimi_read ask succeeds without a Node override or hook-check skip", async () => {
    const fixture = await createMcpFixture("mcp-hook-success");
    fixture.env.KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH = path.join(fixture.data, "invocation.json");
    let client: McpClient | undefined;
    try {
      expect(fixture.env.KIMI_PLUGIN_CC_NODE_BIN).toBeUndefined();
      expect(fixture.env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK).toBeUndefined();
      client = await McpClient.legacy(fixture);
      const result = await client.request("tools/call", {
        name: "kimi_read",
        arguments: { workspace: fixture.repo, mode: "ask", prompt: "Prove the hook is active" },
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent.status).toBe("completed");
      expect(result.content[0].text).toContain("Ask answer from mock Kimi.");
      expect(existsSync(fixture.env.KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH)).toBe(true);
    } finally {
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 60_000);

  test("a corrupted pin refuses before model spawn and does not create a task result", async () => {
    const fixture = await createMcpFixture("mcp-hook-refusal");
    const configPath = path.join(fixture.kimiHome, "config.toml");
    const config = await readFile(configPath, "utf8");
    await writeFile(configPath, config.replaceAll("approval-hook.js", "not-our-hook.js"), "utf8");
    fixture.env.KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH = path.join(fixture.data, "invocation.json");
    let client: McpClient | undefined;
    try {
      client = await McpClient.modern(fixture);
      const started = await client.request("tools/call", {
        name: "kimi_read",
        arguments: { workspace: fixture.repo, mode: "ask", prompt: "This must not spawn" },
        _meta: modernMeta(),
      });
      expect(started.resultType).toBe("complete");
      expect(started.isError).toBe(true);
      expect(started.content[0].text).toContain("ASK_HOOK_NOT_INSTALLED");
      expect(started.structuredContent.error.code).toBe("MCP_CHILD_LAUNCH_FAILED");
      expect(existsSync(fixture.env.KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH)).toBe(false);

      const store = new JobStore(resolvePluginPaths(fixture.env));
      try {
        const taskId = started.structuredContent.error.details.job_id as string;
        expect(store.getMcpTask(taskId)?.launch_state).toBe("exited");
        expect(store.getJob(taskId)).toBeNull();
      } finally {
        store.close();
      }
    } finally {
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 60_000);
});
