import { describe, expect, test } from "bun:test";

import { createMcpFixture, McpClient, modernMeta } from "../helpers/mcp.js";

describe("MCP terminal result semantics", () => {
  test("a failed Kimi job completes the task with isError and its artifact", async () => {
    const fixture = await createMcpFixture("mcp-failed-artifact", { scenario: "rescue-empty" });
    let client: McpClient | undefined;
    try {
      client = await McpClient.modern(fixture);
      const started = await client.request("tools/call", {
        name: "kimi_write",
        arguments: { workspace: fixture.repo, mode: "rescue", prompt: "Return an empty response" },
        _meta: modernMeta(),
      });
      expect(started.resultType).toBe("task");
      let view: any;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        view = await client.request("tasks/get", { taskId: started.taskId, _meta: modernMeta() });
        if (view.status !== "working") break;
        await Bun.sleep(100);
      }
      expect(view.status).toBe("completed");
      expect(view.result.resultType).toBe("complete");
      expect(view.result.isError).toBe(true);
      expect(view.result.structuredContent.status).toBe("failed");
      expect(view.result.content[0].text).toContain("RESCUE_EMPTY_OUTPUT");
    } finally {
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 60_000);

  test("a budget timeout preserves partial output marked as not a final answer", async () => {
    const fixture = await createMcpFixture("mcp-timeout-artifact");
    fixture.env.KIMI_PLUGIN_CC_MOCK_POST_OUTPUT_DELAY_MS = "3000";
    let client: McpClient | undefined;
    try {
      client = await McpClient.modern(fixture);
      const started = await client.request("tools/call", {
        name: "kimi_read",
        arguments: { workspace: fixture.repo, mode: "ask", prompt: "Exceed this budget", budget: "1s" },
        _meta: modernMeta(),
      });
      let view: any;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        view = await client.request("tasks/get", { taskId: started.taskId, _meta: modernMeta() });
        if (view.status !== "working") break;
        await Bun.sleep(100);
      }
      expect(view.status).toBe("completed");
      expect(view.result.isError).toBe(true);
      expect(view.result.structuredContent.status).toBe("failed");
      expect(view.result.structuredContent.partial_output).toBe(true);
      expect(view.result.content[0].text).toContain("Partial output");
      expect(view.result.content[0].text).toContain("NOT a final answer");
    } finally {
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 60_000);

  test("tasks/cancel acknowledges and tasks/get resolves cancelled", async () => {
    const fixture = await createMcpFixture("mcp-task-cancel", { delayMs: "30000" });
    let client: McpClient | undefined;
    try {
      client = await McpClient.modern(fixture);
      const started = await client.request("tools/call", {
        name: "kimi_read",
        arguments: { workspace: fixture.repo, mode: "ask", prompt: "Cancel through the task method" },
        _meta: modernMeta(),
      });
      const acknowledged = await client.request("tasks/cancel", { taskId: started.taskId, _meta: modernMeta() });
      expect(acknowledged).toEqual({ resultType: "complete" });
      let view: any;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        view = await client.request("tasks/get", { taskId: started.taskId, _meta: modernMeta() });
        if (view.status !== "working") break;
        await Bun.sleep(100);
      }
      expect(view.status).toBe("cancelled");
      expect(view.result).toBeUndefined();
    } finally {
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 60_000);
});
