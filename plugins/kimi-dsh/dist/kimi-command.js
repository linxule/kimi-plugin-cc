import { RuntimeError } from "./errors.js";
export function resolveKimiCliCommand(env) {
    const command = env.KIMI_PLUGIN_CC_KIMI_BIN || "kimi";
    const raw = env.KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS;
    if (!raw) {
        return { command, prefixArgs: [] };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        // Plain-text values are space-split for launcher-style overrides.
        const plainArgs = raw.split(" ").filter(Boolean);
        assertPrefixArgsSafe(plainArgs, raw);
        return { command, prefixArgs: plainArgs };
    }
    if (!Array.isArray(parsed)) {
        throw new RuntimeError("INVALID_ENV", "KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS must be a JSON array of strings.", "kimi-command.env", { details: { env_var: "KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS", value: raw, retryable_after_setup: false } });
    }
    for (const entry of parsed) {
        if (typeof entry !== "string") {
            throw new RuntimeError("INVALID_ENV", "KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS entries must be strings.", "kimi-command.env", { details: { env_var: "KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS", value: raw, retryable_after_setup: false } });
        }
    }
    const prefixArgs = parsed;
    assertPrefixArgsSafe(prefixArgs, raw);
    return { command, prefixArgs };
}
/**
 * Flags the plugin owns on the `kimi -p` argv. The prefix is only a launcher
 * shim (e.g. `["run", "<companion-dist>"]`); it must never carry a kimi flag
 * that changes the session, engine, plan, prompt, or output format. In
 * particular a smuggled `-r <session>` would resume a session the plugin never
 * scanned for plan-mode taint (the journal scan keys only on the plugin-chosen
 * resumeSessionId), so it is refused here — the single resolution point reached
 * by both foreground and detached-worker spawns.
 */
const RESERVED_PREFIX_FLAGS = new Set([
    // Session selection — incl. the HIDDEN `-C` alias of `--continue`
    // (apps/kimi-code/src/cli/commands.ts), which resumes the latest session for
    // the cwd without any plugin-chosen resumeSessionId, so no journal scan runs.
    "-r", "--resume", "-S", "--session", "-c", "-C", "--continue",
    // Prompt / output.
    "-p", "--prompt", "--output-format",
    // Permission / plan mode.
    "--plan", "--auto", "-y", "--yolo", "--yes", "--auto-approve", "--manual",
    // Model / profile / roots.
    "-m", "--model", "--skills-dir", "--agent", "--agent-file", "--add-dir",
    // Terminal informational flags (would replace the run with a banner).
    "-V", "--version", "-h", "--help",
]);
export function assertPrefixArgsSafe(prefixArgs, raw) {
    for (const token of prefixArgs) {
        // Compare the flag name only, so `--session=x` is caught as well as `-S x`.
        const flag = token.startsWith("-") ? token.split("=", 1)[0] : token;
        if (RESERVED_PREFIX_FLAGS.has(flag)) {
            throw new RuntimeError("INVALID_ENV", `KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS must not contain the reserved kimi flag "${flag}". ` +
                "The prefix is a launcher shim only; session, engine, plan, prompt, model, and " +
                "output-format flags are owned by the plugin and would bypass its safety checks.", "kimi-command.env", {
                details: {
                    env_var: "KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS",
                    reserved_flag: flag,
                    value: raw,
                    retryable_after_setup: false,
                },
            });
        }
    }
}
