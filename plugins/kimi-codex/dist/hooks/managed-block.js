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
import { parse as parseToml } from "../vendor/smol-toml/parse.js";
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
    // Parser-based matcher rejection — defense in depth over the line-based
    // MATCHER_LINE_RE above. smol-toml normalizes a quoted `"matcher"`, a literal
    // `'matcher'`, or a dotted key to the `matcher` key that the bare-line regex
    // (`/^matcher\s*=/`) MISSES, while kimi-code's real parser honors it and
    // DISABLES the hook (`new RegExp("*")` throws → fire-for-nothing → auto-
    // approve). The absent-state fallback (`hasCleanEnforcingHookEntry`) already
    // parses and is immune; the primary marked-block path must be too, or a
    // quoted matcher slips a disabled hook past the verifier as `installed:true`.
    // Fail closed on any parse error — a body that won't parse in isolation is
    // anomalous and kimi-code would reject the whole config anyway. (kimi
    // whole-repo audit 2026-07-17.)
    if (invalidReason === undefined) {
        try {
            const parsed = parseToml(rawBody.join("\n"));
            const hooks = parsed !== null && typeof parsed === "object"
                ? parsed.hooks
                : undefined;
            const hasMatcher = Array.isArray(hooks) &&
                hooks.some((entry) => entry !== null &&
                    typeof entry === "object" &&
                    Object.prototype.hasOwnProperty.call(entry, "matcher"));
            if (hasMatcher) {
                invalidReason =
                    "block contains a `matcher` key (in a quoted or dotted spelling the line scanner misses) — kimi-code compiles matchers as JS regex and disables the hook. Reinstall with /kimi:setup to repair.";
            }
        }
        catch {
            invalidReason =
                "block body is not valid TOML in isolation — cannot confirm it carries no hook-disabling matcher. Reinstall with /kimi:setup to repair.";
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
/**
 * Robust, PARSER-based "is our clean enforcing hook present?" check for the
 * marker-less fallback. Parses the whole config with the same vendored
 * `smol-toml` kimi-code uses, then looks for a `hooks[]` entry that is EXACTLY
 * our clean hook:
 *
 *   - `event === "PreToolUse"`,
 *   - `command === expectedCommand` (byte-exact — the security boundary),
 *   - NO `matcher` key in ANY TOML spelling (bare `matcher`, quoted
 *     `"matcher"`, after a blank line, past a multiline array) — a matcher can
 *     disable the hook (`new RegExp("*")` throws → hook never fires) or narrow
 *     it to a subset of tools, so its presence means "not a clean install",
 *   - no keys beyond `{event, command, timeout}` — an unknown key trips
 *     kimi-code's `.strict()` hook schema and disables the whole hooks array.
 *
 * Using the real parser (not the line-oriented `findBareApprovalHookTables`,
 * which stays the conservative PRUNE scanner) closes the entire class of
 * line-scanner blind spots a three-model review panel demonstrated (Opus +
 * Codex + kimi all independently: parse the table, don't lex it). Returns
 * `false` on any parse error — fail-closed. The real callers
 * (`verifyHookInstalled`, `runCheck`) run whole-file schema validation first,
 * so a malformed or foreign-invalid file never reaches an installed verdict.
 *
 * NOTE: this deliberately does NOT range-check `timeout` — that is the config
 * schema's job (run upstream by both callers). A clean entry with an
 * out-of-range timeout is refused there, not here.
 */
/**
 * Return `contents` with every well-formed managed BEGIN/END block removed
 * (inclusive), so what remains is only the bare/root TOML. Used by
 * `hasCleanEnforcingHookEntry` to enforce host isolation. If the markers are
 * unbalanced (orphan), returns the input unchanged — the caller is only reached
 * in the `absent` state, where a well-formed foreign block is the norm.
 */
function stripManagedBlockLines(contents) {
    const lines = contents.split("\n").map((line) => line.replace(/\r$/, ""));
    const paired = pairBlocks(lines);
    if (!("blocks" in paired))
        return contents;
    const inBlock = new Set();
    for (const block of paired.blocks) {
        for (let i = block.beginLine; i <= block.endLine; i += 1)
            inBlock.add(i);
    }
    if (inBlock.size === 0)
        return contents;
    return lines.filter((_, i) => !inBlock.has(i)).join("\n");
}
/**
 * True if a parsed `hooks[]` array contains a clean enforcing entry for
 * `expectedCommand`: `event="PreToolUse"`, byte-exact `command`, NO `matcher`
 * (any spelling the parser normalized to the `matcher` key can disable/narrow
 * the hook), and no keys beyond {event,command,timeout} (a stray key is fatal to
 * kimi-code's strict schema). Each host's hook path is distinct, so the command
 * uniquely identifies this host's entry.
 */
function hooksArrayHasCleanEntry(hooks, expectedCommand) {
    if (!Array.isArray(hooks))
        return false;
    const allowedKeys = new Set(["event", "command", "timeout"]);
    for (const entry of hooks) {
        if (entry === null || typeof entry !== "object")
            continue;
        const rec = entry;
        if (rec.event !== "PreToolUse")
            continue;
        if (rec.command !== expectedCommand)
            continue;
        if (Object.prototype.hasOwnProperty.call(rec, "matcher"))
            continue;
        if (!Object.keys(rec).every((k) => allowedKeys.has(k)))
            continue;
        return true;
    }
    return false;
}
export function hasCleanEnforcingHookEntry(contents, expectedCommand) {
    // Consider only hooks that live OUTSIDE every managed BEGIN/END block. In the
    // `absent` state this host has no block of its own, so any surviving marked
    // block belongs to ANOTHER host — its entries are that host's responsibility,
    // not evidence that THIS host is installed (host isolation). The fallback's
    // whole purpose is to recognize a MARKER-STRIPPED (bare) copy of our own hook,
    // so we strip all marked-block lines, then parse the remainder with the real
    // TOML parser.
    let parsed;
    try {
        parsed = parseToml(stripManagedBlockLines(contents));
    }
    catch {
        return false;
    }
    if (parsed === null || typeof parsed !== "object")
        return false;
    return hooksArrayHasCleanEntry(parsed.hooks, expectedCommand);
}
/**
 * Whole-file parser check for the FOUND (marked-block present) path. The line
 * grammar in `validateBlockBody` only inspects the lines BETWEEN the BEGIN/END
 * markers — but a `matcher = "*"` (or a stray key) placed AFTER the END comment
 * is still part of the SAME `[[hooks]]` TOML table (comments don't terminate a
 * table), so kimi-code loads it and DISABLES the hook (`new RegExp("*")` throws)
 * while the marked body looks clean → a fail-open `installed:true`. Parsing the
 * whole file exactly as kimi-code does attributes that trailing key to our entry
 * and rejects it. Fail-closed on any parse error. (Fable/kimi audit 2026-07-17.)
 */
function foundHookEntryIsClean(contents, expectedCommand) {
    let parsed;
    try {
        parsed = parseToml(contents);
    }
    catch {
        return false;
    }
    if (parsed === null || typeof parsed !== "object")
        return false;
    return hooksArrayHasCleanEntry(parsed.hooks, expectedCommand);
}
export function evaluateInstalled(contents, expectedCommand, opts) {
    const { state } = parseManagedBlock(contents, opts.hostId);
    if (state.kind === "absent") {
        // kimi-code re-serializes config.toml on login/settings writes via a
        // comment-dropping TOML stringifier (`stringifyToml(configToTomlData(...))`
        // in packages/agent-core/src/config/toml.ts — smol-toml has no comment
        // support), which deletes our BEGIN/END markers while leaving the
        // `[[hooks]]` TABLE (data) intact and enforcing. Markers were never the
        // security boundary — the byte-exact canonical command is — so a
        // marker-less table that is EXACTLY our clean enforcing hook still counts
        // as installed. This decision is made against the REAL TOML parser (not a
        // line scanner): a line scanner has TOML-semantic blind spots that a
        // reviewer panel demonstrated let a hook-DISABLING `matcher` hide from it —
        // after a blank line, behind a quoted `"matcher"` key, or past a multiline
        // array value — while kimi-code still honors it (`new RegExp("*")` throws →
        // hook disabled → auto-approve). The parser sees the whole table regardless
        // of layout, so `hasCleanEnforcingHookEntry` is immune to all three.
        if (hasCleanEnforcingHookEntry(contents, expectedCommand)) {
            return {
                installed: true,
                via: "bare-table",
                note: "this host's managed-block markers are missing (kimi-code rewrites its config on login/settings changes and strips all comments), but the hook table with the exact canonical command is present and enforcing. Run /kimi:setup to re-adorn the markers.",
                state,
            };
        }
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
    // The marked body (lines between BEGIN/END) passed the line grammar and the
    // command matches — but confirm with the REAL whole-file parse that no matcher
    // or stray key rides our `[[hooks]]` table from OUTSIDE the markers (e.g. after
    // the END comment, which does not terminate the TOML table). Such a key would
    // load in kimi-code and disable/reject the hook while the body looks clean.
    if (!foundHookEntryIsClean(contents, expectedCommand)) {
        return {
            installed: false,
            reason: "the managed block's hook table carries a matcher or an unexpected key OUTSIDE the marked body (e.g. after the END marker) — kimi-code would load it and disable the hook. Run /kimi:setup --uninstall, then /kimi:setup to repair.",
            state,
        };
    }
    return { installed: true, via: "managed-block", state };
}
/**
 * The line-oriented PRUNE scanner: find bare (marker-less) `[[hooks]]` tables
 * matching our grammar so `findUnmanagedApprovalHookBlocks` can remove them.
 *
 * NOTE: the INSTALLED decision does NOT use this — it uses the real TOML parser
 * (`hasCleanEnforcingHookEntry`), because a line scanner has TOML-semantic
 * blind spots (a `matcher` hidden after a blank line / behind a quoted key /
 * past a multiline array). This scanner is only for computing physical line
 * RANGES to delete, where a conservative, layout-aware view is what we want.
 *
 * `[start, end)` (the range to delete) stays CONSERVATIVE: it covers only the
 * contiguous non-blank body after the `[[hooks]]` header (stopping at the first
 * blank line, next table header, or managed marker), so a prune never swallows
 * adjacent user content past a blank separator. Separately, to avoid leaving a
 * DANGLING `matcher` when a table has one after a blank line, the GRAMMAR check
 * scans the table's full TOML span (to the next header/marker/EOF) for a
 * `matcher` line and, if found, does not report the table at all (so it is
 * never half-cut). `command` is the decoded shell command.
 */
export function findBareApprovalHookTables(contents) {
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
        // CRITICAL (Opus review, HIGH): a blank line does NOT end a TOML table —
        // table membership runs from `[[hooks]]` to the NEXT table header (`[…`) or
        // EOF, across any blank lines. The contiguous loop above stops at the first
        // blank, so a `matcher = "*"` placed AFTER a blank line is still part of
        // this hook table for kimi-code's real parser: it loads (matcher is a
        // schema-valid string, so whole-file validation passes), then throws at
        // `new RegExp("*")` at hook-execution time and SILENTLY DISABLES the hook.
        // If we only checked the contiguous body we'd report `installed: true` for
        // a hook that is actually off — the exact auto-approve bypass this plugin
        // exists to prevent. So scan the REST of the table's TOML span for a
        // matcher and reject the table if one appears anywhere. (The prune line
        // range stays `[start, j)` — conservative, never eating past the blank —
        // because a rejected table is never pruned anyway.) Foreign keys after a
        // blank are NOT re-checked here: an unknown key fails kimi-code's `.strict()`
        // hook schema, so `validateKimiHookSetForEnvironment` rejects the whole file
        // upstream; only `matcher` is schema-valid-but-hook-disabling.
        let matcherBeyondBody = false;
        for (let k = j; k < lines.length; k += 1) {
            const t = lines[k].trim();
            // The current table's TOML span ends at the next table header or a
            // managed marker; a matcher past that point belongs to a different table.
            if (t.startsWith("[") || BEGIN_LINE_RE.test(t) || END_LINE_RE.test(t))
                break;
            if (MATCHER_LINE_RE.test(t)) {
                matcherBeyondBody = true;
                break;
            }
        }
        // Only report a table that matches our managed-block grammar EXACTLY:
        // `event = "PreToolUse"`, no matcher anywhere in its TOML span, and no keys
        // beyond event/command/timeout in the contiguous body. (Codex + Kimi review
        // — reduces false positives and avoids corrupting a multi-line-array table.)
        // Command-identity filtering (ours? whose host?) is the caller's concern —
        // see `findUnmanagedApprovalHookBlocks` and `evaluateInstalled`.
        if (simpleGrammar &&
            commandDecoded.length > 0 &&
            hasPreToolUseEvent &&
            !hasMatcher &&
            !matcherBeyondBody) {
            ranges.push({ start: i, end: j, command: commandDecoded });
        }
    }
    return ranges;
}
/**
 * Find orphaned, marker-less `[[hooks]]` tables that are unambiguously THIS
 * plugin's approval hook (canonical `'<node>' '<...>/approval-hook.js'` command
 * under a kimi-marketplace / kimi-plugin-cc tree) and live OUTSIDE any managed
 * BEGIN/END block. These arise when a kimi-code config rewrite strips the
 * marker comments off a live block (kimi-code's TOML stringifier drops all
 * comments), or from pre-v1.7.0 installs / host-path churn.
 *
 * HOST SCOPING (v1.8.2): pass `ownedBy` (a host id from `resolveHostId`) to
 * restrict the result to tables whose command path derives to THAT host via
 * `hostIdFromHookCommand`. Pruning MUST pass it — after a kimi-code comment
 * strip, another host's marker-less table is that host's LIVE hook, and a
 * host-blind prune silently disarms it (the pre-v1.8.2 seesaw: each host's
 * setup deleted the other's enforcement). Omitting `ownedBy` is the explicit
 * every-host sweep reserved for `/kimi:setup --uninstall --all`.
 */
export function findUnmanagedApprovalHookBlocks(contents, ownedBy, alsoMatchCommand) {
    return findBareApprovalHookTables(contents).filter((table) => {
        // A table whose command byte-equals what THIS host would write is
        // unambiguously this host's own (marker-stripped) hook — the tightest
        // possible ownership signal, stronger than any path derivation. Match it
        // regardless of `ownedBy`, so the install re-adorn works even when a
        // `KIMI_PLUGIN_CC_HOST_ID` override disagrees with the path-derived host
        // (`hostIdFromHookCommand`) — otherwise setup would append a duplicate
        // block beside the identical bare table (Kimi review F4). Never widens the
        // prune: another host's table and a hand-rolled hook carry different
        // commands, so they never equal this host's canonical command.
        if (alsoMatchCommand !== undefined && table.command === alsoMatchCommand)
            return true;
        if (!isOurApprovalHookCommand(table.command))
            return false;
        if (ownedBy === undefined)
            return true;
        return hostIdFromHookCommand(table.command) === ownedBy;
    });
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
