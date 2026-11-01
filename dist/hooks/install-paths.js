// Shared canonical-path helpers for the kimi-plugin-cc PreToolUse hook.
//
// Setup, the shell probe, and the per-call verifier all build the command here.
// The verifier reconstructs the expected command from the resolved Node binary
// and hook script, then requires exact equality: a stale path or a substring
// lookalike must never pass, because a hook that fails to spawn fails open
// upstream. The probe executes the same bytes that setup writes.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeError } from "../errors.js";
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
export function preferStableNodePath(execPath, argv0 = process.argv0, realpath = realpathSync) {
    if (argv0 === undefined || argv0.length === 0 || !path.isAbsolute(argv0)) {
        return execPath;
    }
    try {
        return realpath(argv0) === realpath(execPath) ? argv0 : execPath;
    }
    catch {
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
export function resolveNodeBinary(env) {
    const override = env.KIMI_PLUGIN_CC_NODE_BIN;
    if (override === undefined || override.length === 0) {
        return preferStableNodePath(process.execPath);
    }
    if (!path.isAbsolute(override)) {
        throw new RuntimeError("SETUP_NODE_BIN_NOT_ABSOLUTE", [
            `KIMI_PLUGIN_CC_NODE_BIN must be an absolute path; got ${JSON.stringify(override)}.`,
            `kimi-code spawns hooks via /bin/sh -c, where a bare command relies on the shell's PATH at hook execution time.`,
            `Use an absolute path so the hook keeps firing under sanitized-PATH launches.`,
        ].join(" "), "setup.node-bin", { details: { override } });
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
export function buildHookShellCommand(hookScriptPath, env) {
    const nodeBin = resolveNodeBinary(env);
    return `${shellSingleQuote(nodeBin)} ${shellSingleQuote(hookScriptPath)}`;
}
/**
 * POSIX shell single-quote a string. Inner `'` are escaped as `'\''`
 * (close-quote, escaped quote, re-open-quote). Always safe — no shell
 * metacharacters survive the encoding.
 */
export function shellSingleQuote(value) {
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
export function resolveHookScriptPath(env) {
    const override = env.KIMI_PLUGIN_CC_HOOK_SCRIPT;
    if (override !== undefined && override.length > 0) {
        if (!path.isAbsolute(override)) {
            // The hook shell's cwd can differ from the companion's. Require an
            // absolute override so installation, verification, and the runtime spawn
            // all refer to the same file rather than blessing a relative path that
            // resolves elsewhere when kimi-code executes it.
            throw new RuntimeError("SETUP_HOOK_SCRIPT_NOT_ABSOLUTE", [
                `KIMI_PLUGIN_CC_HOOK_SCRIPT must be an absolute path; got ${JSON.stringify(override)}.`,
                `kimi-code spawns hooks via /bin/sh -c with a cwd that may differ from the companion's.`,
                `Use an absolute path so the verifier and the runtime spawn refer to the same file.`,
            ].join(" "), "setup.hook-script-path", { details: { override } });
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
function resolveHookFailure(here) {
    return new RuntimeError("SETUP_RESOLVE_HOOK_FAILED", `Could not infer plugin root from install-paths module path ${here}. Set KIMI_PLUGIN_CC_HOOK_SCRIPT to the absolute path of dist/hooks/approval-hook.js.`, "setup.resolve-hook", { details: { here } });
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
export function parseHookShellCommand(command) {
    const tokens = parseSingleQuotedTokens(command);
    if (tokens === null || tokens.length !== 2) {
        return null;
    }
    return { nodeBin: tokens[0], hookScript: tokens[1] };
}
/**
 * Tokenize a string of POSIX single-quoted tokens as produced by
 * `shellSingleQuote` (`'...'` with inner `'` encoded as `'\''`). Returns the
 * decoded token list, or `null` if the input contains any unquoted bare
 * character or an unterminated quote — i.e. anything outside the grammar this
 * module emits.
 */
function parseSingleQuotedTokens(input) {
    const tokens = [];
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
            const ch = input[i];
            if (ch === "'") {
                // A '...'  quoted segment. Single-quoted content can never contain a
                // literal "'", so the next "'" is always the real close.
                const close = input.indexOf("'", i + 1);
                if (close === -1)
                    return null;
                token += input.slice(i + 1, close);
                i = close + 1;
                consumedAny = true;
            }
            else if (ch === "\\") {
                // The `\'` half of a `'\''` escape (an apostrophe in the value).
                if (i + 1 >= n)
                    return null;
                token += input[i + 1];
                i += 2;
                consumedAny = true;
            }
            else {
                return null;
            }
        }
        if (!consumedAny)
            return null;
        tokens.push(token);
    }
    return tokens;
}
/**
 * Do two paths name the same file? Used to distinguish a changed path spelling
 * from a real interpreter move. Any filesystem error returns false, yielding
 * the conservative non-retryable classification.
 */
function defaultSameFile(a, b) {
    try {
        return realpathSync(a) === realpathSync(b);
    }
    catch {
        return false;
    }
}
/**
 * Machine-readable classification of a canonical-command mismatch. Returns
 * which token moved and, for Node, whether both spellings name the same file.
 *
 * `"hook-script"` drift is recoverable by running setup on this host.
 * `"node-bin"`/`"both"` drift is also recoverable when
 * `nodeInterpreterUnchanged === true`; a token naming a different interpreter
 * is not automatically repairable. A hook that cannot spawn fails open upstream.
 *
 * Returns `undefined` for non-canonical commands or equal tokens. Classification
 * never changes the verifier's exact-equality decision.
 */
export function classifyHookCommandDrift(installedCommand, expectedCommand, sameFile = defaultSameFile) {
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
    // A changed Node spelling that still names the same file is path drift, not
    // an interpreter move; callers use this to decide whether setup may retry.
    return {
        axis,
        installedCommand,
        expectedCommand,
        ...(nodeDrift ? { nodeInterpreterUnchanged: sameFile(installed.nodeBin, expected.nodeBin) } : {}),
    };
}
/**
 * Describe a canonical-command mismatch in actionable prose: which token moved
 * and, for Node, whether the installed binary still exists. Returns `undefined`
 * for non-canonical commands or equal tokens, leaving the generic mismatch
 * message in place. Pure except for the injected filesystem predicates; never
 * changes the verifier's exact-equality decision.
 */
export function describeHookCommandDrift(installedCommand, expectedCommand, nodeExists, sameFile = defaultSameFile) {
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
    const parts = [];
    if (nodeDrift) {
        if (!nodeExists(installed.nodeBin)) {
            parts.push(`Node binary drift: the installed hook pins ${installed.nodeBin}, which no longer exists on disk ` +
                `(this companion runs ${expected.nodeBin}). This is the classic Node-upgrade / version-manager ` +
                `(nvm, asdf, mise, fnm, Homebrew) drift — the pinned interpreter moved, so kimi-code can no longer ` +
                `spawn the hook and read-only enforcement silently degrades.`);
        }
        else if (sameFile(installed.nodeBin, expected.nodeBin)) {
            // Both paths name the same interpreter, so this is a spelling change,
            // not a version-manager switch or a moved binary.
            parts.push(`Node path spelling changed: the installed hook pins ${installed.nodeBin} and this companion runs ` +
                `${expected.nodeBin} — these are the SAME interpreter reached by different paths. Since v1.9.0 the ` +
                `hook pins the stable path instead of the version-stamped one, so a Node upgrade no longer breaks it. ` +
                `This is the expected one-time re-pin after upgrading the plugin; your Node did not move.`);
        }
        else {
            parts.push(`Node binary changed: the installed hook pins ${installed.nodeBin}, but this companion runs ` +
                `${expected.nodeBin} (both exist on disk — likely a Node version-manager switch between runs).`);
        }
    }
    if (hookDrift) {
        parts.push(`Hook script path drift: the installed hook points at ${installed.hookScript}, but this companion's ` +
            `hook is ${expected.hookScript} (likely a plugin update or move — the install path is version-stamped).`);
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
export function tryBuildExpectedHookCommand(env) {
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
    }
    catch (err) {
        if (err instanceof RuntimeError) {
            return { error: err };
        }
        return {
            error: new RuntimeError("SETUP_RESOLVE_HOOK_FAILED", `Unexpected error resolving hook path: ${err.message}`, "setup.resolve-hook", err instanceof Error
                ? { cause: err, details: {} }
                : { details: {} }),
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
export function resolveHostId(env, hookScriptPath) {
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
 * `host-<sha1(hookDir)[:16]>` for dev checkouts / unrecognized layouts.
 */
export function hostIdFromHookScript(hookScriptPath) {
    const norm = hookScriptPath.split(path.sep).join("/");
    if (norm.includes("/.claude/"))
        return "claude-code";
    if (norm.includes("/.codex/"))
        return "codex";
    // Hashing the hook directory is stable for dev checkouts. Sixteen hex chars
    // avoid the collision risk of a 32-bit prefix, which could make one root
    // treat another root's managed block as its own.
    const digest = createHash("sha1").update(path.dirname(hookScriptPath)).digest("hex");
    return `host-${digest.slice(0, 16)}`;
}
/**
 * Normalize an arbitrary host-id override into the `[a-z0-9-]+` slug the
 * marker regex accepts. Empty results fall back to `host` so the marker is
 * always well-formed.
 */
export function slugifyHostId(value) {
    const slug = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
    return slug.length > 0 ? slug : "host";
}
/**
 * Derive the owning host id from a canonical hook command's script path.
 * Returns `null` for a non-canonical command whose owner cannot be determined;
 * scoped cleanup treats that as ambiguous rather than claiming another host's
 * block.
 */
export function hostIdFromHookCommand(command) {
    const parsed = parseHookShellCommand(command);
    if (parsed === null)
        return null;
    return hostIdFromHookScript(parsed.hookScript);
}
/**
 * True only for a canonical two-single-quoted-token command whose script is
 * `approval-hook.js` under a kimi-plugin-cc/dsh-kimi-plugin-cc/kimi-marketplace install tree.
 * This strict ownership test protects hand-rolled and non-canonical user hooks
 * from orphan pruning.
 */
export function isOurApprovalHookCommand(decodedCommand) {
    const parsed = parseHookShellCommand(decodedCommand);
    if (parsed === null)
        return false;
    const script = parsed.hookScript.split(/[\\/]/);
    if (script[script.length - 1] !== "approval-hook.js")
        return false;
    const normalized = parsed.hookScript.replace(/\\/g, "/");
    // Require a real path segment, not an arbitrary substring, so a user hook in
    // a similarly named wrapper directory is never misclassified and pruned.
    return normalized.includes("/kimi-plugin-cc/") || normalized.includes("/dsh-kimi-plugin-cc/") || normalized.includes("/kimi-marketplace/");
}
