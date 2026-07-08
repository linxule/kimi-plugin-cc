// Shared canonical-path helpers for the kimi-plugin-cc PreToolUse hook.
//
// Why a separate module:
//
//   `runtime/commands/setup.ts` is the installer; `runtime/hooks/install.ts`
//   is the per-call verifier. Audit (reports 27 + 28) found two
//   convergent issues:
//
//     1. The verifier's drift gate was opt-in (callers had to pass
//        `expectedHookPath`). rescue.ts called it WITHOUT the path, so
//        a managed block referencing a stale hook script silently passed.
//        kimi-code's spawn of the stale path exited 127 (or
//        MODULE_NOT_FOUND), which the hook runner treats as ALLOW —
//        rescue's workspace-bound allowlist bypassed in production.
//
//     2. Even when callers DID pass `expectedHookPath`, the verifier
//        used `commandPath.includes(expectedHookPath)` (substring), so a
//        crafted command like `true # /path/to/approval-hook.js` would
//        pass: `/bin/sh -c "true # ..."` runs only `true` (exit 0,
//        no-op allow), then kimi-code treats exit 0 as ALLOW.
//
//   Fix: every verifier path now reconstructs the canonical expected
//   shell command from the resolved Node binary + hook script path, and
//   does EXACT equality. This module owns the single source of truth for
//   how that command is built.
//
//   Both setup.ts (write side) and install.ts (verify side) import from
//   here. The probe in setup.ts also uses `buildHookShellCommand` so the
//   shell probe runs the exact byte string the managed block writes.
//   These three call sites cannot drift without a compile error.

import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RuntimeError } from "../errors.js";

/**
 * Resolve the absolute path to the Node binary used in the PreToolUse
 * hook command. kimi-code spawns hooks via `/bin/sh -c "<command>"`; a
 * bare `node` would rely on the shell's PATH at execution time, which
 * fails under GUI/LaunchAgent launches with sanitized PATH. Require an
 * absolute path — either the in-process `process.execPath` or an
 * explicit `KIMI_PLUGIN_CC_NODE_BIN` override.
 */
export function resolveNodeBinary(env: NodeJS.ProcessEnv): string {
  const override = env.KIMI_PLUGIN_CC_NODE_BIN;
  if (override === undefined || override.length === 0) {
    return process.execPath;
  }
  if (!path.isAbsolute(override)) {
    throw new RuntimeError(
      "SETUP_NODE_BIN_NOT_ABSOLUTE",
      [
        `KIMI_PLUGIN_CC_NODE_BIN must be an absolute path; got ${JSON.stringify(override)}.`,
        `kimi-code spawns hooks via /bin/sh -c, where a bare command relies on the shell's PATH at hook execution time.`,
        `Use an absolute path so the hook keeps firing under sanitized-PATH launches.`,
      ].join(" "),
      "setup.node-bin",
      { details: { override } },
    );
  }
  return override;
}

/**
 * Build the exact shell command string that `/bin/sh -c "<command>"`
 * needs to spawn the hook. Single source of truth for:
 *
 *   - what `/kimi:setup` writes into kimi-code's config
 *     (`command = "..."` inside [[hooks]])
 *   - what the shell probe runs via `spawn("/bin/sh", ["-c", ...])`
 *   - what the verifier (`evaluateInstalled`) equality-checks the
 *     installed `command = "..."` against on every command spawn
 *
 * Single-quoting both tokens means a path containing spaces or
 * apostrophes round-trips cleanly. The probe and managed block ARE the
 * same byte string — drift between them would break safety.
 */
export function buildHookShellCommand(
  hookScriptPath: string,
  env: NodeJS.ProcessEnv,
): string {
  const nodeBin = resolveNodeBinary(env);
  return `${shellSingleQuote(nodeBin)} ${shellSingleQuote(hookScriptPath)}`;
}

/**
 * POSIX shell single-quote a string. Inner `'` are escaped as `'\''`
 * (close-quote, escaped quote, re-open-quote). Always safe — no shell
 * metacharacters survive the encoding.
 */
export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Resolve the absolute path to the compiled hook script.
 *
 * Resolution order:
 *
 *   1. `KIMI_PLUGIN_CC_HOOK_SCRIPT` override — tests / advanced users.
 *   2. Sibling resolution from this file's URL. This module lives at
 *      `<root>/{runtime,dist}/hooks/install-paths.{ts,js}`. The hook
 *      artifact lives at `<root>/dist/hooks/approval-hook.js`. Walk up
 *      to `<root>` and append the canonical hook artifact path.
 */
export function resolveHookScriptPath(env: NodeJS.ProcessEnv): string {
  const override = env.KIMI_PLUGIN_CC_HOOK_SCRIPT;
  if (override !== undefined && override.length > 0) {
    if (!path.isAbsolute(override)) {
      // kimi-code spawns hooks via `/bin/sh -c "<command>"` with a
      // cwd that may not match the companion's. A relative path here
      // would resolve against the kimi-code shell's working dir at
      // hook execution time — different from the path resolved at
      // install time. The mismatch would let the verifier bless a
      // path that doesn't actually run. Match the NODE_BIN_NOT_ABSOLUTE
      // contract by requiring an absolute override. Audit re-review
      // (report 34 Codex MEDIUM) flagged this.
      throw new RuntimeError(
        "SETUP_HOOK_SCRIPT_NOT_ABSOLUTE",
        [
          `KIMI_PLUGIN_CC_HOOK_SCRIPT must be an absolute path; got ${JSON.stringify(override)}.`,
          `kimi-code spawns hooks via /bin/sh -c with a cwd that may differ from the companion's.`,
          `Use an absolute path so the verifier and the runtime spawn refer to the same file.`,
        ].join(" "),
        "setup.hook-script-path",
        { details: { override } },
      );
    }
    return override;
  }
  const here = fileURLToPath(import.meta.url);
  const parts = here.split(path.sep);
  // Pin to the canonical suffix `{runtime|dist}/hooks/install-paths.{ts,js}`
  // — anchoring to a specific tail keeps ancestor directories named
  // "runtime" or "dist" from confusing the lookup.
  if (parts.length < 3) {
    throw resolveHookFailure(here);
  }
  const tailParent = parts[parts.length - 2];
  const tailGrandparent = parts[parts.length - 3];
  if (tailParent !== "hooks" || (tailGrandparent !== "runtime" && tailGrandparent !== "dist")) {
    throw resolveHookFailure(here);
  }
  const pluginRoot = parts.slice(0, parts.length - 3).join(path.sep) || path.sep;
  return path.join(pluginRoot, "dist", "hooks", "approval-hook.js");
}

function resolveHookFailure(here: string): RuntimeError {
  return new RuntimeError(
    "SETUP_RESOLVE_HOOK_FAILED",
    `Could not infer plugin root from install-paths module path ${here}. Set KIMI_PLUGIN_CC_HOOK_SCRIPT to the absolute path of dist/hooks/approval-hook.js.`,
    "setup.resolve-hook",
    { details: { here } },
  );
}

/**
 * Parse a hook shell command of the canonical `'<nodeBin>' '<hookScript>'`
 * shape (two POSIX single-quoted tokens, space-separated) back into its two
 * tokens. The exact inverse of `buildHookShellCommand` →
 * `shellSingleQuote(nodeBin) + " " + shellSingleQuote(hookScript)`.
 *
 * Returns `null` for any command that isn't exactly two single-quoted tokens
 * (e.g. a legacy bare-`node` form, a crafted/garbage command, or anything with
 * unquoted bare words) — callers treat `null` as "can't classify; use the
 * generic mismatch message". Strict by design: it only recognizes the canonical
 * single-quoted form this module emits, so it never mis-attributes a hand-rolled
 * command's tokens. Tokens with embedded spaces or apostrophes round-trip
 * (spaces live inside the quotes; `'` is encoded as `'\''`).
 */
export function parseHookShellCommand(
  command: string,
): { nodeBin: string; hookScript: string } | null {
  const tokens = parseSingleQuotedTokens(command);
  if (tokens === null || tokens.length !== 2) {
    return null;
  }
  return { nodeBin: tokens[0]!, hookScript: tokens[1]! };
}

/**
 * Tokenize a string of POSIX single-quoted tokens as produced by
 * `shellSingleQuote` (`'...'` with inner `'` encoded as `'\''`). Returns the
 * decoded token list, or `null` if the input contains any unquoted bare
 * character or an unterminated quote — i.e. anything outside the grammar this
 * module emits.
 */
function parseSingleQuotedTokens(input: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    if (input[i] === " ") {
      i += 1;
      continue;
    }
    let token = "";
    let consumedAny = false;
    while (i < n && input[i] !== " ") {
      const ch = input[i]!;
      if (ch === "'") {
        // A '...'  quoted segment. Single-quoted content can never contain a
        // literal "'", so the next "'" is always the real close.
        const close = input.indexOf("'", i + 1);
        if (close === -1) return null; // unterminated quote
        token += input.slice(i + 1, close);
        i = close + 1;
        consumedAny = true;
      } else if (ch === "\\") {
        // The `\'` half of a `'\''` escape (an apostrophe in the value).
        if (i + 1 >= n) return null;
        token += input[i + 1]!;
        i += 2;
        consumedAny = true;
      } else {
        // A bare unquoted character — not part of the canonical grammar.
        return null;
      }
    }
    if (!consumedAny) return null;
    tokens.push(token);
  }
  return tokens;
}

/**
 * H4 — classify a hook-command MISMATCH into an actionable diagnosis. When the
 * managed block is structurally valid but its `command` differs from what this
 * companion would write, the raw "expected X; got Y" dump is hard to act on. The
 * common real cause is environment drift: a Node upgrade or version-manager
 * (nvm/asdf/mise/fnm/Homebrew) switch moved the pinned interpreter, or a plugin
 * update changed the version-stamped hook-script path. This names which token
 * drifted and, for Node, whether the old binary still exists on disk (a gone
 * binary is the unambiguous "your Node moved" signal).
 *
 * Returns `undefined` when it can't classify (either command isn't the canonical
 * two-single-quoted-token shape, or the tokens are somehow equal) — the caller
 * then falls back to the generic mismatch message. Pure except for the injected
 * `nodeExists` predicate (so the fs probe stays at the call site). Does NOT alter
 * the verifier's exact-equality decision — only the human/LLM-facing reason.
 */
export function describeHookCommandDrift(
  installedCommand: string,
  expectedCommand: string,
  nodeExists: (binPath: string) => boolean,
): string | undefined {
  const installed = parseHookShellCommand(installedCommand);
  const expected = parseHookShellCommand(expectedCommand);
  if (installed === null || expected === null) {
    return undefined;
  }
  const nodeDrift = installed.nodeBin !== expected.nodeBin;
  const hookDrift = installed.hookScript !== expected.hookScript;
  if (!nodeDrift && !hookDrift) {
    return undefined;
  }

  const parts: string[] = [];
  if (nodeDrift) {
    if (!nodeExists(installed.nodeBin)) {
      parts.push(
        `Node binary drift: the installed hook pins ${installed.nodeBin}, which no longer exists on disk ` +
          `(this companion runs ${expected.nodeBin}). This is the classic Node-upgrade / version-manager ` +
          `(nvm, asdf, mise, fnm, Homebrew) drift — the pinned interpreter moved, so kimi-code can no longer ` +
          `spawn the hook and read-only enforcement silently degrades.`,
      );
    } else {
      parts.push(
        `Node binary changed: the installed hook pins ${installed.nodeBin}, but this companion runs ` +
          `${expected.nodeBin} (both exist on disk — likely a Node version-manager switch between runs).`,
      );
    }
  }
  if (hookDrift) {
    parts.push(
      `Hook script path drift: the installed hook points at ${installed.hookScript}, but this companion's ` +
        `hook is ${expected.hookScript} (likely a plugin update or move — the install path is version-stamped).`,
    );
  }
  parts.push("Run /kimi:setup to re-pin the managed block to this companion's current paths.");
  return parts.join(" ");
}

/**
 * Best-effort: compute the canonical expected shell command for the
 * current env. Returns `undefined` if either path can't be resolved
 * (caller treats this as "managed block is unverifiable; do not assume
 * installed"). Never throws.
 *
 * This is the helper the verifier uses on every plugin command spawn.
 */
export function tryBuildExpectedHookCommand(
  env: NodeJS.ProcessEnv,
): { command: string; hookScriptPath: string } | { error: RuntimeError } {
  try {
    const hookScriptPath = resolveHookScriptPath(env);
    const command = buildHookShellCommand(hookScriptPath, env);
    return { command, hookScriptPath };
  } catch (err) {
    if (err instanceof RuntimeError) {
      return { error: err };
    }
    return {
      error: new RuntimeError(
        "SETUP_RESOLVE_HOOK_FAILED",
        `Unexpected error resolving hook path: ${(err as Error).message}`,
        "setup.resolve-hook",
        err instanceof Error
          ? { cause: err, details: {} }
          : { details: {} },
      ),
    };
  }
}

// ----- Host identity -----------------------------------------------------
//
// Claude Code and Codex install this plugin to DIFFERENT, version-stamped,
// host-specific paths but SHARE one `~/.kimi-code/config.toml`:
//
//   Claude: ~/.claude/plugins/cache/kimi-marketplace/kimi/<ver>/dist/hooks/approval-hook.js
//   Codex:  ~/.codex/plugins/cache/kimi-marketplace/kimi/<ver>/dist/hooks/approval-hook.js
//
// The managed block is host-scoped (marker suffix `:<host-id>`) so each host
// owns and verifies its OWN PreToolUse block without clobbering the other's.
// The host id must be VERSION-INDEPENDENT so a plugin upgrade REFRESHES the
// same host's block instead of accumulating one block per version.

/**
 * Resolve a stable, version-independent host id for the managed-block marker.
 *
 * Order: an explicit `KIMI_PLUGIN_CC_HOST_ID` override (slugified) wins — used
 * by tests and the live-repair path. Otherwise derive from the resolved hook
 * script path. Pass the already-resolved `hookScriptPath` when you have it
 * (the verifier + setup do) so we don't re-resolve and risk a second throw.
 */
export function resolveHostId(
  env: NodeJS.ProcessEnv,
  hookScriptPath?: string,
): string {
  const override = env.KIMI_PLUGIN_CC_HOST_ID;
  if (override !== undefined && override.trim().length > 0) {
    return slugifyHostId(override);
  }
  const resolved = hookScriptPath ?? resolveHookScriptPath(env);
  return hostIdFromHookScript(resolved);
}

/**
 * Derive a host id from a hook-script path. `~/.claude/...` → `claude-code`,
 * `~/.codex/...` → `codex` (both literal + version-independent), else a stable
 * `host-<sha1(hookDir)[:8]>` for dev checkouts / unrecognized layouts.
 */
export function hostIdFromHookScript(hookScriptPath: string): string {
  const norm = hookScriptPath.split(path.sep).join("/");
  if (norm.includes("/.claude/")) return "claude-code";
  if (norm.includes("/.codex/")) return "codex";
  // Dev checkouts are not version-stamped, so hashing the hook's directory is
  // stable across runs (and across plugin upgrades, which don't move it).
  const digest = createHash("sha1").update(path.dirname(hookScriptPath)).digest("hex");
  return `host-${digest.slice(0, 8)}`;
}

/**
 * Normalize an arbitrary host-id override into the `[a-z0-9-]+` slug the
 * marker regex accepts. Empty results fall back to `host` so the marker is
 * always well-formed.
 */
export function slugifyHostId(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug.length > 0 ? slug : "host";
}

/**
 * True when a (decoded) hook `command` string is unambiguously THIS plugin's
 * approval hook — a canonical two-single-quoted-token command whose script is
 * `approval-hook.js` living under a `kimi-plugin-cc` / `kimi-marketplace`
 * install tree. Used to prune orphaned, marker-less `[[hooks]]` entries left by
 * older installs. Deliberately strict: a hand-rolled or non-canonical command
 * returns false, so we never remove a user's own hook.
 */
/**
 * Derive the host id that OWNS a hook command, from its script path — the
 * host-scoped counterpart of `hostIdFromHookScript`. Returns `null` when the
 * command isn't the canonical two-single-quoted-token shape (a stale/bare
 * legacy command whose owner can't be determined). Callers treat `null` as
 * "claimable by the current host." Lets a legacy (un-suffixed) block be
 * attributed to whichever host actually wrote it, so one host's `/kimi:setup`
 * never adopts or removes another host's block.
 */
export function hostIdFromHookCommand(command: string): string | null {
  const parsed = parseHookShellCommand(command);
  if (parsed === null) return null;
  return hostIdFromHookScript(parsed.hookScript);
}

export function isOurApprovalHookCommand(decodedCommand: string): boolean {
  const parsed = parseHookShellCommand(decodedCommand);
  if (parsed === null) return false;
  const script = parsed.hookScript.split(/[\\/]/);
  if (script[script.length - 1] !== "approval-hook.js") return false;
  const normalized = parsed.hookScript.replace(/\\/g, "/");
  // Require a real path SEGMENT, not an arbitrary substring — otherwise a
  // user hook at `/opt/acme/kimi-plugin-cc-wrapper/approval-hook.js` would be
  // misclassified as ours and pruned. (Codex review.)
  return normalized.includes("/kimi-plugin-cc/") || normalized.includes("/kimi-marketplace/");
}
