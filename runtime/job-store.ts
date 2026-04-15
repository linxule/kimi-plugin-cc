import { createRequire } from "node:module";

import { RuntimeError, formatError } from "./errors.js";
import type { JobError, JobStatus, ManagedCommandType } from "./types.js";
import type { PluginPaths } from "./paths.js";

export interface JobRecord {
  job_id: string;
  repo_id: string;
  command_type: ManagedCommandType;
  created_at: string;
  updated_at: string;
  cwd: string;
  model: string | null;
  thinking: boolean | null;
  background: boolean;
  pid: number | null;
  kimi_pid: number | null;
  status: JobStatus;
  kimi_session_id: string | null;
  agent_profile: string;
  prompt_digest: string;
  summary: string;
  final_output_path: string | null;
  stream_log_path: string;
  error: JobError | null;
}

export interface CreateJobInput {
  job_id: string;
  repo_id: string;
  command_type: ManagedCommandType;
  cwd: string;
  model: string | null;
  thinking: boolean | null;
  background: boolean;
  pid: number | null;
  kimi_pid: number | null;
  status: JobStatus;
  kimi_session_id: string | null;
  agent_profile: string;
  prompt_digest: string;
  summary: string;
  final_output_path: string | null;
  stream_log_path: string;
  error: JobError | null;
}

export interface FindLatestJobOptions {
  repoId: string;
  commandType?: ManagedCommandType;
  terminalOnly?: boolean;
  runningOnly?: boolean;
}

export class JobStore {
  private readonly db: SqliteAdapter;

  constructor(paths: PluginPaths) {
    try {
      this.db = createSqliteAdapter(paths.stateDbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("busy_timeout = 5000");
    } catch (error) {
      throw translateSqliteError(error);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
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

      CREATE INDEX IF NOT EXISTS jobs_repo_updated_idx
        ON jobs (repo_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS jobs_repo_type_updated_idx
        ON jobs (repo_id, command_type, updated_at DESC);

      CREATE INDEX IF NOT EXISTS jobs_session_idx
        ON jobs (repo_id, kimi_session_id, updated_at DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS jobs_running_rescue_session_idx
        ON jobs (repo_id, kimi_session_id)
        WHERE status = 'running' AND command_type = 'rescue';
    `);
  }

  close(): void {
    this.db.close();
  }

  createJob(input: CreateJobInput): JobRecord {
    const now = new Date().toISOString();
    try {
      this.db.run(
        `
          INSERT INTO jobs (
            job_id, repo_id, command_type, created_at, updated_at, cwd, model, thinking,
            background, pid, kimi_pid, status, kimi_session_id, agent_profile, prompt_digest,
            summary, final_output_path, stream_log_path, error
          )
          VALUES (
            @job_id, @repo_id, @command_type, @created_at, @updated_at, @cwd, @model, @thinking,
            @background, @pid, @kimi_pid, @status, @kimi_session_id, @agent_profile, @prompt_digest,
            @summary, @final_output_path, @stream_log_path, @error
          )
        `,
        {
          ...serializeRecord(input),
          created_at: now,
          updated_at: now,
        },
      );
    } catch (error) {
      if (isSqliteConstraintError(error) && input.command_type === "rescue") {
        throw new RuntimeError(
          "RESCUE_ALREADY_RUNNING",
          `A rescue job for session ${input.kimi_session_id ?? "<unknown>"} is already running in this repo. Use /kimi:status to find it.`,
          "rescue.resume",
          error instanceof Error ? { cause: error } : undefined,
        );
      }
      throw translateSqliteError(error);
    }

    return this.getJob(input.job_id)!;
  }

  getJob(jobId: string): JobRecord | null {
    const row = this.db.get<DbRow>("SELECT * FROM jobs WHERE job_id = ?", jobId);
    return row ? hydrateRow(row) : null;
  }

  findLatestJob(options: FindLatestJobOptions): JobRecord | null {
    const conditions = ["repo_id = @repo_id"];
    const params: Record<string, unknown> = {
      repo_id: options.repoId,
    };

    if (options.commandType) {
      conditions.push("command_type = @command_type");
      params.command_type = options.commandType;
    }

    if (options.terminalOnly) {
      conditions.push("status IN ('completed', 'failed', 'cancelled')");
    }

    if (options.runningOnly) {
      conditions.push("status = 'running'");
    }

    const row = this.db.get<DbRow>(
      `SELECT * FROM jobs WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC LIMIT 1`,
      params,
    );

    return row ? hydrateRow(row) : null;
  }

  listRunningBackgroundJobs(): JobRecord[] {
    const rows = this.db.all<DbRow>(
      `SELECT * FROM jobs WHERE status = 'running' AND background = 1 AND pid IS NOT NULL`,
    );
    return rows.map(hydrateRow);
  }

  findRescueJobBySession(repoId: string, sessionId: string): JobRecord | null {
    const row = this.db.get<DbRow>(
      `
        SELECT *
        FROM jobs
        WHERE repo_id = ?
          AND command_type = 'rescue'
          AND kimi_session_id = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      repoId,
      sessionId,
    );

    return row ? hydrateRow(row) : null;
  }

  updateRunningJob(jobId: string, patch: Partial<JobRecord>): JobRecord | null {
    return this.updateWhere(jobId, patch, "status = 'running'");
  }

  markCompleted(
    jobId: string,
    patch: Pick<JobRecord, "summary" | "final_output_path" | "error"> & Partial<JobRecord>,
  ): JobRecord | null {
    return this.updateWhere(jobId, { ...patch, status: "completed", pid: null, kimi_pid: null }, "status = 'running'");
  }

  markFailed(
    jobId: string,
    patch: Pick<JobRecord, "summary" | "error"> & Partial<JobRecord>,
  ): JobRecord | null {
    return this.updateWhere(jobId, { ...patch, status: "failed", pid: null, kimi_pid: null }, "status = 'running'");
  }

  markCancelled(
    jobId: string,
    patch: Pick<JobRecord, "summary" | "error"> & Partial<JobRecord>,
  ): JobRecord | null {
    return this.updateWhere(jobId, { ...patch, status: "cancelled", pid: null, kimi_pid: null }, "status = 'running'");
  }

  private updateWhere(jobId: string, patch: Partial<JobRecord>, whereClause?: string): JobRecord | null {
    const updates: string[] = ["updated_at = @updated_at"];
    const params: Record<string, unknown> = {
      job_id: jobId,
      updated_at: new Date().toISOString(),
    };

    for (const [key, value] of Object.entries(serializePatch(patch))) {
      if (key === "job_id" || key === "created_at" || key === "updated_at" || value === undefined) {
        continue;
      }
      updates.push(`${key} = @${key}`);
      params[key] = value;
    }

    const statement = `
      UPDATE jobs
      SET ${updates.join(", ")}
      WHERE job_id = @job_id${whereClause ? ` AND ${whereClause}` : ""}
    `;

    this.db.run(statement, params);
    return this.getJob(jobId);
  }
}

interface SqliteAdapter {
  pragma(statement: string): void;
  exec(statement: string): void;
  run(statement: string, params?: Record<string, unknown> | unknown[]): void;
  get<T>(statement: string, ...params: unknown[]): T | undefined;
  all<T>(statement: string, ...params: unknown[]): T[];
  close(): void;
}

interface DbRow {
  job_id: string;
  repo_id: string;
  command_type: ManagedCommandType;
  created_at: string;
  updated_at: string;
  cwd: string;
  model: string | null;
  thinking: number | null;
  background: number;
  pid: number | null;
  kimi_pid: number | null;
  status: JobStatus;
  kimi_session_id: string | null;
  agent_profile: string;
  prompt_digest: string;
  summary: string;
  final_output_path: string | null;
  stream_log_path: string;
  error: string | null;
}

function hydrateRow(row: DbRow): JobRecord {
  return {
    ...row,
    thinking: row.thinking === null ? null : Boolean(row.thinking),
    background: Boolean(row.background),
    error: row.error ? (JSON.parse(row.error) as JobError) : null,
  };
}

function serializeRecord(record: CreateJobInput): Record<string, unknown> {
  return {
    ...record,
    thinking: record.thinking === null ? null : Number(record.thinking),
    background: Number(record.background),
    error: record.error ? JSON.stringify(record.error) : null,
  };
}

function serializePatch(patch: Partial<JobRecord>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(patch)) {
    if (key === "thinking") {
      result[key] = value === null ? null : Number(Boolean(value));
      continue;
    }

    if (key === "background") {
      result[key] = Number(Boolean(value));
      continue;
    }

    if (key === "error") {
      result[key] = value ? JSON.stringify(value) : null;
      continue;
    }

    result[key] = value;
  }

  return result;
}

function createSqliteAdapter(filename: string): SqliteAdapter {
  const require = createRequire(import.meta.url);

  if (typeof Bun !== "undefined") {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(filename);
    return {
      pragma(statement) {
        db.exec(`PRAGMA ${statement}`);
      },
      exec(statement) {
        db.exec(statement);
      },
      run(statement, params) {
        const query = db.query(rewriteNamedParamsForBun(statement)) as {
          run: (...bindings: unknown[]) => unknown;
        };
        if (Array.isArray(params)) {
          query.run(...params);
          return;
        }

        query.run(rewriteNamedBindingsForBun((params ?? {}) as Record<string, unknown>));
      },
      get<T>(statement: string, ...params: unknown[]) {
        const query = db.query(rewriteNamedParamsForBun(statement)) as {
          get: (...bindings: unknown[]) => unknown;
        };
        if (params.length === 1) {
          const first = params[0];
          return query.get(
            typeof first === "object" && first !== null && !Array.isArray(first)
              ? rewriteNamedBindingsForBun(first as Record<string, unknown>)
              : first,
          ) as unknown as T | undefined;
        }

        return query.get(...params) as unknown as T | undefined;
      },
      all<T>(statement: string, ...params: unknown[]) {
        const query = db.query(rewriteNamedParamsForBun(statement)) as {
          all: (...bindings: unknown[]) => unknown[];
        };
        if (params.length === 1) {
          const first = params[0];
          return query.all(
            typeof first === "object" && first !== null && !Array.isArray(first)
              ? rewriteNamedBindingsForBun(first as Record<string, unknown>)
              : first,
          ) as unknown as T[];
        }

        return query.all(...params) as unknown as T[];
      },
      close() {
        db.close();
      },
    };
  }

  const BetterSqlite3 = require("better-sqlite3") as typeof import("better-sqlite3");
  const db = new BetterSqlite3(filename);
  return {
    pragma(statement) {
      db.pragma(statement);
    },
    exec(statement) {
      db.exec(statement);
    },
    run(statement, params) {
      db.prepare(statement).run(params ?? {});
    },
    get<T>(statement: string, ...params: unknown[]) {
      return db.prepare(statement).get(...params) as T | undefined;
    },
    all<T>(statement: string, ...params: unknown[]) {
      return db.prepare(statement).all(...params) as T[];
    },
    close() {
      db.close();
    },
  };
}

function rewriteNamedParamsForBun(statement: string): string {
  return statement.replaceAll(/@([A-Za-z0-9_]+)/g, (_, key: string) => `$${key}`);
}

function rewriteNamedBindingsForBun(bindings: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(bindings).map(([key, value]) => [`$${key}`, value]));
}

function isSqliteConstraintError(error: unknown): boolean {
  const message = formatError(error).toLowerCase();
  return message.includes("unique constraint") || message.includes("constraint failed");
}

function isSqliteBusyError(error: unknown): boolean {
  const message = formatError(error).toLowerCase();
  return message.includes("database is locked") || message.includes("busy");
}

function translateSqliteError(error: unknown): RuntimeError {
  if (isSqliteBusyError(error)) {
    return new RuntimeError(
      "JOB_STORE_BUSY",
      "The plugin job store is locked by another process. Wait a moment and retry, or check for stuck rescue workers with /kimi:status.",
      "job-store",
      error instanceof Error ? { cause: error } : undefined,
    );
  }
  if (error instanceof RuntimeError) {
    return error;
  }
  return new RuntimeError(
    "JOB_STORE_ERROR",
    `Job store operation failed: ${formatError(error)}`,
    "job-store",
    error instanceof Error ? { cause: error } : undefined,
  );
}
