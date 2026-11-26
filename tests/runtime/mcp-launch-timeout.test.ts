import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { JobStore } from "../../runtime/job-store.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import { readProcessIdentity } from "../../runtime/process-tree.js";
import { createMcpFixture, McpClient, modernMeta, type McpFixture } from "../helpers/mcp.js";

const stableNode = execFileSync("which", ["node"], { encoding: "utf8" }).trim();

describe("MCP attachment timeout", () => {
  test("a stalled preflight is terminated instead of hanging tools/call forever", async () => {
    const fixture = await createMcpFixture("mcp-launch-timeout");
    const launcherUrl = pathToFileURL(path.join(process.cwd(), "dist/mcp/launcher.js")).href;
    const operationsUrl = pathToFileURL(path.join(process.cwd(), "dist/mcp/operations.js")).href;
    const runner = `
      import { launchMcpOperation } from ${JSON.stringify(launcherUrl)};
      import { buildMcpOperationInvocation } from ${JSON.stringify(operationsUrl)};
      await launchMcpOperation(
        buildMcpOperationInvocation("kimi_read", {
          workspace: process.env.MCP_TEST_WORKSPACE,
          mode: "review",
          prompt: "stall",
        }),
        process.env,
        { attachTimeoutMs: 100 },
      );
    `;
    try {
      const result = spawnSync(stableNode, ["--no-warnings", "--input-type=module", "-e", runner], {
        cwd: fixture.repo,
        env: {
          ...fixture.env,
          MCP_TEST_WORKSPACE: fixture.repo,
          KIMI_PLUGIN_CC_MOCK_DELAY_MS: "30000",
          KIMI_PLUGIN_CC_NODE_BIN: await installSlowNode(fixture, 5),
        },
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("MCP_LAUNCH_TIMEOUT");
      const db = new DatabaseSync(resolvePluginPaths(fixture.env).stateDbPath);
      const task = db.prepare("SELECT launch_state, launch_error FROM mcp_tasks").get();
      const jobs = db.prepare("SELECT COUNT(*) AS count FROM jobs").get();
      db.close();
      if (!task || !jobs) throw new Error("missing launch evidence");
      expect(task.launch_state).toBe("exited");
      expect(task.launch_error).toContain("did not become cancellation-ready");
      expect(jobs.count).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  test("an identity-less timeout before job creation remains working and recoverable", async () => {
    const fixture = await createMcpFixture("mcp-launch-timeout-no-job");
    const launcherUrl = pathToFileURL(path.join(process.cwd(), "dist/mcp/launcher.js")).href;
    const operationsUrl = pathToFileURL(path.join(process.cwd(), "dist/mcp/operations.js")).href;
    const runner = `
      import { launchMcpOperation } from ${JSON.stringify(launcherUrl)};
      import { buildMcpOperationInvocation } from ${JSON.stringify(operationsUrl)};
      let companionPid;
      try {
        await launchMcpOperation(
          buildMcpOperationInvocation("kimi_read", {
            workspace: process.env.MCP_TEST_WORKSPACE,
            mode: "ask",
            prompt: "Recover after an identity-less timeout",
          }),
          process.env,
          {
            attachTimeoutMs: 100,
            identityReader: async (pid) => {
              companionPid = pid;
              return undefined;
            },
          },
        );
      } catch (error) {
        console.log(JSON.stringify({ errorCode: error.code, companionPid }));
        process.exitCode = 1;
      }
    `;
    let client: McpClient | undefined;
    let store: JobStore | undefined;
    let companionPid: number | undefined;
    try {
      const result = spawnSync(stableNode, ["--no-warnings", "--input-type=module", "-e", runner], {
        cwd: fixture.repo,
        env: {
          ...fixture.env,
          MCP_TEST_WORKSPACE: fixture.repo,
          KIMI_PLUGIN_CC_MOCK_DELAY_MS: "30000",
          KIMI_PLUGIN_CC_NODE_BIN: await installSlowNode(fixture, 5),
        },
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(result.status).not.toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.errorCode).toBe("MCP_LAUNCH_TIMEOUT");
      companionPid = output.companionPid;
      store = new JobStore(resolvePluginPaths(fixture.env));
      const task = store.getMcpTask((await onlyTaskId(fixture))!);
      expect(task?.launch_state).toBe("starting");
      expect(task?.launch_error).toBeNull();
      expect(store.getJob(task!.task_id)).toBeNull();

      client = await McpClient.modern(fixture);
      const starting = await client.request("tasks/get", { taskId: task!.task_id, _meta: modernMeta() });
      expect(starting.status).toBe("working");
      expect(starting.result).toBeUndefined();

      let job;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        job = store.getJob(task!.task_id) ?? undefined;
        if (job) break;
        await Bun.sleep(100);
      }
      if (!job) {
        throw new Error(`The companion did not create its job.\n${await Bun.file(task!.stderr_path).text()}`);
      }
      expect(job.status).toBe("running");
      const attached = await client.request("tasks/get", { taskId: task!.task_id, _meta: modernMeta() });
      expect(attached.status).toBe("working");
      await client.request("tasks/cancel", { taskId: task!.task_id, _meta: modernMeta() });
      expect(store.getJob(task!.task_id)?.status).toBe("cancelled");
    } finally {
      if (client) await client.close();
      companionPid ??= await recordedCompanionPid(fixture);
      await terminateCompanion(companionPid);
      store?.close();
      await fixture.cleanup();
    }
  }, 30_000);

  test("an identity-less timeout returns an existing starting job without marking it exited", async () => {
    const fixture = await createMcpFixture("mcp-launch-timeout-existing-job");
    const launcherUrl = pathToFileURL(path.join(process.cwd(), "dist/mcp/launcher.js")).href;
    const operationsUrl = pathToFileURL(path.join(process.cwd(), "dist/mcp/operations.js")).href;
    const jobStoreUrl = pathToFileURL(path.join(process.cwd(), "dist/job-store.js")).href;
    const pathsUrl = pathToFileURL(path.join(process.cwd(), "dist/paths.js")).href;
    const runner = `
      import { DatabaseSync } from "node:sqlite";
      import { launchMcpOperation } from ${JSON.stringify(launcherUrl)};
      import { buildMcpOperationInvocation } from ${JSON.stringify(operationsUrl)};
      import { JobStore } from ${JSON.stringify(jobStoreUrl)};
      import { resolvePluginPaths } from ${JSON.stringify(pathsUrl)};
      let companionPid;
      let inserted = false;
      const launched = await launchMcpOperation(
        buildMcpOperationInvocation("kimi_read", {
          workspace: process.env.MCP_TEST_WORKSPACE,
          mode: "ask",
          prompt: "Keep an existing job reachable after timeout",
        }),
        process.env,
        {
          attachTimeoutMs: 100,
          identityReader: async (pid) => {
            companionPid = pid;
            if (!inserted) {
              inserted = true;
              const paths = resolvePluginPaths(process.env);
              const db = new DatabaseSync(paths.stateDbPath);
              const task = db.prepare(
                "SELECT task_id, operation_kind, repo_id, workspace_cwd FROM mcp_tasks",
              ).get();
              db.close();
              const store = new JobStore(paths);
              try {
                store.createJob({
                  job_id: task.task_id,
                  repo_id: task.repo_id,
                  command_type: "ask",
                  cwd: task.workspace_cwd,
                  model: null,
                  thinking: null,
                  background: false,
                  pid,
                  kimi_pid: null,
                  status: "running",
                  kimi_session_id: null,
                  operation_kind: task.operation_kind,
                  agent_profile: "<cli-client>",
                  prompt_digest: "mcp-launch-timeout",
                  summary: "MCP launch is starting",
                  phase: "starting",
                  final_output_path: null,
                  stream_log_path: task.workspace_cwd + "/mcp-launch-timeout.jsonl",
                  error: null,
                });
              } finally {
                store.close();
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
            return undefined;
          },
        },
      );
      console.log(JSON.stringify({
        jobId: launched.job.job_id,
        companionPid,
        launchState: launched.task.launch_state,
        launchError: launched.task.launch_error,
        status: launched.job.status,
      }));
    `;
    let client: McpClient | undefined;
    let store: JobStore | undefined;
    let companionPid: number | undefined;
    try {
      const result = spawnSync(stableNode, ["--no-warnings", "--input-type=module", "-e", runner], {
        cwd: fixture.repo,
        env: {
          ...fixture.env,
          MCP_TEST_WORKSPACE: fixture.repo,
          KIMI_PLUGIN_CC_MOCK_DELAY_MS: "30000",
          KIMI_PLUGIN_CC_NODE_BIN: await installSlowNode(fixture, 5),
        },
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.launchState).toBe("starting");
      expect(output.launchError).toBeNull();
      expect(output.status).toBe("running");
      companionPid = output.companionPid;
      store = new JobStore(resolvePluginPaths(fixture.env));
      expect(store.getMcpTask(output.jobId)?.launch_state).toBe("starting");
      expect(store.getMcpTask(output.jobId)?.launch_error).toBeNull();
      expect(store.getJob(output.jobId)?.status).toBe("running");

      client = await McpClient.legacy(fixture);
      const status = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "status", job_id: output.jobId },
      });
      expect(status.structuredContent.status).toBe("running");
      expect(store.getMcpTask(output.jobId)?.launch_state).toBe("attached");
      const cancelled = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "cancel", job_id: output.jobId },
      });
      if (cancelled.isError) throw new Error(JSON.stringify(cancelled));
      expect(cancelled.structuredContent.cancellation.status).toBe("cancelled");
    } finally {
      if (client) await client.close();
      companionPid ??= await recordedCompanionPid(fixture);
      await terminateCompanion(companionPid);
      store?.close();
      await fixture.cleanup();
    }
  }, 30_000);
});

async function installSlowNode(fixture: McpFixture, seconds: number): Promise<string> {
  const launcher = path.join(fixture.data, `slow-node-${seconds}.sh`);
  await writeFile(
    launcher,
    `#!/bin/sh\nsleep ${seconds}\nunset KIMI_PLUGIN_CC_NODE_BIN\nexec ${JSON.stringify(stableNode)} "$@"\n`,
    { mode: 0o755 },
  );
  return launcher;
}

async function onlyTaskId(fixture: McpFixture): Promise<string | undefined> {
  const db = new DatabaseSync(resolvePluginPaths(fixture.env).stateDbPath);
  try {
    const row = db.prepare("SELECT task_id FROM mcp_tasks").get() as { task_id: string } | undefined;
    return row?.task_id;
  } finally {
    db.close();
  }
}

async function recordedCompanionPid(fixture: McpFixture): Promise<number | undefined> {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(resolvePluginPaths(fixture.env).stateDbPath);
    const row = db.prepare("SELECT companion_pid FROM mcp_tasks").get() as { companion_pid: number | null } | undefined;
    return row?.companion_pid ?? undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

async function terminateCompanion(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  const identity = await readProcessIdentity(pid);
  if (!identity) return;
  try {
    process.kill(identity.processGroupId === identity.pid ? -identity.processGroupId : identity.pid, "SIGKILL");
  } catch {}
}
