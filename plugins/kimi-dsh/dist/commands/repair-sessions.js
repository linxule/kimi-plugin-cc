import { REPAIR_SESSIONS_SUPPORTED_FLAGS } from "../parsing.js";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { digestPrompt } from "../jobs.js";
import { resolvePluginPaths } from "../paths.js";
import { syncKimiSessionTitle } from "../session-title.js";
// Repair is deliberately finite and local. Stream logs may be very large, but
// the spawn record follows the invocation header: read only a bounded prefix.
const MAX_JOBS = 1000;
const MAX_SPAWN_BYTES = 2 * 1024 * 1024;
export async function runRepairSessions(argv, context) {
    const seen = new Set();
    for (const arg of argv) {
        if ((arg !== "--apply" && arg !== "--all") || seen.has(arg)) {
            throw new RuntimeError("INVALID_ARGS", `Usage: repair-sessions. Supported flags: ${REPAIR_SESSIONS_SUPPORTED_FLAGS}.`, "repair-sessions.args");
        }
        seen.add(arg);
    }
    const apply = seen.has("--apply");
    const all = seen.has("--all");
    const paths = resolvePluginPaths(context.env);
    const repoId = all ? undefined : (await resolveRepoIdentity(context.cwd)).repoId;
    const jobs = await readRepairJobs(paths.stateDbPath, repoId);
    const sessions = new Set();
    const results = [];
    for (const job of jobs) {
        if (sessions.has(job.kimi_session_id))
            continue;
        sessions.add(job.kimi_session_id);
        const promptText = await readVerifiedPrompt(job, paths.logsDir, paths.worktreesDir);
        const status = promptText === undefined
            ? "unavailable-verified-prompt"
            : await syncKimiSessionTitle({
                env: context.env,
                cwd: job.cwd,
                sessionId: job.kimi_session_id,
                title: "",
                promptText,
                dryRun: !apply,
                preserveTitle: true,
                requireNativeV2: true,
                stderr: context.stderr,
            });
        results.push({ job_id: job.job_id, session_id: job.kimi_session_id, status });
    }
    const counts = {};
    for (const { status } of results)
        counts[status] = (counts[status] ?? 0) + 1;
    return `${JSON.stringify({ mode: apply ? "apply" : "dry-run", scope: all ? "host" : "repository", sessions: results.length, counts, results }, null, 2)}\n`;
}
async function readRepairJobs(filename, repoId) {
    try {
        const stats = await lstat(filename);
        if (!stats.isFile() || stats.isSymbolicLink()) {
            throw new RuntimeError("SESSION_REPAIR_UNSAFE_STORE", "Repair requires a regular, non-symlink job database.", "repair-sessions.store");
        }
    }
    catch (error) {
        if (error.code === "ENOENT")
            return [];
        throw error;
    }
    const require = createRequire(import.meta.url);
    // Bind constructors before `new`: compiler emission must not turn the
    // module-loader call into the constructor (new require(...).Database).
    const db = (() => {
        if (typeof Bun !== "undefined") {
            const { Database } = require("bun:sqlite");
            return new Database(filename, { readonly: true });
        }
        const { DatabaseSync } = require("node:sqlite");
        return new DatabaseSync(filename, { readOnly: true });
    })();
    try {
        // Never construct JobStore here: it performs migrations and stale-row
        // reconciliation. Both preview and apply keep plugin job data read-only.
        const columns = db.prepare("PRAGMA table_info(jobs)").all();
        const names = new Set(columns.map((column) => column.name));
        const required = ["job_id", "repo_id", "command_type", "operation_kind", "status", "kimi_session_id", "cwd", "kimi_version", "intended_engine", "observed_engine", "stream_log_path", "prompt_digest", "updated_at"];
        if (required.some((name) => !names.has(name)))
            return [];
        const rows = db.prepare(`
      SELECT j.job_id, j.repo_id, j.operation_kind, j.kimi_session_id, j.cwd, j.kimi_version, j.stream_log_path, j.prompt_digest
      FROM jobs j
      WHERE j.status = 'completed' AND j.intended_engine = 'native-v2' AND j.observed_engine = 'native-v2'
        AND j.command_type != 'review_gate'
        AND j.operation_kind IN ('ask', 'review', 'challenge', 'rescue', 'pursue', 'swarm', 'swarm-write')
        AND j.kimi_session_id IS NOT NULL AND length(trim(j.kimi_session_id)) > 0
        AND j.kimi_version IS NOT NULL
        ${repoId === undefined ? "" : "AND j.repo_id = ?"}
        AND NOT EXISTS (SELECT 1 FROM jobs active WHERE active.kimi_session_id = j.kimi_session_id AND active.status = 'running')
      ORDER BY j.updated_at DESC, j.job_id DESC LIMIT ${MAX_JOBS + 1}
    `).all(...(repoId === undefined ? [] : [repoId]));
        if (rows.length > MAX_JOBS) {
            throw new RuntimeError("SESSION_REPAIR_LIMIT", `More than ${MAX_JOBS} eligible jobs; narrow the repair to one repository.`, "repair-sessions.store");
        }
        return rows;
    }
    finally {
        db.close();
    }
}
async function readVerifiedPrompt(job, logsDir, worktreesDir) {
    // All plugin stream logs are direct children. Refuse nested/escaped paths,
    // symlinks and special files; opening nonblocking avoids FIFO hangs.
    if (!path.isAbsolute(job.stream_log_path) || path.dirname(job.stream_log_path) !== logsDir)
        return undefined;
    try {
        const root = await lstat(logsDir);
        if (!root.isDirectory() || root.isSymbolicLink())
            return undefined;
        const file = await open(job.stream_log_path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const stats = await file.stat();
            if (!stats.isFile())
                return undefined;
            const buffer = Buffer.alloc(MAX_SPAWN_BYTES + 1);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
            const prefix = buffer.subarray(0, bytesRead).toString("utf8");
            const lines = prefix.split("\n");
            // A prefix cut mid-record must never be treated as a complete JSON line.
            if (bytesRead > MAX_SPAWN_BYTES)
                lines.pop();
            for (const line of lines.slice(0, 32)) {
                if (!line.trim())
                    continue;
                const record = JSON.parse(line);
                if (record.event !== "spawn") {
                    if (record.direction === "meta")
                        continue;
                    return undefined;
                }
                const expectedCwd = job.operation_kind === "swarm-write"
                    ? path.join(worktreesDir, job.repo_id, `swarm-write-${job.job_id}`)
                    : job.cwd;
                if (record.intended_engine !== "native-v2" || record.kimi_version !== job.kimi_version ||
                    record.operation_kind !== job.operation_kind || record.cwd !== expectedCwd)
                    return undefined;
                if (!Array.isArray(record.args) || record.args.length < 2)
                    return undefined;
                const args = record.args;
                const prompt = args[args.length - 1];
                if (args[args.length - 2] !== "-p" || typeof prompt !== "string" || !prompt.trim())
                    return undefined;
                return digestPrompt(prompt) === job.prompt_digest ? prompt : undefined;
            }
            return undefined;
        }
        finally {
            await file.close();
        }
    }
    catch {
        return undefined;
    }
}
