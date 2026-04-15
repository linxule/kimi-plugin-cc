import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { runAsk } from "../../runtime/commands/ask.js";
import { resolveRepoIdentity } from "../../runtime/git.js";
import { JobStore } from "../../runtime/job-store.js";
import { runStatus } from "../../runtime/commands/status.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import type { CommandContext } from "../../runtime/types.js";
import {
  cleanupTestPath,
  createGitRepoFixture,
  createTestPluginDataRoot,
} from "../helpers/test-env.js";

const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli.ts");

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
    KIMI_PLUGIN_CC_MOCK_DELAY_MS: String(options?.delayMs ?? 0),
  };
}

async function waitForJobState(
  env: NodeJS.ProcessEnv,
  repoId: string,
  predicate: (job: ReturnType<JobStore["findLatestJob"]>) => boolean,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const store = new JobStore(resolvePluginPaths(env));
    try {
      const job = store.findLatestJob({ repoId, commandType: "ask" });
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

  throw new Error(`Timed out while waiting for the latest ask job in repo ${repoId}.`);
}

describe("ask session resume", () => {
  test("resume with no prior ask jobs throws ASK_RESUME_NOT_FOUND", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-resume-none");
    const repoRoot = await createGitRepoFixture("ask-resume-none-repo");
    const invocationPath = path.join(pluginDataRoot, "ask-resume-none.jsonl");
    const env = makeMockEnv(pluginDataRoot, "ask-success", invocationPath);

    try {
      await expect(runAsk(["--resume"], makeContext(repoRoot, env))).rejects.toMatchObject({
        code: "ASK_RESUME_NOT_FOUND",
      });
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("resume with a bogus id throws ASK_RESUME_NOT_FOUND", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-resume-bogus");
    const repoRoot = await createGitRepoFixture("ask-resume-bogus-repo");
    const invocationPath = path.join(pluginDataRoot, "ask-resume-bogus.jsonl");
    const env = makeMockEnv(pluginDataRoot, "ask-success", invocationPath);

    try {
      await expect(
        runAsk(["--resume", "bogus-id", "What", "next?"], makeContext(repoRoot, env)),
      ).rejects.toMatchObject({
        code: "ASK_RESUME_NOT_FOUND",
      });
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("resume with a prior ask job reuses that session and the new job is visible in status", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-resume-latest");
    const repoRoot = await createGitRepoFixture("ask-resume-latest-repo");
    const invocationPath = path.join(pluginDataRoot, "ask-resume-latest.jsonl");
    const env = makeMockEnv(pluginDataRoot, "ask-success", invocationPath);
    const repoId = await getRepoId(repoRoot);

    try {
      await runAsk(["What", "changed?"], makeContext(repoRoot, env));

      const store = new JobStore(resolvePluginPaths(env));
      const firstJob = store.findLatestJob({ repoId, commandType: "ask" });
      store.close();
      const firstSession = firstJob?.kimi_session_id;
      if (!firstSession) {
        throw new Error("Expected the first ask job to persist a session id.");
      }

      await runAsk(["-r", "What", "should", "I", "do", "next?"], makeContext(repoRoot, env));

      const latestJob = JSON.parse(
        await runStatus(["--type", "ask"], makeContext(repoRoot, env)),
      ) as { job_id: string; kimi_session_id: string };
      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
      const sessionIndex = invocation.argv.indexOf("--session");

      expect(latestJob.job_id).not.toBe(firstJob?.job_id);
      expect(latestJob.kimi_session_id).toBe(firstSession);
      expect(invocation.argv[sessionIndex + 1]).toBe(firstSession);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("resume with a specific job id resumes that exact job session", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-resume-specific");
    const repoRoot = await createGitRepoFixture("ask-resume-specific-repo");
    const invocationPath = path.join(pluginDataRoot, "ask-resume-specific.jsonl");
    const env = makeMockEnv(pluginDataRoot, "ask-success", invocationPath);
    const repoId = await getRepoId(repoRoot);

    try {
      await runAsk(["First", "question?"], makeContext(repoRoot, env));
      let store = new JobStore(resolvePluginPaths(env));
      const firstJob = store.findLatestJob({ repoId, commandType: "ask" });
      store.close();

      await runAsk(["--fresh", "Second", "question?"], makeContext(repoRoot, env));
      store = new JobStore(resolvePluginPaths(env));
      const secondJob = store.findLatestJob({ repoId, commandType: "ask" });
      store.close();

      await runAsk(["--resume", firstJob!.job_id, "Follow", "up?"], makeContext(repoRoot, env));
      store = new JobStore(resolvePluginPaths(env));
      const latestJob = store.findLatestJob({ repoId, commandType: "ask" });
      store.close();
      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
      const sessionIndex = invocation.argv.indexOf("--session");
      const firstSession = firstJob?.kimi_session_id;
      if (!firstSession) {
        throw new Error("Expected the first ask job to persist a session id.");
      }

      expect(secondJob?.kimi_session_id).toBeTruthy();
      expect(secondJob?.kimi_session_id).not.toBe(firstSession);
      expect(latestJob?.kimi_session_id).toBe(firstSession);
      expect(invocation.argv[sessionIndex + 1]).toBe(firstSession);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("resume plus fresh throws INVALID_FLAGS", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-resume-fresh-invalid");
    const repoRoot = await createGitRepoFixture("ask-resume-fresh-invalid-repo");
    const invocationPath = path.join(pluginDataRoot, "ask-resume-fresh-invalid.jsonl");
    const env = makeMockEnv(pluginDataRoot, "ask-success", invocationPath);

    try {
      await expect(
        runAsk(["--resume", "--fresh", "What", "changed?"], makeContext(repoRoot, env)),
      ).rejects.toMatchObject({
        code: "INVALID_FLAGS",
      });
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("fresh with prior ask jobs creates a new session without mutating the prior job", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-fresh");
    const repoRoot = await createGitRepoFixture("ask-fresh-repo");
    const invocationPath = path.join(pluginDataRoot, "ask-fresh.jsonl");
    const env = makeMockEnv(pluginDataRoot, "ask-success", invocationPath);
    const repoId = await getRepoId(repoRoot);

    try {
      await runAsk(["Original", "question?"], makeContext(repoRoot, env));
      let store = new JobStore(resolvePluginPaths(env));
      const firstJob = store.findLatestJob({ repoId, commandType: "ask" });
      store.close();

      await runAsk(["--fresh", "New", "question?"], makeContext(repoRoot, env));
      store = new JobStore(resolvePluginPaths(env));
      const latestJob = store.findLatestJob({ repoId, commandType: "ask" });
      const persistedFirst = firstJob ? store.getJob(firstJob.job_id) : null;
      store.close();

      expect(latestJob?.job_id).not.toBe(firstJob?.job_id);
      expect(latestJob?.kimi_session_id).not.toBe(firstJob?.kimi_session_id);
      expect(persistedFirst?.kimi_session_id).toBe(firstJob?.kimi_session_id);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("resume with a running ask job throws ASK_ALREADY_RUNNING", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-resume-running");
    const repoRoot = await createGitRepoFixture("ask-resume-running-repo");
    const invocationPath = path.join(pluginDataRoot, "ask-resume-running.jsonl");
    const env = makeMockEnv(pluginDataRoot, "review-gate-allow", invocationPath, { delayMs: 250 });
    const repoId = await getRepoId(repoRoot);

    try {
      const firstRun = runAsk(["Initial", "question?"], makeContext(repoRoot, env));
      const runningJob = await waitForJobState(env, repoId, (job) => job?.status === "running");

      expect(runningJob?.status).toBe("running");
      await expect(runAsk(["-r", "Follow", "up?"], makeContext(repoRoot, env))).rejects.toMatchObject(
        {
          code: "ASK_ALREADY_RUNNING",
        },
      );

      await firstRun;
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });
});

async function getRepoId(repoRoot: string): Promise<string> {
  return (await resolveRepoIdentity(repoRoot)).repoId;
}
