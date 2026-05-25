import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { evaluateInstalled } from "./managed-block.js";
import { tryBuildExpectedHookCommand } from "./install-paths.js";

/**
 * Verify that the kimi-plugin-cc PreToolUse hook is installed and
 * structurally valid in `~/.kimi-code/config.toml`, AND that its
 * `command = "..."` exactly matches the canonical shell command this
 * companion would write for the current env.
 *
 * PR 4 hardened the grammar (matcher rejection, duplicate detection,
 * etc.). The pre-tag audit (reports 27 + 28) found two further gaps,
 * both fixed here:
 *
 *   1. Optional `expectedHookPath` parameter → callers (rescue, ask,
 *      review, review-gate) all omitted it, so a managed block
 *      referencing a stale or missing hook script silently passed. The
 *      verifier now ALWAYS reconstructs the expected command from the
 *      current env (via `tryBuildExpectedHookCommand`) and equality-
 *      checks. There is no opt-out short of `KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1`.
 *
 *   2. The path check was substring (`commandPath.includes(hookPath)`),
 *      which a crafted command like `true # /path/to/approval-hook.js`
 *      passed: `/bin/sh -c "true # ..."` runs only `true` (exit 0),
 *      which kimi-code's hook runner treats as ALLOW. Equality on the
 *      full canonical shell command closes this.
 *
 * Tests / setup probes can opt out via
 * `KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1` — that bypass also disables
 * rescue's refusal gate (documented in `docs/safety.md`).
 */
export interface HookInstallStatus {
  installed: boolean;
  /** Human-readable reason (filled when `installed === false`). */
  reason?: string;
  /** Path examined. Useful for the warning message. */
  configPath: string;
}

export async function verifyHookInstalled(
  env: NodeJS.ProcessEnv,
): Promise<HookInstallStatus> {
  const configPath = resolveKimiCodeConfigPath(env);
  if (env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK === "1") {
    return { installed: true, configPath };
  }

  // Canonical expected shell command for the current env. If this
  // can't be resolved (KIMI_PLUGIN_CC_NODE_BIN not absolute,
  // install-paths module can't infer plugin root, etc.) treat the hook
  // as un-verifiable — installed=false with a structured reason. The
  // caller's stderr warning surfaces the underlying error code.
  const expected = tryBuildExpectedHookCommand(env);
  if ("error" in expected) {
    return {
      installed: false,
      reason: `unable to resolve canonical hook command for this companion: ${expected.error.message}`,
      configPath,
    };
  }

  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        installed: false,
        reason: "kimi-code config file does not exist",
        configPath,
      };
    }
    return {
      installed: false,
      reason: `failed to read kimi-code config: ${(err as Error).message}`,
      configPath,
    };
  }

  const check = evaluateInstalled(raw, expected.command);
  return {
    installed: check.installed,
    reason: check.reason,
    configPath,
  };
}

function resolveKimiCodeConfigPath(env: NodeJS.ProcessEnv): string {
  // KIMI_CODE_HOME mirrors kimi-code's own override (apps/kimi-code reads
  // it before falling back to ~/.kimi-code). Tests rely on this.
  const home = env.KIMI_CODE_HOME ?? path.join(os.homedir(), ".kimi-code");
  return path.join(home, "config.toml");
}

/**
 * Format a stderr-suitable warning message for the missing-hook case.
 * Single source of truth so review.ts / review-gate.ts / ask.ts emit
 * identical language.
 */
export function formatHookMissingWarning(
  status: HookInstallStatus,
  commandLabel: string,
): string {
  return [
    "",
    "WARNING: kimi-plugin-cc safety hook is NOT installed (or is invalid).",
    `  Command: ${commandLabel}`,
    `  Config:  ${status.configPath}`,
    `  Reason:  ${status.reason ?? "unknown"}`,
    "",
    "  Without a valid PreToolUse hook, kimi-code's `-p` mode auto-approves",
    "  every tool call — including Bash, Write, Edit — even from commands",
    "  documented as read-only. Run `/kimi:setup` to install or repair the",
    "  managed block in ~/.kimi-code/config.toml. Set",
    "  KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1 to silence this warning intentionally.",
    "",
  ].join("\n");
}

/**
 * Process-lifetime latch so commands don't spam the warning on every
 * call inside a single test run.
 */
let warnedThisProcess = false;

/**
 * Emit the warning to stderr at most once per process.
 *
 * Why stderr rather than stdout: stdout is reserved for the command's
 * load-bearing output (artifact prose, JSON envelopes). LLM-caller
 * discipline says stderr is humans-only, and this warning is exactly
 * that — a developer-facing nudge to run /kimi:setup before tagging.
 */
export function maybeWarnHookMissing(
  status: HookInstallStatus,
  commandLabel: string,
  stderr: NodeJS.WritableStream = process.stderr,
): void {
  if (status.installed) return;
  if (warnedThisProcess) return;
  warnedThisProcess = true;
  stderr.write(formatHookMissingWarning(status, commandLabel));
}

/** Test hook — resets the once-per-process latch. */
export function __resetHookMissingWarning(): void {
  warnedThisProcess = false;
}
