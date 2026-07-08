// Shared parser for the kimi-plugin-cc managed block in
// ~/.kimi-code/config.toml.
//
// Why a separate module:
//
//   PR 2 added `runtime/hooks/install.ts::verifyHookInstalled` as a
//   pre-call gate. PR 4 added `runtime/commands/setup.ts` as the
//   installer. PR 4 reviewers found that the two were validating
//   different shapes — the verifier was a substring check (could be
//   bypassed by stray comments containing `kimi-plugin-cc-managed`),
//   and `setup --check` only confirmed `blockText.includes(hookPath)`
//   without checking for matcher/event/command exactness. A block with
//   `matcher = "*"` (which throws inside kimi-code and silently
//   disables the hook) would pass both gates.
//
//   This module owns the single source of truth for what a valid
//   managed block looks like. Both call sites import from here.
//
// (The drift classifier `describeHookCommandDrift` lives in install-paths.ts —
// the single source of truth for the hook command's byte shape — and is used
// here to turn a command MISMATCH into an actionable diagnosis when the caller
// supplies an `nodeExists` fs predicate.)
//
// HOST SCOPING (v1.7.0):
//
//   Claude Code and Codex install this plugin to DIFFERENT, version-stamped
//   paths but SHARE one `~/.kimi-code/config.toml`. Before v1.7.0 there was a
//   single managed block whose `command` was exact-matched to the RUNNING
//   host's path, so `/kimi:setup` (Claude) and `$kimi-setup` (Codex) overwrote
//   each other. Now the block is HOST-SCOPED — the marker carries a `:<host-id>`
//   suffix and each host owns/verifies its OWN block. Un-suffixed markers are
//   treated as LEGACY (from pre-v1.7.0 single-host installs); the current host
//   adopts a lone legacy block on its next install (see setup.ts).
//
// What a valid managed block looks like (line-by-line, post-trim):
//
//   # === BEGIN kimi-plugin-cc-managed:<host-id> (vX.Y.Z) ===
//   ... optional comment lines (any number, any content) ...
//   [[hooks]]
//   event = "PreToolUse"
//   command = "node 'absolute/path/to/approval-hook.js'"  (or process.execPath form)
//   timeout = <integer>
//   # === END kimi-plugin-cc-managed:<host-id> ===
//
// Critical rules:
//
//   - NO `matcher = ...` line. kimi-code compiles matchers as JS regex;
//     `new RegExp("*")` throws and silently disables the hook. Omitting
//     matcher means "fire for every tool".
//   - `event = "PreToolUse"` is required. Any other event would not
//     enforce our safety contract.
//   - Exactly ONE `[[hooks]]` declaration inside the block. Two would
//     register two hooks, which is fine functionally but breaks
//     idempotency checks.
//   - The `command` line must contain the hook script path we expect.
import { describeHookCommandDrift, hostIdFromHookCommand, isOurApprovalHookCommand, } from "./install-paths.js";
const MARKER_TAG = "kimi-plugin-cc-managed";
/**
 * Strict BEGIN matcher. Accepts `# === BEGIN kimi-plugin-cc-managed`
 * with an optional `:<host-id>` suffix, an optional ` (vX.Y.Z)` suffix,
 * and trailing ` ===`. Group 1 captures the host id (undefined = legacy).
 * Anything else (random comment containing the tag, mid-line embedded
 * marker) is not a managed-block marker.
 */
const BEGIN_LINE_RE = /^#\s*===\s*BEGIN\s+kimi-plugin-cc-managed(?::([A-Za-z0-9._-]+))?(?:\s+\([^)]+\))?\s*===\s*$/;
const END_LINE_RE = /^#\s*===\s*END\s+kimi-plugin-cc-managed(?::([A-Za-z0-9._-]+))?\s*===\s*$/;
/** TOML basic string for `command = "..."`. Captures the inner value. */
const COMMAND_LINE_RE = /^command\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/;
/** TOML literal string for `command = '...'` (no escapes inside). */
const COMMAND_LITERAL_LINE_RE = /^command\s*=\s*'([^']*)'\s*$/;
const EVENT_LINE_RE = /^event\s*=\s*"PreToolUse"\s*$/;
/** Anything matcher-shaped is a critical safety failure — block disabled. */
const MATCHER_LINE_RE = /^matcher\s*=/;
/** `timeout = <int>` — the only other key our managed [[hooks]] table emits. */
const TIMEOUT_LINE_RE = /^timeout\s*=\s*\d+\s*$/;
const HOOKS_TABLE_RE = /^\[\[hooks\]\]\s*$/;
/** Locate every BEGIN/END marker line, in order, with its parsed host id. */
function findMarkers(lines) {
    const hits = [];
    for (let i = 0; i < lines.length; i += 1) {
        const trimmed = lines[i].trim();
        const begin = BEGIN_LINE_RE.exec(trimmed);
        if (begin !== null) {
            // Normalize marker host ids to lowercase so a hand-edited `:Claude-Code`
            // isn't treated as a different host from the lowercase `claude-code` the
            // installer emits (Kimi review — avoids confusing duplicate blocks).
            hits.push({ index: i, kind: "begin", hostId: begin[1]?.toLowerCase() ?? null });
            continue;
        }
        const end = END_LINE_RE.exec(trimmed);
        if (end !== null) {
            hits.push({ index: i, kind: "end", hostId: end[1]?.toLowerCase() ?? null });
        }
    }
    return hits;
}
/**
 * Pair BEGIN/END markers into well-formed blocks. Returns the first orphan
 * (BEGIN-without-END or END-without-BEGIN) encountered, mirroring the
 * pre-v1.7.0 single-block behavior — an orphan is a hard error for install.
 */
function pairBlocks(lines) {
    const markers = findMarkers(lines);
    const blocks = [];
    let open = null;
    for (const marker of markers) {
        if (marker.kind === "begin") {
            // A second BEGIN before the previous one closed → the previous is orphaned.
            if (open !== null)
                return { orphan: "BEGIN-without-END" };
            open = marker;
            continue;
        }
        // end
        if (open === null)
            return { orphan: "END-without-BEGIN" };
        const body = validateBlockBody(lines.slice(open.index + 1, marker.index));
        blocks.push({
            hostId: open.hostId,
            beginLine: open.index,
            endLine: marker.index,
            commandPath: body.commandPath,
            valid: body.valid,
            invalidReason: body.invalidReason,
        });
        open = null;
    }
    if (open !== null)
        return { orphan: "BEGIN-without-END" };
    return { blocks };
}
/** Validate the lines BETWEEN a BEGIN/END pair against the safety grammar. */
function validateBlockBody(rawBody) {
    const blockLines = rawBody.map((line) => line.trim());
    let foundHooksTable = false;
    let foundEvent = false;
    let commandPath = "";
    let invalidReason;
    for (const line of blockLines) {
        if (line.length === 0 || line.startsWith("#"))
            continue;
        if (HOOKS_TABLE_RE.test(line)) {
            if (foundHooksTable) {
                invalidReason = "block contains more than one [[hooks]] table";
                break;
            }
            foundHooksTable = true;
            continue;
        }
        if (line.startsWith("[")) {
            // Any TOML table header other than the single [[hooks]] table means the
            // `event`/`command` lines below could belong to a DIFFERENT table (e.g.
            // `[[hooks]]` with only an event, then `[not_hooks]` carrying the
            // canonical command). Binding the block to exactly one [[hooks]] table
            // keeps the verifier from blessing a command-less hook. (Codex review.)
            invalidReason =
                "block contains an unexpected TOML table — only a single [[hooks]] table is allowed. Reinstall with /kimi:setup to repair.";
            break;
        }
        if (MATCHER_LINE_RE.test(line)) {
            invalidReason =
                'block contains a `matcher = ...` line — kimi-code compiles matchers as JS regex (`new RegExp("*")` throws and disables the hook). Reinstall with /kimi:setup to repair.';
            break;
        }
        if (EVENT_LINE_RE.test(line)) {
            foundEvent = true;
            continue;
        }
        const basic = COMMAND_LINE_RE.exec(line);
        const literal = COMMAND_LITERAL_LINE_RE.exec(line);
        if (basic !== null || literal !== null) {
            // TOML basic strings escape `\`, `"`, and the control chars.
            // Setup writes the escaped form via `tomlBasicString`; the
            // verifier compares against the JS-string canonical command, so
            // we must decode the escapes here before equality. Without this,
            // a hook script path containing `'` round-trips through
            // `shellSingleQuote` -> backslash -> TOML basic-string escape ->
            // captured raw -> mismatch on verify. Audit re-review (reports
            // 33/34) flagged this as a UX false-fail. Literal strings ('...')
            // have no escapes — pass through as-is.
            commandPath = basic !== null ? decodeTomlBasicString(basic[1]) : literal[1];
            continue;
        }
        // Other TOML lines (timeout = N, etc.) are accepted as opaque
        // pass-through. We don't validate them; if kimi-code rejects them
        // the probe will catch it.
    }
    if (invalidReason === undefined) {
        if (!foundHooksTable) {
            invalidReason = "block is missing a `[[hooks]]` table";
        }
        else if (!foundEvent) {
            invalidReason = 'block is missing `event = "PreToolUse"`';
        }
        else if (commandPath.length === 0) {
            invalidReason = "block is missing a `command = \"...\"` line";
        }
    }
    return { valid: invalidReason === undefined, invalidReason, commandPath };
}
/**
 * Parse the supplied kimi-code config text and resolve the managed-block
 * state FOR A SPECIFIC HOST.
 *
 * Host resolution: the current host's own suffixed block is authoritative if
 * present; otherwise a lone LEGACY (un-suffixed) block is adoptable and is
 * returned as the found block (the current host will convert it on install).
 * Other hosts' suffixed blocks are ignored for this host's state (that is the
 * whole point of host scoping — they coexist).
 *
 * Stripping line endings before the per-line matchers means this is
 * CRLF-safe — the trailing `\r` on each line is removed before regex
 * comparison.
 */
export function parseManagedBlock(contents, hostId) {
    const rawLines = contents.split("\n");
    const lines = rawLines.map((line) => line.replace(/\r$/, ""));
    const paired = pairBlocks(lines);
    if ("orphan" in paired) {
        return { state: { kind: "orphan", detail: paired.orphan }, blocks: [], lines };
    }
    const blocks = paired.blocks;
    // A block "belongs to" the current host when its marker suffix is this host,
    // OR (for a legacy un-suffixed block) its command path derives to this host —
    // an un-parseable/stale legacy command is claimable by whoever installs next.
    // This is what stops one host from adopting/clobbering another host's legacy
    // block during migration (Kimi review): a `~/.codex/…` legacy block is NOT
    // relevant to the `claude-code` host, so Claude appends its own block and
    // leaves Codex's intact.
    const relevant = blocks.filter((b) => effectiveHost(b, hostId) === hostId);
    if (relevant.length === 0) {
        return { state: { kind: "absent" }, blocks, lines };
    }
    if (relevant.length > 1) {
        return {
            state: { kind: "duplicate", beginLines: relevant.map((b) => b.beginLine) },
            blocks,
            lines,
        };
    }
    const block = relevant[0];
    return {
        state: {
            kind: "found",
            beginLine: block.beginLine,
            endLine: block.endLine,
            hostId: block.hostId,
            commandPath: block.commandPath,
            valid: block.valid,
            invalidReason: block.invalidReason,
        },
        blocks,
        lines,
    };
}
/**
 * The host a managed block belongs to: its marker suffix when present,
 * otherwise the host derived from its command path (a legacy un-suffixed
 * block), falling back to `currentHost` when the command can't be attributed
 * (a stale/bare legacy command — claimable by whoever installs next).
 */
export function effectiveHost(block, currentHost) {
    if (block.hostId !== null)
        return block.hostId;
    return hostIdFromHookCommand(block.commandPath) ?? currentHost;
}
/**
 * Decode the `command = "..."` (or `'...'`) value from a single trimmed TOML
 * line, or `null` if the line isn't a command assignment. Exported so the
 * uninstall path can attribute a legacy block to its host without re-deriving
 * the TOML decode.
 */
export function decodeManagedCommandLine(trimmedLine) {
    const basic = COMMAND_LINE_RE.exec(trimmedLine);
    if (basic !== null)
        return decodeTomlBasicString(basic[1]);
    const literal = COMMAND_LITERAL_LINE_RE.exec(trimmedLine);
    if (literal !== null)
        return literal[1];
    return null;
}
export function evaluateInstalled(contents, expectedCommand, opts) {
    const { state } = parseManagedBlock(contents, opts.hostId);
    if (state.kind === "absent") {
        return { installed: false, reason: "managed block is not present", state };
    }
    if (state.kind === "duplicate") {
        return {
            installed: false,
            reason: `duplicate managed blocks detected at lines ${state.beginLines
                .map((line) => line + 1)
                .join(", ")}. Run /kimi:setup --uninstall, then /kimi:setup.`,
            state,
        };
    }
    if (state.kind === "orphan") {
        return {
            installed: false,
            reason: `${state.detail} marker. Run /kimi:setup --uninstall to clear.`,
            state,
        };
    }
    if (!state.valid) {
        return {
            installed: false,
            reason: state.invalidReason ?? "managed block failed validation",
            state,
        };
    }
    if (state.commandPath !== expectedCommand) {
        const classified = opts.nodeExists !== undefined
            ? describeHookCommandDrift(state.commandPath, expectedCommand, opts.nodeExists)
            : undefined;
        return {
            installed: false,
            reason: classified ??
                `installed block's command does not match the canonical command this companion would write. Run /kimi:setup to refresh. expected ${expectedCommand}; got ${state.commandPath}.`,
            state,
        };
    }
    return { installed: true, state };
}
/**
 * Find orphaned, marker-less `[[hooks]]` tables that are unambiguously THIS
 * plugin's approval hook (canonical `'<node>' '<...>/approval-hook.js'` command
 * under a kimi-marketplace / kimi-plugin-cc tree) and live OUTSIDE any managed
 * BEGIN/END block. These accumulate from pre-v1.7.0 installs whose managed
 * block was overwritten without cleaning the underlying `[[hooks]]` entry, or
 * from host/path churn. Returns half-open line ranges `[start, end)` to strip.
 *
 * A table spans from its `[[hooks]]` header through the contiguous non-blank
 * key lines that follow (stopping at the first blank line, the next TOML table
 * header, or a managed marker). This matches how the block is written (header +
 * event/command/timeout, then a blank separator), so we never swallow adjacent
 * user content.
 */
export function findUnmanagedApprovalHookBlocks(contents) {
    const lines = contents.split("\n").map((line) => line.replace(/\r$/, ""));
    const managed = new Set();
    const paired = pairBlocks(lines);
    if ("blocks" in paired) {
        for (const block of paired.blocks) {
            for (let i = block.beginLine; i <= block.endLine; i += 1)
                managed.add(i);
        }
    }
    const ranges = [];
    for (let i = 0; i < lines.length; i += 1) {
        if (managed.has(i))
            continue;
        if (!HOOKS_TABLE_RE.test(lines[i].trim()))
            continue;
        // Collect the contiguous table body.
        let j = i + 1;
        let commandDecoded = "";
        let hasPreToolUseEvent = false;
        let hasMatcher = false;
        // A table we wrote contains ONLY event/command/timeout (+ comments). If any
        // OTHER key appears — e.g. a multi-line `metadata = [ … ]` array, whose
        // continuation lines would otherwise fool the `[`-boundary check and leave
        // dangling TOML after a partial prune — treat the table as NOT ours and
        // skip it. Conservative by design (Codex review): never partially cut a
        // structure we don't fully recognize.
        let simpleGrammar = true;
        while (j < lines.length) {
            const trimmed = lines[j].trim();
            if (trimmed.length === 0)
                break;
            // Any TOML table header bounds the table — including one with a trailing
            // comment (`[[permission.rules]] # note`). A bare leading `[` is a table
            // header in TOML (value arrays are `key = [...]`), so stop there and
            // never swallow the next table. (Codex review.)
            if (trimmed.startsWith("["))
                break;
            if (BEGIN_LINE_RE.test(trimmed) || END_LINE_RE.test(trimmed))
                break;
            if (trimmed.startsWith("#")) {
                j += 1;
                continue;
            }
            if (EVENT_LINE_RE.test(trimmed)) {
                hasPreToolUseEvent = true;
            }
            else if (MATCHER_LINE_RE.test(trimmed)) {
                hasMatcher = true;
            }
            else {
                const decoded = decodeManagedCommandLine(trimmed);
                if (decoded !== null) {
                    commandDecoded = decoded;
                }
                else if (!TIMEOUT_LINE_RE.test(trimmed)) {
                    // Some key other than event/command/timeout/matcher — not our shape.
                    simpleGrammar = false;
                }
            }
            j += 1;
        }
        // Only prune a table that matches our managed-block grammar EXACTLY: our
        // approval-hook command, `event = "PreToolUse"`, no matcher, and no keys
        // beyond event/command/timeout. (Codex + Kimi review — reduces false
        // positives and avoids corrupting a multi-line-array table.)
        if (simpleGrammar &&
            commandDecoded.length > 0 &&
            hasPreToolUseEvent &&
            !hasMatcher &&
            isOurApprovalHookCommand(commandDecoded)) {
            ranges.push({ start: i, end: j });
        }
    }
    return ranges;
}
export const MARKERS = {
    TAG: MARKER_TAG,
    BEGIN_LINE_RE,
    END_LINE_RE,
};
/**
 * Decode a TOML 1.0 basic-string body (the bytes BETWEEN the quotes —
 * the surrounding `"..."` is stripped by the capture group). Handles
 * the six standard escapes plus `\\` and `\"`. Unknown escapes fall
 * through as-is, mirroring permissive parsers; the canonical command
 * we compare against never contains them, so a mismatch surfaces as
 * "installed: false" rather than a parse error.
 *
 * The inverse of `tomlBasicString` in `runtime/hooks/install-paths.ts`'s
 * sibling helper in setup.ts. Audit re-review (reports 33/34) flagged
 * the missing decode as a verifier false-fail for apostrophe paths.
 */
function decodeTomlBasicString(raw) {
    let out = "";
    for (let i = 0; i < raw.length; i += 1) {
        const ch = raw[i];
        if (ch !== "\\") {
            out += ch;
            continue;
        }
        const next = raw[i + 1];
        if (next === undefined) {
            out += ch;
            continue;
        }
        i += 1;
        switch (next) {
            case "\\":
                out += "\\";
                break;
            case "\"":
                out += "\"";
                break;
            case "b":
                out += "\b";
                break;
            case "t":
                out += "\t";
                break;
            case "n":
                out += "\n";
                break;
            case "f":
                out += "\f";
                break;
            case "r":
                out += "\r";
                break;
            default:
                // Pass unknown escapes through verbatim. The canonical command
                // never produces them, so an inequality surfaces as a benign
                // "installed: false" rather than a parse exception.
                out += `\\${next}`;
        }
    }
    return out;
}
