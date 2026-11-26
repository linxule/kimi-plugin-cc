import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { RuntimeError } from "./errors.js";
import type { JobStore } from "./job-store.js";
import type { KimiExecutionPlan } from "./kimi-engine.js";
import { resolveKimiHome } from "./kimi-home.js";
import { boundedReaddir, DIR_ENUM_CAP, openJournalSafely, readSmallFileSafe } from "./native-v2-preflight.js";
import { SESSION_REFERENCE_ID_MAX } from "./parsing.js";
import type { ReadScope } from "./read-scope.js";
import { isRealPathInside } from "./session-title.js";

const REFERENCE_ID = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${SESSION_REFERENCE_ID_MAX - 1}}$`);
const TITLE_MAX_CODE_POINTS = 200;
const STATE_MAX_BYTES = 1024 * 1024;

export interface SessionReference {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly logPath: string;
  /** Realpath of the session's main-agent directory: the read root a scoped call needs to open the log. */
  readonly readRoot: string;
}

/** Upstream `sessionLogPath` (app-client sessionReferences.ts, 2.8.0). */
export function sessionLogPath(home: string, workspaceId: string, sessionId: string): string {
  const root = home.replaceAll("\\", "/").replace(/\/+$/, "");
  return `${root}/sessions/${workspaceId}/${sessionId}/agents/main/wire.jsonl`;
}

function xmlAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}

/** Byte-for-byte upstream `renderSessionReferences`. */
export function renderSessionReferences(references: readonly SessionReference[]): string {
  const lines = references.map((reference) =>
    `<session id="${xmlAttr(reference.sessionId)}" title="${xmlAttr(reference.title)}" log="${xmlAttr(reference.logPath)}" />`);
  return ["<referenced_sessions>", ...lines, "</referenced_sessions>"].join("\n");
}

/**
 * A scoped call (--read-root or --network) confines reads, and a session log
 * lives in the Kimi home, outside the workspace. Naming a session grants its
 * whole main-agent directory as a read root: the log and what Kimi keeps
 * beside it (saved tool outputs, plans). Nothing else in the session store
 * becomes readable. The default scope is unconfined and stays undefined.
 */
export function withReferenceReadRoots(scope: ReadScope | undefined, references: readonly SessionReference[]): ReadScope | undefined {
  if (scope === undefined || references.length === 0) return scope;
  const readRoots = [...scope.readRoots];
  for (const reference of references) if (!readRoots.includes(reference.readRoot)) readRoots.push(reference.readRoot);
  return Object.freeze({ readRoots: Object.freeze(readRoots), network: scope.network });
}

export function appendSessionReferences(prompt: string, references: readonly SessionReference[]): string {
  return references.length === 0 ? prompt : `${prompt}\n\n${renderSessionReferences(references)}`;
}

const BLOCK_OPEN = "\n\n<referenced_sessions>\n";
const BLOCK_CLOSE = "\n</referenced_sessions>";
const ATTR = String.raw`(?:[^"&<>\p{Cc}]|&(?:amp|lt|gt|quot);)*`;
const SESSION_LINE = new RegExp(`^<session id="${ATTR}" title="${ATTR}" log="${ATTR}" />$`, "u");

/**
 * Remove one trailing referenced-sessions block of exactly the rendered
 * grammar, for summaries, titles and previews only. A user prompt that itself
 * ends in such a block loses it here too; the spawned prompt never changes.
 */
export function stripSessionReferences(prompt: string): string {
  if (!prompt.endsWith(BLOCK_CLOSE)) return prompt;
  const start = prompt.lastIndexOf(BLOCK_OPEN);
  const bodyStart = start + BLOCK_OPEN.length;
  const bodyEnd = prompt.length - BLOCK_CLOSE.length;
  if (start < 0 || bodyStart > bodyEnd) return prompt;
  const lines = prompt.slice(bodyStart, bodyEnd).split("\n");
  return lines.every((line) => SESSION_LINE.test(line)) ? prompt.slice(0, start) : prompt;
}

export interface ResolveSessionReferencesOptions {
  readonly store: JobStore;
  readonly env: NodeJS.ProcessEnv;
  /** The cwd the Kimi child is spawned in, so `log=` uses the child's KIMI_CODE_HOME spelling. */
  readonly spawnCwd: string;
  readonly plan: Pick<KimiExecutionPlan, "intendedEngine">;
  readonly resumeSessionId?: string | null;
  readonly stage: string;
}

/**
 * Resolve each job id or Kimi session id to its main-agent journal without
 * reading journal content. Refuses with INVALID_ARGS before any job row.
 * The checks hold at resolution time only: Kimi opens the path later, and the
 * session store is the operator's own mutable state.
 */
export async function resolveSessionReferences(
  inputs: readonly string[] | undefined,
  options: ResolveSessionReferencesOptions,
): Promise<SessionReference[]> {
  if (!inputs || inputs.length === 0) return [];
  const refuse = (input: string, reason: string): RuntimeError =>
    new RuntimeError("INVALID_ARGS", `--reference-session ${JSON.stringify(input)}: ${reason}.`, options.stage);
  if (options.plan.intendedEngine !== "native-v2") {
    throw refuse(inputs[0]!, "session references need a native-v2 Kimi Code release; this run selected legacy-v1");
  }
  const home = resolveKimiHome(options.env, options.spawnCwd);
  if (/\p{Cc}/u.test(home) || (process.platform !== "win32" && home.includes("\\"))) {
    throw refuse(inputs[0]!, "the Kimi home path contains characters a session log path cannot carry");
  }
  const sessionsDir = path.join(home, "sessions");
  let workspaces: string[] | undefined;
  const references: SessionReference[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    if (!REFERENCE_ID.test(input)) throw refuse(input, "not a job id or Kimi session id");
    const job = options.store.getJob(input);
    const sessionId = job ? job.kimi_session_id : input;
    if (!sessionId) throw refuse(input, `job ${input} has no Kimi session yet`);
    if (!REFERENCE_ID.test(sessionId)) throw refuse(input, `job ${input} records an unsafe Kimi session id`);
    if (options.resumeSessionId && sessionId === options.resumeSessionId) {
      throw refuse(input, `session ${sessionId} is the session being resumed`);
    }
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);

    workspaces ??= await listWorkspaces(sessionsDir, (reason) => refuse(input, reason));
    const matches: string[] = [];
    for (const workspace of workspaces) {
      try {
        await lstat(path.join(sessionsDir, workspace, sessionId));
        matches.push(workspace);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") {
          throw refuse(input, `could not search the Kimi session store: ${(error as Error).message}`);
        }
      }
    }
    if (matches.length === 0) {
      throw refuse(input, job ? `session ${sessionId} of job ${input} was not found in the Kimi session store`
        : "no plugin job or Kimi session has this id");
    }
    if (matches.length > 1) {
      throw refuse(input, `session ${sessionId} is ambiguous: it exists in ${matches.length} workspaces (${matches.join(", ")})`);
    }
    const workspaceId = matches[0]!;
    if (/\p{Cc}/u.test(workspaceId) || workspaceId.includes("\\")) {
      throw refuse(input, `unsafe workspace directory name for session ${sessionId}`);
    }
    const sessionDir = path.join(sessionsDir, workspaceId, sessionId);
    const mainDir = path.join(sessionDir, "agents", "main");
    if (!(await isRealPathInside(sessionsDir, mainDir))) {
      const missing = await lstat(mainDir).then(() => false, (error: NodeJS.ErrnoException) => error.code === "ENOENT");
      throw refuse(input, missing ? `session ${sessionId} has no main agent journal`
        : `session ${sessionId} has an unsafe path (a symbolic link, a non-directory, or outside the sessions directory)`);
    }
    // On a case-insensitive volume another spelling opens the same directory;
    // the self-reference check, the dedupe and `log=` all need the stored one.
    // The read root a scoped call is granted must be the directory just
    // validated: its physical path is the physical sessions directory plus the
    // validated components, so a tree changed during resolution refuses.
    let stored: string;
    let readRoot: string;
    try {
      stored = path.basename(await realpath(sessionDir));
      readRoot = await realpath(mainDir);
      if (stored === sessionId && readRoot !== path.join(await realpath(sessionsDir), workspaceId, sessionId, "agents", "main")) {
        throw refuse(input, `session ${sessionId} has an unsafe path (its main agent directory resolves outside its own session)`);
      }
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw refuse(input, `session ${sessionId} changed while it was being resolved: ${(error as Error).message}`);
    }
    if (stored !== sessionId) {
      throw refuse(input, `session ids must be spelled exactly as stored; the store has ${stored}`);
    }
    const opened = await openJournalSafely(path.join(mainDir, "wire.jsonl"));
    if (opened.kind !== "ok") {
      throw refuse(input, opened.reason === "journal not found" ? `session ${sessionId} has no main agent journal`
        : `session ${sessionId} main journal is unusable: ${opened.reason}`);
    }
    await opened.handle.close().catch(() => undefined);

    references.push({
      sessionId,
      workspaceId,
      title: await sessionTitle(path.join(sessionDir, "state.json"), sessionId),
      logPath: sessionLogPath(home, workspaceId, sessionId),
      readRoot,
    });
  }
  return references;
}

async function listWorkspaces(sessionsDir: string, refuse: (reason: string) => RuntimeError): Promise<string[]> {
  try {
    const info = await lstat(sessionsDir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw refuse(`unsafe Kimi sessions directory ${sessionsDir}`);
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw refuse(`could not read the Kimi sessions directory: ${(error as Error).message}`);
  }
  const listed = await boundedReaddir(sessionsDir, DIR_ENUM_CAP);
  if (listed.kind === "absent") return [];
  if (listed.kind === "cap-exceeded") throw refuse(`too many entries under ${sessionsDir} to search safely`);
  if (listed.kind === "unreadable") throw refuse(`could not enumerate the Kimi session store: ${listed.reason}`);
  const workspaces: string[] = [];
  for (const entry of listed.entries) {
    if (entry.isSymbolicLink()) throw refuse(`symlinked entry in the Kimi session store: ${path.join(sessionsDir, entry.name)}`);
    if (entry.isDirectory()) workspaces.push(entry.name);
  }
  return workspaces;
}

/** Upstream title order (title, then collapsed lastPrompt, then id), without control characters, capped. */
async function sessionTitle(statePath: string, sessionId: string): Promise<string> {
  const read = await readSmallFileSafe(statePath, STATE_MAX_BYTES);
  let state: Record<string, unknown> = {};
  if (read.kind === "ok") {
    try {
      const parsed = JSON.parse(read.contents) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) state = parsed as Record<string, unknown>;
    } catch {
      // An unreadable state falls back to the id.
    }
  }
  const title = typeof state.title === "string" ? state.title.trim() : "";
  const lastPrompt = typeof state.lastPrompt === "string" ? state.lastPrompt.replace(/\s+/g, " ").trim() : "";
  const clean = (title || lastPrompt || sessionId).replace(/\p{Cc}+/gu, " ").trim();
  return [...clean].slice(0, TITLE_MAX_CODE_POINTS).join("").trimEnd() || sessionId;
}
