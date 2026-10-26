import { createRequire } from "node:module";
import { RuntimeError, formatError } from "./errors.js";
export class JobStore {
    db;
    constructor(paths) {
        // Open the adapter into a local before assigning to this.db so the
        // catch can release the handle even if pragma throws AFTER the
        // adapter opened — `journal_mode = WAL` on a read-only mount, for
        // example, would otherwise leak the handle because the constructor
        // exits via throw before any caller reference exists for cleanup.
        let db;
        try {
            db = createSqliteAdapter(paths.stateDbPath);
            // busy_timeout FIRST: switching the journal mode takes a brief write lock,
            // and a second opener (status/result racing a worker) otherwise fails
            // immediately with SQLITE_BUSY instead of waiting (seen 2026-10-14).
            db.pragma("busy_timeout = 5000");
            db.pragma("journal_mode = WAL");
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
        // Every `this.db.exec` / `tableHasColumn` below can throw on a
        // corrupt DB, full disk, mid-migration failure, etc. Catch
        // internally, close the adapter, and rethrow the translated error
        // so the SQLite handle never leaks past a failed migration.
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
        operation_kind TEXT,
        intended_engine TEXT,
        observed_engine TEXT,
        kimi_version TEXT,
        system_version TEXT,
        kimi_command TEXT,
        kimi_prefix_args TEXT,
        plan_certification TEXT,
        resumed_from_job_id TEXT,
        safety_profile TEXT,
        agent_profile TEXT NOT NULL,
        prompt_digest TEXT NOT NULL,
        summary TEXT NOT NULL,
        phase TEXT,
        budget_ms INTEGER,
        final_output_path TEXT,
        stream_log_path TEXT NOT NULL,
        error TEXT
      );
    `);
            if (!tableHasColumn(this.db, "phase")) {
                this.db.exec(`ALTER TABLE jobs ADD COLUMN phase TEXT;`);
            }
            if (!tableHasColumn(this.db, "budget_ms")) {
                this.db.exec(`ALTER TABLE jobs ADD COLUMN budget_ms INTEGER;`);
            }
            for (const column of ["kimi_session_id_source", "budget_source", "thinking_effort", "hook_escapes"]) {
                if (!tableHasColumn(this.db, column)) {
                    this.db.exec("ALTER TABLE jobs ADD COLUMN " + column + " TEXT;");
                }
            }
            // Additive provenance migration. Existing rows deliberately remain NULL:
            // v1.9.5 plus kimi-code 0.33/0.34 could have routed to native v2 before the
            // legacy pin landed, so a blanket historical v1 backfill would invent fact.
            const provenanceColumns = [
                "operation_kind",
                "intended_engine",
                "observed_engine",
                "kimi_version",
                "system_version",
                "kimi_command",
                "kimi_prefix_args",
                "plan_certification",
                "resumed_from_job_id",
                "safety_profile",
            ];
            for (const column of provenanceColumns) {
                if (!tableHasColumn(this.db, column)) {
                    this.db.exec(`ALTER TABLE jobs ADD COLUMN ${column} TEXT;`);
                }
            }
            this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_tasks (
        task_id TEXT PRIMARY KEY,
        operation_kind TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        workspace_cwd TEXT NOT NULL,
        companion_pid INTEGER,
        companion_identity TEXT,
        kimi_identity TEXT,
        stdout_path TEXT NOT NULL,
        stderr_path TEXT NOT NULL,
        launch_state TEXT NOT NULL,
        launch_error TEXT,
        created_at TEXT NOT NULL,
        attached_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS mcp_tasks_workspace_updated_idx
        ON mcp_tasks (workspace_cwd, updated_at DESC);

      CREATE INDEX IF NOT EXISTS jobs_repo_updated_idx
        ON jobs (repo_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS swarm_recovery (job_id TEXT PRIMARY KEY, payload TEXT NOT NULL, recovery_owner TEXT);

      CREATE INDEX IF NOT EXISTS jobs_repo_type_updated_idx
        ON jobs (repo_id, command_type, updated_at DESC);

      CREATE INDEX IF NOT EXISTS jobs_session_id_idx ON jobs (kimi_session_id);

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
            if (!mcpTableHasColumn(this.db, "kimi_identity")) {
                this.db.exec("ALTER TABLE mcp_tasks ADD COLUMN kimi_identity TEXT;");
            }
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
    getSwarmRecovery(jobId) {
        const row = this.db.get("SELECT payload, recovery_owner FROM swarm_recovery WHERE job_id = ?", jobId);
        return row ? { record: JSON.parse(row.payload), owner: row.recovery_owner } : null;
    }
    saveSwarmRecovery(jobId, record) {
        this.db.run("INSERT INTO swarm_recovery (job_id, payload) VALUES (?, ?) ON CONFLICT(job_id) DO UPDATE SET payload = excluded.payload", [jobId, JSON.stringify(record)]);
    }
    claimSwarmRecovery(jobId, expected, owner) {
        this.db.run("UPDATE swarm_recovery SET recovery_owner = ? WHERE job_id = ? AND recovery_owner IS ?", [owner, jobId, expected]);
        return this.db.get("SELECT changes() AS count").count === 1;
    }
    close() {
        this.db.close();
    }
    createJob(input) {
        const now = new Date().toISOString();
        try {
            this.db.run(`
          INSERT INTO jobs (
            job_id, repo_id, command_type, created_at, updated_at, cwd, model, thinking, thinking_effort,
            background, pid, kimi_pid, status, kimi_session_id, kimi_session_id_source, budget_source,
            operation_kind, intended_engine, observed_engine, kimi_version, system_version,
            kimi_command, kimi_prefix_args, plan_certification, resumed_from_job_id, safety_profile,
            agent_profile, prompt_digest, summary, phase, budget_ms, final_output_path, stream_log_path, error
          )
          VALUES (
            @job_id, @repo_id, @command_type, @created_at, @updated_at, @cwd, @model, @thinking, @thinking_effort,
            @background, @pid, @kimi_pid, @status, @kimi_session_id, @kimi_session_id_source, @budget_source,
            @operation_kind, @intended_engine, @observed_engine, @kimi_version, @system_version,
            @kimi_command, @kimi_prefix_args, @plan_certification, @resumed_from_job_id, @safety_profile,
            @agent_profile, @prompt_digest, @summary, @phase, @budget_ms, @final_output_path, @stream_log_path, @error
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
    /** Global across repos and terminal states; optionally exclude the current row. */
    hasSessionId(sessionId, exceptJobId = "") {
        return Boolean(this.db.get("SELECT 1 FROM jobs WHERE kimi_session_id = ? AND job_id != ? LIMIT 1", sessionId, exceptJobId));
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
    createMcpTask(input) {
        const now = new Date().toISOString();
        try {
            this.db.run(`
        INSERT INTO mcp_tasks (
          task_id, operation_kind, repo_id, workspace_cwd, companion_pid, companion_identity, kimi_identity,
          stdout_path, stderr_path, launch_state, launch_error, created_at, attached_at, updated_at
        ) VALUES (
          @task_id, @operation_kind, @repo_id, @workspace_cwd, NULL, NULL, NULL,
          @stdout_path, @stderr_path, 'starting', NULL, @created_at, NULL, @updated_at
        )
      `, { ...input, created_at: now, updated_at: now });
        }
        catch (error) {
            throw translateSqliteError(error);
        }
        return this.getMcpTask(input.task_id);
    }
    getMcpTask(taskId) {
        return this.db.get("SELECT * FROM mcp_tasks WHERE task_id = ?", taskId) ?? null;
    }
    updateMcpTask(taskId, patch) {
        const updates = ["updated_at = @updated_at"];
        const params = { task_id: taskId, updated_at: new Date().toISOString() };
        for (const key of ["companion_pid", "companion_identity", "kimi_identity", "launch_state", "launch_error", "attached_at"]) {
            const value = patch[key];
            if (value === undefined)
                continue;
            updates.push(`${key} = @${key}`);
            params[key] = value;
        }
        this.db.run(`UPDATE mcp_tasks SET ${updates.join(", ")} WHERE task_id = @task_id`, params);
        return this.getMcpTask(taskId);
    }
    updateRunningJob(jobId, patch) {
        return this.updateWhere(jobId, patch, "status = 'running'");
    }
    /** Recheck uniqueness atomically: another worker can claim an ID during the
     * asynchronous directory scan. Ordinary announced/resumed IDs may be shared. */
    claimRecoveredSessionId(jobId, sessionId) {
        this.db.run(`UPDATE jobs
      SET kimi_session_id = @session_id, kimi_session_id_source = 'recovered_session_dir',
          updated_at = @updated_at
      WHERE job_id = @job_id AND status = 'running' AND kimi_session_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM jobs WHERE kimi_session_id = @session_id AND job_id != @job_id)`, { job_id: jobId, session_id: sessionId, updated_at: new Date().toISOString() });
        const job = this.getJob(jobId);
        return job?.status === "running" && job.kimi_session_id === sessionId &&
            job.kimi_session_id_source === "recovered_session_dir" ? job : null;
    }
    /**
     * Evidence-only backfill for pre-provenance rows. COALESCE prevents forensic
     * inspection from overwriting a field already recorded at execution time.
     * updated_at is intentionally unchanged so a status lookup cannot reorder
     * historical jobs merely because their logs were inspected.
     */
    backfillHistoricalProvenance(jobId, patch) {
        this.db.run(`
        UPDATE jobs
        SET operation_kind = COALESCE(operation_kind, @operation_kind),
            observed_engine = COALESCE(observed_engine, @observed_engine),
            kimi_version = COALESCE(kimi_version, @kimi_version),
            system_version = COALESCE(system_version, @system_version)
        WHERE job_id = @job_id
      `, {
            job_id: jobId,
            operation_kind: patch.operation_kind ?? null,
            observed_engine: patch.observed_engine ?? null,
            kimi_version: patch.kimi_version ?? null,
            system_version: patch.system_version ?? null,
        });
        return this.getJob(jobId);
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
        "status", "summary", "phase", "budget_ms", "budget_source", "kimi_session_id_source", "pid", "kimi_pid",
        "final_output_path", "stream_log_path", "kimi_session_id",
        "error", "command_type", "prompt_digest", "repo_id",
        "cwd", "model", "thinking", "thinking_effort", "hook_escapes", "background", "agent_profile",
        "operation_kind", "intended_engine", "observed_engine", "kimi_version",
        "system_version", "kimi_command", "kimi_prefix_args", "plan_certification",
        "resumed_from_job_id", "safety_profile",
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
        thinking_effort: record.thinking_effort ?? null,
        phase: record.phase ?? null,
        budget_ms: record.budget_ms ?? null,
        budget_source: record.budget_source ?? null,
        kimi_session_id_source: record.kimi_session_id_source ?? null,
        operation_kind: record.operation_kind ?? null,
        intended_engine: record.intended_engine ?? null,
        observed_engine: record.observed_engine ?? null,
        kimi_version: record.kimi_version ?? null,
        system_version: record.system_version ?? null,
        kimi_command: record.kimi_command ?? null,
        kimi_prefix_args: record.kimi_prefix_args ?? null,
        plan_certification: record.plan_certification ?? null,
        resumed_from_job_id: record.resumed_from_job_id ?? null,
        safety_profile: record.safety_profile ?? null,
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
function mcpTableHasColumn(db, columnName) {
    return db.all("PRAGMA table_info(mcp_tasks)").some((column) => column.name === columnName);
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
 * Run a function with a temporary `JobStore`, closing its handle on return or
 * throw after construction succeeds. The constructor owns cleanup when opening
 * or migrating the store fails.
 */
export async function withJobStore(paths, fn) {
    // Keep construction inside try: the constructor cleans up its own failures,
    // while this finally closes every successfully constructed store.
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
/** Parsed `hook_escapes` column for JSON envelopes: [] when NULL or unreadable. */
export function parseHookEscapes(raw) {
    if (!raw)
        return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
/** Old non-null budgets have unknown provenance; never invent explicit intent. */
export function renderBudgetSource(job) {
    return job.budget_source ?? (job.budget_ms === null ? "default" : "unknown");
}
