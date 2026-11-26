import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { JobStore } from "../../runtime/job-store.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import { readProcessIdentity } from "../../runtime/process-tree.js";
import { createMcpFixture, McpClient, type McpFixture } from "../helpers/mcp.js";

const stableNode = execFileSync("which", ["node"], { encoding: "utf8" }).trim();

describe("MCP attachment identity races", () => {
  test("normal attachment rejects a changed identity and preserves the recovery handle", async () => {
    const fixture = await createMcpFixture("mcp-attach-changed-identity");
    let companionPid: number | undefined;
    try {
      const result = await runSyntheticScenario(fixture, "attach-mismatch");
      expect(result.stderr).toBe("");
      expect(result.status).not.toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.errorCode).toBe("MCP_PROCESS_IDENTITY_MISMATCH");
      companionPid = output.companionPid;
      const jobId = output.errorJobId as string;
      expect(jobId).toBe((await onlyTaskId(fixture))!);
      const store = new JobStore(resolvePluginPaths(fixture.env));
      try {
        const task = store.getMcpTask(jobId);
        expect(task?.launch_state).toBe("starting");
        expect(task?.launch_error).toBeNull();
        expect(task?.companion_identity).toContain("expected-start");
        expect(task?.companion_identity).not.toContain("reused-start");
        expect(store.getJob(jobId)?.status).toBe("running");
      } finally {
        store.close();
      }
      await restoreAndCancel(fixture, jobId, companionPid!);
    } finally {
      companionPid ??= await recordedCompanionPid(fixture);
      await terminateCompanion(companionPid!);
      await fixture.cleanup();
    }
  }, 30_000);

  test("attachment accepts a companion that settled its job before the identity probe", async () => {
    const fixture = await createMcpFixture("mcp-attach-settled");
    let companionPid: number | undefined;
    try {
      const result = await runSyntheticScenario(fixture, "attach-settled");
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      companionPid = output.companionPid;
      expect(output.status).toBe("completed");
      expect(output.launchState).toBe("attached");
      expect(output.launchError).toBeNull();
    } finally {
      companionPid ??= await recordedCompanionPid(fixture);
      await terminateCompanion(companionPid!);
      await fixture.cleanup();
    }
  }, 30_000);

  test("an inconclusive post-signal probe preserves a live starting job", async () => {
    const fixture = await createMcpFixture("mcp-post-signal-probe");
    let companionPid: number | undefined;
    try {
      const result = await runSyntheticScenario(fixture, "post-signal-probe");
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.launchState).toBe("starting");
      expect(output.launchError).toBeNull();
      expect(output.status).toBe("running");
      companionPid = output.companionPid;
      const jobId = output.jobId as string;
      const store = new JobStore(resolvePluginPaths(fixture.env));
      try {
        expect(store.getMcpTask(jobId)?.launch_state).toBe("starting");
        expect(store.getMcpTask(jobId)?.launch_error).toBeNull();
        expect(store.getJob(jobId)?.status).toBe("running");
      } finally {
        store.close();
      }
      expect(await readProcessIdentity(companionPid!)).toBeDefined();
      await restoreAndCancel(fixture, jobId, companionPid!);
    } finally {
      companionPid ??= await recordedCompanionPid(fixture);
      await terminateCompanion(companionPid!);
      await fixture.cleanup();
    }
  }, 30_000);
});

async function runSyntheticScenario(
  fixture: McpFixture,
  scenario: "attach-mismatch" | "attach-settled" | "post-signal-probe",
) {
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
    const scenario = ${JSON.stringify(scenario)};
    let companionPid;
    let expected;
    let jobId;
    let calls = 0;
    try {
      const launched = await launchMcpOperation(
        buildMcpOperationInvocation("kimi_read", {
          workspace: process.env.MCP_TEST_WORKSPACE,
          mode: "ask",
          prompt: "Preserve identity through attachment races",
        }),
        process.env,
        {
          attachTimeoutMs: 100,
          identityReader: async (pid) => {
            companionPid = pid;
            calls += 1;
            if (calls === 1) {
              expected = {
                pid,
                processGroupId: pid,
                startToken: "expected-start",
                state: "S",
              };
              const paths = resolvePluginPaths(process.env);
              const db = new DatabaseSync(paths.stateDbPath);
              const task = db.prepare(
                "SELECT task_id, operation_kind, repo_id, workspace_cwd FROM mcp_tasks",
              ).get();
              db.close();
              jobId = task.task_id;
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
                  prompt_digest: "mcp-attachment-identity",
                  summary: "MCP attachment identity scenario",
                  phase: scenario === "post-signal-probe" ? "starting" : "turn-running",
                  final_output_path: null,
                  stream_log_path: task.workspace_cwd + "/mcp-attachment-identity.jsonl",
                  error: null,
                });
              } finally {
                store.close();
              }
              return expected;
            }
            if (scenario === "attach-mismatch") {
              return { ...expected, startToken: "reused-start" };
            }
            if (scenario === "attach-settled") {
              // The companion finished its job and exited before the probe.
              const store = new JobStore(resolvePluginPaths(process.env));
              try {
                store.markCompleted(jobId, { summary: "settled before the probe", final_output_path: null, error: null });
              } finally {
                store.close();
              }
              return undefined;
            }
            if (calls === 2) return expected;
            throw new Error("injected inconclusive identity probe");
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
    } catch (error) {
      console.log(JSON.stringify({
        errorCode: error.code,
        errorJobId: error.details?.job_id,
        companionPid,
      }));
      process.exitCode = 1;
    }
  `;
  const slowCompanion = path.join(fixture.data, `slow-${scenario}.sh`);
  await writeFile(
    slowCompanion,
    "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 30; done\n",
    { mode: 0o755 },
  );
  return spawnSync(stableNode, ["--no-warnings", "--input-type=module", "-e", runner], {
    cwd: fixture.repo,
    env: {
      ...fixture.env,
      MCP_TEST_WORKSPACE: fixture.repo,
      KIMI_PLUGIN_CC_NODE_BIN: slowCompanion,
    },
    encoding: "utf8",
    timeout: 15_000,
  });
}

async function restoreAndCancel(fixture: McpFixture, jobId: string, pid: number): Promise<void> {
  const identity = await readProcessIdentity(pid);
  expect(identity).toBeDefined();
  const store = new JobStore(resolvePluginPaths(fixture.env));
  try {
    store.updateMcpTask(jobId, { companion_identity: JSON.stringify(identity) });
  } finally {
    store.close();
  }
  const client = await McpClient.legacy(fixture);
  try {
    const status = await client.request("tools/call", {
      name: "kimi_job",
      arguments: { action: "status", job_id: jobId },
    });
    expect(status.structuredContent.status).toBe("running");
    const cancelled = await client.request("tools/call", {
      name: "kimi_job",
      arguments: { action: "cancel", job_id: jobId },
    });
    if (cancelled.isError) throw new Error(JSON.stringify(cancelled));
    expect(cancelled.structuredContent.cancellation.status).toBe("cancelled");
  } finally {
    await client.close();
  }
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
