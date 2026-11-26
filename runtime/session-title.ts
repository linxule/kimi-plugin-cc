import { basename, isAbsolute, relative, resolve } from "node:path";
import path from "node:path";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
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
  /**
   * Raw task text for the session preview (the question, task or objective),
   * never the prefixed prompt and never the completed job's answer summary.
   */
  promptText?: string;
  /**
   * Repair only: replace a native-v2 preview only when it is blank or one of
   * these verified plugin prompts. Omitted after a settled run, whose request
   * is the session's latest prompt (print mode never writes lastPrompt).
   */
  ownPrompts?: readonly string[];
  /** Repair previews/indexing without changing existing titles. */
  preserveTitle?: boolean;
  requireNativeV2?: boolean;
  dryRun?: boolean;
  stderr?: NodeJS.WritableStream;
}

export type SyncKimiSessionTitleResult =
  | "updated"
  | "would-update"
  | "preview-replaced"
  | "would-replace-preview"
  | "unchanged"
  | "unsupported-state"
  | "state-changed"
  | "index-failed"
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
  const normalized = promptMetadataText(summary ?? "") ?? "";
  return shortenForTitle(normalized ? `${prefix}: ${normalized}` : prefix, KIMI_SESSION_TITLE_MAX_LENGTH);
}

export function normalizeTitleFragment(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Mirrors kimi-code 2.0.0 promptMetadataTextFromText: redact BEFORE truncating. */
export function promptMetadataText(text: string): string | undefined {
  const sanitized = sanitizePromptMetadata(text);
  return sanitized ? sanitized.slice(0, 4000) : undefined;
}

function sanitizePromptMetadata(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[redacted]")
    .replace(/\b(authorization)\s*:\s*bearer\s+\S+/gi, "$1: Bearer [redacted]")
    .replace(/\b(api[_-]?key|token|secret|password|passwd|pwd)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "$1=[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(/\b[A-Za-z0-9][A-Za-z0-9+/=_-]{39,}\b/g, "[redacted]")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const OWN_PROMPT_MIN_PREFIX = 40;

/**
 * Earlier plugin releases stored the submitted prompt redacted, whitespace-
 * collapsed and capped, so compare normalized forms. A prefix relation counts
 * only when the shorter side is long enough that short native text never does.
 */
function isOwnPrompt(existing: string, ownPrompts: readonly string[]): boolean {
  const current = normalizeTitleFragment(existing);
  if (!current) return false;
  return ownPrompts.some((prompt) =>
    [normalizeTitleFragment(prompt), sanitizePromptMetadata(prompt)].some((own) => own.length > 0 && (current === own ||
      (Math.min(own.length, current.length) >= OWN_PROMPT_MIN_PREFIX && (own.startsWith(current) || current.startsWith(own))))));
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
  if (sessionId === "." || sessionId === ".." || /[/\\\p{Cc}]/u.test(sessionId)) {
    warn(options.stderr, `session metadata sync skipped for ${formatSessionIdForLog(sessionId)}: unsafe session id`);
    return "unsafe-entry";
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
  const nativeV2 = state.version === 2;
  if (options.requireNativeV2 && !nativeV2) return "unsupported-state";
  if (nativeV2 && typeof state.id === "string" && state.id !== sessionId) return "invalid-state";
  // Custom-title normalization also recognizes titleKind and the older customTitle.
  const customTitle = state.isCustomTitle === true || state.titleKind === "custom" ||
    (typeof state.customTitle === "string" && state.customTitle.trim().length > 0);
  const generatedTitle = state.titleKind === "generated";
  const next = { ...state };
  const preview = options.promptText === undefined ? undefined : promptMetadataText(options.promptText);
  const blankPreview = typeof state.lastPrompt !== "string" || !state.lastPrompt.trim();
  if (nativeV2 && preview && (blankPreview || !options.ownPrompts || isOwnPrompt(state.lastPrompt as string, options.ownPrompts))) {
    next.lastPrompt = preview;
  }
  const replacedPreview = !blankPreview && next.lastPrompt !== state.lastPrompt;
  if (!options.preserveTitle && !customTitle && !generatedTitle) {
    next.title = promptMetadataText(options.title)?.slice(0, KIMI_SESSION_TITLE_MAX_LENGTH) ?? "Kimi Session";
    // Native UI generation must remain eligible; a deterministic fallback is not
    // a human rename. Legacy engines retain their existing custom-title behavior.
    next.isCustomTitle = !nativeV2;
    if (nativeV2) next.titleKind = "replaceable";
  }

  const changed = JSON.stringify(next) !== JSON.stringify(state);
  if (options.dryRun) return !changed ? "unchanged" : replacedPreview ? "would-replace-preview" : "would-update";
  try {
    if (changed && !(await writeStateFileAtomic(statePath, `${JSON.stringify(next, null, 2)}\n`, stateFileMode, stateRead.text))) {
      warn(options.stderr, "session metadata sync skipped: state changed concurrently; retry after the session is idle");
      return "state-changed";
    }
  } catch {
    warn(options.stderr, `session metadata sync skipped for ${safeSessionId}: failed to write state.json`);
    return "write-failed";
  }
  if (nativeV2) {
    try {
      // Also re-mark unchanged metadata, so a previous invalidation failure is
      // repairable without rewriting the state or changing a manual title.
      await markSessionIndexDirty(sessionsRoot, sessionId);
    } catch {
      warn(options.stderr, `session metadata saved for ${safeSessionId}, but index notification failed; retry repair-sessions --apply when idle`);
      return "index-failed";
    }
  }
  if (changed) return replacedPreview ? "preview-replaced" : "updated";
  return customTitle && !options.preserveTitle ? "custom-title" : "unchanged";
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

export async function isRealPathInside(parent: string, child: string): Promise<boolean> {
  try {
    let current = parent;
    for (const part of relative(parent, child).split(path.sep)) {
      current = path.join(current, part);
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
    }
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

async function writeStateFileAtomic(statePath: string, contents: string, mode: number, expected: string): Promise<boolean> {
  const tmpPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, contents, { encoding: "utf8", mode, flag: "wx" });
    const current = await readUtf8FileCapped(statePath, SESSION_STATE_MAX_BYTES);
    if (!current.ok || current.text !== expected) return false;
    await rename(tmpPath, statePath);
    return true;
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {});
  }
}

async function markSessionIndexDirty(sessionsRoot: string, sessionId: string): Promise<void> {
  if (!(await isSafeSessionsRoot(sessionsRoot))) throw new Error("Unsafe sessions root");
  const dir = path.join(sessionsRoot, ".index-dirty");
  await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (!(await isRealPathInside(sessionsRoot, dir))) throw new Error("Unsafe dirty journal");
  // Upstream splits at the LAST dot; the unique suffix must contain no dots.
  const file = await open(path.join(dir, `${sessionId}.${Date.now()}-${randomUUID()}`),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  await file.close();
}

type CappedReadResult =
  | { ok: true; text: string }
  | { ok: false; reason: "missing" | "not-file" | "too-large" };

async function readUtf8FileCapped(filePath: string, maxBytes: number): Promise<CappedReadResult> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
