import { readFile, writeFile } from "node:fs/promises";
const DEFAULT_CONFIG = {
    reviewGateEnabled: false,
};
export async function readPluginConfig(paths) {
    try {
        const contents = await readFile(paths.configPath, "utf8");
        const parsed = JSON.parse(contents);
        return {
            reviewGateEnabled: parsed.reviewGateEnabled ?? DEFAULT_CONFIG.reviewGateEnabled,
        };
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return DEFAULT_CONFIG;
        }
        throw error;
    }
}
export async function writePluginConfig(paths, config) {
    await writeFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
