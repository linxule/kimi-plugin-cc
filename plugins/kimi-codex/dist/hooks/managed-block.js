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
// What a valid managed block looks like (line-by-line, post-trim):
//
//   # === BEGIN kimi-plugin-cc-managed (vX.Y.Z) ===
//   ... optional comment lines (any number, any content) ...
//   [[hooks]]
//   event = "PreToolUse"
//   command = "node 'absolute/path/to/approval-hook.js'"  (or process.execPath form)
//   timeout = <integer>
//   # === END kimi-plugin-cc-managed ===
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
import { describeHookCommandDrift } from "./install-paths.js";
const MARKER_TAG = "kimi-plugin-cc-managed";
/**
 * Strict BEGIN matcher. Accepts `# === BEGIN kimi-plugin-cc-managed`
 * with an optional ` (vX.Y.Z)` suffix and trailing ` ===`. Anything
 * else (random comment containing the tag, mid-line embedded marker)
 * is not a managed-block marker.
 */
const BEGIN_LINE_RE = /^#\s*===\s*BEGIN\s+kimi-plugin-cc-managed(?:\s+\([^)]+\))?\s*===\s*$/;
const END_LINE_RE = /^#\s*===\s*END\s+kimi-plugin-cc-managed\s*===\s*$/;
/** TOML basic string for `command = "..."`. Captures the inner value. */
const COMMAND_LINE_RE = /^command\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/;
/** TOML literal string for `command = '...'` (no escapes inside). */
const COMMAND_LITERAL_LINE_RE = /^command\s*=\s*'([^']*)'\s*$/;
const EVENT_LINE_RE = /^event\s*=\s*"PreToolUse"\s*$/;
/** Anything matcher-shaped is a critical safety failure — block disabled. */
const MATCHER_LINE_RE = /^matcher\s*=/;
const HOOKS_TABLE_RE = /^\[\[hooks\]\]\s*$/;
/**
 * Parse the supplied kimi-code config text for the managed block.
 *
 * Stripping line endings before the per-line matchers means this is
 * CRLF-safe — the trailing `\r` on each line is removed before regex
 * comparison.
 */
export function parseManagedBlock(contents) {
    const rawLines = contents.split("\n");
    const lines = rawLines.map((line) => line.replace(/\r$/, ""));
    const beginLines = [];
    for (let i = 0; i < lines.length; i += 1) {
        if (BEGIN_LINE_RE.test(lines[i].trim())) {
            beginLines.push(i);
        }
    }
    const endLines = [];
    for (let i = 0; i < lines.length; i += 1) {
        if (END_LINE_RE.test(lines[i].trim())) {
            endLines.push(i);
        }
    }
    if (beginLines.length === 0 && endLines.length === 0) {
        return { state: { kind: "absent" }, lines };
    }
    if (beginLines.length > 1) {
        return { state: { kind: "duplicate", beginLines }, lines };
    }
    if (beginLines.length === 1 && endLines.length === 0) {
        return { state: { kind: "orphan", detail: "BEGIN-without-END" }, lines };
    }
    if (beginLines.length === 0 && endLines.length >= 1) {
        return { state: { kind: "orphan", detail: "END-without-BEGIN" }, lines };
    }
    const beginLine = beginLines[0];
    // First END after BEGIN. Any END before BEGIN was caught above.
    const endLine = endLines.find((line) => line > beginLine) ?? -1;
    if (endLine === -1) {
        return { state: { kind: "orphan", detail: "BEGIN-without-END" }, lines };
    }
    // A second END line after the canonical pair is suspicious — likely
    // a stray marker from a manual edit. We don't fail outright, but the
    // canonical block is the first pair.
    const blockLines = lines.slice(beginLine + 1, endLine).map((line) => line.trim());
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
    return {
        state: {
            kind: "found",
            beginLine,
            endLine,
            commandPath,
            valid: invalidReason === undefined,
            invalidReason,
        },
        lines,
    };
}
export function evaluateInstalled(contents, expectedCommand, opts) {
    const { state } = parseManagedBlock(contents);
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
        const classified = opts?.nodeExists !== undefined
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
