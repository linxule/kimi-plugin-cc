import { describe, expect, test } from "bun:test";

import { createMcpFixture, McpClient, modernMeta } from "../helpers/mcp.js";

describe("MCP supervised job lifecycle", () => {
  test("Claude task start, polling, result, and restart recovery", async () => {
    const fixture = await createMcpFixture("mcp-modern", { delayMs: "1000" });
    let client: McpClient | undefined;
    try {
      client = await McpClient.modern(fixture);
      const started = await client.request("tools/call", {
        name: "kimi_read",
        arguments: { workspace: fixture.repo, mode: "ask", prompt: "Explain the job store" },
        _meta: modernMeta(),
      });
      expect(started.resultType).toBe("task");
      expect(started.status).toBe("working");
      expect(started.ttlMs).toBeNull();

      const taskId = started.taskId as string;
      let view: any;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        view = await client.request("tasks/get", { taskId, _meta: modernMeta() });
        if (view.status !== "working") break;
        await Bun.sleep(100);
      }
      expect(view.resultType).toBe("complete");
      expect(view.status).toBe("completed");
      expect(view.result.isError).toBe(false);
      expect(view.result.content[0].text).toContain("Ask answer from mock Kimi.");
      await client.close();
      client = undefined;

      client = await McpClient.modern(fixture);
      const recovered = await client.request("tasks/get", { taskId, _meta: modernMeta() });
      expect(recovered.status).toBe("completed");
      expect(recovered.result.content[0].text).toContain("Ask answer from mock Kimi.");
    } finally {
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 60_000);

  test("wait: false starts immediately with job_id and supports workspace-free kimi_job control", async () => {
    const fixture = await createMcpFixture("mcp-legacy-cancel", { delayMs: "30000" });
    let client: McpClient | undefined;
    try {
      client = await McpClient.legacy(fixture);
      const started = await client.request("tools/call", {
        name: "kimi_read",
        arguments: { workspace: fixture.repo, mode: "ask", prompt: "Wait for cancellation", wait: false },
      });
      expect(started.resultType).toBeUndefined();
      expect(started.isError).toBe(false);
      expect(started.structuredContent.status).toBe("running");
      const jobId = started.structuredContent.job_id as string;

      const status = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "status", job_id: jobId },
      });
      expect(status.structuredContent.status).toBe("running");
      expect(status.structuredContent.operation_kind).toBe("ask");

      const cancelled = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "cancel", job_id: jobId },
      });
      expect(cancelled.isError).toBe(false);
      expect(cancelled.structuredContent.cancellation.status).toBe("cancelled");

      const result = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "result", job_id: jobId },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.status).toBe("cancelled");
    } finally {
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 60_000);

  test("wait: true default waits synchronously and returns the settled artifact directly", async () => {
    const fixture = await createMcpFixture("mcp-legacy-sync", { delayMs: "200" });
    let client: McpClient | undefined;
    try {
      client = await McpClient.legacy(fixture);
      const result = await client.request("tools/call", {
        name: "kimi_read",
        arguments: { workspace: fixture.repo, mode: "ask", prompt: "Answer briefly" },
      });
      expect(result.resultType).toBeUndefined();
      expect(result.isError).toBe(false);
      expect(result.structuredContent.status).toBe("completed");
      expect(result.structuredContent.operation_kind).toBe("ask");
      expect(result.content[0].text).toContain("Ask answer from mock Kimi.");
    } finally {
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 60_000);

  test("wait_timeout_ms returns a running handle when exceeded while keeping the job alive", async () => {
    const fixture = await createMcpFixture("mcp-legacy-wait-timeout", { delayMs: "30000" });
    let client: McpClient | undefined;
    let jobId: string | undefined;
    try {
      client = await McpClient.legacy(fixture);
      const timedOut = await client.request("tools/call", {
        name: "kimi_read",
        arguments: {
          workspace: fixture.repo,
          mode: "ask",
          prompt: "Exceed wait_timeout_ms",
          wait_timeout_ms: 1_000,
        },
      });
      expect(timedOut.isError).toBe(false);
      expect(timedOut.structuredContent.status).toBe("running");
      expect(timedOut.structuredContent.timed_out_waiting).toBe(true);
      jobId = timedOut.structuredContent.job_id as string;
      expect(jobId).toEqual(expect.any(String));

      const cancelled = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "cancel", job_id: jobId },
      });
      expect(cancelled.isError).toBe(false);
      expect(cancelled.structuredContent.cancellation.status).toBe("cancelled");
      jobId = undefined;
    } finally {
      if (client && jobId) {
        await client.request("tools/call", {
          name: "kimi_job",
          arguments: { action: "cancel", job_id: jobId },
        }).catch(() => undefined);
      }
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 60_000);
});
