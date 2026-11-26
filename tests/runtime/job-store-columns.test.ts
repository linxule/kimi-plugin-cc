import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { JobStore, parseJobWarnings, type CreateJobInput } from "../../runtime/job-store.js";
import { ensurePluginPaths, resolvePluginPaths } from "../../runtime/paths.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

const LEGACY_SCHEMA = `
  CREATE TABLE jobs (job_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, command_type TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, cwd TEXT NOT NULL, model TEXT, thinking INTEGER,
    background INTEGER NOT NULL, pid INTEGER, kimi_pid INTEGER, status TEXT NOT NULL, kimi_session_id TEXT,
    agent_profile TEXT NOT NULL, prompt_digest TEXT NOT NULL, summary TEXT NOT NULL, final_output_path TEXT,
    stream_log_path TEXT NOT NULL, error TEXT);
  CREATE TABLE mcp_tasks (task_id TEXT PRIMARY KEY, operation_kind TEXT NOT NULL, repo_id TEXT NOT NULL,
    workspace_cwd TEXT NOT NULL, companion_pid INTEGER, companion_identity TEXT, stdout_path TEXT NOT NULL,
    stderr_path TEXT NOT NULL, launch_state TEXT NOT NULL, launch_error TEXT, created_at TEXT NOT NULL,
    attached_at TEXT, updated_at TEXT NOT NULL);
`;

const FULL_INPUT: CreateJobInput = {
  job_id: "job-full", repo_id: "repo", command_type: "rescue", cwd: "/w", model: "m", thinking: true,
  thinking_effort: "high", background: true, pid: 11, kimi_pid: 12, status: "running",
  kimi_session_id: "sess-full", kimi_session_id_source: "announced", operation_kind: "rescue",
  intended_engine: "native-v2", observed_engine: "native-v2", kimi_version: "1.2.3", system_version: "sv",
  kimi_command: "kimi", kimi_prefix_args: "[\"a\"]", plan_certification: "certified", resumed_from_job_id: "prev",
  safety_profile: "workspace-write" as CreateJobInput["safety_profile"], agent_profile: "<cli-client>",
  prompt_digest: "d", summary: "s", phase: "starting", budget_ms: 1000, budget_source: "explicit",
  final_output_path: null, stream_log_path: "/l", error: null,
};

function columns(dbPath: string, table: string): string[] {
  const db = new Database(dbPath);
  try {
    return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>)
      .map((column) => `${column.name} ${column.type}`);
  } finally {
    db.close();
  }
}

function rawRow(dbPath: string, jobId: string): Record<string, unknown> {
  const db = new Database(dbPath);
  try {
    const { created_at: _c, updated_at: _u, ...row } = db.query("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as Record<string, unknown>;
    return row;
  } finally {
    db.close();
  }
}

describe("job-store column handling", () => {
  test("legacy migration appends columns in a fixed order", async () => {
    const root = await createTestPluginDataRoot("job-store-columns-legacy");
    try {
      const paths = resolvePluginPaths({ ...process.env, KIMI_PLUGIN_CC_DATA: root });
      await ensurePluginPaths(paths);
      const seed = new Database(paths.stateDbPath);
      seed.exec(LEGACY_SCHEMA);
      seed.close();

      new JobStore(paths).close();
      new JobStore(paths).close();

      expect(columns(paths.stateDbPath, "jobs")).toEqual([
        "job_id TEXT", "repo_id TEXT", "command_type TEXT", "created_at TEXT", "updated_at TEXT", "cwd TEXT",
        "model TEXT", "thinking INTEGER", "background INTEGER", "pid INTEGER", "kimi_pid INTEGER", "status TEXT",
        "kimi_session_id TEXT", "agent_profile TEXT", "prompt_digest TEXT", "summary TEXT",
        "final_output_path TEXT", "stream_log_path TEXT", "error TEXT",
        "phase TEXT", "budget_ms INTEGER", "kimi_session_id_source TEXT", "budget_source TEXT",
        "thinking_effort TEXT", "hook_escapes TEXT", "operation_kind TEXT", "intended_engine TEXT",
        "observed_engine TEXT", "kimi_version TEXT", "system_version TEXT", "kimi_command TEXT",
        "kimi_prefix_args TEXT", "plan_certification TEXT", "resumed_from_job_id TEXT", "safety_profile TEXT",
        "warnings TEXT", "read_scope TEXT", "companion_identity TEXT", "kimi_identity TEXT",
      ]);
      expect(columns(paths.stateDbPath, "mcp_tasks").at(-1)).toBe("kimi_identity TEXT");
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("create, update and terminal marks store the same values", async () => {
    const root = await createTestPluginDataRoot("job-store-columns-rows");
    try {
      const paths = resolvePluginPaths({ ...process.env, KIMI_PLUGIN_CC_DATA: root });
      await ensurePluginPaths(paths);
      const store = new JobStore(paths);
      try {
        store.createJob(FULL_INPUT);
        expect(rawRow(paths.stateDbPath, "job-full")).toEqual({
          job_id: "job-full", repo_id: "repo", command_type: "rescue", cwd: "/w", model: "m", thinking: 1,
          background: 1, pid: 11, kimi_pid: 12, status: "running", kimi_session_id: "sess-full",
          operation_kind: "rescue", intended_engine: "native-v2", observed_engine: "native-v2",
          kimi_version: "1.2.3", system_version: "sv", kimi_command: "kimi", kimi_prefix_args: "[\"a\"]",
          plan_certification: "certified", resumed_from_job_id: "prev", safety_profile: "workspace-write",
          agent_profile: "<cli-client>", prompt_digest: "d", summary: "s", phase: "starting", budget_ms: 1000,
          final_output_path: null, stream_log_path: "/l", error: null, kimi_session_id_source: "announced",
          budget_source: "explicit", thinking_effort: "high", hook_escapes: null, warnings: null,
          read_scope: null, companion_identity: null, kimi_identity: null,
        });
        // A warning-free row keeps its historical JobRecord shape.
        expect(Object.keys(store.getJob("job-full")!)).not.toContain("warnings");

        // Protected and unknown keys are ignored; undefined values leave the column unchanged.
        store.updateRunningJob("job-full", {
          job_id: "hijack", created_at: "x", updated_at: "y", phase: "turn-running", model: undefined,
          thinking: false, error: { code: "E", message: "m", stage: "s" }, hook_escapes: "[2]",
          ...({ bogus: 1 } as object),
        });
        expect(rawRow(paths.stateDbPath, "job-full")).toMatchObject({
          job_id: "job-full", model: "m", thinking: 0, phase: "turn-running", hook_escapes: "[2]",
          error: "{\"code\":\"E\",\"message\":\"m\",\"stage\":\"s\"}",
        });
        expect(store.getJob("hijack")).toBeNull();

        // A patch cannot override the terminal status, and terminal rows never change again.
        const completed = store.markCompleted("job-full", {
          summary: "done", final_output_path: "/a", error: null, status: "failed",
        });
        expect(completed).toMatchObject({ status: "completed", pid: null, kimi_pid: null, summary: "done" });
        expect(store.markFailed("job-full", { summary: "late", error: null })?.status).toBe("completed");
        expect(store.markCancelled("job-full", { summary: "late", error: null })?.summary).toBe("done");
        expect(store.updateRunningJob("job-full", { phase: "late" })?.phase).toBe("turn-running");

        store.createJob({ ...FULL_INPUT, job_id: "job-ask", command_type: "ask", kimi_session_id: "sess-ask" });
        expect(store.markFailed("job-ask", { summary: "f", error: null })).toMatchObject({ status: "failed", pid: null });
        expect(store.findAskJobBySession("repo", "sess-ask")?.job_id).toBe("job-ask");
        expect(store.findAskJobBySession("repo", "sess-full")).toBeNull();
        expect(store.findRescueJobBySession("repo", "sess-full")?.job_id).toBe("job-full");
        expect(store.findRescueJobBySession("repo", "sess-ask")).toBeNull();
      } finally {
        store.close();
      }
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("launch warnings persist as a JSON array and parse defensively", async () => {
    const root = await createTestPluginDataRoot("job-store-columns-warnings");
    try {
      const paths = resolvePluginPaths({ ...process.env, KIMI_PLUGIN_CC_DATA: root });
      await ensurePluginPaths(paths);
      const store = new JobStore(paths);
      try {
        const warnings = JSON.stringify(["first", "second"]);
        store.createJob({ ...FULL_INPUT, job_id: "job-warned", warnings });
        expect(rawRow(paths.stateDbPath, "job-warned").warnings).toBe(warnings);
        expect(store.getJob("job-warned")?.warnings).toBe(warnings);
        expect(parseJobWarnings(store.getJob("job-warned")?.warnings)).toEqual(["first", "second"]);
      } finally {
        store.close();
      }
    } finally {
      await cleanupTestPath(root);
    }
    expect(parseJobWarnings(null)).toEqual([]);
    expect(parseJobWarnings("not json")).toEqual([]);
    expect(parseJobWarnings('{"a":1}')).toEqual([]);
    expect(parseJobWarnings('["ok", 3, null]')).toEqual(["ok"]);
  });
});
