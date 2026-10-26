import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { resolveRepoIdentity } from "../../runtime/git.js";
import { JobStore } from "../../runtime/job-store.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import {
  collectDescendantIdentities,
  readProcessIdentity,
  revalidateProcessIdentity,
  type ProcessIdentity,
} from "../../runtime/process-tree.js";
import { createMcpFixture, McpClient, modernMeta } from "../helpers/mcp.js";
import { DatabaseSync } from "node:sqlite";

function backdate(env: NodeJS.ProcessEnv, taskId: string): void {
  const db = new DatabaseSync(resolvePluginPaths(env).stateDbPath);
  db.prepare("UPDATE mcp_tasks SET updated_at = ? WHERE task_id = ?").run("2000-01-01T00:00:00.000Z", taskId);
  db.prepare("UPDATE jobs SET updated_at = ? WHERE job_id = ?").run("2000-01-01T00:00:00.000Z", taskId);
  db.close();
}

describe("MCP unattached companion recovery", () => {
  test("a companion that dies before creating its job does not remain working forever", async () => {
    const fixture = await createMcpFixture("mcp-unattached-crash");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      detached: true,
      stdio: "ignore",
    });
    const taskId = randomUUID();
    let client: McpClient | undefined;
    try {
      const paths = resolvePluginPaths(fixture.env);
      const repo = await resolveRepoIdentity(fixture.repo);
      const store = new JobStore(paths);
      try {
        const task = store.createMcpTask({
          task_id: taskId,
          operation_kind: "ask",
          repo_id: repo.repoId,
          workspace_cwd: fixture.repo,
          stdout_path: path.join(paths.logsDir, `mcp-${taskId}.stdout.log`),
          stderr_path: path.join(paths.logsDir, `mcp-${taskId}.stderr.log`),
        });
        const identity = await readProcessIdentity(child.pid!);
        expect(identity).toBeDefined();
        store.updateMcpTask(task.task_id, {
          companion_pid: child.pid,
          companion_identity: JSON.stringify(identity),
        });
      } finally {
        store.close();
      }
      process.kill(child.pid!, "SIGKILL");
      backdate(fixture.env, taskId);
      client = await McpClient.modern(fixture);
      const view = await client.request("tasks/get", { taskId, _meta: modernMeta() });
      expect(view.status).toBe("completed");
      expect(view.result.isError).toBe(true);
      expect(view.result.structuredContent.launch_state).toBe("exited");
      expect(view.result.content[0].text).toContain("disappeared before creating job");
    } finally {
      if (child.exitCode === null) {
        try { process.kill(child.pid!, "SIGKILL"); } catch {}
      }
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 60_000);

  test("a stale unattached task never adopts a process by PID alone", async () => {
    const fixture = await createMcpFixture("mcp-unattached-identity");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      detached: true,
      stdio: "ignore",
    });
    const taskId = randomUUID();
    let client: McpClient | undefined;
    try {
      const paths = resolvePluginPaths(fixture.env);
      const repo = await resolveRepoIdentity(fixture.repo);
      const store = new JobStore(paths);
      try {
        const task = store.createMcpTask({
          task_id: taskId,
          operation_kind: "ask",
          repo_id: repo.repoId,
          workspace_cwd: fixture.repo,
          stdout_path: path.join(paths.logsDir, `mcp-${taskId}.stdout.log`),
          stderr_path: path.join(paths.logsDir, `mcp-${taskId}.stderr.log`),
        });
        store.updateMcpTask(task.task_id, { companion_pid: child.pid });
      } finally {
        store.close();
      }
      backdate(fixture.env, taskId);
      client = await McpClient.modern(fixture);
      const view = await client.request("tasks/get", { taskId, _meta: modernMeta() });
      expect(view.status).toBe("working");
      expect(view.statusMessage).toContain("MCP_PROCESS_IDENTITY_UNAVAILABLE");
      expect(view.result).toBeUndefined();
      const retry = await client.request("tasks/get", { taskId, _meta: modernMeta() });
      expect(retry.status).toBe("working");
    } finally {
      if (child.exitCode === null) {
        try { process.kill(child.pid!, "SIGKILL"); } catch {}
      }
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 60_000);

  test("starting recovery rejects a forged identity without adopting or signalling the companion", async () => {
    const fixture = await createMcpFixture("mcp-starting-identity", { delayMs: "30000" });
    let client: McpClient | undefined;
    let jobId = "";
    let originalIdentity: string | null = null;
    let terminal = false;
    try {
      client = await McpClient.legacy(fixture);
      const started = await client.request("tools/call", {
        name: "kimi_ask",
        arguments: { workspace: fixture.repo, prompt: "Verify starting recovery", fresh: true },
      });
      jobId = started.structuredContent.job_id;
      const forgedStore = new JobStore(resolvePluginPaths(fixture.env));
      let forged: string;
      try {
        const task = forgedStore.getMcpTask(jobId)!;
        originalIdentity = task.companion_identity;
        expect(originalIdentity).not.toBeNull();
        forged = JSON.stringify({ ...JSON.parse(originalIdentity!), startToken: "forged-start-token" });
        forgedStore.updateMcpTask(jobId, {
          launch_state: "starting",
          attached_at: null,
          companion_identity: forged,
        });
      } finally {
        forgedStore.close();
      }

      const refused = await client.request("tools/call", {
        name: "kimi_job_status",
        arguments: { job_id: jobId },
      });
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent.error.code).toBe("MCP_PROCESS_IDENTITY_MISMATCH");
      const inspected = new JobStore(resolvePluginPaths(fixture.env));
      try {
        expect(inspected.getJob(jobId)?.status).toBe("running");
        expect(inspected.getMcpTask(jobId)?.launch_state).toBe("starting");
        expect(inspected.getMcpTask(jobId)?.companion_identity).toBe(forged!);
      } finally {
        inspected.close();
      }

      const restored = new JobStore(resolvePluginPaths(fixture.env));
      try {
        restored.updateMcpTask(jobId, { companion_identity: originalIdentity });
      } finally {
        restored.close();
      }
      const recovered = await client.request("tools/call", {
        name: "kimi_job_status",
        arguments: { job_id: jobId },
      });
      expect(recovered.structuredContent.status).toBe("running");
      const attached = new JobStore(resolvePluginPaths(fixture.env));
      try {
        expect(attached.getMcpTask(jobId)?.launch_state).toBe("attached");
        const { state: _transientState, ...stableIdentity } = JSON.parse(originalIdentity!);
        const attachedIdentity = JSON.parse(attached.getMcpTask(jobId)!.companion_identity!);
        expect(attachedIdentity).toMatchObject(stableIdentity);
        expect(attachedIdentity.state).not.toMatch(/^[ZX]/i);
      } finally {
        attached.close();
      }
      const cancelled = await client.request("tools/call", {
        name: "kimi_job_cancel",
        arguments: { job_id: jobId },
      });
      expect(cancelled.structuredContent.cancellation.status).toBe("cancelled");
      terminal = true;
    } finally {
      if (jobId && originalIdentity) {
        const restore = new JobStore(resolvePluginPaths(fixture.env));
        try {
          restore.updateMcpTask(jobId, { companion_identity: originalIdentity });
        } finally {
          restore.close();
        }
      }
      if (client && jobId && !terminal) {
        try {
          await client.request("tools/call", {
            name: "kimi_job_cancel",
            arguments: { job_id: jobId },
          });
        } catch {}
      }
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 60_000);

  test("a stale starting job reconciles a dead companion instead of repeating identity mismatch", async () => {
    const fixture = await createMcpFixture("mcp-starting-dead-companion", { delayMs: "30000" });
    let client: McpClient | undefined;
    let companionPid: number | null = null;
    let cleanupIdentities: ProcessIdentity[] = [];
    try {
      client = await McpClient.legacy(fixture);
      const started = await client.request("tools/call", {
        name: "kimi_ask",
        arguments: { workspace: fixture.repo, prompt: "Reconcile a stale starting job", fresh: true },
      });
      const jobId = started.structuredContent.job_id as string;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await client.request("tools/call", { name: "kimi_job_status", arguments: { job_id: jobId } });
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
      const running = new JobStore(resolvePluginPaths(fixture.env));
      try {
        companionPid = running.getJob(jobId)!.pid;
        running.updateMcpTask(jobId, { launch_state: "starting", attached_at: null });
      } finally {
        running.close();
      }
      expect(companionPid).not.toBeNull();
      cleanupIdentities = await collectDescendantIdentities(companionPid!);
      process.kill(companionPid!, "SIGKILL");
      companionPid = null;
      backdate(fixture.env, jobId);

      const status = await client.request("tools/call", {
        name: "kimi_job_status",
        arguments: { job_id: jobId },
      });
      expect(status.structuredContent.status).toBe("failed");
      expect(status.structuredContent.error.code).toBe("MCP_COMPANION_DISAPPEARED");
      const result = await client.request("tools/call", {
        name: "kimi_job_result",
        arguments: { job_id: jobId },
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
