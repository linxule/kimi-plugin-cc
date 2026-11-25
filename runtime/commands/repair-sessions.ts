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
import type { CommandContext } from "../types.js";
import { askPromptSubject } from "./ask.js";
import { buildGoalPrompt } from "./pursue.js";
import { stripRescuePromptPrefix } from "./rescue.js";
import { buildSwarmPrompt, buildSwarmWritePrompt } from "./swarm.js";

// Repair is deliberately finite and local. Stream logs may be very large, but
// the spawn record follows the invocation header: read only a bounded prefix.
const MAX_JOBS = 1000;
const MAX_SPAWN_BYTES = 2 * 1024 * 1024;
interface RepairJob {
  job_id: string;
  repo_id: string;
  operation_kind: string;
  kimi_session_id: string;
  cwd: string;
  kimi_version: string;
  stream_log_path: string;
  prompt_digest: string;
}

export async function runRepairSessions(argv: string[], context: CommandContext): Promise<string> {
  const seen = new Set<string>();
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
  // Newest job first per session: it supplies the preview, while every
  // verified prompt of the session counts as the plugin's own.
  const sessions = new Map<string, RepairJob[]>();
  for (const job of jobs) {
    const sessionJobs = sessions.get(job.kimi_session_id);
    if (sessionJobs) sessionJobs.push(job);
    else sessions.set(job.kimi_session_id, [job]);
  }
  const results: Array<{ job_id: string; session_id: string; status: string }> = [];
  for (const [sessionId, [job, ...earlier]] of sessions) {
    const prompt = await readVerifiedPrompt(job!, paths.logsDir, paths.worktreesDir);
    let status: string = "unavailable-verified-prompt";
    if (prompt !== undefined) {
      const raw = rawTaskTextFromSubmittedPrompt(job!.operation_kind, prompt);
      const own = [prompt];
      if (raw !== undefined) {
        for (const other of earlier) {
          const otherPrompt = await readVerifiedPrompt(other, paths.logsDir, paths.worktreesDir);
          if (otherPrompt !== undefined) own.push(otherPrompt);
        }
      }
      status = await syncKimiSessionTitle({
        env: context.env,
        cwd: job!.cwd,
        sessionId,
        title: "",
        // Without an exact raw-text derivation, only a missing preview is
        // filled, with the verified prompt itself.
        promptText: raw ?? prompt,
        submittedPrompt: raw === undefined ? undefined : own,
        dryRun: !apply,
        preserveTitle: true,
        requireNativeV2: true,
        stderr: context.stderr,
      });
    }
    results.push({ job_id: job!.job_id, session_id: sessionId, status });
  }
  const counts: Record<string, number> = {};
  for (const { status } of results) counts[status] = (counts[status] ?? 0) + 1;
  return `${JSON.stringify({ mode: apply ? "apply" : "dry-run", scope: all ? "host" : "repository", sessions: results.length, counts, results }, null, 2)}\n`;
}

async function readRepairJobs(filename: string, repoId: string | undefined): Promise<RepairJob[]> {
  try {
    const stats = await lstat(filename);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new RuntimeError("SESSION_REPAIR_UNSAFE_STORE", "Repair requires a regular, non-symlink job database.", "repair-sessions.store");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const require = createRequire(import.meta.url);
  // Bind constructors before `new`: compiler emission must not turn the
  // module-loader call into the constructor (new require(...).Database).
  const db = (() => {
    if (typeof Bun !== "undefined") {
      const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
      return new Database(filename, { readonly: true });
    }
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    return new DatabaseSync(filename, { readOnly: true });
  })();
  try {
    // Never construct JobStore here: it performs migrations and stale-row
    // reconciliation. Both preview and apply keep plugin job data read-only.
    const columns = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    const required = ["job_id", "repo_id", "command_type", "operation_kind", "status", "kimi_session_id", "cwd", "kimi_version", "intended_engine", "observed_engine", "stream_log_path", "prompt_digest", "updated_at"];
    if (required.some((name) => !names.has(name))) return [];
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
    `).all(...(repoId === undefined ? [] : [repoId])) as unknown as RepairJob[];
    if (rows.length > MAX_JOBS) {
      throw new RuntimeError("SESSION_REPAIR_LIMIT", `More than ${MAX_JOBS} eligible jobs; narrow the repair to one repository.`, "repair-sessions.store");
    }
    return rows;
  } finally {
    db.close();
  }
}

async function readVerifiedPrompt(job: RepairJob, logsDir: string, worktreesDir: string): Promise<string | undefined> {
  // All plugin stream logs are direct children. Refuse nested/escaped paths,
  // symlinks and special files; opening nonblocking avoids FIFO hangs.
  if (!path.isAbsolute(job.stream_log_path) || path.dirname(job.stream_log_path) !== logsDir) return undefined;
  try {
    const root = await lstat(logsDir);
    if (!root.isDirectory() || root.isSymbolicLink()) return undefined;
    const file = await open(job.stream_log_path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stats = await file.stat();
      if (!stats.isFile()) return undefined;
      const buffer = Buffer.alloc(MAX_SPAWN_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const prefix = buffer.subarray(0, bytesRead).toString("utf8");
      const lines = prefix.split("\n");
      // A prefix cut mid-record must never be treated as a complete JSON line.
      if (bytesRead > MAX_SPAWN_BYTES) lines.pop();
      for (const line of lines.slice(0, 32)) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.event !== "spawn") {
          if (record.direction === "meta") continue;
          return undefined;
        }
        const expectedCwd = job.operation_kind === "swarm-write"
          ? path.join(worktreesDir, job.repo_id, `swarm-write-${job.job_id}`)
          : job.cwd;
        if (record.intended_engine !== "native-v2" || record.kimi_version !== job.kimi_version ||
          record.operation_kind !== job.operation_kind || record.cwd !== expectedCwd) return undefined;
        if (!Array.isArray(record.args) || record.args.length < 2) return undefined;
        const args = record.args;
        const prompt = args[args.length - 1];
        if (args[args.length - 2] !== "-p" || typeof prompt !== "string" || !prompt.trim()) return undefined;
        return digestPrompt(prompt) === job.prompt_digest ? prompt : undefined;
      }
      return undefined;
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

const TASK_SLOT = "\u0000kimi-plugin-cc-task\u0000";

/**
 * Recover the raw task text a live run previews from its verified submitted
 * prompt. Derivations are exact or absent: prompts from other plugin releases,
 * ambiguous parameter choices and unknown operations return undefined.
 */
export function rawTaskTextFromSubmittedPrompt(operationKind: string, prompt: string): string | undefined {
  switch (operationKind) {
    case "ask":
      return strippedOrUndefined(prompt, askPromptSubject(prompt));
    case "rescue":
      return strippedOrUndefined(prompt, stripRescuePromptPrefix(prompt));
    case "pursue":
      return uniqueInversion(prompt, [undefined, ...numbersAfter(prompt, /at most (\d+) turns/g)]
        .map((turns) => (task: string) => buildGoalPrompt(task, turns)));
    case "swarm":
    case "swarm-write": {
      const build = operationKind === "swarm" ? buildSwarmPrompt : buildSwarmWritePrompt;
      const caps = [undefined, ...numbersAfter(prompt, /at most (\d+) subagents/g)];
      const waves = [undefined, 1, ...numbersAfter(prompt, /at most (\d+) entries/g)];
      return uniqueInversion(prompt, caps.flatMap((cap) => waves.map((wave) => (task: string) => build(task, cap, wave))));
    }
    case "review":
    case "challenge":
      return reviewTaskText(prompt);
    default:
      return undefined;
  }
}

function strippedOrUndefined(prompt: string, stripped: string): string | undefined {
  return stripped !== prompt && stripped.trim() ? stripped : undefined;
}

function numbersAfter(prompt: string, pattern: RegExp): number[] {
  return [...new Set([...prompt.matchAll(pattern)].map((match) => Number(match[1])))];
}

/**
 * Split each candidate template around the task slot and require an exact
 * rebuild. The template explaining the most prompt text wins (without --turns
 * the turn guidance would otherwise read as objective); a tie is ambiguous.
 */
function uniqueInversion(prompt: string, builders: Array<(task: string) => string>): string | undefined {
  let found = new Set<string>();
  let bestTemplate = -1;
  for (const build of builders) {
    try {
      const template = build(TASK_SLOT);
      const at = template.indexOf(TASK_SLOT);
      if (at < 0) continue;
      const head = template.slice(0, at);
      const tail = template.slice(at + TASK_SLOT.length);
      if (prompt.length < head.length + tail.length || !prompt.startsWith(head) || !prompt.endsWith(tail)) continue;
      const task = prompt.slice(head.length, prompt.length - tail.length);
      if (!task.trim() || build(task) !== prompt || head.length + tail.length < bestTemplate) continue;
      if (head.length + tail.length > bestTemplate) found = new Set();
      bestTemplate = head.length + tail.length;
      found.add(task);
    } catch {
      continue;
    }
  }
  return found.size === 1 ? [...found][0] : undefined;
}

// Mirrors the review/challenge preview built at the review.ts sync call; the
// review command tests pin the two against real submitted prompts.
const REVIEW_PROMPT_START = "Perform a read-only code review of the supplied repository changes.\n";
const REVIEW_TARGET_LINES = /\n\nTarget: (current working tree changes|branch diff against [^\n]+)\nScope: (?:branch diff only; all working-tree changes are out of scope|current working tree, including tracked and untracked changes)\nRepository root: /;
const REVIEW_FOCUS_LINE = "\nReview focus: ";

function reviewTaskText(prompt: string): string | undefined {
  if (!prompt.startsWith(REVIEW_PROMPT_START)) return undefined;
  const target = REVIEW_TARGET_LINES.exec(prompt);
  if (!target) return undefined;
  const header = prompt.slice(0, target.index);
  const focusAt = header.indexOf(REVIEW_FOCUS_LINE);
  const focus = focusAt < 0 ? undefined : header.slice(focusAt + REVIEW_FOCUS_LINE.length);
  return `Review target: ${target[1]}${focus ? `. Focus: ${focus}` : ""}`;
}
