import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { evaluateInstalled } from "./managed-block.js";
import { tryBuildExpectedHookCommand } from "./install-paths.js";
import { resolveKimiHome } from "../kimi-home.js";
export async function verifyHookInstalled(env) {
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
    // Pass `nodeExists` so a command MISMATCH is classified into an actionable
    // H4 diagnosis (Node upgrade / version-manager switch vs. plugin path drift)
    // instead of a raw expected-vs-got dump. Classification only refines the
    // reason; it never changes the installed=false decision.
    const check = evaluateInstalled(raw, expected.command, {
        nodeExists: (binPath) => existsSync(binPath),
    });
    return {
        installed: check.installed,
        reason: check.reason,
        configPath,
    };
}
function resolveKimiCodeConfigPath(env) {
    return path.join(resolveKimiHome(env), "config.toml");
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
        "  documented as read-only.",
        "",
        "  Fix: run `/kimi:setup` to install or repair the managed block in",
        "  ~/.kimi-code/config.toml. If you use nvm, asdf, mise, or fnm, you",
        "  must re-run `/kimi:setup` after any Node version switch — the",
        "  verifier pins the absolute Node binary path and a switch invalidates",
        "  the previously-installed block by design. See docs/safety.md.",
        "",
        "  Set KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1 to silence this warning",
        "  intentionally (also disables rescue's refusal gate).",
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
