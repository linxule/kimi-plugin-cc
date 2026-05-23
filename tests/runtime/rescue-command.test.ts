import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
const RESCUE_SUCCESS_OUTPUT = [
  "Applied the requested change.",
  "",
  "- Updated note.txt with the requested fix.",
  "- Ran pwd to verify the workspace context.",
  "- Mock verification passed.",
  "",
].join("\n");

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
        summary: string;
        phase: string | null;
      };
      const store = new JobStore(resolvePluginPaths(env));
      const latest = store.getJob(status.job_id);
      store.close();

      expect(output).toBe(RESCUE_SUCCESS_OUTPUT);
      expect(status.status).toBe("completed");
      expect(status.summary).toBe("Applied the requested change.");
      expect(status.phase).toBe("done");
      expect(status.kimi_session_id).toBe(invocation.argv[sessionIndex + 1]);
      expect(latest?.kimi_session_id).toBe(invocation.argv[sessionIndex + 1]);
      expect(latest?.summary).toBe("Applied the requested change.");
      expect(latest?.phase).toBe("done");
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

      await runRescue(["--resume", firstStatus.job_id], makeContext(repoRoot, env));
      let invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
      expect(invocation.argv[invocation.argv.indexOf("--session") + 1]).toBe(firstSession);

      await runRescue(["--resume", firstSession], makeContext(repoRoot, env));
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
        phase: string | null;
      };
      expect(output).toContain("# Failed Job");
      expect(status.status).toBe("failed");
      expect(status.phase).toBe("failed");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("rescue resume by job id is scoped to the current repo", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("rescue-resume-cross-repo");
    const repoA = await createGitRepoFixture("rescue-resume-cross-repo-a");
    const repoB = await createGitRepoFixture("rescue-resume-cross-repo-b");
    const invocationPath = path.join(pluginDataRoot, "rescue-resume-cross-repo.jsonl");
    const env = makeMockEnv(pluginDataRoot, "rescue-success", invocationPath);

    try {
      await runRescue(["Initial", "task"], makeContext(repoA, env));
      const repoAStatus = JSON.parse(await runStatus(["--type", "rescue"], makeContext(repoA, env))) as {
        job_id: string;
      };

      await expect(runRescue(["--resume", repoAStatus.job_id], makeContext(repoB, env))).rejects.toMatchObject({
        code: "RESCUE_RESUME_NOT_FOUND",
      });
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoA);
      await cleanupTestPath(repoB);
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
        summary: string;
        phase: string | null;
      };
      const inFlight = await waitForJobState(
        successEnv,
        jobId,
        (job) => job?.status === "running" && job.phase === "turn-running" && Boolean(job.kimi_pid),
      );

      expect(["running", "completed"]).toContain(runningStatus.status);
      expect(runningStatus.summary).toBe("Do the work");
      expect(["worker-spawned", "worker-running", "turn-running", "done"]).toContain(runningStatus.phase ?? "");
      expect(inFlight?.phase).toBe("turn-running");
      expect(inFlight?.summary).toBe("Do the work");

      const completed = await waitForTerminalJob(() => new JobStore(resolvePluginPaths(successEnv)), jobId, 10_000);
      const resultOutput = await runResult([jobId], makeContext(repoRoot, successEnv));

      expect(completed.status).toBe("completed");
      expect(completed.summary).toBe("Applied the requested change.");
      expect(completed.phase).toBe("done");
      expect(resultOutput).toBe(RESCUE_SUCCESS_OUTPUT);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("empty rescue output fails with RESCUE_EMPTY_OUTPUT", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("rescue-empty");
    const repoRoot = await createGitRepoFixture("rescue-empty-repo");
    const invocationPath = path.join(pluginDataRoot, "rescue-empty.jsonl");
    const env = makeMockEnv(pluginDataRoot, "rescue-empty", invocationPath);

    try {
      const output = await runRescue(["Investigate", "the", "workspace"], makeContext(repoRoot, env));
      const status = JSON.parse(await runStatus(["--type", "rescue"], makeContext(repoRoot, env))) as {
        status: string;
        summary: string;
        phase: string | null;
        error: { code?: string; stage?: string; message?: string } | null;
      };

      expect(output).toContain("# Failed Job");
      expect(output).toContain("RESCUE_EMPTY_OUTPUT");
      expect(output).toContain("rescue.runtime");
      expect(output).toContain("Rescue returned empty output.");
      expect(status.status).toBe("failed");
      expect(status.summary).toBe("Rescue failed.");
      expect(status.phase).toBe("failed");
      expect(status.error?.code).toBe("RESCUE_EMPTY_OUTPUT");
      expect(status.error?.stage).toBe("rescue.runtime");
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
      expect(terminal.phase).toBe("cancelled");
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

  test("rescue setup failure marks the job failed, releases signal listeners, and closes the job store", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("rescue-setup-leak");
    const invocationPath = path.join(pluginDataRoot, "rescue-setup-leak.jsonl");
    const env = makeMockEnv(pluginDataRoot, "rescue-success", invocationPath);
    // A cwd that cannot be realpath'd forces createRescueApprovalPolicy to
    // throw ENOENT before the Wire client is built.
    const missingCwd = path.join(pluginDataRoot, "definitely", "missing", randomUUID());

    const sigTermBefore = process.listenerCount("SIGTERM");
    const sigIntBefore = process.listenerCount("SIGINT");

    try {
      // Pre-create a git-repo fixture just to satisfy the initial repo-identity probe;
      // then redirect the CommandContext at the missing path for the actual execution.
      const realRepo = await createGitRepoFixture("rescue-setup-leak-repo");
      try {
        // Seed a rescue job whose cwd cannot be realpath'd — this forces
        // createRescueApprovalPolicy to throw ENOENT inside the new setup
        // try/catch before any Wire client or signal listeners are attached.
        const seedContext = makeContext(realRepo, env);
        await ensurePluginPaths(resolvePluginPaths(env));
        const store = new JobStore(resolvePluginPaths(env));
        let createdJob;
        try {
          createdJob = store.createJob({
            job_id: randomUUID(),
            repo_id: "setup-leak-repo",
            command_type: "rescue",
            cwd: missingCwd,
            model: null,
            thinking: null,
            background: false,
            pid: null,
            kimi_pid: null,
            status: "running",
            kimi_session_id: randomUUID(),
            agent_profile: "runtime/agents/rescue.yaml",
            prompt_digest: "deadbeef",
            summary: "setup leak test",
            phase: "starting",
            final_output_path: null,
            stream_log_path: path.join(pluginDataRoot, "logs", `rescue-setup-leak-${randomUUID()}.jsonl`),
            error: null,
          });
        } finally {
          store.close();
        }

        const { executeRescueJob } = await import("../../runtime/commands/rescue.js");
        const result = await executeRescueJob(createdJob.job_id, "dummy prompt", seedContext);

        expect(result.status).toBe("failed");
        expect(result.phase).toBe("failed");
        expect(result.error?.stage).toBe("rescue.setup");
        expect(result.error?.code).toBe("RESCUE_SETUP_FAILED");

        // No orphaned signal listeners should remain — setup failure runs
        // before process.once registration.
        expect(process.listenerCount("SIGTERM")).toBe(sigTermBefore);
        expect(process.listenerCount("SIGINT")).toBe(sigIntBefore);

        // Fresh JobStore reopen must succeed (the failure path closed the
        // previous store — no busy lock should be held).
        const reopen = new JobStore(resolvePluginPaths(env));
        try {
          const persisted = reopen.getJob(createdJob.job_id);
          expect(persisted?.status).toBe("failed");
          expect(persisted?.phase).toBe("failed");
        } finally {
          reopen.close();
        }
      } finally {
        await cleanupTestPath(realRepo);
      }
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("rescue fails fast when KIMI_PLUGIN_CC_NODE_BIN points at a missing binary", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("rescue-node-bin-invalid");
    const repoRoot = await createGitRepoFixture("rescue-node-bin-invalid-repo");
    const invocationPath = path.join(pluginDataRoot, "rescue-node-bin-invalid.jsonl");
    const env = makeMockEnv(pluginDataRoot, "rescue-success", invocationPath);
    env.KIMI_PLUGIN_CC_NODE_BIN = `/tmp/kimi-plugin-cc-missing-node-${randomUUID()}`;

    try {
      await expect(
        runRescue(["--background", "Do", "the", "work"], makeContext(repoRoot, env)),
      ).rejects.toMatchObject({
        code: "RESCUE_NODE_BIN_INVALID",
      });

      const status = JSON.parse(await runStatus(["--type", "rescue"], makeContext(repoRoot, env))) as {
        status: string;
        phase: string | null;
        error: { code?: string; stage?: string; details?: { rawOutput?: string } } | null;
      };
      expect(status.status).toBe("failed");
      expect(status.phase).toBe("failed");
      expect(status.error?.code).toBe("RESCUE_NODE_BIN_INVALID");
      expect(status.error?.stage).toBe("rescue.worker.spawn");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("rescue classifies writeArtifact failure as RESCUE_ARTIFACT_WRITE_FAILED", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("rescue-artifact-write-fail");
    const repoRoot = await createGitRepoFixture("rescue-artifact-write-fail-repo");
    const invocationPath = path.join(pluginDataRoot, "rescue-artifact-write-fail.jsonl");
    const env = makeMockEnv(pluginDataRoot, "rescue-success", invocationPath);
    env.KIMI_PLUGIN_CC_TEST_FAIL_WRITE_ARTIFACT = "1";

    try {
      const output = await runRescue(["Implement", "the", "fix"], makeContext(repoRoot, env));
      const status = JSON.parse(await runStatus(["--type", "rescue"], makeContext(repoRoot, env))) as {
        status: string;
        phase: string | null;
        error: { code?: string; stage?: string; details?: Record<string, unknown> } | null;
      };

      expect(output).toContain("# Failed Job");
      expect(status.status).toBe("failed");
      expect(status.phase).toBe("failed");
      expect(status.error?.code).toBe("RESCUE_ARTIFACT_WRITE_FAILED");
      expect(status.error?.stage).toBe("rescue.artifact");
      expect(status.error?.details?.rawOutput).toBe(RESCUE_SUCCESS_OUTPUT.trimEnd());
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("background --wait on a failed rescue returns the failure artifact with code and stage", async () => {
    // This is the honest shape of item 3: `markJobFailed` writes a failure
    // artifact via `renderTerminalJobArtifact` that already carries Code +
    // Stage + Message. Background --wait reads that artifact via
    // `readArtifact` and returns it as the string result — the
    // `!final_output_path` throw branch in `startBackgroundRescue` only fires
    // in the rare edge case where the failure artifact itself cannot be
    // written. `describeMissingResult` guards that edge case; this test
    // verifies the full path exposes failure details through the artifact.
    const pluginDataRoot = await createTestPluginDataRoot("rescue-wait-failure-artifact");
    const repoRoot = await createGitRepoFixture("rescue-wait-failure-artifact-repo");
    const invocationPath = path.join(pluginDataRoot, "rescue-wait-failure-artifact.jsonl");
    const env = makeMockEnv(pluginDataRoot, "rescue-success", invocationPath);
    env.KIMI_PLUGIN_CC_TEST_FAIL_WRITE_ARTIFACT = "1";

    try {
      const output = await runRescue(
        ["--background", "--wait", "Do", "the", "work"],
        makeContext(repoRoot, env),
      );

      expect(output).toContain("# Failed Job");
      expect(output).toContain("RESCUE_ARTIFACT_WRITE_FAILED");
      expect(output).toContain("rescue.artifact");

      const persistedStatus = JSON.parse(
        await runStatus(["--type", "rescue"], makeContext(repoRoot, env)),
      ) as {
        status: string;
        phase: string | null;
        error: { code?: string; stage?: string; details?: Record<string, unknown> } | null;
      };

      expect(persistedStatus.status).toBe("failed");
      expect(persistedStatus.phase).toBe("failed");
      expect(persistedStatus.error?.code).toBe("RESCUE_ARTIFACT_WRITE_FAILED");
      expect(persistedStatus.error?.stage).toBe("rescue.artifact");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("describeMissingResult surfaces the inner failure code when the terminal record carries an error", async () => {
    const { describeMissingResult } = await import("../../runtime/commands/rescue.js");

    const failed = {
      job_id: "job-xyz",
      status: "failed",
      phase: "failed",
      summary: "Rescue failed.",
      error: {
        code: "RESCUE_ARTIFACT_WRITE_FAILED",
        message: "Failed to write rescue artifact: ENOSPC.",
        stage: "rescue.artifact",
      },
    } as unknown as Parameters<typeof describeMissingResult>[0];

    const cancelled = {
      job_id: "job-abc",
      status: "cancelled",
      phase: "cancelled",
      summary: "Rescue cancelled by user request.",
      error: {
        code: "RESCUE_CANCELLED",
        message: "Rescue cancelled.",
        stage: "rescue.cancel",
      },
    } as unknown as Parameters<typeof describeMissingResult>[0];

    const completedWithoutArtifact = {
      job_id: "job-done",
      status: "completed",
      phase: "done",
      summary: "no detail",
      error: null,
    } as unknown as Parameters<typeof describeMissingResult>[0];

    expect(describeMissingResult(failed)).toContain("RESCUE_ARTIFACT_WRITE_FAILED");
    expect(describeMissingResult(failed)).toContain("failed");
    expect(describeMissingResult(failed)).toContain("rescue.artifact");
    expect(describeMissingResult(failed)).toContain("ENOSPC");
    expect(describeMissingResult(cancelled)).toContain("RESCUE_CANCELLED");
    expect(describeMissingResult(cancelled)).toContain("cancelled");
    expect(describeMissingResult(cancelled)).toContain("rescue.cancel");
    expect(describeMissingResult(completedWithoutArtifact)).toContain(
      "finished without a rendered result",
    );
    expect(describeMissingResult(completedWithoutArtifact)).not.toContain("failed");

    // Empty error.message falls through to summary (via `||`, not `??`).
    const failedWithEmptyMessage = {
      job_id: "job-empty",
      status: "failed",
      phase: "failed",
      summary: "Summary fallback text.",
      error: {
        code: "RESCUE_UNKNOWN",
        message: "",
        stage: "rescue.runtime",
      },
    } as unknown as Parameters<typeof describeMissingResult>[0];
    expect(describeMissingResult(failedWithEmptyMessage)).toContain("Summary fallback text.");

    // Both empty → "no further detail" final fallback.
    const failedWithAllEmpty = {
      job_id: "job-all-empty",
      status: "failed",
      phase: "failed",
      summary: "",
      error: {
        code: "RESCUE_UNKNOWN",
        message: "",
        stage: "rescue.runtime",
      },
    } as unknown as Parameters<typeof describeMissingResult>[0];
    expect(describeMissingResult(failedWithAllEmpty)).toContain("no further detail");

    // Null error (cancelled via runCancel path before error was populated).
    const cancelledNullError = {
      job_id: "job-null-err",
      status: "cancelled",
      phase: "cancelled",
      summary: "Rescue cancelled by user request.",
      error: null,
    } as unknown as Parameters<typeof describeMissingResult>[0];
    expect(describeMissingResult(cancelledNullError)).toContain("cancelled");
    expect(describeMissingResult(cancelledNullError)).toContain("unknown");
    expect(describeMissingResult(cancelledNullError)).toContain("Rescue cancelled by user request.");
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
