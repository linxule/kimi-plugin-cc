import { basename, isAbsolute, relative, resolve } from "node:path";
import path from "node:path";
import { lstat, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { resolveKimiHome } from "./kimi-home.js";

export type KimiSessionTitleCommand =
  | "ask"
  | "review"
  | "challenge"
  | "rescue"
  | "pursue"
  | "swarm"
  | "swarm-write";

export const KIMI_SESSION_TITLE_MAX_LENGTH = 120;
const SESSION_INDEX_MAX_BYTES = 16 * 1024 * 1024;
const SESSION_INDEX_LINE_MAX_BYTES = 1024 * 1024;
const SESSION_STATE_MAX_BYTES = 1024 * 1024;

const DISPLAY_NAMES: Record<KimiSessionTitleCommand, string> = {
  ask: "Ask",
  review: "Review",
  challenge: "Challenge",
  rescue: "Rescue",
  pursue: "Pursue",
  swarm: "Swarm",
  "swarm-write": "Swarm Write",
};

export interface SyncKimiSessionTitleOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  sessionId: string | undefined | null;
  title: string;
  stderr?: NodeJS.WritableStream;
}

export type SyncKimiSessionTitleResult =
  | "updated"
  | "missing-session-id"
  | "missing-index"
  | "missing-entry"
  | "unsafe-entry"
  | "missing-state"
  | "invalid-state"
  | "custom-title"
  | "write-failed";

interface SessionIndexEntry {
  sessionId: string;
  sessionDir: string;
}

export function buildKimiSessionTitle(
  command: KimiSessionTitleCommand,
  summary: string | undefined,
): string {
  const prefix = `Kimi ${DISPLAY_NAMES[command] ?? "Session"}`;
  const normalized = normalizeTitleFragment(summary ?? "");
  return shortenForTitle(normalized ? `${prefix}: ${normalized}` : prefix, KIMI_SESSION_TITLE_MAX_LENGTH);
}

export function normalizeTitleFragment(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function shortenForTitle(text: string, maxLength: number): string {
  const normalized = normalizeTitleFragment(text);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export async function syncKimiSessionTitle(
  options: SyncKimiSessionTitleOptions,
): Promise<SyncKimiSessionTitleResult> {
  const sessionId = options.sessionId?.trim();
  if (!sessionId) {
    return "missing-session-id";
  }

  const kimiHome = resolveKimiHome(options.env, options.cwd);
  const sessionsRoot = path.join(kimiHome, "sessions");
  const indexPath = path.join(kimiHome, "session_index.jsonl");

  const indexRead = await readUtf8FileCapped(indexPath, SESSION_INDEX_MAX_BYTES);
  if (!indexRead.ok) {
    if (indexRead.reason === "too-large") {
      warn(options.stderr, `session title sync skipped: session_index.jsonl is too large`);
    }
    return "missing-index";
  }

  const entry = findSessionIndexEntry(indexRead.text, sessionId, options.stderr);
  if (!entry) {
    return "missing-entry";
  }

  const safeSessionId = formatSessionIdForLog(sessionId);
  const sessionDir = resolve(entry.sessionDir);
  if (
    !isAbsolute(entry.sessionDir) ||
    !isPathInside(sessionsRoot, sessionDir) ||
    basename(sessionDir) !== sessionId
  ) {
    warn(options.stderr, `session title sync skipped for ${safeSessionId}: unsafe session index entry`);
    return "unsafe-entry";
  }
  if (!(await isSafeSessionsRoot(sessionsRoot))) {
    warn(options.stderr, `session title sync skipped for ${safeSessionId}: unsafe sessions root`);
    return "unsafe-entry";
  }
  if (!(await isRealPathInside(sessionsRoot, sessionDir))) {
    warn(options.stderr, `session title sync skipped for ${safeSessionId}: unsafe session index target`);
    return "unsafe-entry";
  }

  const statePath = path.join(sessionDir, "state.json");
  const stateFileMode = await readSafeStateFileMode(statePath, options.stderr, sessionId);
  if (stateFileMode === null) {
    return "unsafe-entry";
  }

  let parsed: unknown;
  const stateRead = await readUtf8FileCapped(statePath, SESSION_STATE_MAX_BYTES);
  if (!stateRead.ok) {
    const reason = stateRead.reason === "too-large" ? "oversized state.json" : "missing or invalid state.json";
    warn(options.stderr, `session title sync skipped for ${safeSessionId}: ${reason}`);
    return "missing-state";
  }
  try {
    parsed = JSON.parse(stateRead.text) as unknown;
  } catch {
    warn(options.stderr, `session title sync skipped for ${safeSessionId}: missing or invalid state.json`);
    return "missing-state";
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warn(options.stderr, `session title sync skipped for ${safeSessionId}: invalid state.json shape`);
    return "invalid-state";
  }

  const state = parsed as Record<string, unknown>;
  if (state.isCustomTitle === true) {
    return "custom-title";
  }

  const next = {
    ...state,
    title: options.title.trim(),
    isCustomTitle: true,
  };

  try {
    await writeStateFileAtomic(statePath, `${JSON.stringify(next, null, 2)}\n`, stateFileMode);
    return "updated";
  } catch {
    warn(options.stderr, `session title sync skipped for ${safeSessionId}: failed to write state.json`);
    return "write-failed";
  }
}

function findSessionIndexEntry(
  indexText: string,
  sessionId: string,
  stderr?: NodeJS.WritableStream,
): SessionIndexEntry | null {
  for (const line of indexText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (Buffer.byteLength(trimmed, "utf8") > SESSION_INDEX_LINE_MAX_BYTES) {
      warn(stderr, `session title sync skipped oversized session index line`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      warn(stderr, `session title sync skipped malformed session index line`);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      continue;
    }
    const entry = parsed as Partial<SessionIndexEntry>;
    if (
      entry.sessionId === sessionId &&
      typeof entry.sessionDir === "string"
    ) {
      return {
        sessionId,
        sessionDir: entry.sessionDir,
      };
    }
  }
  return null;
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function isSafeSessionsRoot(sessionsRoot: string): Promise<boolean> {
  try {
    const stats = await lstat(sessionsRoot);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

async function isRealPathInside(parent: string, child: string): Promise<boolean> {
  try {
    const realParent = await realpath(parent);
    const realChild = await realpath(child);
    return isPathInside(realParent, realChild);
  } catch {
    return false;
  }
}

async function readSafeStateFileMode(
  statePath: string,
  stderr: NodeJS.WritableStream | undefined,
  sessionId: string,
): Promise<number | null> {
  try {
    const stats = await lstat(statePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      warn(stderr, `session title sync skipped for ${formatSessionIdForLog(sessionId)}: unsafe state.json`);
      return null;
    }
    return stats.mode & 0o777;
  } catch {
    return 0o600;
  }
}

async function writeStateFileAtomic(statePath: string, contents: string, mode: number): Promise<void> {
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmpPath, contents, { encoding: "utf8", mode, flag: "wx" });
    await rename(tmpPath, statePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

type CappedReadResult =
  | { ok: true; text: string }
  | { ok: false; reason: "missing" | "not-file" | "too-large" };

async function readUtf8FileCapped(filePath: string, maxBytes: number): Promise<CappedReadResult> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(filePath, "r");
  } catch {
    return { ok: false, reason: "missing" };
  }

  try {
    const stats = await file.stat();
    if (!stats.isFile()) {
      return { ok: false, reason: "not-file" };
    }
    if (stats.size > maxBytes) {
      return { ok: false, reason: "too-large" };
    }
    const buffer = Buffer.alloc(stats.size);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return { ok: true, text: buffer.subarray(0, bytesRead).toString("utf8") };
  } finally {
    await file.close();
  }
}

function formatSessionIdForLog(sessionId: string): string {
  return JSON.stringify(normalizeTitleFragment(sessionId));
}

function warn(stderr: NodeJS.WritableStream | undefined, message: string): void {
  stderr?.write(`[kimi-plugin-cc] ${message}.\n`);
}
