import { basename, isAbsolute, relative, resolve } from "node:path";
import path from "node:path";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { resolveKimiHome } from "./kimi-home.js";
export const KIMI_SESSION_TITLE_MAX_LENGTH = 120;
const SESSION_INDEX_MAX_BYTES = 16 * 1024 * 1024;
const SESSION_INDEX_LINE_MAX_BYTES = 1024 * 1024;
const SESSION_STATE_MAX_BYTES = 1024 * 1024;
const DISPLAY_NAMES = {
    ask: "Ask",
    review: "Review",
    challenge: "Challenge",
    rescue: "Rescue",
    pursue: "Pursue",
    swarm: "Swarm",
    "swarm-write": "Swarm Write",
};
export function buildKimiSessionTitle(command, summary) {
    const prefix = `Kimi ${DISPLAY_NAMES[command] ?? "Session"}`;
    const normalized = promptMetadataText(summary ?? "") ?? "";
    return shortenForTitle(normalized ? `${prefix}: ${normalized}` : prefix, KIMI_SESSION_TITLE_MAX_LENGTH);
}
export function normalizeTitleFragment(text) {
    return text
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
/** Mirrors kimi-code 2.0.0 promptMetadataTextFromText: redact BEFORE truncating. */
export function promptMetadataText(text) {
    const sanitized = text
        .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[redacted]")
        .replace(/\b(authorization)\s*:\s*bearer\s+\S+/gi, "$1: Bearer [redacted]")
        .replace(/\b(api[_-]?key|token|secret|password|passwd|pwd)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "$1=[redacted]")
        .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
        .replace(/\b[A-Za-z0-9][A-Za-z0-9+/=_-]{39,}\b/g, "[redacted]")
        .replace(/\p{Cc}+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
    return sanitized ? sanitized.slice(0, 4000) : undefined;
}
export function shortenForTitle(text, maxLength) {
    const normalized = normalizeTitleFragment(text);
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
export async function syncKimiSessionTitle(options) {
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
    if (!isAbsolute(entry.sessionDir) ||
        !isPathInside(sessionsRoot, sessionDir) ||
        basename(sessionDir) !== sessionId) {
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
    let parsed;
    const stateRead = await readUtf8FileCapped(statePath, SESSION_STATE_MAX_BYTES);
    if (!stateRead.ok) {
        const reason = stateRead.reason === "too-large" ? "oversized state.json" : "missing or invalid state.json";
        warn(options.stderr, `session title sync skipped for ${safeSessionId}: ${reason}`);
        return "missing-state";
    }
    try {
        parsed = JSON.parse(stateRead.text);
    }
    catch {
        warn(options.stderr, `session title sync skipped for ${safeSessionId}: missing or invalid state.json`);
        return "missing-state";
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        warn(options.stderr, `session title sync skipped for ${safeSessionId}: invalid state.json shape`);
        return "invalid-state";
    }
    const state = parsed;
    const nativeV2 = state.version === 2;
    if (options.requireNativeV2 && !nativeV2)
        return "unsupported-state";
    if (nativeV2 && typeof state.id === "string" && state.id !== sessionId)
        return "invalid-state";
    // Custom-title normalization also recognizes titleKind and the older customTitle.
    const customTitle = state.isCustomTitle === true || state.titleKind === "custom" ||
        (typeof state.customTitle === "string" && state.customTitle.trim().length > 0);
    const generatedTitle = state.titleKind === "generated";
    const next = { ...state };
    const preview = options.promptText === undefined ? undefined : promptMetadataText(options.promptText);
    if (nativeV2 && preview && (typeof state.lastPrompt !== "string" || !state.lastPrompt.trim())) {
        next.lastPrompt = preview;
    }
    if (!options.preserveTitle && !customTitle && !generatedTitle) {
        next.title = promptMetadataText(options.title)?.slice(0, KIMI_SESSION_TITLE_MAX_LENGTH) ?? "Kimi Session";
        // Native UI generation must remain eligible; a deterministic fallback is not
        // a human rename. Legacy engines retain their existing custom-title behavior.
        next.isCustomTitle = !nativeV2;
        if (nativeV2)
            next.titleKind = "replaceable";
    }
    const changed = JSON.stringify(next) !== JSON.stringify(state);
    if (options.dryRun)
        return changed ? "would-update" : "unchanged";
    try {
        if (changed && !(await writeStateFileAtomic(statePath, `${JSON.stringify(next, null, 2)}\n`, stateFileMode, stateRead.text))) {
            warn(options.stderr, "session metadata sync skipped: state changed concurrently; retry after the session is idle");
            return "state-changed";
        }
    }
    catch {
        warn(options.stderr, `session metadata sync skipped for ${safeSessionId}: failed to write state.json`);
        return "write-failed";
    }
    if (nativeV2) {
        try {
            // Also re-mark unchanged metadata, so a previous invalidation failure is
            // repairable without rewriting the state or changing a manual title.
            await markSessionIndexDirty(sessionsRoot, sessionId);
        }
        catch {
            warn(options.stderr, `session metadata saved for ${safeSessionId}, but index notification failed; retry repair-sessions --apply when idle`);
            return "index-failed";
        }
    }
    return changed ? "updated" : customTitle && !options.preserveTitle ? "custom-title" : "unchanged";
}
function findSessionIndexEntry(indexText, sessionId, stderr) {
    for (const line of indexText.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        if (Buffer.byteLength(trimmed, "utf8") > SESSION_INDEX_LINE_MAX_BYTES) {
            warn(stderr, `session title sync skipped oversized session index line`);
            continue;
        }
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch {
            warn(stderr, `session title sync skipped malformed session index line`);
            continue;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            continue;
        }
        const entry = parsed;
        if (entry.sessionId === sessionId &&
            typeof entry.sessionDir === "string") {
            return {
                sessionId,
                sessionDir: entry.sessionDir,
            };
        }
    }
    return null;
}
function isPathInside(parent, child) {
    const rel = relative(resolve(parent), resolve(child));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
async function isSafeSessionsRoot(sessionsRoot) {
    try {
        const stats = await lstat(sessionsRoot);
        return stats.isDirectory() && !stats.isSymbolicLink();
    }
    catch {
        return false;
    }
}
async function isRealPathInside(parent, child) {
    try {
        let current = parent;
        for (const part of relative(parent, child).split(path.sep)) {
            current = path.join(current, part);
            const info = await lstat(current);
            if (!info.isDirectory() || info.isSymbolicLink())
                return false;
        }
        const realParent = await realpath(parent);
        const realChild = await realpath(child);
        return isPathInside(realParent, realChild);
    }
    catch {
        return false;
    }
}
async function readSafeStateFileMode(statePath, stderr, sessionId) {
    try {
        const stats = await lstat(statePath);
        if (stats.isSymbolicLink() || !stats.isFile()) {
            warn(stderr, `session title sync skipped for ${formatSessionIdForLog(sessionId)}: unsafe state.json`);
            return null;
        }
        return stats.mode & 0o777;
    }
    catch {
        return 0o600;
    }
}
async function writeStateFileAtomic(statePath, contents, mode, expected) {
    const tmpPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(tmpPath, contents, { encoding: "utf8", mode, flag: "wx" });
        const current = await readUtf8FileCapped(statePath, SESSION_STATE_MAX_BYTES);
        if (!current.ok || current.text !== expected)
            return false;
        await rename(tmpPath, statePath);
        return true;
    }
    finally {
        await rm(tmpPath, { force: true }).catch(() => { });
    }
}
async function markSessionIndexDirty(sessionsRoot, sessionId) {
    if (!(await isSafeSessionsRoot(sessionsRoot)))
        throw new Error("Unsafe sessions root");
    const dir = path.join(sessionsRoot, ".index-dirty");
    await mkdir(dir, { mode: 0o700 }).catch((error) => {
        if (error.code !== "EEXIST")
            throw error;
    });
    if (!(await isRealPathInside(sessionsRoot, dir)))
        throw new Error("Unsafe dirty journal");
    // Upstream splits at the LAST dot; the unique suffix must contain no dots.
    const file = await open(path.join(dir, `${sessionId}.${Date.now()}-${randomUUID()}`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.close();
}
async function readUtf8FileCapped(filePath, maxBytes) {
    let file;
    try {
        file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    }
    catch {
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
    }
    finally {
        await file.close();
    }
}
function formatSessionIdForLog(sessionId) {
    return JSON.stringify(normalizeTitleFragment(sessionId));
}
function warn(stderr, message) {
    stderr?.write(`[kimi-plugin-cc] ${message}.\n`);
}
