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
