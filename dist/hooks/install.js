import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { evaluateInstalled, parseManagedBlock } from "./managed-block.js";
export async function verifyHookInstalled(env, options = {}) {
    const configPath = resolveKimiCodeConfigPath(env);
    if (env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK === "1") {
        return { installed: true, configPath };
    }
    let raw;
    try {
        raw = await readFile(configPath, "utf8");
    }
    catch (err) {
        const code = err.code;
        if (code === "ENOENT") {
            return {
                installed: false,
                reason: "kimi-code config file does not exist",
                configPath,
            };
        }
        return {
            installed: false,
            reason: `failed to read kimi-code config: ${err.message}`,
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
function resolveKimiCodeConfigPath(env) {
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
export function formatHookMissingWarning(status, commandLabel) {
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
export function maybeWarnHookMissing(status, commandLabel, stderr = process.stderr) {
    if (status.installed)
        return;
    if (warnedThisProcess)
        return;
    warnedThisProcess = true;
    stderr.write(formatHookMissingWarning(status, commandLabel));
}
/** Test hook — resets the once-per-process latch. */
export function __resetHookMissingWarning() {
    warnedThisProcess = false;
}
