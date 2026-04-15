import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { runAsk } from "../../runtime/commands/ask.js";
import { runResult } from "../../runtime/commands/result.js";
import { runStatus } from "../../runtime/commands/status.js";
import { JobStore } from "../../runtime/job-store.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import type { CommandContext } from "../../runtime/types.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli.ts");

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
      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
      const sessionIndex = invocation.argv.indexOf("--session");
      const store = new JobStore(resolvePluginPaths(env));

      try {
        const storedJob = store.getJob(status.job_id);
        expect(storedJob?.kimi_session_id).toBe(invocation.argv[sessionIndex + 1]);
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

  test("0.1.4 migration reconciles orphaned duplicate running rows", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("job-store-migration");
    const paths = resolvePluginPaths({ ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot });

    try {
      await mkdir(paths.pluginRoot, { recursive: true });

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

        expect(newer?.status).toBe("running");
        expect(older?.status).toBe("failed");
        expect(older?.error?.code).toBe("JOB_STORE_ORPHANED_ON_UPGRADE");
        expect(other?.status).toBe("running");
      } finally {
        store.close();
      }
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });
});
