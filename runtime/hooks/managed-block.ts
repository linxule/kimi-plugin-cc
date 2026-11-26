// Shared parser for the canonical kimi-plugin-cc managed block in
// ~/.kimi-code/config.toml. Setup and the verifier use this one grammar;
// install-paths.ts separately owns the canonical command bytes and drift
// classification used here after a mismatch.
//
// A valid block has this line-oriented shape:
//
//   # === BEGIN kimi-plugin-cc-managed (vX.Y.Z) ===
//   ... optional comments ...
//   [[hooks]]
//   event = "PreToolUse"
//   command = "'/abs/path/to/node' '/abs/path/to/approval-hook.js'"
//   timeout = <integer>
//   # === END kimi-plugin-cc-managed ===
//
// Critical rules:
//
//   - No `matcher` in any TOML spelling: it can disable or narrow the hook.
//   - `event = "PreToolUse"` is required.
//   - Exactly one `[[hooks]]` table appears inside the markers.
//   - The decoded command must equal the canonical expected command byte-for-byte.
//   - Every PreToolUse entry with that command needs an effective timeout of at
//     least HOOK_TIMEOUT_S (checked on the whole-file parse).

import { parse as parseToml } from "../vendor/smol-toml/parse.js";
import {
  classifyHookCommandDrift,
  describeHookCommandDrift,
  isOurApprovalHookCommand,
} from "./install-paths.js";
import { HOOK_TIMEOUT_S, hookTimeoutEnforces } from "./hook-timing.js";

export type ManagedBlockState =
  | { kind: "absent" }
  | {
      kind: "found";
      beginLine: number;
      endLine: number;
      /** Legacy host suffix parsed from an older block, or `null` for the canonical block. */
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
      /** Line numbers of every BEGIN we found. */
      beginLines: number[];
    }
  | { kind: "orphan"; detail: "BEGIN-without-END" | "END-without-BEGIN" };

/** One well-formed BEGIN/END pair (canonical or legacy suffixed). */
export interface ManagedBlockEntry {
  /** Legacy host suffix; `null` for the canonical un-suffixed block. */
  hostId: string | null;
  beginLine: number;
  endLine: number;
  commandPath: string;
  valid: boolean;
  invalidReason?: string;
}

const MARKER_TAG = "kimi-plugin-cc-managed";

export const ORPHAN_MARKER_REMEDY =
  "Run `kimi_setup` (with action \"install\") or `scripts/companion.sh setup` (without --uninstall or --check) to repair orphaned managed marker comments while preserving existing hook tables.";

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
  /** Every well-formed BEGIN/END pair in the file. */
  blocks: ManagedBlockEntry[];
  /** Lines with only a trailing CR removed, used for parsing and debugging. */
  lines: string[];
  /** Unpaired managed marker comments. */
  orphans: OrphanMarker[];
}

interface MarkerHit {
  index: number;
  kind: "begin" | "end";
  hostId: string | null;
}

// Recognize comment lines lexically, not text inside TOML string values.
// Whole-document parsing remains the authority for TOML validity.
export function scanTomlLines(contents: string): { markers: Set<number>; tables: Set<number> } {
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
export function pairBlocks(lines: string[]): { blocks: ManagedBlockEntry[]; orphans: OrphanMarker[] } {
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
        "block contains an unexpected TOML table — only a single [[hooks]] table is allowed. Reinstall with setup to repair.";
      break;
    }
    if (MATCHER_LINE_RE.test(line)) {
      invalidReason =
        'block contains a `matcher = ...` line — kimi-code compiles matchers as JS regex (`new RegExp("*")` throws and disables the hook). Reinstall with setup to repair.';
      break;
    }
    if (EVENT_LINE_RE.test(line)) {
      foundEvent = true;
      continue;
    }
    // Decode TOML basic-string escapes before comparing with the canonical JS
    // string; literal strings have no escapes. Otherwise shell quoting and
    // TOML escaping can make an equivalent command compare unequal.
    const decoded = decodeManagedCommandLine(line);
    if (decoded !== null) {
      commandPath = decoded;
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
          "block contains a `matcher` key (in a quoted or dotted spelling the line scanner misses) — kimi-code compiles matchers as JS regex and disables the hook. Reinstall with setup to repair.";
      }
    } catch {
      invalidReason =
        "block body is not valid TOML in isolation — cannot confirm it carries no hook-disabling matcher. Reinstall with setup to repair.";
    }
  }

  return { valid: invalidReason === undefined, invalidReason, commandPath };
}

/**
 * Parse the supplied kimi-code config text and resolve the canonical
 * managed-block state (accepting either the canonical un-suffixed block or a
 * single legacy `:<host-id>` block from an older install).
 */
export function parseManagedBlock(contents: string, _hostId?: string): ParsedManagedBlock {
  const rawLines = contents.split("\n");
  const lines = rawLines.map((line) => line.replace(/\r$/, ""));

  const { blocks, orphans } = pairBlocks(lines);
  if (orphans.length > 0) {
    return { state: { kind: "orphan", detail: orphans[0]!.detail }, blocks: [], lines, orphans };
  }

  if (blocks.length === 0) {
    return { state: { kind: "absent" }, blocks, lines, orphans };
  }
  if (blocks.length > 1) {
    return {
      state: { kind: "duplicate", beginLines: blocks.map((b) => b.beginLine) },
      blocks,
      lines,
      orphans,
    };
  }
  const block = blocks[0]!;
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
    orphans,
  };
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
  /** Set when the only defect is a timeout kimi-code would not wait out; plain setup rewrites it. */
  timeoutTooShort?: true;
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
  /**
   * True when `KIMI_PLUGIN_CC_DATA` overrides the data root while the installed
   * hook points at the default shared canonical hook (`retryable_after_setup: false`).
   */
  dataOverrideFromCanonical?: true;
}

export interface EvaluateInstalledOptions {
  /** Retained as optional no-op for caller compatibility. */
  hostId?: string;
  /**
   * Optional filesystem predicate used only to refine a mismatch reason through
   * `describeHookCommandDrift`. It never changes the installed decision.
   */
  nodeExists?: (binPath: string) => boolean;
  /** Caller environment for classifying `KIMI_PLUGIN_CC_DATA` override drift. */
  env?: NodeJS.ProcessEnv;
}

/**
 * True if a parsed `hooks[]` array contains a clean enforcing entry for
 * `expectedCommand`: `event="PreToolUse"`, byte-exact `command`, NO `matcher`
 * (any spelling the parser normalized to the `matcher` key can disable/narrow
 * the hook), no keys beyond {event,command,timeout} (a stray key is fatal to
 * kimi-code's strict schema), and a timeout kimi-code waits out. Each host's
 * hook path is distinct, so the command uniquely identifies this host's entry.
 */
function countCleanEntries(hooks: unknown, expectedCommand: string): number {
  if (!Array.isArray(hooks)) return 0;
  const allowedKeys = new Set(["event", "command", "timeout"]);
  let count = 0;
  for (const entry of hooks) {
    if (entry === null || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    if (rec.event !== "PreToolUse") continue;
    if (rec.command !== expectedCommand) continue;
    if (Object.prototype.hasOwnProperty.call(rec, "matcher")) continue;
    if (!Object.keys(rec).every((k) => allowedKeys.has(k))) continue;
    if (!hookTimeoutEnforces(rec.timeout)) continue;
    count += 1;
  }
  return count;
}

/** Clean entries in the whole file's parsed `hooks[]`; 0 when it does not parse. */
export function countCleanEntriesInFile(contents: string, expectedCommand: string): number {
  let parsed: unknown;
  try {
    parsed = parseToml(contents);
  } catch {
    return 0;
  }
  if (parsed === null || typeof parsed !== "object") return 0;
  return countCleanEntries((parsed as Record<string, unknown>).hooks, expectedCommand);
}

/**
 * The first PreToolUse entry with this exact command whose timeout kimi-code
 * would not wait out, in whole-file parse order (a `timeout` after the END
 * marker binds to the same table). kimi-code runs only the first entry per
 * command, after matcher filtering, so a short copy anywhere can be the one
 * that runs and its timeout is read as allow. `null` when every copy enforces
 * or the file does not parse; parse failures already fail closed elsewhere.
 */
export function findShortHookTimeout(
  contents: string,
  expectedCommand: string,
): { timeout: unknown } | null {
  let parsed: unknown;
  try {
    parsed = parseToml(contents);
  } catch {
    return null;
  }
  const hooks = (parsed as Record<string, unknown> | null)?.hooks;
  if (!Array.isArray(hooks)) return null;
  for (const entry of hooks) {
    if (entry === null || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    if (rec.event !== "PreToolUse" || rec.command !== expectedCommand) continue;
    if (!hookTimeoutEnforces(rec.timeout)) return { timeout: rec.timeout };
  }
  return null;
}

/** `timeout = <value>` as written, for diagnoses. */
export function describeHookTimeout(timeout: unknown): string {
  const shown = typeof timeout === "number" || typeof timeout === "bigint" ? String(timeout) : JSON.stringify(timeout);
  return `timeout = ${shown}`;
}

export function hookTimeoutReason(timeout: unknown): string {
  return `the managed hook entry has ${describeHookTimeout(timeout)}; kimi-code reads a hook that runs past its timeout as allow, so the entry needs a timeout of at least ${HOOK_TIMEOUT_S} seconds. Run kimi_setup (or scripts/companion.sh setup) to rewrite it; setup leaves the config unchanged and names any copy it cannot rewrite.`;
}

/**
 * Parser-based fallback used only in the absent state. Parse the WHOLE file
 * exactly as kimi-code does: deleting managed-block lines first would change
 * which table their keys bind to (a `matcher` written before another host's
 * `[[hooks]]` header belongs to the preceding table, possibly this host's bare
 * one). Host isolation is kept by counting: every managed block whose body
 * carries this exact command may account for one clean entry, so only a clean
 * entry beyond those can be this host's marker-less table. Requires the exact
 * event and command, no matcher in any spelling, and no foreign keys. Parse
 * errors fail closed. Callers run whole-file schema validation first.
 */
export function hasCleanEnforcingHookEntry(
  contents: string,
  expectedCommand: string,
): boolean {
  const lines = contents.split("\n").map((line) => line.replace(/\r$/, ""));
  const managedWithCommand = pairBlocks(lines).blocks.filter(
    (block) => block.commandPath === expectedCommand,
  ).length;
  return countCleanEntriesInFile(contents, expectedCommand) > managedWithCommand;
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
  return countCleanEntriesInFile(contents, expectedCommand) > 0;
}

export function evaluateInstalled(
  contents: string,
  expectedCommand: string,
  opts: EvaluateInstalledOptions = {},
): InstalledCheck {
  const { state, blocks } = parseManagedBlock(contents);
  const shortTimeout = findShortHookTimeout(contents, expectedCommand);
  const timeoutRefusal = (): InstalledCheck => ({
    installed: false,
    reason: hookTimeoutReason(shortTimeout!.timeout),
    state,
    timeoutTooShort: true,
  });
  if (state.kind === "absent") {
    if (shortTimeout !== null) return timeoutRefusal();
    // kimi-code config rewrites drop comments but leave hook tables intact. In
    // the absent state only, accept a marker-less table that is exactly our
    // clean enforcing hook: markers are not the security boundary, the
    // byte-exact command is.
    if (hasCleanEnforcingHookEntry(contents, expectedCommand)) {
      return {
        installed: true,
        via: "bare-table",
        note:
          "managed-block markers are missing (kimi-code rewrites its config on login/settings changes and strips all comments), but the hook table with the exact canonical command is present and enforcing. Run `kimi_setup` or `scripts/companion.sh setup` to re-adorn the markers.",
        state,
      };
    }
    const staleOwn = findBareApprovalHookTables(contents).find(
      (table) => table.command !== expectedCommand && isOurApprovalHookCommand(table.command),
    );
    const bareDrift =
      staleOwn !== undefined ? classifyHookCommandDrift(staleOwn.command, expectedCommand, undefined, opts.env) : undefined;
    const bareOverrideReason =
      bareDrift?.dataOverrideFromCanonical === true && opts.nodeExists !== undefined
        ? describeHookCommandDrift(staleOwn!.command, expectedCommand, opts.nodeExists, undefined, opts.env)
        : undefined;
    return {
      installed: false,
      reason: bareOverrideReason ?? "managed block is not present",
      state,
      ...(bareDrift !== undefined ? { drift: bareDrift } : {}),
    };
  }
  if (state.kind === "duplicate") {
    const hasLegacyBlock = blocks.some((entry) => entry.hostId !== null);
    return {
      installed: false,
      reason: hasLegacyBlock
        ? `duplicate managed blocks detected at lines ${state.beginLines
            .map((line) => line + 1)
            .join(", ")} (including legacy host-scoped block(s)). Run \`kimi_setup\` (action "install") or \`scripts/companion.sh setup\` to consolidate them into one canonical block.`
        : `duplicate managed blocks detected at lines ${state.beginLines
            .map((line) => line + 1)
            .join(", ")}. Run \`scripts/companion.sh setup --uninstall\`, then setup again.`,
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
        ? describeHookCommandDrift(state.commandPath, expectedCommand, opts.nodeExists, undefined, opts.env)
        : undefined;
    return {
      installed: false,
      reason:
        classified ??
        `installed block's command does not match the canonical command this companion would write. Run setup to refresh. expected ${expectedCommand}; got ${state.commandPath}.`,
      state,
      drift: classifyHookCommandDrift(state.commandPath, expectedCommand, undefined, opts.env),
    };
  }
  if (shortTimeout !== null) return timeoutRefusal();
  if (!foundHookEntryIsClean(contents, expectedCommand)) {
    return {
      installed: false,
      reason:
        "the managed block's hook table carries a matcher or an unexpected key OUTSIDE the marked body (e.g. after the END marker) — kimi-code would load it and disable the hook. Run `scripts/companion.sh setup --uninstall`, then setup to repair.",
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
 * Non-canonical and hand-rolled hooks are never matched.
 */
export function findUnmanagedApprovalHookBlocks(
  contents: string,
  alsoMatchCommand?: string,
): BareHookTable[] {
  return findBareApprovalHookTables(contents).filter((table) => {
    if (alsoMatchCommand !== undefined && table.command === alsoMatchCommand) return true;
    return isOurApprovalHookCommand(table.command);
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
