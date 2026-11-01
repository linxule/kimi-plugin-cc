import { constants as fsConstants, existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { validateKimiHookSetForEnvironment } from "./config-safety.js";
import { evaluateInstalled } from "./managed-block.js";
import { resolveHostId, tryBuildExpectedHookCommand } from "./install-paths.js";
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
    const hookSet = await validateKimiHookSetForEnvironment(raw, env);
    if (!hookSet.valid) {
        return {
            installed: false,
            reason: hookSet.reason ?? "configured hooks failed whole-array validation",
            configPath,
        };
    }
    // Classify command mismatches into actionable drift reasons without changing
    // the installed=false decision. hostId isolates this host's block in the
    // shared config.
    const check = evaluateInstalled(raw, expected.command, {
        hostId: resolveHostId(env, expected.hookScriptPath),
        nodeExists: (binPath) => existsSync(binPath),
    });
    if (!check.installed) {
        return {
            installed: false,
            reason: check.reason,
            configPath,
            // Forwarded verbatim. Present only for a parseable path/binary mismatch;
            // the earlier short-circuits above (unresolvable command, unreadable
            // config, invalid hook set) return before this point and therefore never
            // carry drift — those are not re-pin-recoverable.
            ...(check.drift !== undefined ? { drift: check.drift } : {}),
        };
    }
    // A byte-exact command does not prove the hook can run. Confirm the script
    // remains readable and fail closed on every access error.
    try {
        await access(expected.hookScriptPath, fsConstants.R_OK);
    }
    catch {
        return {
            installed: false,
            reason: `hook script ${expected.hookScriptPath} is missing or unreadable — run /kimi:setup to reinstall`,
            configPath,
        };
    }
    // Confirm the pinned interpreter with a NARROW X_OK backstop. Interpreter
    // moves that change the recomputed command are already refused as drift; this
    // check covers only unchanged command bytes whose Node token fails X_OK now:
    //
    //   1. An absolute KIMI_PLUGIN_CC_NODE_BIN override names a dead interpreter
    //      other than the running process, so launch never proved it executable.
    //   2. The interpreter is chmodded after launch. realpathSync still resolves
    //      it, the preferred path and command bytes stay unchanged, but X_OK fails.
    //   3. The pathname is removed after launch. realpathSync throws, and the
    //      execPath fallback can retain the same spelling, so equality still passes
    //      while the pinned path is gone.
    //
    // Refusing these cases matters because a failed hook spawn is ALLOW upstream.
    // This per-spawn check also catches degradation since setup's last execution
    // probe. It proves only the exec bit, not a working Node, architecture, or
    // version; setup's shell probe executes the byte-identical command instead.
    //
    // Fail closed on EVERY access error. Do not harmonize this with spawning code
    // that ignores selected errnos: a security verifier cannot "try and see".
    //
    // This refusal carries no drift and therefore no retryable_after_setup field:
    // setup cannot repair a broken Node installation.
    try {
        await access(expected.nodeBin, fsConstants.X_OK);
    }
    catch {
        return {
            installed: false,
            reason: `hook interpreter ${expected.nodeBin} is missing or not executable, so the PreToolUse hook ` +
                `cannot spawn (kimi-code reads a failed hook as ALLOW). Repair the Node install, or set ` +
                `KIMI_PLUGIN_CC_NODE_BIN to a valid Node >=22.5 executable and run /kimi:setup.`,
            configPath,
            refusalKind: "node-bin-not-executable",
            nodeBin: expected.nodeBin,
        };
    }
    return { installed: true, configPath };
}
function resolveKimiCodeConfigPath(env) {
    return path.join(resolveKimiHome(env), "config.toml");
}
/**
 * Caller-facing repair protocol shared by every hook-refusal surface. Re-pin
 * through the resolved plugin root, retry ONCE only when
 * `retryable_after_setup` is literally true and setup exits zero, and never use
 * the skip-check environment variable as a repair.
 */
export function hookRefusalRetryProtocol(env) {
    const root = env.CLAUDE_PLUGIN_ROOT ?? env.PLUGIN_ROOT ?? "${CLAUDE_PLUGIN_ROOT}";
    return (`If details shows retryable_after_setup:true (routine after a plugin update — the ` +
        `version-stamped hook path moved), run \`${root}/scripts/companion.sh setup\` and, only ` +
        `if it exits 0, retry the refused command once. Anything else — or a second refusal — ` +
        `surface the refusal instead of retrying.`);
}
/**
 * Structured details for a hook-refusal RuntimeError. `retryable_after_setup`
 * is present only for drift and is literally true only when setup can re-pin
 * every differing token: hook-script drift, or node-bin/both drift whose Node
 * tokens name the same file. A different interpreter is not automatically
 * repairable. Callers must also require a zero setup exit before one retry.
 */
export function hookRefusalDetails(status) {
    return {
        config_path: status.configPath,
        // Routes the caller to "tell the human to repair Node" instead of the
        // default "run /kimi:setup and retry" reflex. Never co-occurs with `drift`:
        // drift requires the equality check to FAIL, this requires it to PASS.
        ...(status.refusalKind !== undefined
            ? { refusal_kind: status.refusalKind, node_bin: status.nodeBin }
            : {}),
        ...(status.drift !== undefined
            ? {
                drift_axis: status.drift.axis,
                drift_installed_command: status.drift.installedCommand,
                drift_expected_command: status.drift.expectedCommand,
                retryable_after_setup: status.drift.axis === "hook-script" || status.drift.nodeInterpreterUnchanged === true,
            }
            : {}),
    };
}
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
        "  This command will not start a Kimi model run until enforcement is",
        "  repaired (the review gate skips instead of blocking stop).",
        "",
        "  Fix: run Claude Code `/kimi:setup` or Codex `$kimi-setup` to install",
        "  or repair this host's managed block in",
        "  ~/.kimi-code/config.toml. If you use nvm, asdf, mise, or fnm, you",
        "  must re-run `/kimi:setup` after any Node version switch — the",
        "  verifier pins the absolute Node binary path and a switch invalidates",
        "  the previously-installed block by design. See docs/safety.md.",
        "",
        "  KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1 explicitly bypasses hook-verification",
        "  refusals and restores un-enforced `permission: auto` execution. It does",
        "  NOT bypass the experimental-v2 safety refusal. Reserve it for tests or",
        "  diagnostics where the hook risk is intentional.",
        "",
    ].join("\n");
}
/** Once-per-process latch for missing-hook warnings. */
let warnedThisProcess = false;
/**
 * Emit the warning to stderr at most once per process. Stderr is for humans;
 * stdout remains reserved for load-bearing command output.
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
