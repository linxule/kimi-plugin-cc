import { createRequire } from "node:module";
import { RuntimeError, formatError } from "./errors.js";
export class JobStore {
    db;
    constructor(paths) {
        try {
            this.db = createSqliteAdapter(paths.stateDbPath);
            this.db.pragma("journal_mode = WAL");
            this.db.pragma("busy_timeout = 5000");
        }
        catch (error) {
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
    close() {
        this.db.close();
    }
    createJob(input) {
        const now = new Date().toISOString();
        try {
            this.db.run(`
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
        `, {
                ...serializeRecord(input),
                created_at: now,
                updated_at: now,
            });
        }
        catch (error) {
            if (isSqliteConstraintError(error) && input.command_type === "rescue") {
                throw new RuntimeError("RESCUE_ALREADY_RUNNING", `A rescue job for session ${input.kimi_session_id ?? "<unknown>"} is already running in this repo. Use /kimi:status to find it.`, "rescue.resume", error instanceof Error ? { cause: error } : undefined);
            }
            throw translateSqliteError(error);
        }
        return this.getJob(input.job_id);
    }
    getJob(jobId) {
        const row = this.db.get("SELECT * FROM jobs WHERE job_id = ?", jobId);
        return row ? hydrateRow(row) : null;
    }
    findLatestJob(options) {
        const conditions = ["repo_id = @repo_id"];
        const params = {
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
        const row = this.db.get(`SELECT * FROM jobs WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC LIMIT 1`, params);
        return row ? hydrateRow(row) : null;
    }
    listRunningBackgroundJobs() {
        const rows = this.db.all(`SELECT * FROM jobs WHERE status = 'running' AND background = 1 AND pid IS NOT NULL`);
        return rows.map(hydrateRow);
    }
    findRescueJobBySession(repoId, sessionId) {
        const row = this.db.get(`
        SELECT *
        FROM jobs
        WHERE repo_id = ?
          AND command_type = 'rescue'
          AND kimi_session_id = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `, repoId, sessionId);
        return row ? hydrateRow(row) : null;
    }
    updateRunningJob(jobId, patch) {
        return this.updateWhere(jobId, patch, "status = 'running'");
    }
    markCompleted(jobId, patch) {
        return this.updateWhere(jobId, { ...patch, status: "completed", pid: null, kimi_pid: null }, "status = 'running'");
    }
    markFailed(jobId, patch) {
        return this.updateWhere(jobId, { ...patch, status: "failed", pid: null, kimi_pid: null }, "status = 'running'");
    }
    markCancelled(jobId, patch) {
        return this.updateWhere(jobId, { ...patch, status: "cancelled", pid: null, kimi_pid: null }, "status = 'running'");
    }
    updateWhere(jobId, patch, whereClause) {
        const updates = ["updated_at = @updated_at"];
        const params = {
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
function hydrateRow(row) {
    return {
        ...row,
        thinking: row.thinking === null ? null : Boolean(row.thinking),
        background: Boolean(row.background),
        error: row.error ? JSON.parse(row.error) : null,
    };
}
function serializeRecord(record) {
    return {
        ...record,
        thinking: record.thinking === null ? null : Number(record.thinking),
        background: Number(record.background),
        error: record.error ? JSON.stringify(record.error) : null,
    };
}
function serializePatch(patch) {
    const result = {};
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
function createSqliteAdapter(filename) {
    const require = createRequire(import.meta.url);
    if (typeof Bun !== "undefined") {
        const { Database } = require("bun:sqlite");
        const db = new Database(filename);
        return {
            pragma(statement) {
                db.exec(`PRAGMA ${statement}`);
            },
            exec(statement) {
                db.exec(statement);
            },
            run(statement, params) {
                const query = db.query(rewriteNamedParamsForBun(statement));
                if (Array.isArray(params)) {
                    query.run(...params);
                    return;
                }
                query.run(rewriteNamedBindingsForBun((params ?? {})));
            },
            get(statement, ...params) {
                const query = db.query(rewriteNamedParamsForBun(statement));
                if (params.length === 1) {
                    const first = params[0];
                    return query.get(typeof first === "object" && first !== null && !Array.isArray(first)
                        ? rewriteNamedBindingsForBun(first)
                        : first);
                }
                return query.get(...params);
            },
            all(statement, ...params) {
                const query = db.query(rewriteNamedParamsForBun(statement));
                if (params.length === 1) {
                    const first = params[0];
                    return query.all(typeof first === "object" && first !== null && !Array.isArray(first)
                        ? rewriteNamedBindingsForBun(first)
                        : first);
                }
                return query.all(...params);
            },
            close() {
                db.close();
            },
        };
    }
    const BetterSqlite3 = require("better-sqlite3");
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
        get(statement, ...params) {
            return db.prepare(statement).get(...params);
        },
        all(statement, ...params) {
            return db.prepare(statement).all(...params);
        },
        close() {
            db.close();
        },
    };
}
function rewriteNamedParamsForBun(statement) {
    return statement.replaceAll(/@([A-Za-z0-9_]+)/g, (_, key) => `$${key}`);
}
function rewriteNamedBindingsForBun(bindings) {
    return Object.fromEntries(Object.entries(bindings).map(([key, value]) => [`$${key}`, value]));
}
function isSqliteConstraintError(error) {
    const message = formatError(error).toLowerCase();
    return message.includes("unique constraint") || message.includes("constraint failed");
}
function isSqliteBusyError(error) {
    const message = formatError(error).toLowerCase();
    return message.includes("database is locked") || message.includes("busy");
}
function translateSqliteError(error) {
    if (isSqliteBusyError(error)) {
        return new RuntimeError("JOB_STORE_BUSY", "The plugin job store is locked by another process. Wait a moment and retry, or check for stuck rescue workers with /kimi:status.", "job-store", error instanceof Error ? { cause: error } : undefined);
    }
    if (error instanceof RuntimeError) {
        return error;
    }
    return new RuntimeError("JOB_STORE_ERROR", `Job store operation failed: ${formatError(error)}`, "job-store", error instanceof Error ? { cause: error } : undefined);
}
