import { createRequire } from "node:module";
import { RuntimeError, formatError } from "./errors.js";
export class JobStore {
    db;
    constructor(paths) {
        // v0.3.3 final audit (Claude H1.1 + Kimi defect HIGH #1): open the
        // adapter into a local before assigning to this.db so the catch
        // can release the handle even if pragma throws AFTER the adapter
        // opened. Pre-audit fix wrapped only the schema-migration block;
        // a `journal_mode = WAL` failure on a read-only mount would leak
        // the open handle because the constructor exits via throw before
        // `new JobStore` can return a reference for withJobStore to close.
        let db;
        try {
            db = createSqliteAdapter(paths.stateDbPath);
            db.pragma("journal_mode = WAL");
            db.pragma("busy_timeout = 5000");
        }
        catch (error) {
            try {
                db?.close();
            }
            catch {
                // Best-effort — original error takes priority over close failure.
            }
            throw translateSqliteError(error);
        }
        this.db = db;
        // v0.3.3 (Claude H1): every `this.db.exec` / `tableHasColumn` below can
        // throw on a corrupt DB, full disk, mid-migration failure, etc. Before
        // this wrap, a throw here leaked the SQLite handle because the
        // constructor exited with `this.db` open but the new JobStore reference
        // never reached the caller. Catch internally, close the adapter, and
        // rethrow the translated error so withJobStore's `store?.close()`
        // path doesn't end up as the only line of defense.
        try {
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
        phase TEXT,
        final_output_path TEXT,
        stream_log_path TEXT NOT NULL,
        error TEXT
      );
    `);
            if (!tableHasColumn(this.db, "phase")) {
                this.db.exec(`ALTER TABLE jobs ADD COLUMN phase TEXT;`);
            }
            this.db.exec(`

      CREATE INDEX IF NOT EXISTS jobs_repo_updated_idx
        ON jobs (repo_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS jobs_repo_type_updated_idx
        ON jobs (repo_id, command_type, updated_at DESC);

      CREATE INDEX IF NOT EXISTS jobs_session_idx
        ON jobs (repo_id, kimi_session_id, updated_at DESC);

      DROP INDEX IF EXISTS jobs_running_rescue_session_idx;

      -- Reconcile orphaned duplicate running rows before creating the unique
      -- partial index. A 0.1.3 database with a hard-crashed worker can contain
      -- multiple (repo_id, command_type, kimi_session_id) rows at status='running',
      -- which would fail the CREATE UNIQUE INDEX at open and brick the store.
      -- Keep the most recently updated row per group; mark the rest as failed.
      UPDATE jobs
      SET status = 'failed',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          error = COALESCE(
            error,
            '{"code":"JOB_STORE_ORPHANED_ON_UPGRADE","message":"Orphaned duplicate running job reconciled on 0.1.4 schema upgrade","stage":"job-store.migrate"}'
          )
      WHERE status = 'running'
        AND command_type IN ('rescue', 'ask')
        AND kimi_session_id IS NOT NULL
        AND rowid NOT IN (
          SELECT rowid FROM (
            SELECT rowid,
                   ROW_NUMBER() OVER (
                     PARTITION BY repo_id, command_type, kimi_session_id
                     ORDER BY updated_at DESC, rowid DESC
                   ) AS rn
            FROM jobs
            WHERE status = 'running'
              AND command_type IN ('rescue', 'ask')
              AND kimi_session_id IS NOT NULL
          )
          WHERE rn = 1
        );

      CREATE UNIQUE INDEX IF NOT EXISTS jobs_running_session_idx
        ON jobs (repo_id, command_type, kimi_session_id)
        WHERE status = 'running' AND command_type IN ('rescue', 'ask');

      -- 0.1.6 migration: rename adversarial_review to challenge
      UPDATE jobs SET command_type = 'challenge' WHERE command_type = 'adversarial_review';
    `);
        }
        catch (error) {
            // Migration failed — close the adapter so the OS handle is released
            // before propagating. Wrap close() in its own try so a double-fault
            // doesn't mask the original migration error.
            try {
                this.db.close();
            }
            catch {
                // intentionally swallow — original error takes priority
            }
            throw translateSqliteError(error);
        }
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
            summary, phase, final_output_path, stream_log_path, error
          )
          VALUES (
            @job_id, @repo_id, @command_type, @created_at, @updated_at, @cwd, @model, @thinking,
            @background, @pid, @kimi_pid, @status, @kimi_session_id, @agent_profile, @prompt_digest,
            @summary, @phase, @final_output_path, @stream_log_path, @error
          )
        `, {
                ...serializeRecord(input),
                created_at: now,
                updated_at: now,
            });
        }
        catch (error) {
            if (isSqliteConstraintError(error)) {
                if (input.command_type === "rescue") {
                    throw new RuntimeError("RESCUE_ALREADY_RUNNING", `A rescue job for session ${input.kimi_session_id ?? "<unknown>"} is already running in this repo. Use /kimi:status to find it.`, "rescue.resume", error instanceof Error ? { cause: error } : undefined);
                }
                if (input.command_type === "ask") {
                    throw new RuntimeError("ASK_ALREADY_RUNNING", `An ask session ${input.kimi_session_id ?? "<unknown>"} is already running in this repo. Use /kimi:status to find it.`, "ask.resume", error instanceof Error ? { cause: error } : undefined);
                }
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
    listRunningJobsWithProcessHints() {
        const rows = this.db.all(`SELECT * FROM jobs WHERE status = 'running' AND (pid IS NOT NULL OR kimi_pid IS NOT NULL)`);
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
    findAskJobBySession(repoId, sessionId) {
        const row = this.db.get(`
        SELECT *
        FROM jobs
        WHERE repo_id = ?
          AND command_type = 'ask'
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
    static JOBS_COLUMNS = new Set([
        "status", "summary", "phase", "pid", "kimi_pid",
        "final_output_path", "stream_log_path", "kimi_session_id",
        "error", "command_type", "prompt_digest", "repo_id",
        "cwd", "model", "thinking", "background", "agent_profile",
    ]);
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
            if (!JobStore.JOBS_COLUMNS.has(key))
                continue;
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
        phase: record.phase ?? null,
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
    // Node 22.5+ ships node:sqlite as a built-in. We use it via createRequire so the compiled
    // dist/ has zero native dependencies — no `bun install` step required for drop-in plugin
    // installs, no platform-specific compiled binaries to ship. See package.json engines.node.
    let nodeSqlite;
    try {
        nodeSqlite = require("node:sqlite");
    }
    catch (error) {
        throw new RuntimeError("JOB_STORE_UNSUPPORTED_RUNTIME", "kimi-plugin-cc requires Node >= 22.5 for its built-in node:sqlite module. Upgrade Node, or set KIMI_PLUGIN_CC_NODE_BIN to a qualifying binary.", "job-store", error instanceof Error ? { cause: error } : undefined);
    }
    const db = new nodeSqlite.DatabaseSync(filename);
    return {
        pragma(statement) {
            db.exec(`PRAGMA ${statement}`);
        },
        exec(statement) {
            db.exec(statement);
        },
        run(statement, params) {
            // Cast through `any` so the prepared-statement methods are called as methods (preserving
            // `this`). Pulling them off the instance via `const fn = stmt.run` strips the binding and
            // node:sqlite throws "Illegal invocation".
            const stmt = db.prepare(statement);
            if (Array.isArray(params)) {
                stmt.run(...params);
                return;
            }
            stmt.run(normalizeNodeSqliteBindings((params ?? {})));
        },
        get(statement, ...params) {
            const stmt = db.prepare(statement);
            if (params.length === 1 && isPlainObject(params[0])) {
                return stmt.get(normalizeNodeSqliteBindings(params[0]));
            }
            return stmt.get(...params);
        },
        all(statement, ...params) {
            const stmt = db.prepare(statement);
            if (params.length === 1 && isPlainObject(params[0])) {
                return stmt.all(normalizeNodeSqliteBindings(params[0]));
            }
            return stmt.all(...params);
        },
        close() {
            db.close();
        },
    };
}
// node:sqlite's prepared-statement binding API accepts objects whose keys omit the parameter
// prefix (so SQL `@job_id` binds from `{ job_id: ... }`). Normalize optional values to null,
// coerce booleans to 0/1, and fail fast on unsupported binding types before they reach the
// native layer as opaque SQLITE_MISMATCH errors.
function normalizeNodeSqliteBindings(bindings) {
    const result = {};
    for (const [key, value] of Object.entries(bindings)) {
        if (value === undefined) {
            result[key] = null;
            continue;
        }
        if (value === null) {
            result[key] = null;
            continue;
        }
        if (typeof value === "boolean") {
            result[key] = value ? 1 : 0;
            continue;
        }
        if (typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "bigint" ||
            value instanceof Uint8Array) {
            result[key] = value;
            continue;
        }
        throw new Error(`node:sqlite binding for ${key} has unsupported type ${typeof value} (${value?.constructor?.name ?? "unknown"})`);
    }
    return result;
}
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function rewriteNamedParamsForBun(statement) {
    return statement.replaceAll(/@([A-Za-z0-9_]+)/g, (_, key) => `$${key}`);
}
function rewriteNamedBindingsForBun(bindings) {
    return Object.fromEntries(Object.entries(bindings).map(([key, value]) => [`$${key}`, value]));
}
function tableHasColumn(db, columnName) {
    const columns = db.all(`PRAGMA table_info(jobs)`);
    return columns.some((column) => column.name === columnName);
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
/**
 * Run a function with a temporary `JobStore` whose handle is closed when
 * the function returns OR when the function throws after construction
 * succeeded.
 *
 * Note on construction failures (v0.3.3): if `new JobStore(paths)` itself
 * throws, this helper cannot close anything — the constructor's own
 * try/catch (lines 61–166) is what owns adapter-handle cleanup on
 * mid-migration failures. The helper handles the common case of "store
 * opened cleanly, function threw"; JobStore handles "open or migrate
 * failed mid-construction." Together they make the leak class
 * unreachable.
 *
 * Consolidates the repeated
 *
 *     const store = new JobStore(paths);
 *     try { ... } finally { store.close(); }
 *
 * dance that every command file used to copy. For the rare case where
 * the caller needs to keep a reference to the store past the function
 * body (e.g., async cancel handlers that close elsewhere), continue
 * using the explicit `new JobStore` + try/finally idiom — `withJobStore`
 * is for the common single-scope case.
 */
export async function withJobStore(paths, fn) {
    // v0.3.2: construct inside the try so a constructor throw that opens
    // the SQLite adapter and then fails during pragma/exec doesn't leak
    // the handle. Pre-v0.3.2 the JSDoc claimed this safety but `new
    // JobStore` lived above the try block.
    let store;
    try {
        store = new JobStore(paths);
        return await fn(store);
    }
    finally {
        store?.close();
    }
}
/** Synchronous companion to `withJobStore` for callers that don't await inside. */
export function withJobStoreSync(paths, fn) {
    let store;
    try {
        store = new JobStore(paths);
        return fn(store);
    }
    finally {
        store?.close();
    }
}
