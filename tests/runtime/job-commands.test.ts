import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runAsk } from "../../runtime/commands/ask.js";
import { runCancel } from "../../runtime/commands/cancel.js";
import { runResult } from "../../runtime/commands/result.js";
import { runStatus } from "../../runtime/commands/status.js";
import { resolveRepoIdentity } from "../../runtime/git.js";
import { sweepStaleJobs } from "../../runtime/jobs.js";
import { JobStore } from "../../runtime/job-store.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import type { CommandContext } from "../../runtime/types.js";
import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";

const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli-v1.ts");

function makeContext(cwd: string, env: NodeJS.ProcessEnv): CommandContext {
  return {
    cwd,
    env,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

function makeMockEnv(pluginDataRoot: string, scenario: string, invocationPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginDataRoot,
    KIMI_PLUGIN_CC_KIMI_BIN: "bun",
    KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
    KIMI_PLUGIN_CC_MOCK_SCENARIO: scenario,
    KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH: invocationPath,
  };
}

describe("job-backed ask/status/result", () => {
  test("ask is persisted and visible through status/result", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("job-ask");
    const invocationPath = path.join(pluginDataRoot, "ask-invocation.jsonl");
    const env = makeMockEnv(pluginDataRoot, "ask-success", invocationPath);

    try {
      const askResult = await runAsk(["What", "changed?"], makeContext(process.cwd(), env));
      const statusOutput = await runStatus(["--type", "ask"], makeContext(process.cwd(), env));
      const resultOutput = await runResult(["--type", "ask"], makeContext(process.cwd(), env));
      const status = JSON.parse(statusOutput) as { job_id: string; status: string; command_type: string };
      const store = new JobStore(resolvePluginPaths(env));

      try {
        const storedJob = store.getJob(status.job_id);
        // v1.0: kimi-code mints the session id and announces it on stderr;
        // cli-client captures it and we persist what we received. We can't
        // pre-correlate it with an argv flag (no --session anymore), so
        // just verify the row carries a uuid-shaped value.
        expect(storedJob?.kimi_session_id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
      } finally {
        store.close();
      }

      expect(askResult).toBe("Ask answer from mock Kimi.");
      expect(status.command_type).toBe("ask");
      expect(status.status).toBe("completed");
      expect(resultOutput).toContain("Ask answer from mock Kimi.");
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("result returns raw markdown by default and a structured envelope with --json", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("result-json-envelope");
    const repoRoot = await createGitRepoFixture("result-json-envelope-repo");
    const paths = resolvePluginPaths({ ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot });
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot };

    try {
      await mkdir(paths.pluginRoot, { recursive: true });
      await mkdir(paths.logsDir, { recursive: true });
      await mkdir(paths.artifactsDir, { recursive: true });
      const repoIdentity = await resolveRepoIdentity(repoRoot);
      const artifactPath = path.join(paths.artifactsDir, "ask-job-json.md");
      const body = "# Result\n\nRaw markdown body.\n";
      await writeFile(artifactPath, body, "utf8");

      const store = new JobStore(paths);
      try {
        store.createJob({
          job_id: "job-json",
          repo_id: repoIdentity.repoId,
          command_type: "ask",
          cwd: repoRoot,
          model: null,
          thinking: null,
          background: false,
          pid: null,
          kimi_pid: null,
          status: "completed",
          kimi_session_id: "session-json",
          agent_profile: "read-only",
          prompt_digest: "digest",
          summary: "Raw markdown body.",
          phase: "done",
          final_output_path: artifactPath,
          stream_log_path: path.join(paths.logsDir, "ask-job-json.jsonl"),
          error: null,
        });
      } finally {
        store.close();
      }

      expect(await runResult(["job-json"], makeContext(repoRoot, env))).toBe(body);

      const envelope = JSON.parse(await runResult(["job-json", "--json"], makeContext(repoRoot, env))) as {
        job_id: string;
        kind: string;
        status: string;
        summary: string;
        error: unknown;
        artifact_path: string;
        body: string;
        created_at: string;
        completed_at: string;
      };
      expect(envelope).toMatchObject({
        job_id: "job-json",
        kind: "ask",
        status: "completed",
        summary: "Raw markdown body.",
        error: null,
        artifact_path: artifactPath,
        body,
      });
      expect(envelope.created_at).toBeString();
      expect(envelope.completed_at).toBeString();
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("result --json rejects unknown flags before lookup", async () => {
    await expect(
      runResult(["job-json", "--json", "--gibberish"], makeContext(process.cwd(), process.env)),
    ).rejects.toMatchObject({
      code: "INVALID_ARGS",
    });
  });

  test("result --json rejects running jobs as not terminal", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("result-json-running");
    const repoRoot = await createGitRepoFixture("result-json-running-repo");
    const paths = resolvePluginPaths({ ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot });
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot };

    try {
      await mkdir(paths.pluginRoot, { recursive: true });
      await mkdir(paths.logsDir, { recursive: true });
      await mkdir(paths.artifactsDir, { recursive: true });
      const repoIdentity = await resolveRepoIdentity(repoRoot);
      const store = new JobStore(paths);
      try {
        store.createJob({
          job_id: "job-running-json",
          repo_id: repoIdentity.repoId,
          command_type: "ask",
          cwd: repoRoot,
          model: null,
          thinking: null,
          background: false,
          pid: null,
          kimi_pid: null,
          status: "running",
          kimi_session_id: "session-running",
          agent_profile: "read-only",
          prompt_digest: "digest",
          summary: "Running ask.",
          phase: "turn-running",
          final_output_path: null,
          stream_log_path: path.join(paths.logsDir, "ask-job-running-json.jsonl"),
          error: null,
        });
      } finally {
        store.close();
      }

      await expect(
        runResult(["job-running-json", "--json"], makeContext(repoRoot, env)),
      ).rejects.toMatchObject({
        code: "JOB_NOT_TERMINAL",
      });
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("0.1.4 migration reconciles orphaned duplicate running rows", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("job-store-migration");
    const paths = resolvePluginPaths({ ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot });

    try {
      await mkdir(paths.pluginRoot, { recursive: true });
      await mkdir(paths.logsDir, { recursive: true });
      await mkdir(paths.artifactsDir, { recursive: true });

      // Seed a 0.1.3-shaped database: jobs table with the old rescue-only unique
      // index, plus two running ask rows that share a (repo_id, kimi_session_id).
      // The new 0.1.4 unique index would reject these at CREATE time, so the
      // migration step must reconcile them before the index is built.
      const seed = new Database(paths.stateDbPath);
      try {
        seed.exec(`
          CREATE TABLE jobs (
            job_id TEXT PRIMARY KEY,
            repo_id TEXT NOT NULL,
            command_type TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            cwd TEXT NOT NULL,
            model TEXT,
            thinking INTEGER,
            background INTEGER NOT NULL,
            pid INTEGER,
            kimi_pid INTEGER,
            status TEXT NOT NULL,
            kimi_session_id TEXT,
            agent_profile TEXT NOT NULL,
            prompt_digest TEXT NOT NULL,
            summary TEXT NOT NULL,
            final_output_path TEXT,
            stream_log_path TEXT NOT NULL,
            error TEXT
          );
          CREATE UNIQUE INDEX jobs_running_rescue_session_idx
            ON jobs (repo_id, kimi_session_id)
            WHERE status = 'running' AND command_type = 'rescue';
        `);
        const insert = seed.query(`
          INSERT INTO jobs (
            job_id, repo_id, command_type, created_at, updated_at, cwd, background,
            status, kimi_session_id, agent_profile, prompt_digest, summary, stream_log_path
          ) VALUES (?, ?, 'ask', ?, ?, '/tmp/fake', 0, 'running', ?, 'read-only', 'digest', 'summary', '/tmp/fake.log')
        `);
        // Older row (should be reconciled)
        insert.run("job-older", "repo-x", "2026-04-14T10:00:00.000Z", "2026-04-14T10:00:00.000Z", "session-dup");
        // Newer row (should survive as the canonical running entry)
        insert.run("job-newer", "repo-x", "2026-04-14T11:00:00.000Z", "2026-04-14T11:00:00.000Z", "session-dup");
        // Unrelated running row with a distinct session — must stay untouched
        insert.run("job-other", "repo-x", "2026-04-14T10:30:00.000Z", "2026-04-14T10:30:00.000Z", "session-other");
      } finally {
        seed.close();
      }

      // Opening the JobStore runs the 0.1.4 schema init, which must dedupe
      // before creating the new unique partial index. This should not throw.
      const store = new JobStore(paths);
      try {
        const older = store.getJob("job-older");
        const newer = store.getJob("job-newer");
        const other = store.getJob("job-other");
        const columns = getJobTableColumns(paths.stateDbPath);

        expect(newer?.status).toBe("running");
        expect(older?.status).toBe("failed");
        expect(older?.error?.code).toBe("JOB_STORE_ORPHANED_ON_UPGRADE");
        expect(other?.status).toBe("running");
        expect(columns).toContain("phase");
      } finally {
        store.close();
      }
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("0.1.7 migration adds the phase column idempotently", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("job-store-phase-migration");
    const paths = resolvePluginPaths({ ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot });

    try {
      await mkdir(paths.pluginRoot, { recursive: true });

      const seed = new Database(paths.stateDbPath);
      try {
        seed.exec(`
          CREATE TABLE jobs (
            job_id TEXT PRIMARY KEY,
            repo_id TEXT NOT NULL,
            command_type TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            cwd TEXT NOT NULL,
            model TEXT,
            thinking INTEGER,
            background INTEGER NOT NULL,
            pid INTEGER,
            kimi_pid INTEGER,
            status TEXT NOT NULL,
            kimi_session_id TEXT,
            agent_profile TEXT NOT NULL,
            prompt_digest TEXT NOT NULL,
            summary TEXT NOT NULL,
            final_output_path TEXT,
            stream_log_path TEXT NOT NULL,
            error TEXT
          );
        `);
      } finally {
        seed.close();
      }

      const store = new JobStore(paths);
      store.close();
      expect(getJobTableColumns(paths.stateDbPath)).toContain("phase");

      const reopened = new JobStore(paths);
      reopened.close();
      expect(getJobTableColumns(paths.stateDbPath).filter((column) => column === "phase")).toHaveLength(1);
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("sweeps stale foreground jobs whose Kimi process disappeared", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("job-store-foreground-sweep");
    const paths = resolvePluginPaths({ ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot });

    try {
      await mkdir(paths.pluginRoot, { recursive: true });
      await mkdir(paths.logsDir, { recursive: true });
      await mkdir(paths.artifactsDir, { recursive: true });
      const deadPid = findDefinitelyDeadPid();

      const store = new JobStore(paths);
      try {
        store.createJob({
          job_id: "job-stale-foreground",
          repo_id: "repo-x",
          command_type: "review",
          cwd: "/tmp/fake",
          model: null,
          thinking: null,
          background: false,
          pid: null,
          kimi_pid: deadPid,
          status: "running",
          kimi_session_id: "session-x",
          agent_profile: "read-only",
          prompt_digest: "digest",
          summary: "Running review.",
          final_output_path: null,
          stream_log_path: path.join(paths.logsDir, "review-job-stale-foreground.jsonl"),
          error: null,
        });
      } finally {
        store.close();
      }

      const seed = new Database(paths.stateDbPath);
      try {
        seed
          .query("UPDATE jobs SET updated_at = ? WHERE job_id = ?")
          .run("2026-04-14T10:00:00.000Z", "job-stale-foreground");
      } finally {
        seed.close();
      }

      const sweepStore = new JobStore(paths);
      try {
        await sweepStaleJobs(sweepStore, paths);
        const swept = sweepStore.getJob("job-stale-foreground");
        expect(swept?.status).toBe("failed");
        expect(swept?.error?.code).toBe("FOREGROUND_PROCESS_DISAPPEARED");
        expect(swept?.final_output_path).toBeTruthy();
        expect(await readFile(swept!.final_output_path!, "utf8")).toContain(
          "Foreground Kimi job disappeared before reporting a terminal state.",
        );
      } finally {
        sweepStore.close();
      }
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("sweeps stale foreground jobs that died before Kimi pid was recorded", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("job-store-foreground-pre-kimi-sweep");
    const paths = resolvePluginPaths({ ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot });

    try {
      await mkdir(paths.pluginRoot, { recursive: true });
      await mkdir(paths.logsDir, { recursive: true });
      await mkdir(paths.artifactsDir, { recursive: true });
      const deadPid = findDefinitelyDeadPid();

      const store = new JobStore(paths);
      try {
        store.createJob({
          job_id: "job-stale-before-kimi",
          repo_id: "repo-x",
          command_type: "ask",
          cwd: "/tmp/fake",
          model: null,
          thinking: null,
          background: false,
          pid: deadPid,
          kimi_pid: null,
          status: "running",
          kimi_session_id: "session-x",
          agent_profile: "read-only",
          prompt_digest: "digest",
          summary: "Running ask.",
          phase: "starting",
          final_output_path: null,
          stream_log_path: path.join(paths.logsDir, "ask-job-stale-before-kimi.jsonl"),
          error: null,
        });
      } finally {
        store.close();
      }

      const seed = new Database(paths.stateDbPath);
      try {
        seed
          .query("UPDATE jobs SET updated_at = ? WHERE job_id = ?")
          .run("2026-04-14T10:00:00.000Z", "job-stale-before-kimi");
      } finally {
        seed.close();
      }

      const sweepStore = new JobStore(paths);
      try {
        await sweepStaleJobs(sweepStore, paths);
        const swept = sweepStore.getJob("job-stale-before-kimi");
        expect(swept?.status).toBe("failed");
        expect(swept?.phase).toBe("failed");
        expect(swept?.error?.message).toContain("Foreground companion pid");
      } finally {
        sweepStore.close();
      }
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("status and result sweep stale foreground jobs through the user-facing path", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("job-store-user-facing-sweep");
    const repoRoot = await createTestPluginDataRoot("job-store-user-facing-sweep-repo");
    const paths = resolvePluginPaths({ ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot });
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot };

    try {
      await mkdir(paths.pluginRoot, { recursive: true });
      await mkdir(paths.logsDir, { recursive: true });
      await mkdir(paths.artifactsDir, { recursive: true });
      const deadPid = findDefinitelyDeadPid();

      const store = new JobStore(paths);
      try {
        store.createJob({
          job_id: "job-user-facing-stale",
          repo_id: repoRoot,
          command_type: "review",
          cwd: repoRoot,
          model: null,
          thinking: null,
          background: false,
          pid: deadPid,
          kimi_pid: null,
          status: "running",
          kimi_session_id: "session-x",
          agent_profile: "read-only",
          prompt_digest: "digest",
          summary: "Running review.",
          final_output_path: null,
          stream_log_path: path.join(paths.logsDir, "review-job-user-facing-stale.jsonl"),
          error: null,
        });
      } finally {
        store.close();
      }

      const seed = new Database(paths.stateDbPath);
      try {
        seed
          .query("UPDATE jobs SET updated_at = ? WHERE job_id = ?")
          .run("2026-04-14T10:00:00.000Z", "job-user-facing-stale");
      } finally {
        seed.close();
      }

      const status = JSON.parse(await runStatus(["job-user-facing-stale"], makeContext(repoRoot, env))) as {
        status: string;
        error: { code: string };
      };
      const result = await runResult(["job-user-facing-stale"], makeContext(repoRoot, env));

      expect(status.status).toBe("failed");
      expect(status.error.code).toBe("FOREGROUND_PROCESS_DISAPPEARED");
      expect(result).toContain("Foreground Kimi job disappeared before reporting a terminal state.");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("sweeping a stale foreground companion terminates an orphaned Kimi child", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("job-store-orphan-kimi-sweep");
    const paths = resolvePluginPaths({ ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot });
    const orphan = spawnLongRunningProcess();

    try {
      await mkdir(paths.pluginRoot, { recursive: true });
      await mkdir(paths.logsDir, { recursive: true });
      await mkdir(paths.artifactsDir, { recursive: true });

      const store = new JobStore(paths);
      try {
        store.createJob({
          job_id: "job-orphan-kimi",
          repo_id: "repo-x",
          command_type: "review",
          cwd: "/tmp/fake",
          model: null,
          thinking: null,
          background: false,
          pid: findDefinitelyDeadPid(),
          kimi_pid: orphan.pid ?? null,
          status: "running",
          kimi_session_id: "session-x",
          agent_profile: "read-only",
          prompt_digest: "digest",
          summary: "Running review.",
          final_output_path: null,
          stream_log_path: path.join(paths.logsDir, "review-job-orphan-kimi.jsonl"),
          error: null,
        });
      } finally {
        store.close();
      }

      const seed = new Database(paths.stateDbPath);
      try {
        seed
          .query("UPDATE jobs SET updated_at = ? WHERE job_id = ?")
          .run("2026-04-14T10:00:00.000Z", "job-orphan-kimi");
      } finally {
        seed.close();
      }

      const sweepStore = new JobStore(paths);
      try {
        await sweepStaleJobs(sweepStore, paths);
        const swept = sweepStore.getJob("job-orphan-kimi");
        expect(swept?.status).toBe("failed");
      } finally {
        sweepStore.close();
      }

      await waitForChildExit(orphan);
      expect(orphan.exitCode !== null || orphan.signalCode !== null).toBe(true);
    } finally {
      if (orphan.exitCode === null && orphan.signalCode === null) {
        orphan.kill("SIGKILL");
      }
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("sweep skips foreground jobs whose companion is still alive (no SIGTERM mid-render)", async () => {
    // Regression for v0.2.3: a sibling shell running /kimi:status while the
    // foreground review is mid-render would previously SIGTERM the live
    // companion when kimi_pid had just died. The sweeper must skip the
    // termination/markFailed step while the companion is still alive — it
    // will write its own terminal state.
    const pluginDataRoot = await createTestPluginDataRoot("job-store-sweep-live-companion");
    const paths = resolvePluginPaths({ ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot });
    const liveCompanion = spawnLongRunningProcess();

    try {
      await mkdir(paths.pluginRoot, { recursive: true });
      await mkdir(paths.logsDir, { recursive: true });
      await mkdir(paths.artifactsDir, { recursive: true });
      const deadKimi = findDefinitelyDeadPid();

      const store = new JobStore(paths);
      try {
        store.createJob({
          job_id: "job-live-companion-dead-kimi",
          repo_id: "repo-x",
          command_type: "review",
          cwd: "/tmp/fake",
          model: null,
          thinking: null,
          background: false,
          pid: liveCompanion.pid ?? null,
          kimi_pid: deadKimi,
          status: "running",
          kimi_session_id: "session-x",
          agent_profile: "read-only",
          prompt_digest: "digest",
          summary: "Running review.",
          final_output_path: null,
          stream_log_path: path.join(paths.logsDir, "review-job-live-companion-dead-kimi.jsonl"),
          error: null,
        });
      } finally {
        store.close();
      }

      const seed = new Database(paths.stateDbPath);
      try {
        seed
          .query("UPDATE jobs SET updated_at = ? WHERE job_id = ?")
          .run("2026-04-14T10:00:00.000Z", "job-live-companion-dead-kimi");
      } finally {
        seed.close();
      }

      const sweepStore = new JobStore(paths);
      try {
        await sweepStaleJobs(sweepStore, paths);
        const swept = sweepStore.getJob("job-live-companion-dead-kimi");
        // Should stay running — companion is alive and will finish on its own.
        expect(swept?.status).toBe("running");
      } finally {
        sweepStore.close();
      }
      // And the companion must still be alive — we did NOT SIGTERM it.
      expect(liveCompanion.exitCode).toBe(null);
      expect(liveCompanion.signalCode).toBe(null);
    } finally {
      if (liveCompanion.exitCode === null && liveCompanion.signalCode === null) {
        liveCompanion.kill("SIGKILL");
      }
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("sweep marks a stale review_gate row as failed without trying to signal a null pid", async () => {
    // Regression: review_gate records pid: null. If the hook companion crashes
    // after kimi_pid is recorded, the row sits with pid=null,kimi_pid=<dead>.
    // Sweeper should mark it failed cleanly, terminate any (already-dead) kimi
    // process, and not touch the hook caller's pid.
    const pluginDataRoot = await createTestPluginDataRoot("job-store-review-gate-sweep");
    const paths = resolvePluginPaths({ ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot });

    try {
      await mkdir(paths.pluginRoot, { recursive: true });
      await mkdir(paths.logsDir, { recursive: true });
      await mkdir(paths.artifactsDir, { recursive: true });
      const deadKimi = findDefinitelyDeadPid();

      const store = new JobStore(paths);
      try {
        store.createJob({
          job_id: "job-review-gate-stale",
          repo_id: "repo-x",
          command_type: "review_gate",
          cwd: "/tmp/fake",
          model: null,
          thinking: null,
          background: false,
          pid: null,
          kimi_pid: deadKimi,
          status: "running",
          kimi_session_id: "session-x",
          agent_profile: "read-only",
          prompt_digest: "digest",
          summary: "Running review gate.",
          final_output_path: null,
          stream_log_path: path.join(paths.logsDir, "review-gate-job-review-gate-stale.jsonl"),
          error: null,
        });
      } finally {
        store.close();
      }

      const seed = new Database(paths.stateDbPath);
      try {
        seed
          .query("UPDATE jobs SET updated_at = ? WHERE job_id = ?")
          .run("2026-04-14T10:00:00.000Z", "job-review-gate-stale");
      } finally {
        seed.close();
      }

      const sweepStore = new JobStore(paths);
      try {
        await sweepStaleJobs(sweepStore, paths);
        const swept = sweepStore.getJob("job-review-gate-stale");
        expect(swept?.status).toBe("failed");
        expect(swept?.error?.code).toBe("FOREGROUND_PROCESS_DISAPPEARED");
        expect(swept?.final_output_path).toBeTruthy();
      } finally {
        sweepStore.close();
      }
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("cancel on a review_gate job signals only kimi_pid, never the hook companion", async () => {
    // Regression: review_gate records pid: null because its companion lifecycle
    // is bounded by the Stop hook; cancel must SIGTERM only the recorded
    // kimi_pid. If pid were set to process.pid, this test would terminate the
    // test runner mid-flight.
    const pluginDataRoot = await createTestPluginDataRoot("job-store-review-gate-cancel");
    const repoRoot = await createTestPluginDataRoot("job-store-review-gate-cancel-repo");
    const paths = resolvePluginPaths({ ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot });
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot };
    const child = spawnLongRunningProcess();

    try {
      await mkdir(paths.pluginRoot, { recursive: true });
      await mkdir(paths.logsDir, { recursive: true });
      await mkdir(paths.artifactsDir, { recursive: true });

      const store = new JobStore(paths);
      try {
        store.createJob({
          job_id: "job-review-gate-cancel",
          repo_id: repoRoot,
          command_type: "review_gate",
          cwd: repoRoot,
          model: null,
          thinking: null,
          background: false,
          pid: null,
          kimi_pid: child.pid ?? null,
          status: "running",
          kimi_session_id: "session-x",
          agent_profile: "read-only",
          prompt_digest: "digest",
          summary: "Running review gate.",
          final_output_path: null,
          stream_log_path: path.join(paths.logsDir, "review-gate-job-review-gate-cancel.jsonl"),
          error: null,
        });
      } finally {
        store.close();
      }

      const output = JSON.parse(await runCancel(["job-review-gate-cancel"], makeContext(repoRoot, env))) as {
        status: string;
        message: string;
      };

      expect(output.status).toBe("cancelled");
      await waitForChildExit(child);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("cancel of a review_gate job escalates SIGTERM→SIGKILL when the child ignores SIGTERM", async () => {
    // v0.2.4 regression test: the v0.2.3 cancel.ts pre-marked the row as
    // `cancelled`, which made waitForCancellation return on the status
    // check and skip SIGKILL escalation entirely. v0.2.4 runs unconditional
    // SIGTERM → 1s wait → SIGKILL on the recorded pids for review_gate.
    // Use a child that traps SIGTERM so only SIGKILL can end it.
    const pluginDataRoot = await createTestPluginDataRoot("job-store-review-gate-sigkill");
    const repoRoot = await createTestPluginDataRoot("job-store-review-gate-sigkill-repo");
    const paths = resolvePluginPaths({ ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot });
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot };
    const child = spawnSigtermIgnoringProcess();

    try {
      await mkdir(paths.pluginRoot, { recursive: true });
      await mkdir(paths.logsDir, { recursive: true });
      await mkdir(paths.artifactsDir, { recursive: true });

      const store = new JobStore(paths);
      try {
        store.createJob({
          job_id: "job-review-gate-sigkill",
          repo_id: repoRoot,
          command_type: "review_gate",
          cwd: repoRoot,
          model: null,
          thinking: null,
          background: false,
          pid: null,
          kimi_pid: child.pid ?? null,
          status: "running",
          kimi_session_id: "session-sigkill",
          agent_profile: "read-only",
          prompt_digest: "digest",
          summary: "Running review gate.",
          final_output_path: null,
          stream_log_path: path.join(
            paths.logsDir,
            "review-gate-job-review-gate-sigkill.jsonl",
          ),
          error: null,
        });
      } finally {
        store.close();
      }

      const start = Date.now();
      const output = JSON.parse(
        await runCancel(["job-review-gate-sigkill"], makeContext(repoRoot, env)),
      ) as { status: string; message: string };
      const elapsed = Date.now() - start;

      expect(output.status).toBe("cancelled");
      // The escalation window is 1s sleep between SIGTERM and SIGKILL.
      // Require at least 900ms to confirm the path actually waited rather
      // than short-circuiting on the pre-marked status.
      expect(elapsed).toBeGreaterThan(900);
      await waitForChildExit(child);
      // SIGKILL exit reports via signalCode (or exit code 137 / null exitCode + signalCode === 'SIGKILL').
      expect(child.signalCode).toBe("SIGKILL");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("cancel can force-cancel a foreground job with a recorded process", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("job-store-foreground-cancel");
    const repoRoot = await createTestPluginDataRoot("job-store-foreground-cancel-repo");
    const paths = resolvePluginPaths({ ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot });
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot };
    const child = spawnLongRunningProcess();

    try {
      await mkdir(paths.pluginRoot, { recursive: true });
      await mkdir(paths.logsDir, { recursive: true });
      await mkdir(paths.artifactsDir, { recursive: true });

      const store = new JobStore(paths);
      try {
        store.createJob({
          job_id: "job-foreground-cancel",
          repo_id: repoRoot,
          command_type: "review",
          cwd: repoRoot,
          model: null,
          thinking: null,
          background: false,
          pid: child.pid ?? null,
          kimi_pid: null,
          status: "running",
          kimi_session_id: "session-x",
          agent_profile: "read-only",
          prompt_digest: "digest",
          summary: "Running review.",
          final_output_path: null,
          stream_log_path: path.join(paths.logsDir, "review-job-foreground-cancel.jsonl"),
          error: null,
        });
      } finally {
        store.close();
      }

      const output = JSON.parse(await runCancel(["job-foreground-cancel"], makeContext(repoRoot, env))) as {
        status: string;
        message: string;
      };

      expect(output.status).toBe("cancelled");
      expect(output.message).toContain("Cancellation");
      await waitForChildExit(child);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });
});

function getJobTableColumns(dbPath: string): string[] {
  const db = new Database(dbPath);
  try {
    const columns = db.query("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
    return columns.map((column) => column.name);
  } finally {
    db.close();
  }
}

function findDefinitelyDeadPid(): number {
  for (let pid = 999_999; pid > 900_000; pid -= 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return pid;
      }
    }
  }

  throw new Error("Unable to find an unused pid for stale-job test.");
}

function spawnLongRunningProcess(): ChildProcess {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000);"], {
    stdio: "ignore",
  });
}

function spawnSigtermIgnoringProcess(): ChildProcess {
  // Long-running child that explicitly traps SIGTERM. Used to verify that
  // /kimi:cancel of a review_gate job escalates to SIGKILL when SIGTERM is
  // ignored — the v0.2.4 fix for the wait-loop-skips-escalation bug.
  return spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30_000);"],
    { stdio: "ignore" },
  );
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for child pid ${child.pid ?? "<unknown>"} to exit.`));
    }, 2_000);
    timer.unref();

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
