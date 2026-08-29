import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { execFileSync } from "node:child_process";
import { access, mkdir, symlink, writeFile } from "node:fs/promises";

import { buildHookShellCommand } from "../../runtime/hooks/install-paths.js";

import { executeAskJob, runAsk } from "../../runtime/commands/ask.js";
import { runResult } from "../../runtime/commands/result.js";
import { runStatus } from "../../runtime/commands/status.js";
import { JobStore } from "../../runtime/job-store.js";
import { waitForTerminalJob } from "../../runtime/jobs.js";
import { ensurePluginPaths, resolvePluginPaths } from "../../runtime/paths.js";
import type { CommandContext } from "../../runtime/types.js";
import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";

const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli-v1.ts");

// Background --wait returns the artifact text as-is (includes writeArtifact trailing newline)
const ASK_SUCCESS_BACKGROUND_OUTPUT = "Ask answer from mock Kimi.\n";
// Foreground runAsk trims the artifact text to match the original behavior
const ASK_SUCCESS_OUTPUT = "Ask answer from mock Kimi.";

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
  options?: {
    delayMs?: number;
  },
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginDataRoot,
    KIMI_PLUGIN_CC_KIMI_BIN: "bun",
    KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
    KIMI_PLUGIN_CC_MOCK_SCENARIO: scenario,
    KIMI_PLUGIN_CC_MOCK_DELAY_MS: String(options?.delayMs ?? 0),
    KIMI_PLUGIN_CC_NODE_BIN: "node",
    KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
  };
}

/**
 * Absolute path to a REAL node binary.
 *
 * Deliberately NOT `process.execPath`: these tests run under `bun test`, so
 * execPath is the bun binary. Spawning a background worker with bun fails —
 * background-spawn passes `--import tsx`, which bun does not accept. That
 * mistake produced a confusing "Cannot find module './cjs/index.cjs'" from the
 * child, which is why the rest of this file hardcodes KIMI_PLUGIN_CC_NODE_BIN
 * to "node". Tests that need to spawn node *through a symlink* need the
 * resolved path rather than a bare name.
 */
function realNodeBinary(): string {
  return execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim();
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

describe("ask background", () => {
  test("worker re-verifies the hook and persists the exact refusal without invoking Kimi", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-background-worker-hook");
    const repoRoot = await createGitRepoFixture("ask-background-worker-hook-repo");
    const invocationPath = path.join(pluginDataRoot, "kimi-invocation.json");
    const env = makeMockEnv(pluginDataRoot, "ask-success");
    delete env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK;
    env.KIMI_CODE_HOME = path.join(pluginDataRoot, "missing-kimi-home");
    env.KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH = invocationPath;
    const paths = resolvePluginPaths(env);
    const jobId = randomUUID();

    try {
      await ensurePluginPaths(paths);
      const store = new JobStore(paths);
      try {
        store.createJob({
          job_id: jobId,
          repo_id: "ask-background-worker-hook-repo",
          command_type: "ask",
          cwd: repoRoot,
          model: null,
          thinking: null,
          background: true,
          pid: null,
          kimi_pid: null,
          status: "running",
          kimi_session_id: null,
          agent_profile: "<cli-client>",
          prompt_digest: "worker-hook-preflight",
          summary: "worker hook preflight",
          phase: "worker-spawned",
          final_output_path: null,
          stream_log_path: path.join(paths.logsDir, `ask-${jobId}.jsonl`),
          error: null,
        });
      } finally {
        store.close();
      }

      await expect(
        executeAskJob(jobId, "Question that must not reach Kimi", makeContext(repoRoot, env)),
      ).rejects.toMatchObject({
        code: "ASK_HOOK_NOT_INSTALLED",
        stage: "ask.hook-check",
      });

      const reopened = new JobStore(paths);
      try {
        const failed = reopened.getJob(jobId);
        expect(failed?.status).toBe("failed");
        expect(failed?.phase).toBe("failed");
        expect(failed?.error?.code).toBe("ASK_HOOK_NOT_INSTALLED");
        expect(failed?.error?.stage).toBe("ask.hook-check");
      } finally {
        reopened.close();
      }
      await expect(access(invocationPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("ask --background creates a job with background=true and returns {job_id, command_type}", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-background-basic");
    const repoRoot = await createGitRepoFixture("ask-background-basic-repo");
    const env = makeMockEnv(pluginDataRoot, "ask-success", { delayMs: 50 });

    try {
      const startOutput = await runAsk(
        ["--background", "What", "is", "the", "module", "structure?"],
        makeContext(repoRoot, env),
      );
      const parsed = JSON.parse(startOutput) as { job_id: string; command_type: string };

      expect(parsed.job_id).toBeString();
      expect(parsed.command_type).toBe("ask");

      // Wait for it to settle to avoid leaving a dangling process
      await waitForTerminalJob(() => new JobStore(resolvePluginPaths(env)), parsed.job_id, 10_000);

      const store = new JobStore(resolvePluginPaths(env));
      try {
        const job = store.getJob(parsed.job_id);
        expect(job?.background).toBe(true);
        expect(job?.command_type).toBe("ask");
      } finally {
        store.close();
      }
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("ask --background supports status/result after completion", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-background-result");
    const repoRoot = await createGitRepoFixture("ask-background-result-repo");
    const env = makeMockEnv(pluginDataRoot, "ask-success", { delayMs: 150 });

    try {
      const startOutput = await runAsk(
        ["--background", "Explain", "the", "approval", "policy"],
        makeContext(repoRoot, env),
      );
      const jobId = parseStartedJobId(startOutput);

      const runningStatus = JSON.parse(
        await runStatus([jobId], makeContext(repoRoot, env)),
      ) as {
        status: string;
        command_type: string;
        phase: string | null;
      };

      expect(["running", "completed"]).toContain(runningStatus.status);
      expect(runningStatus.command_type).toBe("ask");
      expect(["queued", "worker-spawned", "worker-running", "turn-running", "done"]).toContain(
        runningStatus.phase ?? "",
      );

      const completed = await waitForTerminalJob(
        () => new JobStore(resolvePluginPaths(env)),
        jobId,
        10_000,
      );
      const resultOutput = await runResult([jobId], makeContext(repoRoot, env));

      expect(completed.status).toBe("completed");
      expect(completed.phase).toBe("done");
      // runResult reads the artifact file directly (includes writeArtifact trailing newline)
      expect(resultOutput).toBe(ASK_SUCCESS_BACKGROUND_OUTPUT);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("ask --background --wait blocks until terminal state and returns the artifact text", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-background-wait");
    const repoRoot = await createGitRepoFixture("ask-background-wait-repo");
    const env = makeMockEnv(pluginDataRoot, "ask-success");

    try {
      const output = await runAsk(
        ["--background", "--wait", "Explain", "the", "job", "store"],
        makeContext(repoRoot, env),
      );

      expect(output).toBe(ASK_SUCCESS_BACKGROUND_OUTPUT);

      const status = JSON.parse(
        await runStatus(["--type", "ask"], makeContext(repoRoot, env)),
      ) as {
        status: string;
        phase: string | null;
      };

      expect(status.status).toBe("completed");
      expect(status.phase).toBe("done");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  // STRUCTURAL GAP CLOSER (v1.9.0 post-release review). Every other background
  // test sets KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1, and the one worker-refusal test
  // above calls executeAskJob IN-PROCESS. So no test had ever run a REAL
  // detached worker with enforcement enabled — which is exactly why the v1.9.0
  // `spawn(process.execPath)` regression reached pre-release review instead of
  // being caught by CI. That bug made the spawned worker rebuild a DIFFERENT
  // canonical command than the one setup pinned, so every background ask/rescue
  // refused forever and /kimi:setup could not converge them.
  //
  // This test crosses the process boundary: the parent pins a command,
  // background-spawn launches a real child, and the CHILD's own
  // verifyHookInstalled must agree — or the job lands failed with
  // ASK_HOOK_NOT_INSTALLED instead of completed.
  //
  // LIMIT: because it sets KIMI_PLUGIN_CC_NODE_BIN, spawner and verifier agree
  // BY CONSTRUCTION (the buggy code honored the override too), so it cannot
  // catch the v1.9.0 regression itself. Reproducing that needs the no-override
  // path with a real node parent, which is impossible under `bun test` — see
  // tests/runtime/background-hook-enforcement.test.ts.
  test("a REAL spawned background worker verifies the hook and completes with enforcement ON", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-background-hook-enforced");
    const repoRoot = await createGitRepoFixture("ask-background-hook-enforced-repo");

    try {
      const kimiHome = path.join(pluginDataRoot, "kimi-home");
      await mkdir(kimiHome, { recursive: true });

      // Spawn node through a symlink, mirroring the real Homebrew layout the
      // v1.9.0 fix targets (pinned stable name vs. version-stamped realpath).
      const nodeSymlink = path.join(kimiHome, "node-stable");
      await symlink(realNodeBinary(), nodeSymlink);

      // The real compiled hook script — verifyHookInstalled access()-checks both
      // this and, since the X_OK fix, the interpreter above.
      const hookScript = path.join(process.cwd(), "dist", "hooks", "approval-hook.js");

      const env = makeMockEnv(pluginDataRoot, "ask-success");
      delete env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK; // <- the whole point
      env.KIMI_CODE_HOME = kimiHome;
      env.KIMI_PLUGIN_CC_HOOK_SCRIPT = hookScript;
      env.KIMI_PLUGIN_CC_NODE_BIN = nodeSymlink;

      await writeFile(
        path.join(kimiHome, "config.toml"),
        [
          "[[hooks]]",
          'event = "PreToolUse"',
          `command = ${JSON.stringify(buildHookShellCommand(hookScript, env))}`,
          "timeout = 15",
        ].join("\n"),
        "utf8",
      );

      const output = await runAsk(
        ["--background", "--wait", "Explain", "the", "job", "store"],
        makeContext(repoRoot, env),
      );

      // Completion is the assertion: the spawned worker's own hook check passed.
      expect(output).toBe(ASK_SUCCESS_BACKGROUND_OUTPUT);

      const status = JSON.parse(
        await runStatus(["--type", "ask"], makeContext(repoRoot, env)),
      ) as { status: string; phase: string | null; error: { code?: string } | null };

      expect(status.error?.code).toBeUndefined();
      expect(status.status).toBe("completed");
      expect(status.phase).toBe("done");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  }, 30_000);

  // The negative direction. NOTE: despite sitting next to a spawn test, this
  // refusal happens in the PARENT — runAsk calls requireAskHookInstalled before
  // job creation and before startBackgroundJob (commands/ask.ts), so a stale pin
  // never reaches a worker and NO child is spawned. It proves the entry gate
  // refuses on drift with enforcement on; the worker's own re-verify is covered
  // by the in-process test at the top of this file.
  test("a REAL spawned background worker refuses when the pinned command is stale", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-background-hook-stale");
    const repoRoot = await createGitRepoFixture("ask-background-hook-stale-repo");

    try {
      const kimiHome = path.join(pluginDataRoot, "kimi-home");
      await mkdir(kimiHome, { recursive: true });
      const nodeSymlink = path.join(kimiHome, "node-stable");
      await symlink(realNodeBinary(), nodeSymlink);
      const hookScript = path.join(process.cwd(), "dist", "hooks", "approval-hook.js");

      const env = makeMockEnv(pluginDataRoot, "ask-success");
      delete env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK;
      env.KIMI_CODE_HOME = kimiHome;
      env.KIMI_PLUGIN_CC_HOOK_SCRIPT = hookScript;
      env.KIMI_PLUGIN_CC_NODE_BIN = nodeSymlink;

      // Pin a hook script path this companion does not use — the version-stamped
      // install-dir drift that started this whole investigation.
      await writeFile(
        path.join(kimiHome, "config.toml"),
        [
          "[[hooks]]",
          'event = "PreToolUse"',
          `command = ${JSON.stringify(
            buildHookShellCommand(path.join(process.cwd(), "dist", "hooks", "stale-hook.js"), env),
          )}`,
          "timeout = 15",
        ].join("\n"),
        "utf8",
      );

      await expect(
        runAsk(["--background", "--wait", "Explain", "the", "job", "store"], makeContext(repoRoot, env)),
      ).rejects.toMatchObject({ code: "ASK_HOOK_NOT_INSTALLED" });
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  }, 30_000);

  test("background ask with -r resumes the latest ask session with an already-resolved session id", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-background-resume");
    const repoRoot = await createGitRepoFixture("ask-background-resume-repo");
    const env = makeMockEnv(pluginDataRoot, "ask-success");

    try {
      // Seed a foreground ask to create a session
      await runAsk(["Initial", "question?"], makeContext(repoRoot, env));

      const store = new JobStore(resolvePluginPaths(env));
      const firstJob = store.findLatestJob({
        repoId: (await import("../../runtime/git.js").then((m) => m.resolveRepoIdentity(repoRoot))).repoId,
        commandType: "ask",
      });
      store.close();
      const firstSession = firstJob?.kimi_session_id;
      if (!firstSession) {
        throw new Error("Expected the first ask job to persist a session id.");
      }

      // Now resume in background — session resolution happens before spawn
      const startOutput = await runAsk(
        ["--background", "--wait", "-r"],
        makeContext(repoRoot, env),
      );

      // With --background --wait, we get the artifact text (includes writeArtifact trailing newline)
      expect(startOutput).toBe(ASK_SUCCESS_BACKGROUND_OUTPUT);

      // The new job should reuse the same session
      const store2 = new JobStore(resolvePluginPaths(env));
      const latestJob = store2.findLatestJob({
        repoId: firstJob!.repo_id,
        commandType: "ask",
      });
      store2.close();

      expect(latestJob?.kimi_session_id).toBe(firstSession);
      expect(latestJob?.background).toBe(true);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("background ask with invalid KIMI_PLUGIN_CC_NODE_BIN path marks job failed with ASK_NODE_BIN_INVALID", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-node-bin-invalid");
    const repoRoot = await createGitRepoFixture("ask-node-bin-invalid-repo");
    const env = makeMockEnv(pluginDataRoot, "ask-success");
    env.KIMI_PLUGIN_CC_NODE_BIN = `/tmp/kimi-plugin-cc-missing-node-${randomUUID()}`;

    try {
      await expect(
        runAsk(["--background", "What", "does", "this", "do?"], makeContext(repoRoot, env)),
      ).rejects.toMatchObject({
        code: "ASK_NODE_BIN_INVALID",
      });

      const status = JSON.parse(
        await runStatus(["--type", "ask"], makeContext(repoRoot, env)),
      ) as {
        status: string;
        phase: string | null;
        error: { code?: string; stage?: string } | null;
      };

      expect(status.status).toBe("failed");
      expect(status.phase).toBe("failed");
      expect(status.error?.code).toBe("ASK_NODE_BIN_INVALID");
      expect(status.error?.stage).toBe("ask.worker.spawn");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("background ask worker exit before phase advancement marks job failed with early-exit classification", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-background-early-exit");
    const repoRoot = await createGitRepoFixture("ask-background-early-exit-repo");

    // Keep the Kimi plan valid so dispatch reaches the background-worker seam,
    // then use an executable that exits immediately as the configured Node
    // launcher. The parent records worker-spawned and its close listener owns
    // the early-exit classification.
    const env = makeMockEnv(pluginDataRoot, "ask-success");
    env.KIMI_PLUGIN_CC_NODE_BIN = "/usr/bin/false";

    try {
      const startOutput = await runAsk(
        ["--background", "What", "is", "the", "structure?"],
        makeContext(repoRoot, env),
      );
      const jobId = parseStartedJobId(startOutput);

      // Wait for terminal state
      const terminal = await waitForTerminalJob(
        () => new JobStore(resolvePluginPaths(env)),
        jobId,
        15_000,
      );

      // The job should end in a failed state — either from the worker failing
      // to launch kimi (setup failure) or from the early-exit close listener.
      expect(terminal.status).toBe("failed");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });
});
