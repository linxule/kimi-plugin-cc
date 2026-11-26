import { constants } from "node:fs";
import { access, chmod, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { resolvePluginDataRoot } from "./plugin-data.js";
export function resolvePluginPaths(env) {
    const dataRoot = resolvePluginDataRoot(env);
    const pluginRoot = path.join(dataRoot, "kimi-plugin-cc");
    const hookDir = path.join(pluginRoot, "hook");
    return {
        dataRoot,
        claudePluginData: dataRoot,
        pluginRoot,
        stateDbPath: path.join(pluginRoot, "state.db"),
        logsDir: path.join(pluginRoot, "logs"),
        artifactsDir: path.join(pluginRoot, "artifacts"),
        hookDir,
        hookScriptPath: path.join(hookDir, "approval-hook.js"),
        worktreesDir: path.join(pluginRoot, "worktrees"),
        configPath: path.join(pluginRoot, "config.json"),
    };
}
/**
 * Plugin-owned kimi-code installs (`setup --install-kimi`): one directory per
 * exact version plus a `current` symlink. Binary resolution and the installer
 * both use this helper so they cannot disagree about the location.
 */
export function resolveKimiBinDir(env) {
    return path.join(resolvePluginPaths(env).pluginRoot, "kimi-bin");
}
export async function ensurePluginPaths(paths) {
    // Never chmod paths.dataRoot (often shared ~/.local/share or a user directory),
    // and never follow a symlink when tightening permissions on plugin directories.
    for (const dir of [paths.pluginRoot, paths.logsDir, paths.artifactsDir]) {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        if (process.platform !== "win32") {
            const info = await lstat(dir);
            if (!info.isSymbolicLink()) {
                await chmod(dir, 0o700);
            }
        }
        await access(dir, constants.R_OK | constants.W_OK);
    }
    // worktreesDir is created lazily by the write-swarm path (not every command
    // needs it), so it is intentionally NOT required here.
}
