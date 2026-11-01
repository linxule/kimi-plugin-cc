import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { digestPrompt } from "./jobs.js";
// Total entries visited across both enumeration levels. The cap guards against
// a pathological tree rather than budgeting normal store size. opendir streams,
// so entries are not buffered. Dot-entries (`.index-dirty`, `.index-cache`) are
// upstream index state, never workspaces, and are skipped without being counted.
// Directories whose mtime predates the spawn cannot have been created by this
// run and are skipped before any read, so the byte budget scales with concurrent
// activity, not with store size.
const DIR_ENUM_CAP = 65_536;
const STATE_MAX_BYTES = 1024 * 1024;
const JOURNAL_PREFIX_BYTES = 4 * 1024 * 1024; // The prompt is argv-bounded (< 1 MiB); the first user message follows a few config records.
const SCAN_MAX_BYTES = 64 * 1024 * 1024;
const MTIME_SLACK_MS = 1000; // Filesystems with coarse mtime granularity.
const SESSION_ID = /^session_[0-9a-f-]{36}$/;
/** Metadata recovery only, never a substitute for resume lineage/plan scans.
 * A capped or unreadable enumeration cannot establish uniqueness and refuses;
 * skipping symlinked or dot entries is not partial — neither can be a session
 * the child created.
 *
 * A candidate is bound to THIS job by content, not only by time: the first
 * user message in the session's main journal must carry a text item whose
 * sha256 equals the job's `prompt_digest` (the exact `-p` argument). Time and
 * cwd alone would admit a concurrent TUI session, another host's finished job
 * (host-local stores cannot see each other's session ids), or a `state.json`
 * planted by repository code running under rescue. The digest is not unique
 * on its own either (the same prompt can run twice), so the window and the
 * exactly-one rule stay in force. */
export async function recoverSessionIdFromStore(options) {
    const entryCap = options.entryCap ?? DIR_ENUM_CAP;
    let entries = 0;
    let bytes = 0;
    let digestMismatches = 0;
    let missingJournals = 0;
    const candidates = [];
    const capped = new Error("enumeration_capped");
    async function* directories(dir) {
        if ((await lstat(dir)).isSymbolicLink())
            throw new Error("unreadable");
        const handle = await opendir(dir);
        for await (const entry of handle) {
            if (entry.name.startsWith("."))
                continue;
            if (++entries > entryCap)
                throw capped;
            // A symlinked entry is never a session the child created; skipping it
            // keeps one stray link from disabling recovery host-wide. Directories
            // we descend are still lstat-anchored above.
            if (entry.isSymbolicLink())
                continue;
            if (entry.isDirectory())
                yield entry.name;
        }
    }
    // Bounded no-follow read of a regular file. Returns undefined when the file
    // is absent; throws "unreadable" for anything that is not a plain file. With
    // `prefix`, a larger file yields its first `maxBytes` instead of refusing.
    async function readBounded(file, maxBytes, prefix = false) {
        let handle;
        try {
            handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return undefined;
            throw error;
        }
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || (stat.size > maxBytes && !prefix))
                throw new Error("unreadable");
            const size = Math.min(stat.size, maxBytes);
            bytes += size;
            if (bytes > SCAN_MAX_BYTES)
                throw capped;
            const buffer = Buffer.alloc(size);
            let offset = 0;
            while (offset < buffer.length) {
                const read = await handle.read(buffer, offset, buffer.length - offset, offset);
                if (!read.bytesRead)
                    break;
                offset += read.bytesRead;
            }
            return buffer.subarray(0, offset);
        }
        finally {
            await handle.close();
        }
    }
    try {
        if (!Number.isFinite(options.spawnedAt) || !Number.isFinite(options.settledAt) ||
            options.settledAt < options.spawnedAt || !/^[0-9a-f]{64}$/.test(options.promptDigest)) {
            return { reason: "none" };
        }
        const cwd = await realpath(options.cwd);
        const sessions = path.join(options.kimiHome, "sessions");
        // Missing nested dirs mean an incomplete scan; only a missing root is normal.
        try {
            await lstat(sessions);
        }
        catch (error) {
            if (error.code === "ENOENT")
                return { reason: "none" };
            throw error;
        }
        for await (const workspace of directories(sessions)) {
            const workspacePath = path.join(sessions, workspace);
            for await (const session of directories(workspacePath)) {
                if (!SESSION_ID.test(session))
                    continue;
                const sessionPath = path.join(workspacePath, session);
                // A directory this run created was modified at or after the spawn.
                if ((await lstat(sessionPath)).mtimeMs < options.spawnedAt - MTIME_SLACK_MS)
                    continue;
                const raw = await readBounded(path.join(sessionPath, "state.json"), STATE_MAX_BYTES);
                if (!raw)
                    continue;
                let state;
                try {
                    state = JSON.parse(raw.toString("utf8"));
                }
                catch {
                    continue;
                }
                if (!state || typeof state !== "object")
                    continue;
                const value = state;
                // The child writes createdAt after the parent stamped spawnedAt on the
                // same clock, so causality orders them; no pre-spawn slack is justified.
                if (value.version !== 2 || typeof value.cwd !== "string" || !path.isAbsolute(value.cwd) ||
                    typeof value.id !== "string" || !SESSION_ID.test(value.id) || value.id !== session ||
                    typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) ||
                    value.createdAt < options.spawnedAt || value.createdAt > options.settledAt)
                    continue;
                let stateCwd;
                try {
                    stateCwd = await realpath(value.cwd);
                }
                catch {
                    continue;
                }
                if (stateCwd !== cwd || options.store.hasSessionId(value.id, options.jobId))
                    continue;
                const journal = await readBounded(path.join(sessionPath, "agents", "main", "wire.jsonl"), JOURNAL_PREFIX_BYTES, true);
                if (!journal) {
                    missingJournals += 1;
                    continue;
                }
                // A prefix cut mid-record must never be parsed as a complete line.
                const text = journal.length === JOURNAL_PREFIX_BYTES
                    ? journal.subarray(0, journal.lastIndexOf(0x0a) + 1).toString("utf8") : journal.toString("utf8");
                if (!firstUserMessageMatches(text, options.promptDigest)) {
                    digestMismatches += 1;
                    continue;
                }
                candidates.push(value.id);
            }
        }
        if (candidates.length === 1)
            return { sessionId: candidates[0] };
        if (candidates.length > 1)
            return { reason: `ambiguous:${candidates.length}` };
        if (digestMismatches > 0)
            return { reason: `digest_mismatch:${digestMismatches}` };
        return { reason: missingJournals > 0 ? `journal_missing:${missingJournals}` : "none" };
    }
    catch (error) {
        return { reason: error === capped ? "enumeration_capped" : "unreadable" };
    }
}
/** True when the FIRST user message in a native-v2 main journal carries a
 * text item equal to the prompt the job spawned with. Later user turns are
 * never consulted: only the opening prompt binds a session to its spawn. */
export function firstUserMessageMatches(journal, promptDigest) {
    for (const line of journal.split("\n")) {
        if (!line.trim())
            continue;
        let record;
        try {
            record = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (!record || typeof record !== "object")
            continue;
        const message = record.message;
        if (!message || typeof message !== "object" || message.role !== "user")
            continue;
        const content = message.content;
        if (!Array.isArray(content))
            return false;
        return content.some((item) => item && typeof item === "object" && item.type === "text" &&
            typeof item.text === "string" &&
            digestPrompt(item.text) === promptDigest);
    }
    return false;
}
