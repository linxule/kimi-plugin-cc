import { homedir } from "node:os";
import path from "node:path";

import { RuntimeError } from "./errors.js";

/**
 * Resolve the base data directory under which `kimi-plugin-cc/` lives.
 * All hosts (Claude Code, Codex, Antigravity, DSH, Magpie, CLI) share one
 * canonical XDG/LocalAppData root unless overridden by KIMI_PLUGIN_CC_DATA.
 */
export function resolvePluginDataRoot(env: NodeJS.ProcessEnv): string {
  const explicit = env.KIMI_PLUGIN_CC_DATA;
  if (explicit !== undefined) {
    if (!path.isAbsolute(explicit)) {
      throw new RuntimeError(
        "INVALID_PLUGIN_DATA",
        "KIMI_PLUGIN_CC_DATA must be an absolute directory path, not an empty or relative value.",
        "paths",
      );
    }
    return path.normalize(explicit);
  }

  if (env.KIMI_PLUGIN_CC_TEST_NO_DEFAULT_DATA === "1") {
    throw new RuntimeError(
      "MISSING_PLUGIN_DATA",
      "Set KIMI_PLUGIN_CC_DATA to an absolute writable data directory.",
      "paths",
    );
  }

  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) {
      if (!path.isAbsolute(localAppData)) {
        throw new RuntimeError(
          "INVALID_PLUGIN_DATA",
          "LOCALAPPDATA must be an absolute directory path.",
          "paths",
        );
      }
      return path.normalize(localAppData);
    }
    const home = resolveHome(env);
    return path.join(home, "AppData", "Local");
  }

  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  if (xdgDataHome && path.isAbsolute(xdgDataHome)) {
    return path.normalize(xdgDataHome);
  }

  return path.join(resolveHome(env), ".local", "share");
}

function resolveHome(env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  if (!path.isAbsolute(home)) {
    throw new RuntimeError(
      "MISSING_PLUGIN_DATA",
      "Set KIMI_PLUGIN_CC_DATA or HOME to an absolute directory path.",
      "paths",
    );
  }
  return path.normalize(home);
}
