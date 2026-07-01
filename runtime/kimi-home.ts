import os from "node:os";
import path from "node:path";

export function resolveKimiHome(env: NodeJS.ProcessEnv, baseCwd = process.cwd()): string {
  const override = env.KIMI_CODE_HOME?.trim();
  if (override) {
    return path.resolve(baseCwd, override);
  }
  return path.join(os.homedir(), ".kimi-code");
}
