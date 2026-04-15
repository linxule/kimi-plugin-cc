import { describe, expect, test } from "bun:test";
import { mkdir, readFile, symlink } from "node:fs/promises";
import path from "node:path";

import { runCancel } from "../../runtime/commands/cancel.js";
import { runRescue } from "../../runtime/commands/rescue.js";
import { runResult } from "../../runtime/commands/result.js";
import { runStatus } from "../../runtime/commands/status.js";
import { JobStore } from "../../runtime/job-store.js";
import { waitForTerminalJob } from "../../runtime/jobs.js";
import { ensurePluginPaths, resolvePluginPaths } from "../../runtime/paths.js";
import { createRescueApprovalPolicy } from "../../runtime/rescue-approval.js";
import type { ApprovalRequestPayload } from "../../runtime/wire/types.js";
import type { CommandContext } from "../../runtime/types.js";
import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";

const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli.ts");
const mockWireServerPath = path.join(process.cwd(), "tests/helpers/mock-wire-server.ts");

function makeContext(cwd: string, env: NodeJS.ProcessEnv): CommandContext {
  return {
    cwd,
    env,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

function makeMockEnv(
  pluginDataRoot: string,
  scenario: string,
  invocationPath: string,
  options?: {
    approvalMode?: "none" | "file" | "shell";
    approvalTarget?: string;
    delayMs?: number;
  },
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginDataRoot,
    KIMI_PLUGIN_CC_KIMI_BIN: "bun",
    KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
    KIMI_PLUGIN_CC_MOCK_SCENARIO: scenario,
    KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH: invocationPath,
    KIMI_PLUGIN_CC_MOCK_APPROVAL_MODE: options?.approvalMode ?? "none",
    KIMI_PLUGIN_CC_MOCK_APPROVAL_TARGET: options?.approvalTarget ?? "",
    KIMI_PLUGIN_CC_MOCK_DELAY_MS: String(options?.delayMs ?? 0),
    KIMI_PLUGIN_CC_NODE_BIN: "node",
  };
}

function makeMockWireEnv(pluginDataRoot: string, scenario: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginDataRoot,
    KIMI_PLUGIN_CC_KIMI_BIN: "bun",
    KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockWireServerPath, scenario]),
    KIMI_PLUGIN_CC_NODE_BIN: "node",
  };
}

function parseStartedJobId(output: string): string {
  return (JSON.parse(output) as { job_id: string }).job_id;
}

async function waitForJobState(
  env: NodeJS.ProcessEnv,
  jobId: string,
  predicate: (job: ReturnType<JobStore["getJob"]>) => boolean,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const store = new JobStore(resolvePluginPaths(env));
    try {
      const job = store.getJob(jobId);
      if (predicate(job)) {
        return job;
      }
    } finally {
      store.close();
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }

  throw new Error(`Timed out while waiting for job ${jobId} to reach the expected state.`);
}

function fileApproval(pathname: string): ApprovalRequestPayload {
  return {
    id: "approval-1",
    sender: "WriteFile",
    action: "edit file",
    description: `Write file \`${pathname}\``,
    display: [
      {
        type: "diff",
        path: pathname,
        old_text: "",
        new_text: "updated",
        old_start: 1,
        new_start: 1,
        is_summary: false,
      },
    ],
  };
}

describe("rescue command lifecycle", () => {
  test("rescue approval rejects overwriting a symlink inside the workspace", async () => {
    const repoRoot = await createGitRepoFixture("rescue-symlink-policy-repo");
    const outsideRoot = await createTestPluginDataRoot("rescue-symlink-policy-outside");
    const linkPath = path.join(repoRoot, "linked-file");
    const policy = await createRescueApprovalPolicy(repoRoot);

    await mkdir(outsideRoot, { recursive: true });
    await symlink(path.join(outsideRoot, "outside.txt"), linkPath);

    try {
      await expect(policy(fileApproval(linkPath), { commandType: "rescue" })).resolves.toMatchObject({
        response: "reject",
        feedback: "Rescue does not overwrite symlinks.",
      });
    } finally {
      await cleanupTestPath(repoRoot);
      await cleanupTestPath(outsideRoot);
    }
  });

  test("foreground rescue auto-approves workspace-local file edits and persists the session id", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("rescue-foreground");
    const repoRoot = await createGitRepoFixture("rescue-foreground-repo");
    const invocationPath = path.join(pluginDataRoot, "rescue-foreground.jsonl");
    const targetPath = path.join(repoRoot, "note.txt");
    const env = makeMockEnv(pluginDataRoot, "rescue-success", invocationPath, {
      approvalMode: "file",
      approvalTarget: targetPath,
    });

    try {
      const output = await runRescue(["Implement", "the", "requested", "fix"], makeContext(repoRoot, env));
      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
      const sessionIndex = invocation.argv.indexOf("--session");
      const status = JSON.parse(await runStatus(["--type", "rescue"], makeContext(repoRoot, env))) as {
        job_id: string;
        status: string;
        kimi_session_id: string;
      };
      const store = new JobStore(resolvePluginPaths(env));
      const latest = store.getJob(status.job_id);
      store.close();

      expect(output).toContain("# Rescue Result");
      expect(status.status).toBe("completed");
      expect(status.kimi_session_id).toBe(invocation.argv[sessionIndex + 1]);
      expect(latest?.kimi_session_id).toBe(invocation.argv[sessionIndex + 1]);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("rescue resume resolution reuses or refreshes sessions in the documented order", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("rescue-resume");
    const repoRoot = await createGitRepoFixture("rescue-resume-repo");
    const invocationPath = path.join(pluginDataRoot, "rescue-resume.jsonl");
    const env = makeMockEnv(pluginDataRoot, "rescue-success", invocationPath);

    try {
      await runRescue(["Initial", "task"], makeContext(repoRoot, env));
      const firstInvocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
      const firstSession = firstInvocation.argv[firstInvocation.argv.indexOf("--session") + 1];
      const firstStatus = JSON.parse(await runStatus(["--type", "rescue"], makeContext(repoRoot, env))) as {
        job_id: string;
        kimi_session_id: string;
      };

      await runRescue(["--resume", firstStatus.job_id, "Continue"], makeContext(repoRoot, env));
      let invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
      expect(invocation.argv[invocation.argv.indexOf("--session") + 1]).toBe(firstSession);

      await runRescue(["--resume", firstSession, "Continue"], makeContext(repoRoot, env));
      invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
      expect(invocation.argv[invocation.argv.indexOf("--session") + 1]).toBe(firstSession);

      await runRescue(["continue", "with", "the", "next", "step"], makeContext(repoRoot, env));
      invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
      expect(invocation.argv[invocation.argv.indexOf("--session") + 1]).toBe(firstSession);

      await runRescue(["Start", "a", "new", "task"], makeContext(repoRoot, env));
      invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
      expect(invocation.argv[invocation.argv.indexOf("--session") + 1]).not.toBe(firstSession);

      await runRescue(["--fresh", "Start", "over"], makeContext(repoRoot, env));
      invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
      expect(invocation.argv[invocation.argv.indexOf("--session") + 1]).not.toBe(firstSession);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("rescue rejects non-allowlisted shell commands", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("rescue-shell-deny");
    const repoRoot = await createGitRepoFixture("rescue-shell-deny-repo");
    const invocationPath = path.join(pluginDataRoot, "rescue-shell-deny.jsonl");
    const env = makeMockEnv(pluginDataRoot, "rescue-success", invocationPath, {
      approvalMode: "shell",
      approvalTarget: "curl https://example.com",
    });

    try {
      const output = await runRescue(["Inspect", "the", "repo"], makeContext(repoRoot, env));
      const status = JSON.parse(await runStatus(["--type", "rescue"], makeContext(repoRoot, env))) as {
        status: string;
      };
      expect(output).toContain("# Failed Job");
      expect(status.status).toBe("failed");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("background rescue supports status/result", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("rescue-background");
    const repoRoot = await createGitRepoFixture("rescue-background-repo");
    const invocationPath = path.join(pluginDataRoot, "rescue-background.jsonl");
    const successEnv = makeMockEnv(pluginDataRoot, "rescue-success", invocationPath, {
      delayMs: 150,
    });

    try {
      const startOutput = await runRescue(["--background", "Do", "the", "work"], makeContext(repoRoot, successEnv));
      const jobId = parseStartedJobId(startOutput);
      const runningStatus = JSON.parse(await runStatus([jobId], makeContext(repoRoot, successEnv))) as {
        status: string;
      };

      expect(["running", "completed"]).toContain(runningStatus.status);

      const completed = await waitForTerminalJob(() => new JobStore(resolvePluginPaths(successEnv)), jobId, 10_000);
      const resultOutput = await runResult([jobId], makeContext(repoRoot, successEnv));

      expect(completed.status).toBe("completed");
      expect(resultOutput).toContain("# Rescue Result");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("background rescue can be cancelled and remains terminal with a session id", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("rescue-background-cancel");
    const repoRoot = await createGitRepoFixture("rescue-background-cancel-repo");
    const invocationPath = path.join(pluginDataRoot, "rescue-background-cancel.jsonl");
    const cancelEnv = makeMockEnv(pluginDataRoot, "rescue-cancel", invocationPath, {
      delayMs: 0,
    });

    try {
      const cancelStart = await runRescue(["--background", "Keep", "working"], makeContext(repoRoot, cancelEnv));
      const cancelJobId = parseStartedJobId(cancelStart);
      const cancelOutput = JSON.parse(await runCancel([cancelJobId], makeContext(repoRoot, cancelEnv))) as {
        status: string;
      };
      const cancelledStatus = JSON.parse(await runStatus([cancelJobId], makeContext(repoRoot, cancelEnv))) as {
        status: string;
        kimi_session_id: string;
      };

      expect(cancelOutput.status).toBe("cancelled");
      expect(cancelledStatus.status).toBe("cancelled");
      expect(cancelledStatus.kimi_session_id).toBeTruthy();
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("cancel during an in-flight turn leaves the job cancelled with its session id", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("rescue-cancel-mid-turn");
    const repoRoot = await createGitRepoFixture("rescue-cancel-mid-turn-repo");
    const env = makeMockWireEnv(pluginDataRoot, "rescue-cancel-turn");

    try {
      const startOutput = await runRescue(["--background", "Keep", "working"], makeContext(repoRoot, env));
      const jobId = parseStartedJobId(startOutput);
      const running = await waitForJobState(env, jobId, (job) => Boolean(job?.pid && job.kimi_pid));
      const cancelled = JSON.parse(await runCancel([jobId], makeContext(repoRoot, env))) as {
        status: string;
      };
      const terminal = await waitForTerminalJob(() => new JobStore(resolvePluginPaths(env)), jobId, 10_000);

      expect(running?.kimi_session_id).toBeTruthy();
      expect(cancelled.status).toBe("cancelled");
      expect(terminal.status).toBe("cancelled");
      expect(terminal.kimi_session_id).toBe(running?.kimi_session_id ?? null);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("cancel during initialize does not leave the Kimi process running", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("rescue-cancel-initialize");
    const repoRoot = await createGitRepoFixture("rescue-cancel-initialize-repo");
    const env = makeMockWireEnv(pluginDataRoot, "slow-initialize");

    try {
      const startOutput = await runRescue(["--background", "Keep", "working"], makeContext(repoRoot, env));
      const jobId = parseStartedJobId(startOutput);
      const running = await waitForJobState(env, jobId, (job) => Boolean(job?.pid && job.kimi_pid));
      await runCancel([jobId], makeContext(repoRoot, env));
      const terminal = await waitForTerminalJob(() => new JobStore(resolvePluginPaths(env)), jobId, 10_000);

      expect(terminal.status).toBe("cancelled");
      expect(running?.kimi_pid).toBeTruthy();

      let alive = true;
      try {
        process.kill(running!.kimi_pid!, 0);
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
      }

      expect(alive).toBe(false);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("waitForTerminalJob timeout tells the user how to recover", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("rescue-wait-timeout");
    const env = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: pluginDataRoot,
    };

    try {
      await ensurePluginPaths(resolvePluginPaths(env));
      await expect(
        waitForTerminalJob(() => new JobStore(resolvePluginPaths(env)), "job-timeout", 10),
      ).rejects.toThrow("use /kimi:status job-timeout to check progress or /kimi:result job-timeout once it completes");
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });
});
