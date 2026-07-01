import { basename, isAbsolute, relative, resolve } from "node:path";
import path from "node:path";
import { lstat, open, realpath, rename, rm, writeFile } from "node:fs/promises";
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
    const normalized = normalizeTitleFragment(summary ?? "");
    return shortenForTitle(normalized ? `${prefix}: ${normalized}` : prefix, KIMI_SESSION_TITLE_MAX_LENGTH);
}
export function normalizeTitleFragment(text) {
    return text
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
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
    }
    catch {
        warn(options.stderr, `session title sync skipped for ${safeSessionId}: failed to write state.json`);
        return "write-failed";
    }
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
async function writeStateFileAtomic(statePath, contents, mode) {
    const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    try {
        await writeFile(tmpPath, contents, { encoding: "utf8", mode, flag: "wx" });
        await rename(tmpPath, statePath);
    }
    catch (error) {
        await rm(tmpPath, { force: true }).catch(() => { });
        throw error;
    }
}
async function readUtf8FileCapped(filePath, maxBytes) {
    let file;
    try {
        file = await open(filePath, "r");
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
