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
        // Plain-text fallback. Mirrors v0.4's permissive shape so users with
        // an existing `KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS="--import tsx ..."`
        // export don't have to migrate to JSON for v1.0.
        return { command, prefixArgs: raw.split(" ").filter(Boolean) };
    }
    if (!Array.isArray(parsed)) {
        throw new RuntimeError("INVALID_ENV", "KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS must be a JSON array of strings.", "kimi-command.env", { details: { env_var: "KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS", value: raw } });
    }
    for (const entry of parsed) {
        if (typeof entry !== "string") {
            throw new RuntimeError("INVALID_ENV", "KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS entries must be strings.", "kimi-command.env", { details: { env_var: "KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS", value: raw } });
        }
    }
    return { command, prefixArgs: parsed };
}
