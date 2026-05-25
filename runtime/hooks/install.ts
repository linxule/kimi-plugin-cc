import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { evaluateInstalled, parseManagedBlock } from "./managed-block.js";

/**
 * Verify that the kimi-plugin-cc PreToolUse hook is installed and
 * structurally valid in `~/.kimi-code/config.toml`.
 *
 * PR 4 hardening:
 *
 *   PR 2 implemented this as a substring check (`includes("kimi-plugin-cc-managed")`
 *   AND `includes("approval-hook.js")`). PR 4 reviewers (Codex + Claude)
 *   independently flagged the gap: stray comments, partial references,
 *   or a malformed block with `matcher = "*"` (which kimi-code rejects
 *   and silently disables) all passed the substring check while the
 *   hook was effectively absent. Rescue's "refuse if hook missing"
 *   gate was therefore bypassable.
 *
 *   The verifier now shares its grammar with `setup.ts` via
 *   `runtime/hooks/managed-block.ts::parseManagedBlock`. Both gates
 *   reject the same shapes:
 *
 *     - duplicate managed blocks (two installs raced)
 *     - orphan markers (manual edit)
 *     - missing [[hooks]] table
 *     - missing event = "PreToolUse"
 *     - missing or empty command
 *     - presence of any `matcher = ...` line
 *
 *   The hook-script-path check is optional: callers (ask/review/etc.)
 *   that just want to know "is something installed and minimally
 *   valid" can pass undefined; setup --check passes the expected dist
 *   path so we also catch stale-path drift.
 *
 * Tests / setup probes can opt out via
 * `KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1` so the warning doesn't pollute
 * mock-driven CI output.
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
  options: { expectedHookPath?: string } = {},
): Promise<HookInstallStatus> {
  const configPath = resolveKimiCodeConfigPath(env);
  if (env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK === "1") {
    return { installed: true, configPath };
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

  if (options.expectedHookPath !== undefined) {
    const check = evaluateInstalled(raw, options.expectedHookPath);
    return {
      installed: check.installed,
      reason: check.reason,
      configPath,
    };
  }

  // No expected path supplied — caller just wants "is a structurally
  // valid managed block present?". This is the common path for
  // ask/review/etc., which only need to know whether to emit the
  // missing-hook warning. Stale-path drift is caught at
  // `/kimi:setup --check` time, not here.
  const { state } = parseManagedBlock(raw);
  switch (state.kind) {
    case "absent":
      return { installed: false, reason: "no kimi-plugin-cc PreToolUse hook found in kimi-code config", configPath };
    case "orphan":
      return {
        installed: false,
        reason: `${state.detail} marker. Run /kimi:setup --uninstall to clear, then /kimi:setup.`,
        configPath,
      };
    case "duplicate":
      return {
        installed: false,
        reason: `duplicate managed blocks. Run /kimi:setup --uninstall, then /kimi:setup.`,
        configPath,
      };
    case "found":
      if (!state.valid) {
        return {
          installed: false,
          reason: state.invalidReason ?? "managed block failed validation",
          configPath,
        };
      }
      return { installed: true, configPath };
  }
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
