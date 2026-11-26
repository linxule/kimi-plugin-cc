import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";

import { JobStore } from "../../runtime/job-store.js";
import { ensurePluginPaths, resolvePluginPaths } from "../../runtime/paths.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

describe("job-store safety_profile column", () => {
  test("is added additively and leaves historical rows null", async () => {
    const root = await createTestPluginDataRoot("job-store-safety-profile");
    try {
      const paths = resolvePluginPaths({ ...process.env, KIMI_PLUGIN_CC_DATA: root });
      await ensurePluginPaths(paths);

      // Seed a pre-1.10 schema: every provenance column except safety_profile.
      const raw = new Database(paths.stateDbPath);
      try {
        raw.exec(`
          CREATE TABLE jobs (
            job_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, command_type TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, cwd TEXT NOT NULL,
            model TEXT, thinking INTEGER, background INTEGER NOT NULL, pid INTEGER, kimi_pid INTEGER,
            status TEXT NOT NULL, kimi_session_id TEXT, operation_kind TEXT, intended_engine TEXT,
            observed_engine TEXT, kimi_version TEXT, system_version TEXT, kimi_command TEXT,
            kimi_prefix_args TEXT, plan_certification TEXT, resumed_from_job_id TEXT,
            agent_profile TEXT NOT NULL, prompt_digest TEXT NOT NULL, summary TEXT NOT NULL,
            phase TEXT, final_output_path TEXT, stream_log_path TEXT NOT NULL, error TEXT
          );
          INSERT INTO jobs (job_id, repo_id, command_type, created_at, updated_at, cwd, background, status,
            operation_kind, intended_engine, observed_engine, kimi_version, kimi_command, kimi_prefix_args,
            plan_certification, agent_profile, prompt_digest, summary, stream_log_path)
          VALUES ('old-1', 'repo', 'ask', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', '/tmp', 0, 'completed',
            'ask', 'native-v2', 'native-v2', '0.42.0', '/usr/bin/kimi', '[]',
            'certified', 'read-only', 'd', 's', '/tmp/log.jsonl');
        `);
      } finally {
        raw.close();
      }

      const store = new JobStore(paths);
      try {
        const old = store.getJob("old-1");
        expect(old?.safety_profile).toBeNull();
        expect(old?.budget_ms).toBeNull();
        expect(old?.budget_source).toBeNull();
        expect(old?.kimi_session_id_source).toBeNull();
        expect(old?.updated_at).toBe("2026-09-01T00:00:00Z");

        const created = store.createJob({
          job_id: "new-1",
          repo_id: "repo",
          command_type: "ask",
          cwd: "/tmp",
          model: null,
          thinking: null,
          background: false,
          budget_ms: 2_700_000,
          budget_source: "explicit",
          pid: null,
          kimi_pid: null,
          status: "running",
          kimi_session_id: null,
          operation_kind: "ask",
          intended_engine: "native-v2",
          kimi_version: "2.8.0",
          kimi_command: "/usr/bin/kimi",
          kimi_prefix_args: "[]",
          plan_certification: "certified",
          safety_profile: "native-v2-no-plan/1",
          agent_profile: "read-only",
          prompt_digest: "d",
          summary: "s",
          final_output_path: null,
          stream_log_path: path.join(root, "log.jsonl"),
          error: null,
        });
        expect(created.budget_ms).toBe(2_700_000);
        expect(created.budget_source).toBe("explicit");
        const sessionId = "session_26242650-d95f-4805-80d9-c947d309b2c6";
        expect(store.claimRecoveredSessionId("new-1", sessionId)?.kimi_session_id_source).toBe("recovered_session_dir");
        store.createJob({ ...created, job_id: "new-2" });
        // Models a second worker whose earlier scan found the same candidate.
        expect(store.claimRecoveredSessionId("new-2", sessionId)).toBeNull();
        expect(store.getJob("new-2")?.kimi_session_id).toBeNull();
        expect(store.getJob("new-1")?.budget_ms).toBe(2_700_000);
        expect(created.safety_profile).toBe("native-v2-no-plan/1");
        expect(store.getJob("new-1")?.safety_profile).toBe("native-v2-no-plan/1");
      } finally {
        store.close();
      }
    } finally {
      await cleanupTestPath(root);
    }
  });
});
