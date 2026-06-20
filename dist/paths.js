import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { RuntimeError } from "./errors.js";
export function resolvePluginPaths(env) {
    const claudePluginData = env.CLAUDE_PLUGIN_DATA;
    if (!claudePluginData) {
        throw new RuntimeError("MISSING_PLUGIN_DATA", "CLAUDE_PLUGIN_DATA is not set. Point it at a writable plugin data directory before running setup.", "paths");
    }
    const pluginRoot = path.join(claudePluginData, "kimi-plugin-cc");
    return {
        claudePluginData,
        pluginRoot,
        stateDbPath: path.join(pluginRoot, "state.db"),
        logsDir: path.join(pluginRoot, "logs"),
        artifactsDir: path.join(pluginRoot, "artifacts"),
        worktreesDir: path.join(pluginRoot, "worktrees"),
        configPath: path.join(pluginRoot, "config.json"),
    };
}
export async function ensurePluginPaths(paths) {
    await mkdir(paths.pluginRoot, { recursive: true });
    await mkdir(paths.logsDir, { recursive: true });
    await mkdir(paths.artifactsDir, { recursive: true });
    await access(paths.pluginRoot, constants.R_OK | constants.W_OK);
    await access(paths.logsDir, constants.R_OK | constants.W_OK);
    await access(paths.artifactsDir, constants.R_OK | constants.W_OK);
    // worktreesDir is created lazily by the write-swarm path (not every command
    // needs it), so it is intentionally NOT required here.
}
