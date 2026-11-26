import { describe, expect, test } from "bun:test";

import { JobStore } from "../../runtime/job-store.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import { createMcpFixture, McpClient } from "../helpers/mcp.js";

const cases = [
  ["kimi_read", { mode: "ask", prompt: "Explain this repository" }, "ask", "ask"],
  ["kimi_read", { mode: "review", prompt: "Check the current diff" }, "review", "review"],
  ["kimi_read", { mode: "challenge", prompt: "Challenge this design" }, "challenge", "challenge"],
  ["kimi_read", { mode: "swarm", prompt: "Review two independent areas", cap: 2, max_concurrency: 1 }, "swarm", "review"],
  ["kimi_write", { mode: "rescue", prompt: "Apply a bounded fix" }, "rescue", "rescue"],
  ["kimi_write", { mode: "pursue", prompt: "Complete one bounded objective" }, "pursue", "rescue"],
  ["kimi_write", { mode: "swarm_patch", prompt: "Prepare an empty patch in a worktree", cap: 1, max_concurrency: 1 }, "swarm-write", "rescue"],
] as const;

describe("MCP operation dispatch", () => {
  test("all seven operations across kimi_read and kimi_write wait by default, attach fixed IDs, and preserve operation identity", async () => {
    const fixture = await createMcpFixture("mcp-all-operations", { scenario: "rescue-success" });
    let client: McpClient | undefined;
    try {
      client = await McpClient.legacy(fixture);
      for (const [name, args, operationKind, commandType] of cases) {
        const result = await client.request("tools/call", {
          name,
          arguments: { ...args, workspace: fixture.repo },
        });
        expect(result.isError, `${name}:${operationKind}`).toBe(false);
        expect(result.structuredContent.operation_kind, `${name}:${operationKind}`).toBe(operationKind);
        expect(result.structuredContent.command_type, `${name}:${operationKind}`).toBe(commandType);
        expect(result.structuredContent.status, `${name}:${operationKind}`).toBe("completed");
        const jobId = result.structuredContent.job_id as string;
        expect(jobId, `${name}:${operationKind}`).toEqual(expect.any(String));

        const store = new JobStore(resolvePluginPaths(fixture.env));
        try {
          const job = store.getJob(jobId);
          const task = store.getMcpTask(jobId);
          expect(job?.background, `${name}:${operationKind}`).toBe(false);
          expect(task?.operation_kind, `${name}:${operationKind}`).toBe(operationKind);
          expect(task?.launch_state, `${name}:${operationKind}`).toBe("attached");
        } finally {
          store.close();
        }
      }
    } finally {
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 90_000);

  test("wait: false returns a job_id immediately and resolves through kimi_job wait/result", async () => {
    const fixture = await createMcpFixture("mcp-all-operations-async", {
      scenario: "ask-success",
      delayMs: "400",
    });
    let client: McpClient | undefined;
    try {
      client = await McpClient.legacy(fixture);
      const started = await client.request("tools/call", {
        name: "kimi_read",
        arguments: {
          mode: "ask",
          prompt: "Run asynchronously",
          workspace: fixture.repo,
          wait: false,
        },
      });
      expect(started.isError).toBe(false);
      expect(started.structuredContent.status).toBe("running");
      const jobId = started.structuredContent.job_id as string;

      const awaited = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "wait", job_id: jobId, wait_ms: 15_000 },
      });
      expect(awaited.isError).toBe(false);
      expect(awaited.structuredContent.status).toBe("completed");
      expect(awaited.content[0].text).toContain("Ask answer from mock Kimi.");
    } finally {
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 60_000);
});
