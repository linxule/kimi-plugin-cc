// Shared canonical-path helpers for the kimi-plugin-cc PreToolUse hook.
//
// Setup, the shell probe, and the per-call verifier all build the command here.
// The verifier reconstructs the expected command from the resolved Node binary
// and hook script, then requires exact equality: a stale path or a substring
// lookalike must never pass, because a hook that fails to spawn fails open
// upstream. The probe executes the same bytes that setup writes.

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RuntimeError } from "../errors.js";
import { resolvePluginPaths } from "../paths.js";
import { resolvePluginDataRoot } from "../plugin-data.js";

/**
 * Prefer a stable, non-version-stamped path to the SAME Node binary.
 * Version-stamped interpreter paths change on upgrade and invalidate the
 * byte-exact managed command, while a missing hook interpreter fails open
 * upstream.
 *
 * `process.argv0` can preserve a stable alias used by companion.sh, but it is
 * eligible ONLY when absolute and `realpath()`-identical to `process.execPath`.
 * That guard permits a different name for the running interpreter, never a
 * different binary. Any error falls back to `execPath`, keeping the result an
 * absolute path to a real interpreter. Managers that already expose a
 * version-stamped argv0 simply retain that path.
 */
export function preferStableNodePath(
  execPath: string,
  argv0: string | undefined = process.argv0,
  realpath: (p: string) => string = realpathSync,
): string {
  if (argv0 === undefined || argv0.length === 0 || !path.isAbsolute(argv0)) {
    return execPath;
  }
  try {
    return realpath(argv0) === realpath(execPath) ? argv0 : execPath;
  } catch {
    return execPath;
  }
}

/**
 * Resolve the absolute path to the Node binary used in the PreToolUse
 * hook command. kimi-code spawns hooks via `/bin/sh -c "<command>"`; a
 * bare `node` would rely on the shell's PATH at execution time, which
 * fails under GUI/LaunchAgent launches with sanitized PATH. Require an
 * absolute path — either a stable alias of the in-process interpreter
 * (see `preferStableNodePath`) or an explicit `KIMI_PLUGIN_CC_NODE_BIN`
 * override.
 */
export function resolveNodeBinary(env: NodeJS.ProcessEnv): string {
  const override = env.KIMI_PLUGIN_CC_NODE_BIN;
  if (override === undefined || override.length === 0) {
    return preferStableNodePath(process.execPath);
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
 *   - what setup writes into kimi-code's config (`command = "..."` inside [[hooks]])
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
 * Locate the compiled, self-contained ESM hook artifact bundled with this
 * package (`<packageRoot>/dist/hooks/approval-hook.js`). Setup copies this
 * file into `<pluginRoot>/hook/approval-hook.js`.
 */
export function resolveBundledHookSourcePath(): string {
  const here = fileURLToPath(import.meta.url);
  const parts = here.split(path.sep);
  if (parts.length < 3) {
    throw resolveHookFailure(here);
  }
  const tailParent = parts[parts.length - 2];
  const tailGrandparent = parts[parts.length - 3];
  if (tailParent !== "hooks" || (tailGrandparent !== "runtime" && tailGrandparent !== "dist")) {
    throw resolveHookFailure(here);
  }
  const packageRoot = parts.slice(0, parts.length - 3).join(path.sep) || path.sep;
  return path.join(packageRoot, "dist", "hooks", "approval-hook.js");
}

/**
 * Resolve the absolute path to the installed hook script.
 *
 * Resolution order:
 *   1. `KIMI_PLUGIN_CC_HOOK_SCRIPT` override — tests / advanced users.
 *   2. Canonical shared plugin hook path: `<pluginRoot>/hook/approval-hook.js`
 *      (e.g. `~/.local/share/kimi-plugin-cc/hook/approval-hook.js`).
 */
export function resolveHookScriptPath(env: NodeJS.ProcessEnv): string {
  const override = env.KIMI_PLUGIN_CC_HOOK_SCRIPT;
  if (override !== undefined && override.length > 0) {
    if (!path.isAbsolute(override)) {
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
  return resolvePluginPaths(env).hookScriptPath;
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
        if (close === -1) return null;
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
        return null;
      }
    }
    if (!consumedAny) return null;
    tokens.push(token);
  }
  return tokens;
}

/**
 * Do two paths name the same file? Used to distinguish a changed path spelling
 * from a real interpreter move. Any filesystem error returns false, yielding
 * the conservative non-retryable classification.
 */
function defaultSameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export function resolveDefaultCanonicalHookScriptPath(env: NodeJS.ProcessEnv): string | undefined {
  const baseEnv: NodeJS.ProcessEnv = { ...env };
  delete baseEnv.KIMI_PLUGIN_CC_DATA;
  delete baseEnv.KIMI_PLUGIN_CC_TEST_NO_DEFAULT_DATA;
  try {
    return path.join(resolvePluginDataRoot(baseEnv), "kimi-plugin-cc", "hook", "approval-hook.js");
  } catch {
    return undefined;
  }
}

export function isDataOverrideFromCanonicalHook(
  installedHookScript: string,
  expectedHookScript: string,
  env?: NodeJS.ProcessEnv,
  sameFile: (a: string, b: string) => boolean = defaultSameFile,
): boolean {
  if (
    env === undefined ||
    env.KIMI_PLUGIN_CC_DATA === undefined ||
    (env.KIMI_PLUGIN_CC_HOOK_SCRIPT && env.KIMI_PLUGIN_CC_HOOK_SCRIPT.length > 0) ||
    installedHookScript === expectedHookScript
  ) {
    return false;
  }
  const canonicalHook = resolveDefaultCanonicalHookScriptPath(env);
  if (canonicalHook === undefined) return false;
  return path.normalize(installedHookScript) === path.normalize(canonicalHook) || sameFile(installedHookScript, canonicalHook);
}

/**
 * Machine-readable classification of a canonical-command mismatch. Returns
 * which token moved and, for Node, whether both spellings name the same file.
 *
 * `"hook-script"` drift is recoverable by running setup on this host unless it
 * stems from an active `KIMI_PLUGIN_CC_DATA` override while the shared block
 * points at the canonical hook (`dataOverrideFromCanonical: true`).
 * `"node-bin"`/`"both"` drift is also recoverable when
 * `nodeInterpreterUnchanged === true`; a token naming a different interpreter
 * is not automatically repairable. A hook that cannot spawn fails open upstream.
 *
 * Returns `undefined` for non-canonical commands or equal tokens. Classification
 * never changes the verifier's exact-equality decision.
 */
export function classifyHookCommandDrift(
  installedCommand: string,
  expectedCommand: string,
  sameFile: (a: string, b: string) => boolean = defaultSameFile,
  env?: NodeJS.ProcessEnv,
):
  | {
      axis: "hook-script" | "node-bin" | "both";
      installedCommand: string;
      expectedCommand: string;
      nodeInterpreterUnchanged?: boolean;
      dataOverrideFromCanonical?: true;
    }
  | undefined {
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
  const axis = nodeDrift && hookDrift ? "both" : nodeDrift ? "node-bin" : "hook-script";
  const dataOverride =
    hookDrift && isDataOverrideFromCanonicalHook(installed.hookScript, expected.hookScript, env, sameFile);
  // A changed Node spelling that still names the same file is path drift, not
  // an interpreter move; callers use this to decide whether setup may retry.
  return {
    axis,
    installedCommand,
    expectedCommand,
    ...(nodeDrift ? { nodeInterpreterUnchanged: sameFile(installed.nodeBin, expected.nodeBin) } : {}),
    ...(dataOverride ? { dataOverrideFromCanonical: true as const } : {}),
  };
}

/**
 * Describe a canonical-command mismatch in actionable prose: which token moved
 * and, for Node, whether the installed binary still exists. Returns `undefined`
 * for non-canonical commands or equal tokens, leaving the generic mismatch
 * message in place. Pure except for the injected filesystem predicates; never
 * changes the verifier's exact-equality decision.
 */
export function describeHookCommandDrift(
  installedCommand: string,
  expectedCommand: string,
  nodeExists: (binPath: string) => boolean,
  sameFile: (a: string, b: string) => boolean = defaultSameFile,
  env?: NodeJS.ProcessEnv,
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
  const dataOverride =
    hookDrift && isDataOverrideFromCanonicalHook(installed.hookScript, expected.hookScript, env, sameFile);

  const parts: string[] = [];
  if (nodeDrift) {
    if (!nodeExists(installed.nodeBin)) {
      parts.push(
        `Node binary drift: the installed hook pins ${installed.nodeBin}, which no longer exists on disk ` +
          `(this companion runs ${expected.nodeBin}). This is the classic Node-upgrade / version-manager ` +
          `(nvm, asdf, mise, fnm, Homebrew) drift — the pinned interpreter moved, so kimi-code can no longer ` +
          `spawn the hook and read-only enforcement silently degrades.`,
      );
    } else if (sameFile(installed.nodeBin, expected.nodeBin)) {
      // Both paths name the same interpreter, so this is a spelling change,
      // not a version-manager switch or a moved binary.
      parts.push(
        `Node path spelling changed: the installed hook pins ${installed.nodeBin} and this companion runs ` +
          `${expected.nodeBin} — these are the SAME interpreter reached by different paths. Since v1.9.0 the ` +
          `hook pins the stable path instead of the version-stamped one, so a Node upgrade no longer breaks it. ` +
          `This is the expected one-time re-pin after upgrading the plugin; your Node did not move.`,
      );
    } else {
      parts.push(
        `Node binary changed: the installed hook pins ${installed.nodeBin}, but this companion runs ` +
          `${expected.nodeBin} (both exist on disk — likely a Node version-manager switch between runs).`,
      );
    }
  }
  if (hookDrift) {
    if (dataOverride) {
      parts.push(
        `Hook script path drift: the installed hook points at the shared canonical hook ${installed.hookScript}, ` +
          `but KIMI_PLUGIN_CC_DATA=${JSON.stringify(env!.KIMI_PLUGIN_CC_DATA)} directs this host to ` +
          `${expected.hookScript} (likely a KIMI_PLUGIN_CC_DATA override left over from a 3.0 per-host setup).`,
      );
    } else {
      parts.push(
        `Hook script path drift: the installed hook points at ${installed.hookScript}, but this companion's ` +
          `hook is ${expected.hookScript} (likely an upgrade from an earlier hook path or a moved data directory).`,
      );
    }
  }
  if (dataOverride) {
    parts.push(
      "Unset KIMI_PLUGIN_CC_DATA in your host environment (for example in ~/.claude/settings.json) and restart the host so it uses the shared canonical hook.",
    );
  } else {
    parts.push("Run `kimi_setup` (action \"install\") or `scripts/companion.sh setup` to re-pin the managed block to this companion's current paths.");
  }
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
): { command: string; hookScriptPath: string; nodeBin: string } | { error: RuntimeError } {
  try {
    const hookScriptPath = resolveHookScriptPath(env);
    const command = buildHookShellCommand(hookScriptPath, env);
    // Surfaced so the verifier can probe the pinned interpreter for
    // executability. DERIVED FROM `command` BY PARSING IT BACK, never by calling
    // `resolveNodeBinary` a second time.
    //
    // Re-resolving would be a latent bypass: `resolveNodeBinary`'s no-override
    // path runs `preferStableNodePath`, which calls `realpathSync` and falls
    // back to `execPath` on ANY throw. So it is NOT a pure function of `env` —
    // it reads live filesystem state. If the pinned symlink were unlinked
    // between the two calls (exactly what `brew upgrade node` does), call #1
    // would embed the symlink in `command` while call #2 returned the old
    // realpath. The verifier would then compare the config against the symlink
    // (match) but probe the OLD Cellar path for executability (may still exist)
    // — reporting installed=true for a hook whose actual pinned interpreter is
    // gone. `/bin/sh -c` would exit 127, which kimi-code reads as ALLOW.
    //
    // Parsing the command back is the exact inverse of how it was built, so
    // `nodeBin` is byte-identical to the token in `command` BY CONSTRUCTION —
    // the guarantee is structural, not probabilistic. The `??` is unreachable
    // (we just built this string with the very quoting `parseHookShellCommand`
    // decodes) and exists only so a future change to either side degrades to
    // the old behavior instead of throwing.
    const nodeBin = parseHookShellCommand(command)?.nodeBin ?? resolveNodeBinary(env);
    return { command, hookScriptPath, nodeBin };
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

const OWNED_APPROVAL_HOOK_PATTERNS: readonly RegExp[] = [
  /\/kimi-plugin-cc\/hook\/approval-hook\.js$/,
  /\/kimi-plugin-cc\/(?:dist|runtime)\/hooks\/approval-hook\.js$/,
  /\/plugins\/kimi-codex\/dist\/hooks\/approval-hook\.js$/,
  /\/dsh-kimi-plugin-cc\/dist\/hooks\/approval-hook\.js$/,
  /\/kimi-marketplace\/[^/]+\/[^/]+\/(?:dist|runtime)\/hooks\/approval-hook\.js$/,
  /\/\.gemini\/config\/plugins\/kimi\/(?:dist|runtime)\/hooks\/approval-hook\.js$/,
];

/**
 * True only for a canonical two-single-quoted-token command whose script
 * matches an exact kimi-plugin-cc install/published approval-hook path.
 * This strict ownership test protects hand-rolled and non-canonical user hooks
 * from orphan pruning.
 */
export function isOurApprovalHookCommand(decodedCommand: string): boolean {
  const parsed = parseHookShellCommand(decodedCommand);
  if (parsed === null) return false;
  const normalized = parsed.hookScript.replace(/\\/g, "/");
  return OWNED_APPROVAL_HOOK_PATTERNS.some((pattern) => pattern.test(normalized));
}

export type ManagedHookArtifactCheck =
  | { ok: true }
  | { ok: false; kind: "unsafe-path" | "missing" | "bundle-missing" | "sha256-mismatch"; reason: string };

/**
 * Verify the managed `<pluginRoot>/hook/approval-hook.js` artifact on disk:
 * - Reject symlinks or non-directory/non-regular files along `pluginRoot`, `hookDir`,
 *   and `hookScriptPath`, and require canonical containment under `pluginRoot/hook`.
 * - Require SHA-256 byte equality against the bundled `dist/hooks/approval-hook.js`.
 * Skipped when `KIMI_PLUGIN_CC_HOOK_SCRIPT` explicitly overrides the script path.
 */
export async function verifyManagedHookArtifact(
  env: NodeJS.ProcessEnv,
  hookScriptPath: string,
): Promise<ManagedHookArtifactCheck> {
  if (env.KIMI_PLUGIN_CC_HOOK_SCRIPT && env.KIMI_PLUGIN_CC_HOOK_SCRIPT.length > 0) {
    return { ok: true };
  }

  const paths = resolvePluginPaths(env);

  let pluginRootReal: string;
  try {
    const info = await lstat(paths.pluginRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return {
        ok: false,
        kind: "unsafe-path",
        reason: `plugin data directory ${paths.pluginRoot} is a symlink or not a directory; refusing to trust managed hook`,
      };
    }
    pluginRootReal = await realpath(paths.pluginRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: false,
        kind: "missing",
        reason: `hook script ${hookScriptPath} is missing or unreadable — run \`kimi_setup\` (action "install") or \`scripts/companion.sh setup\` to reinstall`,
      };
    }
    return {
      ok: false,
      kind: "unsafe-path",
      reason: `unable to inspect plugin data directory ${paths.pluginRoot}: ${(err as Error).message}`,
    };
  }

  let hookDirReal: string;
  try {
    const info = await lstat(paths.hookDir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return {
        ok: false,
        kind: "unsafe-path",
        reason: `hook directory ${paths.hookDir} is a symlink or not a directory; refusing to trust managed hook`,
      };
    }
    hookDirReal = await realpath(paths.hookDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: false,
        kind: "missing",
        reason: `hook script ${hookScriptPath} is missing or unreadable — run \`kimi_setup\` (action "install") or \`scripts/companion.sh setup\` to reinstall`,
      };
    }
    return {
      ok: false,
      kind: "unsafe-path",
      reason: `unable to inspect hook directory ${paths.hookDir}: ${(err as Error).message}`,
    };
  }

  const expectedHookDirReal = path.join(pluginRootReal, "hook");
  if (hookDirReal !== expectedHookDirReal) {
    return {
      ok: false,
      kind: "unsafe-path",
      reason: `hook directory ${paths.hookDir} resolves to ${hookDirReal}, outside ${expectedHookDirReal}; refusing to trust managed hook`,
    };
  }

  try {
    const info = await lstat(hookScriptPath);
    if (info.isSymbolicLink() || !info.isFile()) {
      return {
        ok: false,
        kind: "unsafe-path",
        reason: `hook script ${hookScriptPath} is a symlink or not a regular file; refusing to execute managed hook`,
      };
    }
    const scriptReal = await realpath(hookScriptPath);
    const expectedScriptReal = path.join(hookDirReal, path.basename(hookScriptPath));
    if (scriptReal !== expectedScriptReal) {
      return {
        ok: false,
        kind: "unsafe-path",
        reason: `hook script ${hookScriptPath} resolves to ${scriptReal}, outside ${hookDirReal}; refusing to execute managed hook`,
      };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: false,
        kind: "missing",
        reason: `hook script ${hookScriptPath} is missing or unreadable — run \`kimi_setup\` (action "install") or \`scripts/companion.sh setup\` to reinstall`,
      };
    }
    return {
      ok: false,
      kind: "unsafe-path",
      reason: `unable to inspect hook script ${hookScriptPath}: ${(err as Error).message}`,
    };
  }

  let installedBytes: Buffer;
  try {
    installedBytes = await readFile(hookScriptPath);
  } catch {
    return {
      ok: false,
      kind: "missing",
      reason: `hook script ${hookScriptPath} is missing or unreadable — run \`kimi_setup\` (action "install") or \`scripts/companion.sh setup\` to reinstall`,
    };
  }

  let sourcePath: string;
  let bundledBytes: Buffer;
  try {
    sourcePath = resolveBundledHookSourcePath();
    bundledBytes = await readFile(sourcePath);
  } catch (err) {
    return {
      ok: false,
      kind: "bundle-missing",
      reason: `bundled hook source is missing or unreadable (${(err as Error).message}); run \`bun run build\` or reinstall the plugin`,
    };
  }

  const installedHash = createHash("sha256").update(installedBytes).digest("hex");
  const bundledHash = createHash("sha256").update(bundledBytes).digest("hex");
  if (installedHash !== bundledHash) {
    return {
      ok: false,
      kind: "sha256-mismatch",
      reason:
        `installed hook script ${hookScriptPath} does not match the bundled hook artifact (${sourcePath}, SHA-256 mismatch — likely after a plugin update). ` +
        `Run \`kimi_setup\` (action "install") or \`scripts/companion.sh setup\` to republish it.`,
    };
  }

  return { ok: true };
}
