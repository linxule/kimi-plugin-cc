import { describe, expect, test } from "bun:test";

import { JobStore } from "../../runtime/job-store.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import { createMcpFixture, McpClient } from "../helpers/mcp.js";

const cases = [
  ["kimi_ask", { prompt: "Explain this repository", fresh: true }, "ask", "ask"],
  ["kimi_review", { focus: "Check the current diff" }, "review", "review"],
  ["kimi_review", { mode: "challenge", focus: "Challenge this design" }, "challenge", "challenge"],
  ["kimi_rescue", { prompt: "Apply a bounded fix", fresh: true }, "rescue", "rescue"],
  ["kimi_pursue", { objective: "Complete one bounded objective", turns: 1 }, "pursue", "rescue"],
  ["kimi_swarm", { objective: "Review two independent areas", cap: 2, max_concurrency: 1 }, "swarm", "review"],
  ["kimi_swarm_write", { objective: "Prepare an empty patch in a worktree", cap: 1, max_concurrency: 1 }, "swarm-write", "rescue"],
] as const;

describe("MCP operation dispatch", () => {
  test("all six public model tools, including review challenge mode, attach fixed IDs and preserve operation identity", async () => {
    const fixture = await createMcpFixture("mcp-all-operations", { scenario: "rescue-success" });
    let client: McpClient | undefined;
    try {
      client = await McpClient.legacy(fixture);
      for (const [name, args, operationKind, commandType] of cases) {
        const started = await client.request("tools/call", {
          name,
          arguments: { ...args, workspace: fixture.repo },
        });
        expect(started.isError, name).toBe(false);
        const jobId = started.structuredContent.job_id as string;
        let result: any;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          result = await client.request("tools/call", {
            name: "kimi_job_result",
            arguments: { job_id: jobId },
          });
          if (result.structuredContent?.status && result.structuredContent.status !== "running") break;
          await Bun.sleep(100);
        }
        expect(result.isError, name).toBe(false);
        expect(result.structuredContent.operation_kind, name).toBe(operationKind);
        expect(result.structuredContent.command_type, name).toBe(commandType);
        expect(result.structuredContent.status, name).toBe("completed");

        const store = new JobStore(resolvePluginPaths(fixture.env));
        try {
          const job = store.getJob(jobId);
          const task = store.getMcpTask(jobId);
          expect(job?.background, name).toBe(false);
          expect(task?.operation_kind, name).toBe(operationKind);
          expect(task?.launch_state, name).toBe("attached");
        } finally {
          store.close();
        }
      }
    } finally {
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 90_000);
});
