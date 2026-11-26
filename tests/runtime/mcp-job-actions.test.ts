import { describe, expect, test } from "bun:test";

import { JobStore } from "../../runtime/job-store.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import { createMcpFixture, McpClient } from "../helpers/mcp.js";

describe("MCP kimi_job actions", () => {
  test("list, status, result, wait, cancel, and replay cover the full job lifecycle", async () => {
    const fixture = await createMcpFixture("mcp-job-actions-lifecycle", {
      scenario: "ask-success",
      delayMs: "0",
    });
    let client: McpClient | undefined;
    try {
      client = await McpClient.legacy(fixture);

      // 1. Run a synchronous ask job (wait: true default) to seed a completed job with a stream log.
      const first = await client.request("tools/call", {
        name: "kimi_read",
        arguments: { mode: "ask", prompt: "First job for list and replay", workspace: fixture.repo },
      });
      expect(first.isError).toBe(false);
      expect(first.structuredContent.status).toBe("completed");
      const firstId = first.structuredContent.job_id as string;

      // 2. Omitted job_id defaults to the latest repository job for status and result.
      const latestStatus = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "status" },
      });
      expect(latestStatus.isError).toBe(false);
      expect(latestStatus.structuredContent.job_id).toBe(firstId);
      expect(latestStatus.structuredContent.status).toBe("completed");

      const latestResult = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "result" },
      });
      expect(latestResult.isError).toBe(false);
      expect(latestResult.structuredContent.job_id).toBe(firstId);
      expect(latestResult.content[0].text).toContain("Ask answer from mock Kimi.");

      // 3. Cancel on a terminal job is a non-error no-op.
      const terminalCancel = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "cancel", job_id: firstId },
      });
      expect(terminalCancel.isError).toBe(false);
      expect(terminalCancel.structuredContent.status).toBe("completed");
      expect(terminalCancel.content[0].text).toContain("no-op for terminal jobs");

      // 4. Replay reconstructs prose from the recorded stream log.
      const replayed = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "replay", job_id: firstId },
      });
      expect(replayed.isError).toBe(false);
      expect(replayed.structuredContent).toMatchObject({
        job_id: firstId,
        workspace: fixture.repo,
        action: "replay",
      });
      expect(replayed.content[0].text).toContain("Ask answer from mock Kimi.");

      const replayMissingId = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "replay" },
      });
      expect(replayMissingId.isError).toBe(true);
      expect(replayMissingId.structuredContent.error.code).toBe("MCP_INVALID_ARGUMENTS");

      // 5. Run a second job and verify list, status_filter, and limit.
      const second = await client.request("tools/call", {
        name: "kimi_write",
        arguments: { mode: "rescue", prompt: "Second job for list filter", workspace: fixture.repo },
      });
      // rescue-success scenario isn't active here (ask-success emits assistant prose, which rescue accepts).
      expect(second.isError).toBe(false);
      const secondId = second.structuredContent.job_id as string;

      const listedAll = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "list" },
      });
      expect(listedAll.isError).toBe(false);
      expect(listedAll.structuredContent.count).toBe(2);
      expect(listedAll.structuredContent.jobs.map((j: any) => j.job_id)).toEqual(
        expect.arrayContaining([firstId, secondId]),
      );

      const listedLimited = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "list", status_filter: "completed", limit: 1 },
      });
      expect(listedLimited.isError).toBe(false);
      expect(listedLimited.structuredContent.count).toBe(1);
      expect(listedLimited.structuredContent.jobs[0].status).toBe("completed");

      const listedRunning = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "list", status_filter: "running" },
      });
      expect(listedRunning.isError).toBe(false);
      expect(listedRunning.structuredContent.count).toBe(0);
    } finally {
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 60_000);

  test("wait polls to completion, handles wait_ms timeout, and result refuses while running", async () => {
    const fixture = await createMcpFixture("mcp-job-actions-wait", {
      scenario: "ask-success",
      delayMs: "1500",
    });
    let client: McpClient | undefined;
    let jobId: string | undefined;
    try {
      client = await McpClient.legacy(fixture);

      const started = await client.request("tools/call", {
        name: "kimi_read",
        arguments: { mode: "ask", prompt: "Wait test job", workspace: fixture.repo, wait: false },
      });
      expect(started.isError).toBe(false);
      expect(started.structuredContent.status).toBe("running");
      jobId = started.structuredContent.job_id as string;

      // Result while running fails with JOB_NOT_TERMINAL.
      const earlyResult = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "result", job_id: jobId },
      });
      expect(earlyResult.isError).toBe(true);
      expect(earlyResult.structuredContent.error.code).toBe("JOB_NOT_TERMINAL");

      // Short wait_ms returns a non-error timed_out_waiting handle while job keeps running.
      const shortWait = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "wait", job_id: jobId, wait_ms: 150 },
      });
      expect(shortWait.isError).toBe(false);
      expect(shortWait.structuredContent.job_id).toBe(jobId);
      expect(shortWait.structuredContent.status).toBe("running");
      expect(shortWait.structuredContent.timed_out_waiting).toBe(true);

      // Longer wait finishes and returns the settled artifact directly.
      const completed = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "wait", job_id: jobId, wait_ms: 15_000 },
      });
      expect(completed.isError).toBe(false);
      expect(completed.structuredContent.job_id).toBe(jobId);
      expect(completed.structuredContent.status).toBe("completed");
      expect(completed.content[0].text).toContain("Ask answer from mock Kimi.");
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

  test("recover_swarm previews a recorded swarm recovery state and rejects jobs without recovery records", async () => {
    const fixture = await createMcpFixture("mcp-job-actions-recover", {
      scenario: "ask-success",
      delayMs: "0",
    });
    let client: McpClient | undefined;
    try {
      client = await McpClient.legacy(fixture);

      const ask = await client.request("tools/call", {
        name: "kimi_read",
        arguments: { mode: "ask", prompt: "Non-swarm job", workspace: fixture.repo },
      });
      expect(ask.isError).toBe(false);
      const askJobId = ask.structuredContent.job_id as string;

      // Missing job_id fails argument validation.
      const missingId = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "recover_swarm" },
      });
      expect(missingId.isError).toBe(true);
      expect(missingId.structuredContent.error.code).toBe("MCP_INVALID_ARGUMENTS");

      // A job without a swarm recovery record refuses cleanly.
      const noRecord = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "recover_swarm", job_id: askJobId },
      });
      expect(noRecord.isError).toBe(true);
      expect(noRecord.structuredContent.error.code).toBe("SWARM_RECOVERY_REQUIRED");

      // Seed a swarm recovery record on a completed swarm job and verify preview mode.
      const swarm = await client.request("tools/call", {
        name: "kimi_read",
        arguments: {
          mode: "swarm",
          prompt: "Seed swarm recovery preview",
          max_concurrency: 1,
          workspace: fixture.repo,
        },
      });
      expect(swarm.isError).toBe(false);
      const swarmJobId = swarm.structuredContent.job_id as string;

      const store = new JobStore(resolvePluginPaths(fixture.env));
      try {
        store.saveSwarmRecovery(swarmJobId, {
          schema: 1,
          jobId: swarmJobId,
          ownerPid: process.pid,
          owner: null,
          kimiHome: fixture.kimiHome,
          cwd: fixture.repo,
          workspaceRoot: null,
          launches: [],
          session: { sessionId: "session_preview_1", workspaceId: "ws_preview_1" },
          sessionDirty: true,
          complete: false,
          patchPath: null,
        });
      } finally {
        store.close();
      }

      const preview = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "recover_swarm", job_id: swarmJobId },
      });
      expect(preview.isError).toBe(false);
      expect(preview.structuredContent).toMatchObject({
        job_id: swarmJobId,
        mode: "preview",
        recovery_complete: false,
        session_id: "session_preview_1",
        session_cleanup_pending: true,
        worktree: null,
      });
    } finally {
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 60_000);
});
