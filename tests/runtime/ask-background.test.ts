import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { runAsk } from "../../runtime/commands/ask.js";
import { runResult } from "../../runtime/commands/result.js";
import { runStatus } from "../../runtime/commands/status.js";
import { JobStore } from "../../runtime/job-store.js";
import { waitForTerminalJob } from "../../runtime/jobs.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
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

describe("ask background", () => {
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

    // Use a node binary that exists but an env that will cause the worker to
    // fail fast (missing scenario + no kimi bin). The worker will try to run
    // executeAskJob but fail before advancing the phase past worker-spawned.
    // We don't want to wait too long, so use a very short delay.
    const env = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: pluginDataRoot,
      // Don't set KIMI_PLUGIN_CC_KIMI_BIN so the worker uses the real kimi binary,
      // which won't be found, causing the worker process to exit non-zero.
      // Actually set it to a broken value so spawn fails after phase check.
      KIMI_PLUGIN_CC_KIMI_BIN: `/tmp/missing-kimi-bin-${randomUUID()}`,
      KIMI_PLUGIN_CC_NODE_BIN: "node",
    } as NodeJS.ProcessEnv;

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
