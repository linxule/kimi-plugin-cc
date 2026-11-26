import { constants } from "node:fs";
import { access, chmod, lstat, mkdir } from "node:fs/promises";
import path from "node:path";

import { resolvePluginDataRoot } from "./plugin-data.js";

export interface PluginPaths {
  dataRoot: string;
  /** @deprecated Alias of `dataRoot` retained for existing callers/tests. */
  claudePluginData: string;
  pluginRoot: string;
  stateDbPath: string;
  logsDir: string;
  artifactsDir: string;
  hookDir: string;
  hookScriptPath: string;
  /**
   * Ephemeral git worktrees for write-swarm (v1.4). Lives under the plugin's own
   * data dir — NEVER inside a user repo — so a throwaway worktree is isolated from
   * the user's checkout and the `git worktree add` target is always outside the
   * repo. Each run gets a `swarm-write-<jobId>` subdir; the patch is captured then
   * the dir is removed. Hard-kill orphans are retained for explicit recovery, never age-deleted.
   */
  worktreesDir: string;
  configPath: string;
}

export function resolvePluginPaths(env: NodeJS.ProcessEnv): PluginPaths {
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
export function resolveKimiBinDir(env: NodeJS.ProcessEnv): string {
  return path.join(resolvePluginPaths(env).pluginRoot, "kimi-bin");
}

export async function ensurePluginPaths(paths: PluginPaths): Promise<void> {
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
