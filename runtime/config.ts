import { readFile, writeFile } from "node:fs/promises";

import type { PluginPaths } from "./paths.js";

export interface PluginConfig {
  reviewGateEnabled: boolean;
}

const DEFAULT_CONFIG: PluginConfig = {
  reviewGateEnabled: false,
};

export async function readPluginConfig(paths: PluginPaths): Promise<PluginConfig> {
  try {
    const contents = await readFile(paths.configPath, "utf8");
    const parsed = JSON.parse(contents) as Partial<PluginConfig>;

    return {
      reviewGateEnabled: parsed.reviewGateEnabled ?? DEFAULT_CONFIG.reviewGateEnabled,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_CONFIG;
    }

    throw error;
  }
}

export async function writePluginConfig(paths: PluginPaths, config: PluginConfig): Promise<void> {
  await writeFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
