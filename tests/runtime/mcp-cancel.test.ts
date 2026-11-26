import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { runCancel } from "../../runtime/commands/cancel.js";
import { JobStore } from "../../runtime/job-store.js";
import { sweepStaleJobs } from "../../runtime/jobs.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import {
  collectDescendantIdentities,
  readProcessIdentity,
  revalidateProcessIdentity,
  type ProcessIdentity,
} from "../../runtime/process-tree.js";
import { createMcpFixture, McpClient } from "../helpers/mcp.js";

describe("MCP cancellation and process lifetime", () => {
  test("server EOF leaves an active job alive for reconnect and cancellation", async () => {
    const fixture = await createMcpFixture("mcp-active-reconnect", { delayMs: "30000" });
    let client: McpClient | undefined;
    let jobId = "";
    try {
      client = await McpClient.legacy(fixture);
      const started = await client.request("tools/call", {
        name: "kimi_read",
        arguments: { workspace: fixture.repo, mode: "ask", prompt: "Continue after reconnect", wait: false },
      });
      jobId = started.structuredContent.job_id;
      await client.close();
      client = undefined;

      client = await McpClient.legacy(fixture);
      const status = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "status", job_id: jobId },
      });
      expect(status.structuredContent.status).toBe("running");
      const cancelled = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "cancel", job_id: jobId },
      });
      expect(cancelled.structuredContent.cancellation.status).toBe("cancelled");
    } finally {
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 60_000);

  test("a forged companion identity sends no signal and cancellation can be retried with the real identity", async () => {
    const fixture = await createMcpFixture("mcp-identity-mismatch", { delayMs: "30000" });
    let client: McpClient | undefined;
    let jobId = "";
    try {
      client = await McpClient.legacy(fixture);
      const started = await client.request("tools/call", {
        name: "kimi_read",
        arguments: { workspace: fixture.repo, mode: "ask", prompt: "Verify process identity", wait: false },
      });
      jobId = started.structuredContent.job_id;
      const store = new JobStore(resolvePluginPaths(fixture.env));
      let originalIdentity: string | null;
      try {
        const task = store.getMcpTask(jobId)!;
        originalIdentity = task.companion_identity;
        const forged = { ...JSON.parse(originalIdentity!), startToken: "forged-start-token" };
        store.updateMcpTask(jobId, { companion_identity: JSON.stringify(forged) });
      } finally {
        store.close();
      }

      const refused = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "cancel", job_id: jobId },
      });
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent.error.code).toBe("MCP_PROCESS_IDENTITY_MISMATCH");
      const running = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "status", job_id: jobId },
      });
      expect(running.structuredContent.status).toBe("running");

      const restore = new JobStore(resolvePluginPaths(fixture.env));
      try {
        restore.updateMcpTask(jobId, { companion_identity: originalIdentity });
      } finally {
        restore.close();
      }
      const cancelled = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "cancel", job_id: jobId },
      });
      expect(cancelled.structuredContent.cancellation.status).toBe("cancelled");
    } finally {
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 60_000);

  test("forged or missing Kimi identity prevents signalling until the real identity is restored", async () => {
    const fixture = await createMcpFixture("mcp-kimi-identity-mismatch", { delayMs: "30000" });
    let client: McpClient | undefined;
    let store: JobStore | undefined;
    let jobId = "";
    let originalIdentity: string | null = null;
    let originalPid: number | null = null;
    let terminal = false;
    try {
      client = await McpClient.legacy(fixture);
      const started = await client.request("tools/call", {
        name: "kimi_read",
        arguments: { workspace: fixture.repo, mode: "ask", prompt: "Verify Kimi process identity", wait: false },
      });
      jobId = started.structuredContent.job_id;
      store = new JobStore(resolvePluginPaths(fixture.env));
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await client.request("tools/call", {
          name: "kimi_job",
          arguments: { action: "status", job_id: jobId },
        });
        const task = store.getMcpTask(jobId)!;
        originalIdentity = task.kimi_identity;
        originalPid = store.getJob(jobId)!.kimi_pid;
        if (originalIdentity !== null && originalPid !== null) break;
        if (attempt === 39) throw new Error("Kimi descendant identity was not captured");
        await Bun.sleep(100);
      }
      const forged = JSON.stringify({ ...JSON.parse(originalIdentity!), startToken: "forged-kimi-start" });
      store.updateMcpTask(jobId, { kimi_identity: forged });
      const mismatched = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "cancel", job_id: jobId },
      });
      expect(mismatched.isError).toBe(true);
      expect(mismatched.structuredContent.error.code).toBe("MCP_PROCESS_IDENTITY_MISMATCH");
      expect(store.getJob(jobId)?.status).toBe("running");

      store.updateMcpTask(jobId, { kimi_identity: null });
      store.updateRunningJob(jobId, { kimi_pid: 999_999_999 });
      const missing = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "cancel", job_id: jobId },
      });
      expect(missing.isError).toBe(true);
      expect(missing.structuredContent.error.code).toBe("CANCEL_NOT_SUPPORTED");
      expect(store.getJob(jobId)?.status).toBe("running");

      store.updateRunningJob(jobId, { kimi_pid: originalPid });
      store.updateMcpTask(jobId, { kimi_identity: originalIdentity });
      const cancelled = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "cancel", job_id: jobId },
      });
      expect(cancelled.structuredContent.cancellation.status).toBe("cancelled");
      terminal = true;
    } finally {
      if (store && jobId && originalIdentity) {
        store.updateRunningJob(jobId, { kimi_pid: originalPid });
        store.updateMcpTask(jobId, { kimi_identity: originalIdentity });
      }
      if (client && jobId && !terminal) {
        try {
          await client.request("tools/call", {
            name: "kimi_job",
            arguments: { action: "cancel", job_id: jobId },
          });
        } catch {}
      }
      store?.close();
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 60_000);

  test("MCP-owned rows refuse direct cancellation and skip generic stale sweeps", async () => {
    const fixture = await createMcpFixture("mcp-origin-aware-cancellation", { delayMs: "30000" });
    let client: McpClient | undefined;
    let store: JobStore | undefined;
    let unrelated: ReturnType<typeof spawn> | undefined;
    let jobId = "";
    let originalCompanionPid: number | null = null;
    let originalKimiPid: number | null = null;
    let cleanupIdentities: ProcessIdentity[] = [];
    let terminal = false;
    try {
      client = await McpClient.legacy(fixture);
      const started = await client.request("tools/call", {
        name: "kimi_read",
        arguments: {
          workspace: fixture.repo,
          mode: "ask",
          prompt: "Verify MCP ownership at generic cancellation boundaries",
          wait: false,
        },
      });
      jobId = started.structuredContent.job_id;
      store = new JobStore(resolvePluginPaths(fixture.env));
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await client.request("tools/call", {
          name: "kimi_job",
          arguments: { action: "status", job_id: jobId },
        });
        if (store.getMcpTask(jobId)!.kimi_identity !== null) break;
        if (attempt === 39) throw new Error("Kimi descendant identity was not captured");
        await Bun.sleep(100);
      }
      const job = store.getJob(jobId)!;
      originalCompanionPid = job.pid;
      originalKimiPid = job.kimi_pid;
      expect(originalCompanionPid).not.toBeNull();
      expect(originalKimiPid).not.toBeNull();
      cleanupIdentities = await collectDescendantIdentities(originalCompanionPid!);

      await expect(runCancel([jobId], {
        cwd: fixture.repo,
        env: fixture.env,
        stdout: process.stdout,
        stderr: process.stderr,
      })).rejects.toMatchObject({ code: "MCP_CANCEL_REQUIRES_BINDING" });
      expect(store.getJob(jobId)?.status).toBe("running");

      unrelated = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        detached: true,
        stdio: "ignore",
      });
      const unrelatedIdentity = await readProcessIdentity(unrelated.pid!);
      expect(unrelatedIdentity).toBeDefined();
      store.updateRunningJob(jobId, { pid: null, kimi_pid: unrelated.pid });
      const db = new DatabaseSync(resolvePluginPaths(fixture.env).stateDbPath);
      db.prepare("UPDATE jobs SET updated_at = ? WHERE job_id = ?").run("2000-01-01T00:00:00.000Z", jobId);
      db.close();
      await sweepStaleJobs(store, resolvePluginPaths(fixture.env));
      expect(store.getJob(jobId)?.status).toBe("running");
      expect(await revalidateProcessIdentity(unrelatedIdentity!)).toBeDefined();

      store.updateRunningJob(jobId, { pid: originalCompanionPid, kimi_pid: originalKimiPid });
      const cancelled = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "cancel", job_id: jobId },
      });
      expect(cancelled.structuredContent.cancellation.status).toBe("cancelled");
      terminal = true;
    } finally {
      if (store && jobId && originalCompanionPid !== null) {
        store.updateRunningJob(jobId, { pid: originalCompanionPid, kimi_pid: originalKimiPid });
      }
      if (client && jobId && !terminal) {
        try {
          await client.request("tools/call", {
            name: "kimi_job",
            arguments: { action: "cancel", job_id: jobId },
          });
        } catch {}
      }
      if (unrelated?.exitCode === null) {
        try { process.kill(unrelated.pid!, "SIGKILL"); } catch {}
      }
      for (const identity of cleanupIdentities) {
        if (await revalidateProcessIdentity(identity)) {
          try { process.kill(identity.pid, "SIGKILL"); } catch {}
        }
      }
      store?.close();
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 60_000);

  test("a dead companion reconciles to a failed job after the stale grace", async () => {
    const fixture = await createMcpFixture("mcp-companion-crash", { delayMs: "30000" });
    let client: McpClient | undefined;
    let companionPid: number | null = null;
    let cleanupIdentities: ProcessIdentity[] = [];
    try {
      client = await McpClient.legacy(fixture);
      const started = await client.request("tools/call", {
        name: "kimi_read",
        arguments: { workspace: fixture.repo, mode: "ask", prompt: "Force a companion crash", wait: false },
      });
      const jobId = started.structuredContent.job_id as string;
      const running = new JobStore(resolvePluginPaths(fixture.env));
      try {
        companionPid = running.getJob(jobId)!.pid;
      } finally {
        running.close();
      }
      expect(companionPid).not.toBeNull();
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await client.request("tools/call", {
          name: "kimi_job",
          arguments: { action: "status", job_id: jobId },
        });
        const attached = new JobStore(resolvePluginPaths(fixture.env));
        let captured: string | null;
        try {
          captured = attached.getMcpTask(jobId)!.kimi_identity;
        } finally {
          attached.close();
        }
        if (captured !== null) break;
        if (attempt === 39) throw new Error("Kimi descendant identity was not captured");
        await Bun.sleep(100);
      }
      cleanupIdentities = await collectDescendantIdentities(companionPid!);
      process.kill(companionPid!, "SIGKILL");
      companionPid = null;
      await Bun.sleep(15_200);

      const status = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "status", job_id: jobId },
      });
      expect(status.structuredContent.status).toBe("failed");
      expect(status.structuredContent.error.code).toBe("MCP_COMPANION_DISAPPEARED");
      const result = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "result", job_id: jobId },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error.code).toBe("MCP_COMPANION_DISAPPEARED");
    } finally {
      if (companionPid !== null) {
        try { process.kill(companionPid, "SIGKILL"); } catch {}
      }
      for (const identity of cleanupIdentities) {
        if (await revalidateProcessIdentity(identity)) {
          try { process.kill(identity.pid, "SIGKILL"); } catch {}
        }
      }
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 60_000);
});
