import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runAsk } from "../../runtime/commands/ask.js";
import { rawTaskTextFromSubmittedPrompt } from "../../runtime/commands/repair-sessions.js";
import { resolveRepoIdentity } from "../../runtime/git.js";
import { JobStore } from "../../runtime/job-store.js";
import { runStatus } from "../../runtime/commands/status.js";
import { ensurePluginPaths, resolvePluginPaths } from "../../runtime/paths.js";
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
    KIMI_PLUGIN_CC_DATA: pluginDataRoot,
    KIMI_CODE_HOME: path.join(pluginDataRoot, "kimi-home"),
    KIMI_PLUGIN_CC_KIMI_BIN: "bun",
    KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
    KIMI_PLUGIN_CC_MOCK_SCENARIO: scenario,
    KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH: invocationPath,
    KIMI_PLUGIN_CC_MOCK_DELAY_MS: String(options?.delayMs ?? 0),
    KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
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
  test("per-run model aliases are single argv values and resume without an override omits -m", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-model-selection");
    const repoRoot = await createGitRepoFixture("ask-model-selection-repo");
    const invocationPath = path.join(pluginDataRoot, "invocation.json");
    const env = makeMockEnv(pluginDataRoot, "ask-success", invocationPath);
    const alias = "custom/model with spaces;$(not-a-command)";
    try {
      for (const args of [["Explain"], ["-m", alias, "Explain"], ["-r", "Continue"], ["-r", "-m", "other/alias", "Continue"]]) {
        await runAsk(args, makeContext(repoRoot, env));
        const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
        const index = args.indexOf("-m");
        if (index === -1) expect(invocation.argv).not.toContain("-m");
        else expect(invocation.argv[invocation.argv.indexOf("-m") + 1]).toBe(args[index + 1]!);
        if (args.includes("-r")) expect(invocation.argv).toContain("-r");
      }
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("resume with no prior ask jobs throws ASK_RESUME_NOT_FOUND", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-resume-none");
    const repoRoot = await createGitRepoFixture("ask-resume-none-repo");
    const invocationPath = path.join(pluginDataRoot, "ask-resume-none.jsonl");
    const env = makeMockEnv(pluginDataRoot, "ask-success", invocationPath);

    try {
      await expect(runAsk(["-r"], makeContext(repoRoot, env))).rejects.toMatchObject({
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
      await expect(runAsk(["--resume", "bogus-id"], makeContext(repoRoot, env))).rejects.toMatchObject({
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
      ) as { job_id: string; kimi_session_id: string; resumed_from_job_id: string | null };
      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
      const sessionIndex = invocation.argv.indexOf("-r");

      expect(latestJob.job_id).not.toBe(firstJob?.job_id);
      expect(latestJob.kimi_session_id).toBe(firstSession);
      expect(latestJob.resumed_from_job_id).toBe(firstJob?.job_id);
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

      await runAsk(["--resume", firstJob!.job_id], makeContext(repoRoot, env));
      store = new JobStore(resolvePluginPaths(env));
      const latestJob = store.findLatestJob({ repoId, commandType: "ask" });
      store.close();
      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
      const sessionIndex = invocation.argv.indexOf("-r");
      const firstSession = firstJob?.kimi_session_id;
      if (!firstSession) {
        throw new Error("Expected the first ask job to persist a session id.");
      }

      expect(secondJob?.kimi_session_id).toBeTruthy();
      expect(secondJob?.kimi_session_id).not.toBe(firstSession);
      expect(latestJob?.kimi_session_id).toBe(firstSession);
      expect(latestJob?.resumed_from_job_id).toBe(firstJob?.job_id);
      expect(invocation.argv[sessionIndex + 1]).toBe(firstSession);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("resume plus fresh throws INVALID_ARGS", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-resume-fresh-invalid");
    const repoRoot = await createGitRepoFixture("ask-resume-fresh-invalid-repo");
    const invocationPath = path.join(pluginDataRoot, "ask-resume-fresh-invalid.jsonl");
    const env = makeMockEnv(pluginDataRoot, "ask-success", invocationPath);

    try {
      await expect(
        runAsk(["-r", "--fresh", "What", "changed?"], makeContext(repoRoot, env)),
      ).rejects.toMatchObject({
        code: "INVALID_ARGS",
      });
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("refuses a session proven legacy-v1 instead of silently resuming it under native-v2", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-resume-v1-refusal");
    const repoRoot = await createGitRepoFixture("ask-resume-v1-refusal-repo");
    const invocationPath = path.join(pluginDataRoot, "ask-resume-v1-refusal.jsonl");
    const env = makeMockEnv(pluginDataRoot, "ask-success", invocationPath);
    const repoId = await getRepoId(repoRoot);
    const paths = resolvePluginPaths(env);
    await ensurePluginPaths(paths);
    const store = new JobStore(paths);
    try {
      store.createJob({
        job_id: "legacy-v1-source",
        repo_id: repoId,
        command_type: "ask",
        cwd: repoRoot,
        model: null,
        thinking: null,
        background: false,
        pid: null,
        kimi_pid: null,
        status: "completed",
        kimi_session_id: "session_legacy_v1",
        operation_kind: "ask",
        intended_engine: "legacy-v1",
        observed_engine: "legacy-v1",
        kimi_version: "0.39.0",
        system_version: null,
        agent_profile: "<cli-client>",
        prompt_digest: "digest",
        summary: "legacy v1 source",
        final_output_path: null,
        stream_log_path: path.join(pluginDataRoot, "missing-v1-log.jsonl"),
        error: null,
      });
    } finally {
      store.close();
    }

    try {
      await expect(
        runAsk(["--resume", "legacy-v1-source"], makeContext(repoRoot, env)),
      ).rejects.toMatchObject({
        code: "KIMI_SESSION_ENGINE_MISMATCH",
        details: {
          source_engine: "legacy-v1",
          target_engine: "native-v2",
        },
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
    const env = makeMockEnv(pluginDataRoot, "ask-success", invocationPath, { delayMs: 250 });
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

  test("concurrent resume by explicit job id is rejected at job creation time", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-resume-race");
    const repoRoot = await createGitRepoFixture("ask-resume-race-repo");
    const invocationPath = path.join(pluginDataRoot, "ask-resume-race.jsonl");
    const seedEnv = makeMockEnv(pluginDataRoot, "ask-success", invocationPath);
    const raceEnv = makeMockEnv(pluginDataRoot, "ask-success", invocationPath, { delayMs: 250 });
    const repoId = await getRepoId(repoRoot);

    try {
      await runAsk(["Seed", "question?"], makeContext(repoRoot, seedEnv));

      const store = new JobStore(resolvePluginPaths(seedEnv));
      const seedJob = store.findLatestJob({ repoId, commandType: "ask" });
      store.close();
      if (!seedJob) {
        throw new Error("Expected the seed ask job to exist.");
      }

      const results = await Promise.allSettled([
        runAsk(["--resume", seedJob.job_id], makeContext(repoRoot, raceEnv)),
        runAsk(["--resume", seedJob.job_id], makeContext(repoRoot, raceEnv)),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({
        reason: { code: "ASK_ALREADY_RUNNING" },
      });
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("resume by job id is scoped to the current repo", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-resume-cross-repo");
    const repoA = await createGitRepoFixture("ask-resume-cross-repo-a");
    const repoB = await createGitRepoFixture("ask-resume-cross-repo-b");
    const invocationPath = path.join(pluginDataRoot, "ask-resume-cross-repo.jsonl");
    const env = makeMockEnv(pluginDataRoot, "ask-success", invocationPath);
    const repoAId = await getRepoId(repoA);

    try {
      await runAsk(["Question", "from", "repo", "A?"], makeContext(repoA, env));

      const store = new JobStore(resolvePluginPaths(env));
      const repoAJob = store.findLatestJob({ repoId: repoAId, commandType: "ask" });
      store.close();
      if (!repoAJob) {
        throw new Error("Expected an ask job in repo A.");
      }

      await expect(runAsk(["--resume", repoAJob.job_id], makeContext(repoB, env))).rejects.toMatchObject({
        code: "ASK_RESUME_NOT_FOUND",
      });
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoA);
      await cleanupTestPath(repoB);
    }
  });

  test("bare resume keeps instructions out of the running summary and fallback title", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-resume-metadata");
    const repoRoot = await createGitRepoFixture("ask-resume-metadata-repo");
    const kimiHome = await createTestPluginDataRoot("ask-resume-metadata-kimi-home");
    const invocationPath = path.join(pluginDataRoot, "ask-resume-metadata.jsonl");
    const sessionId = "session_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const env = {
      ...makeMockEnv(pluginDataRoot, "ask-success", invocationPath, { delayMs: 5000 }),
      KIMI_CODE_HOME: kimiHome,
      KIMI_PLUGIN_CC_MOCK_SESSION_ID: sessionId,
      KIMI_PLUGIN_CC_MOCK_NO_SESSION_STORE: "1",
    };
    const repoId = await getRepoId(repoRoot);
    const statePath = await seedKimiSession(kimiHome, sessionId, repoRoot);
    const continuation = "Continue the previous ask conversation and answer any outstanding question.";

    try {
      await runAsk(["Initial", "question"], makeContext(repoRoot, {
        ...env,
        KIMI_PLUGIN_CC_MOCK_DELAY_MS: "0",
      }));
      expect((JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>).lastPrompt).toBe("Initial question");
      const startOutput = await runAsk(["--background", "-r"], makeContext(repoRoot, env));
      const started = JSON.parse(startOutput) as { job_id: string };
      const store = new JobStore(resolvePluginPaths(env));
      try {
        expect(store.getJob(started.job_id)?.summary).toBe(continuation);
      } finally {
        store.close();
      }

      await waitForJobState(env, repoId, (job) => job?.job_id === started.job_id && job.status === "completed", 15_000);
      const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
      expect(state.title).toBe(`Kimi Ask: ${continuation}`);
      // The settled resume is the session's latest prompt: its request replaces the first.
      expect(state.lastPrompt).toBe(continuation);
      const lines = (await readFile(invocationPath, "utf8")).trim().split("\n");
      const argv = (JSON.parse(lines[lines.length - 1]!) as { argv: string[] }).argv;
      expect(rawTaskTextFromSubmittedPrompt("ask", argv[argv.indexOf("-p") + 1]!)).toBe(continuation);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
      await cleanupTestPath(kimiHome);
    }
  }, 20_000);
});

async function getRepoId(repoRoot: string): Promise<string> {
  return (await resolveRepoIdentity(repoRoot)).repoId;
}

async function seedKimiSession(kimiHome: string, sessionId: string, workDir: string): Promise<string> {
  const sessionDir = path.join(kimiHome, "sessions", "wd_repo_123", sessionId);
  await mkdir(path.join(sessionDir, "agents", "main"), { recursive: true });
  await writeFile(
    path.join(sessionDir, "agents", "main", "wire.jsonl"),
    `${JSON.stringify({ type: "metadata", protocol_version: "2" })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(kimiHome, "session_index.jsonl"),
    `${JSON.stringify({ sessionId, sessionDir, workDir })}\n`,
    "utf8",
  );
  const statePath = path.join(sessionDir, "state.json");
  await writeFile(statePath, `${JSON.stringify({
    id: sessionId,
    version: 2,
    cwd: workDir,
    title: "New Session",
    titleKind: "replaceable",
    isCustomTitle: false,
  }, null, 2)}\n`, "utf8");
  return statePath;
}
