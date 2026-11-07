// Shared parser for the kimi-plugin-cc managed block in
// ~/.kimi-code/config.toml. Setup and the verifier use this one grammar;
// install-paths.ts separately owns the canonical command bytes and drift
// classification used here after a mismatch.
//
// Claude Code and Codex share the config but install to different paths. The
// marker's `:<host-id>` suffix makes each host own and verify only its block.
// An un-suffixed legacy block can be adopted by the current host on install.
//
// A valid block has this line-oriented shape:
//
//   # === BEGIN kimi-plugin-cc-managed:<host-id> (vX.Y.Z) ===
//   ... optional comments ...
//   [[hooks]]
//   event = "PreToolUse"
//   command = "'/abs/path/to/node' '/abs/path/to/approval-hook.js'"
//   timeout = <integer>
//   # === END kimi-plugin-cc-managed:<host-id> ===
//
// Critical rules:
//
//   - No `matcher` in any TOML spelling: it can disable or narrow the hook.
//   - `event = "PreToolUse"` is required.
//   - Exactly one `[[hooks]]` table appears inside the markers.
//   - The decoded command must equal the canonical expected command byte-for-byte.

import { parse as parseToml } from "../vendor/smol-toml/parse.js";
import {
  classifyHookCommandDrift,
  describeHookCommandDrift,
  hostIdFromHookCommand,
  isOurApprovalHookCommand,
} from "./install-paths.js";

export type ManagedBlockState =
  | { kind: "absent" }
  | {
      kind: "found";
      beginLine: number;
      endLine: number;
      /** Host id parsed from the marker suffix; `null` for a legacy block. */
      hostId: string | null;
      /** The path referenced by `command = "..."`. May be empty if malformed. */
      commandPath: string;
      /** True when the block passes every safety check below. */
      valid: boolean;
      /** When `valid === false`, why. */
      invalidReason?: string;
    }
  | {
      kind: "duplicate";
      /** Line numbers of every BEGIN we found for the resolved host. */
      beginLines: number[];
    }
  | { kind: "orphan"; detail: "BEGIN-without-END" | "END-without-BEGIN" };

/** One well-formed BEGIN/END pair, tagged with its host id. */
export interface ManagedBlockEntry {
  /** Host id from the marker suffix; `null` for a legacy un-suffixed block. */
  hostId: string | null;
  beginLine: number;
  endLine: number;
  commandPath: string;
  valid: boolean;
  invalidReason?: string;
}

const MARKER_TAG = "kimi-plugin-cc-managed";

/**
 * Plain install removes unpaired marker comments for every host and leaves each
 * host's hook table in place. A scoped uninstall removes only this host's
 * markers, so it would disarm a healthy block and keep another host's orphan.
 */
export const ORPHAN_MARKER_REMEDY =
  "Run /kimi:setup (without --uninstall or --check) to repair: install removes orphaned managed marker comments for every host and keeps each host's hook table. A scoped --uninstall does not remove another host's orphan marker. Another tool rewriting ~/.kimi-code/config.toml usually causes this.";

/**
 * Strict BEGIN matcher. Accepts `# === BEGIN kimi-plugin-cc-managed`
 * with an optional `:<host-id>` suffix, an optional ` (vX.Y.Z)` suffix,
 * and trailing ` ===`. Group 1 captures the host id (undefined = legacy).
 * Anything else (random comment containing the tag, mid-line embedded
 * marker) is not a managed-block marker.
 */
const BEGIN_LINE_RE =
  /^#\s*===\s*BEGIN\s+kimi-plugin-cc-managed(?::([A-Za-z0-9._-]+))?(?:\s+\([^)]+\))?\s*===\s*$/;
const END_LINE_RE =
  /^#\s*===\s*END\s+kimi-plugin-cc-managed(?::([A-Za-z0-9._-]+))?\s*===\s*$/;

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

export interface ParsedManagedBlock {
  state: ManagedBlockState;
  /** Every well-formed BEGIN/END pair in the file (all hosts). */
  blocks: ManagedBlockEntry[];
  /** Lines with only a trailing CR removed, used for parsing and debugging. */
  lines: string[];
  /** Unpaired markers suffixed for other hosts; advisory for this host. */
  foreignOrphans: OrphanMarker[];
}

interface MarkerHit {
  index: number;
  kind: "begin" | "end";
  hostId: string | null;
}

// Recognize comment lines lexically, not text inside TOML string values.
// Whole-document parsing remains the authority for TOML validity.
function scanTomlLines(contents: string): { markers: Set<number>; tables: Set<number> } {
  const markers = new Set<number>();
  const tables = new Set<number>();
  let state: "plain" | "basic" | "literal" | "multibasic" | "multiliteral" = "plain";
  let line = 0;
  let blankPrefix = true;
  for (let i = 0; i < contents.length; i += 1) {
    const c = contents[i]!;
    if (c === "\n") { line += 1; blankPrefix = true; continue; }
    const onlyWhitespaceBefore = blankPrefix;
    if (c !== " " && c !== "\t" && c !== "\r") blankPrefix = false;
    if (state === "plain") {
      if (c === "[" && onlyWhitespaceBefore) tables.add(line);
      if (c === "#") {
        if (onlyWhitespaceBefore) {
          const end = contents.indexOf("\n", i);
          const comment = contents.slice(i, end < 0 ? contents.length : end).trim();
          if (BEGIN_LINE_RE.test(comment) || END_LINE_RE.test(comment)) markers.add(line);
        }
        const end = contents.indexOf("\n", i);
        if (end < 0) break;
        i = end - 1;
      } else if (c === '"' || c === "'") {
        const triple = contents.slice(i, i + 3) === c.repeat(3);
        state = c === '"' ? (triple ? "multibasic" : "basic") : (triple ? "multiliteral" : "literal");
        if (triple) i += 2;
      }
    } else {
      const basic = state === "basic" || state === "multibasic";
      const quote = basic ? '"' : "'";
      if (basic && c === "\\") {
        if (contents[i + 1] === "\n") { line += 1; blankPrefix = true; }
        i += 1;
        continue;
      }
      if (c !== quote) continue;
      if (state === "basic" || state === "literal") state = "plain";
      else if (contents.slice(i, i + 3) === quote.repeat(3)) {
        while (contents[i + 1] === quote) i += 1;
        state = "plain";
      }
    }
  }
  return { markers, tables };
}

export function markerCommentLines(contents: string): Set<number> {
  return scanTomlLines(contents).markers;
}

/** Locate every BEGIN/END marker line, in order, with its parsed host id. */
function findMarkers(lines: string[]): MarkerHit[] {
  const hits: MarkerHit[] = [];
  const comments = markerCommentLines(lines.join("\n"));
  for (let i = 0; i < lines.length; i += 1) {
    if (!comments.has(i)) continue;
    const trimmed = lines[i]!.trim();
    const begin = BEGIN_LINE_RE.exec(trimmed);
    if (begin !== null) {
      // Normalize marker host ids so a hand-edited casing difference cannot
      // create a distinct host and confusing duplicate blocks.
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

/** An unpaired managed marker comment. */
export interface OrphanMarker {
  line: number;
  detail: "BEGIN-without-END" | "END-without-BEGIN";
  /** Marker suffix; `null` for a legacy un-suffixed marker. */
  hostId: string | null;
}

/**
 * Pair BEGIN/END markers into well-formed blocks. A block is a BEGIN followed
 * immediately (in marker order) by an END with the same host suffix; every
 * other marker is an orphan. Nested or interleaved markers therefore orphan
 * both sides rather than being guessed into a block. Callers decide which
 * orphans fail closed (see `parseManagedBlock`).
 */
function pairBlocks(lines: string[]): { blocks: ManagedBlockEntry[]; orphans: OrphanMarker[] } {
  const markers = findMarkers(lines);
  const blocks: ManagedBlockEntry[] = [];
  const orphans: OrphanMarker[] = [];
  let i = 0;
  while (i < markers.length) {
    const marker = markers[i]!;
    const next = markers[i + 1];
    if (marker.kind === "begin" && next !== undefined && next.kind === "end" && next.hostId === marker.hostId) {
      const body = validateBlockBody(lines.slice(marker.index + 1, next.index));
      blocks.push({
        hostId: marker.hostId,
        beginLine: marker.index,
        endLine: next.index,
        commandPath: body.commandPath,
        valid: body.valid,
        invalidReason: body.invalidReason,
      });
      i += 2;
      continue;
    }
    orphans.push({
      line: marker.index,
      detail: marker.kind === "begin" ? "BEGIN-without-END" : "END-without-BEGIN",
      hostId: marker.hostId,
    });
    i += 1;
  }
  return { blocks, orphans };
}

/** Validate the lines BETWEEN a BEGIN/END pair against the safety grammar. */
function validateBlockBody(rawBody: string[]): {
  valid: boolean;
  invalidReason?: string;
  commandPath: string;
} {
  const blockLines = rawBody.map((line) => line.trim());
  let foundHooksTable = false;
  let foundEvent = false;
  let commandPath = "";
  let invalidReason: string | undefined;

  for (const line of blockLines) {
    if (line.length === 0 || line.startsWith("#")) continue;
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
      // keeps the verifier from blessing a command-less hook.
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
      // Decode TOML basic-string escapes before comparing with the canonical JS
      // string; literal strings have no escapes. Otherwise shell quoting and
      // TOML escaping can make an equivalent command compare unequal.
      commandPath = basic !== null ? decodeTomlBasicString(basic[1]!) : literal![1]!;
      continue;
    }
    // Other TOML lines are ignored only by this local grammar. Whole-file schema
    // validation and foundHookEntryIsClean reject foreign keys before an
    // installed verdict; the shell probe is not the validation backstop.
  }

  if (invalidReason === undefined) {
    if (!foundHooksTable) {
      invalidReason = "block is missing a `[[hooks]]` table";
    } else if (!foundEvent) {
      invalidReason = 'block is missing `event = "PreToolUse"`';
    } else if (commandPath.length === 0) {
      invalidReason = "block is missing a `command = \"...\"` line";
    }
  }

  // Parser-based matcher rejection backs up the bare-line regex: smol-toml
  // normalizes quoted, literal, and dotted matcher keys that the regex misses,
  // while kimi-code honors them and can disable or narrow the hook. Both this
  // marked-block path and the absent-state fallback must parse the real TOML.
  // Fail closed when the body cannot be parsed in isolation.
  if (invalidReason === undefined) {
    try {
      const parsed = parseToml(rawBody.join("\n"));
      const hooks =
        parsed !== null && typeof parsed === "object"
          ? (parsed as Record<string, unknown>).hooks
          : undefined;
      const hasMatcher =
        Array.isArray(hooks) &&
        hooks.some(
          (entry) =>
            entry !== null &&
            typeof entry === "object" &&
            Object.prototype.hasOwnProperty.call(entry, "matcher"),
        );
      if (hasMatcher) {
        invalidReason =
          "block contains a `matcher` key (in a quoted or dotted spelling the line scanner misses) — kimi-code compiles matchers as JS regex and disables the hook. Reinstall with /kimi:setup to repair.";
      }
    } catch {
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
 * Only a trailing `\r` is removed from each line for CRLF safety; other line
 * whitespace is preserved here and trimmed only by the relevant matchers.
 */
export function parseManagedBlock(contents: string, hostId: string): ParsedManagedBlock {
  const rawLines = contents.split("\n");
  const lines = rawLines.map((line) => line.replace(/\r$/, ""));

  const { blocks, orphans } = pairBlocks(lines);
  // An orphan suffixed for ANOTHER host cannot be part of this host's block:
  // this host's verdict still rests on its own well-formed pair, the whole-file
  // hook-set validation, and the real-parser cleanliness check. Legacy and own
  // orphans stay fail-closed because they may be this host's damaged block.
  const ownOrphan = orphans.find((o) => o.hostId === null || o.hostId === hostId);
  const foreignOrphans = orphans.filter((o) => o.hostId !== null && o.hostId !== hostId);
  if (ownOrphan !== undefined) {
    return { state: { kind: "orphan", detail: ownOrphan.detail }, blocks: [], lines, foreignOrphans };
  }

  // A block belongs to this host when its marker suffix matches or, for a
  // legacy un-suffixed block, its command derives to this host. An unattributable
  // legacy command is claimable by the next installer; a command attributed to
  // another host is ignored so its block remains untouched.
  const relevant = blocks.filter((b) => effectiveHost(b, hostId) === hostId);
  if (relevant.length === 0) {
    return { state: { kind: "absent" }, blocks, lines, foreignOrphans };
  }
  if (relevant.length > 1) {
    return {
      state: { kind: "duplicate", beginLines: relevant.map((b) => b.beginLine) },
      blocks,
      lines,
      foreignOrphans,
    };
  }
  const block = relevant[0]!;
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
    foreignOrphans,
  };
}

/**
 * The host a managed block belongs to: its marker suffix when present,
 * otherwise the host derived from its command path (a legacy un-suffixed
 * block), falling back to `currentHost` when the command can't be attributed
 * (a stale/bare legacy command — claimable by whoever installs next).
 */
export function effectiveHost(block: ManagedBlockEntry, currentHost: string): string {
  if (block.hostId !== null) return block.hostId;
  return hostIdFromHookCommand(block.commandPath) ?? currentHost;
}

/**
 * Decode the `command = "..."` (or `'...'`) value from a single trimmed TOML
 * line, or `null` if the line isn't a command assignment. Exported so the
 * uninstall path can attribute a legacy block to its host without re-deriving
 * the TOML decode.
 */
export function decodeManagedCommandLine(trimmedLine: string): string | null {
  const basic = COMMAND_LINE_RE.exec(trimmedLine);
  if (basic !== null) return decodeTomlBasicString(basic[1]!);
  const literal = COMMAND_LITERAL_LINE_RE.exec(trimmedLine);
  if (literal !== null) return literal[1]!;
  return null;
}

/**
 * Structured installed verdict for `hostId`. `expectedCommand` is the canonical
 * byte string from `buildHookShellCommand`; equality is exact, never a substring
 * check that could bless a command which merely mentions the hook path.
 */
export interface InstalledCheck {
  installed: boolean;
  reason?: string;
  state: ManagedBlockState;
  /**
   * How the installed decision was reached: via this host's marked managed
   * block, or via a marker-less `[[hooks]]` table whose command is byte-exact
   * (`"bare-table"` — the markers were stripped by a kimi-code config rewrite;
   * see `evaluateInstalled`). Absent when `installed === false`.
   */
  via?: "managed-block" | "bare-table";
  /**
   * Advisory context for the `"bare-table"` case — surfaced by `setup --check`
   * as a warning. Never load-bearing for the installed decision.
   */
  note?: string;
  /**
   * Advisory classification of a canonically parseable command mismatch,
   * derived only after exact equality fails. It never changes `installed` and
   * never triggers an in-verifier write or auto-repin. A caller may use it to
   * request setup explicitly and follow the structured retry protocol.
   */
  drift?: HookCommandDrift;
}

/** Machine-readable drift classification. See `InstalledCheck.drift`. */
export interface HookCommandDrift {
  axis: "hook-script" | "node-bin" | "both";
  installedCommand: string;
  expectedCommand: string;
  /**
   * Present only when the Node token differs. True means both spellings name
   * the same file, which makes node-bin/both drift setup-retryable through
   * `retryable_after_setup`; a different interpreter is not auto-repairable.
   */
  nodeInterpreterUnchanged?: boolean;
}

export interface EvaluateInstalledOptions {
  /**
   * Host id from `resolveHostId`; selects this host's block. A lone legacy
   * un-suffixed block is the backward-compatibility fallback.
   */
  hostId: string;
  /**
   * Optional filesystem predicate used only to refine a mismatch reason through
   * `describeHookCommandDrift`. It never changes the installed decision.
   */
  nodeExists?: (binPath: string) => boolean;
}

/**
 * Return `contents` with every well-formed managed BEGIN/END block removed
 * (inclusive), so what remains is only the bare/root TOML. Used by
 * `hasCleanEnforcingHookEntry` to enforce host isolation. Orphan marker lines
 * are comments and stay in place; the caller is only reached in the `absent`
 * state, where a well-formed foreign block is the norm.
 */
function stripManagedBlockLines(contents: string): string {
  const lines = contents.split("\n").map((line) => line.replace(/\r$/, ""));
  const paired = pairBlocks(lines);
  const inBlock = new Set<number>();
  for (const block of paired.blocks) {
    for (let i = block.beginLine; i <= block.endLine; i += 1) inBlock.add(i);
  }
  if (inBlock.size === 0) return contents;
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
function hooksArrayHasCleanEntry(hooks: unknown, expectedCommand: string): boolean {
  if (!Array.isArray(hooks)) return false;
  const allowedKeys = new Set(["event", "command", "timeout"]);
  for (const entry of hooks) {
    if (entry === null || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    if (rec.event !== "PreToolUse") continue;
    if (rec.command !== expectedCommand) continue;
    if (Object.prototype.hasOwnProperty.call(rec, "matcher")) continue;
    if (!Object.keys(rec).every((k) => allowedKeys.has(k))) continue;
    return true;
  }
  return false;
}

/**
 * Parser-based fallback used only in the absent state. Strip every managed
 * block first so another host's live hook cannot count for this host, then parse
 * the remaining bare/root TOML with the real parser rather than the prune line
 * scanner. `hooksArrayHasCleanEntry` requires the exact event and command, no
 * matcher in any spelling, and no foreign keys. Parse errors fail closed.
 * Callers run whole-file schema validation first, including timeout ranges.
 */
export function hasCleanEnforcingHookEntry(
  contents: string,
  expectedCommand: string,
): boolean {
  let parsed: unknown;
  try {
    parsed = parseToml(stripManagedBlockLines(contents));
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object") return false;
  return hooksArrayHasCleanEntry((parsed as Record<string, unknown>).hooks, expectedCommand);
}

/**
 * Whole-file parser check for the FOUND (marked-block present) path. The line
 * grammar in `validateBlockBody` only inspects the lines BETWEEN the BEGIN/END
 * markers — but a `matcher = "*"` (or a stray key) placed AFTER the END comment
 * is still part of the SAME `[[hooks]]` TOML table (comments don't terminate a
 * table), so kimi-code loads it and DISABLES the hook (`new RegExp("*")` throws)
 * while the marked body looks clean → a fail-open `installed:true`. Parsing the
 * whole file exactly as kimi-code does attributes that trailing key to our entry
 * and rejects it. Fail-closed on any parse error.
 */
function foundHookEntryIsClean(contents: string, expectedCommand: string): boolean {
  let parsed: unknown;
  try {
    parsed = parseToml(contents);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object") return false;
  return hooksArrayHasCleanEntry((parsed as Record<string, unknown>).hooks, expectedCommand);
}

export function evaluateInstalled(
  contents: string,
  expectedCommand: string,
  opts: EvaluateInstalledOptions,
): InstalledCheck {
  const { state } = parseManagedBlock(contents, opts.hostId);
  if (state.kind === "absent") {
    // kimi-code config rewrites drop comments but leave hook tables intact. In
    // the absent state only, accept a marker-less table that is exactly this
    // host's clean enforcing hook: markers are not the security boundary, the
    // byte-exact command is. The real TOML parser sees matchers and foreign keys
    // across blank lines, quoted spellings, and multiline values.
    if (hasCleanEnforcingHookEntry(contents, expectedCommand)) {
      return {
        installed: true,
        via: "bare-table",
        note:
          "this host's managed-block markers are missing (kimi-code rewrites its config on login/settings changes and strips all comments), but the hook table with the exact canonical command is present and enforcing. Run /kimi:setup to re-adorn the markers.",
        state,
      };
    }
    // If no exact bare table remains, classify drift only from this host's own
    // stale table so the caller gets an actionable axis.
    const staleOwn = findBareApprovalHookTables(contents).find(
      (table) =>
        table.command !== expectedCommand &&
        isOurApprovalHookCommand(table.command) &&
        hostIdFromHookCommand(table.command) === opts.hostId,
    );
    return {
      installed: false,
      reason: "managed block is not present",
      state,
      ...(staleOwn !== undefined
        ? { drift: classifyHookCommandDrift(staleOwn.command, expectedCommand) }
        : {}),
    };
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
      reason: `${state.detail} marker. ${ORPHAN_MARKER_REMEDY}`,
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
    const classified =
      opts.nodeExists !== undefined
        ? describeHookCommandDrift(state.commandPath, expectedCommand, opts.nodeExists)
        : undefined;
    return {
      installed: false,
      reason:
        classified ??
        `installed block's command does not match the canonical command this companion would write. Run /kimi:setup to refresh. expected ${expectedCommand}; got ${state.commandPath}.`,
      state,
      drift: classifyHookCommandDrift(state.commandPath, expectedCommand),
    };
  }
  if (!foundHookEntryIsClean(contents, expectedCommand)) {
    return {
      installed: false,
      reason:
        "the managed block's hook table carries a matcher or an unexpected key OUTSIDE the marked body (e.g. after the END marker) — kimi-code would load it and disable the hook. Run /kimi:setup --uninstall, then /kimi:setup to repair.",
      state,
    };
  }
  return { installed: true, via: "managed-block", state };
}

/**
 * A marker-less table outside managed blocks that matches the conservative
 * prune line grammar: PreToolUse, a decodable command, optional timeout and
 * comments, no matcher recognized by that scanner, and no foreign keys in its
 * contiguous body. This is not a full TOML-semantic cleanliness proof.
 * `[start, end)` is the conservative half-open deletion range.
 */
export interface BareHookTable {
  start: number;
  end: number;
  command: string;
}

/**
 * Line-oriented PRUNE scanner, never the installed decision; that decision uses
 * the real TOML parser through `hasCleanEnforcingHookEntry` and
 * `foundHookEntryIsClean`.
 *
 * The deletion range `[start, end)` is conservative: only the contiguous
 * non-blank body after `[[hooks]]`, stopping at a blank line, table header, or
 * managed marker so adjacent user content is preserved. A separate full-span
 * scan refuses any further TOML field before the next table, including quoted
 * and dotted keys, so pruning cannot attach those fields to another table.
 * `command` is decoded for the caller's ownership checks.
 */
export function findBareApprovalHookTables(contents: string): BareHookTable[] {
  const lines = contents.split("\n").map((line) => line.replace(/\r$/, ""));
  const tableLines = scanTomlLines(contents).tables;
  const managed = new Set<number>();
  for (const block of pairBlocks(lines).blocks) {
    for (let i = block.beginLine; i <= block.endLine; i += 1) managed.add(i);
  }

  const ranges: BareHookTable[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (managed.has(i)) continue;
    if (!tableLines.has(i) || !HOOKS_TABLE_RE.test(lines[i]!.trim())) continue;
    // Collect the contiguous table body.
    let j = i + 1;
    let commandDecoded = "";
    let hasPreToolUseEvent = false;
    let hasMatcher = false;
    // Our tables contain only event/command/timeout and comments. Any other key,
    // including a multiline array, makes the shape unrecognized so pruning never
    // partially cuts a structure and leaves dangling TOML.
    let simpleGrammar = true;
    while (j < lines.length) {
      const trimmed = lines[j]!.trim();
      if (trimmed.length === 0) break;
      // Any TOML table header bounds the table — including one with a trailing
      // comment (`[[permission.rules]] # note`). A bare leading `[` is a table
      // header in TOML (value arrays are `key = [...]`), so stop there and
      // never swallow the next table.
      if (trimmed.startsWith("[")) break;
      if (BEGIN_LINE_RE.test(trimmed) || END_LINE_RE.test(trimmed)) break;
      if (trimmed.startsWith("#")) {
        j += 1;
        continue;
      }
      if (EVENT_LINE_RE.test(trimmed)) {
        hasPreToolUseEvent = true;
      } else if (MATCHER_LINE_RE.test(trimmed)) {
        hasMatcher = true;
      } else {
        const decoded = decodeManagedCommandLine(trimmed);
        if (decoded !== null) {
          commandDecoded = decoded;
        } else if (!TIMEOUT_LINE_RE.test(trimmed)) {
          // Some key other than event/command/timeout/matcher — not our shape.
          simpleGrammar = false;
        }
      }
      j += 1;
    }
    // Blank lines and marker comments do not end a TOML table. Never leave any
    // field behind to be rebound to a preceding table after pruning, regardless
    // of the field's spelling or whether it is valid for a hook.
    let fieldBeyondBody = false;
    for (let k = j; k < lines.length; k += 1) {
      const t = lines[k]!.trim();
      if (tableLines.has(k)) break;
      if (t.length > 0 && !t.startsWith("#")) {
        fieldBeyondBody = true;
        break;
      }
    }
    // Report only tables matching this conservative line grammar: PreToolUse,
    // a decoded command, no recognized matcher in the TOML span, and no foreign
    // keys in the contiguous body. This is not a full TOML-semantic acceptance
    // check; command and host ownership are the caller's concern.
    if (
      simpleGrammar &&
      commandDecoded.length > 0 &&
      hasPreToolUseEvent &&
      !hasMatcher &&
      !fieldBeyondBody
    ) {
      ranges.push({ start: i, end: j, command: commandDecoded });
    }
  }
  return ranges;
}

/**
 * Find marker-less canonical approval-hook tables outside managed blocks.
 * `ownedBy` restricts results to the host derived from each command and is
 * required for scoped pruning: another host's marker-less table may be its live
 * hook after a config rewrite. Omit `ownedBy` only for the explicit every-host
 * `/kimi:setup --uninstall --all` sweep. Non-canonical and hand-rolled hooks are
 * not claimed.
 */
export function findUnmanagedApprovalHookBlocks(
  contents: string,
  ownedBy?: string,
  alsoMatchCommand?: string,
): BareHookTable[] {
  return findBareApprovalHookTables(contents).filter((table) => {
    // Exact current command bytes are the strongest ownership signal and win
    // even when a host-id override disagrees with path derivation. This does
    // not widen the prune: another host's or a hand-rolled hook has different
    // command bytes.
    if (alsoMatchCommand !== undefined && table.command === alsoMatchCommand) return true;
    if (!isOurApprovalHookCommand(table.command)) return false;
    if (ownedBy === undefined) return true;
    return hostIdFromHookCommand(table.command) === ownedBy;
  });
}

export const MARKERS = {
  TAG: MARKER_TAG,
  BEGIN_LINE_RE,
  END_LINE_RE,
} as const;

/**
 * Decode a TOML 1.0 basic-string body (the bytes BETWEEN the quotes —
 * the surrounding `"..."` is stripped by the capture group). Handles
 * the six standard escapes plus `\\` and `\"`. Unknown escapes fall
 * through as-is, mirroring permissive parsers; the canonical command
 * we compare against never contains them, so a mismatch surfaces as
 * "installed: false" rather than a parse error.
 *
 * Inverse of `tomlBasicString` in `runtime/commands/setup.ts`; decoding before
 * comparison prevents shell/TOML escaping from causing a false mismatch.
 */
function decodeTomlBasicString(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
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
