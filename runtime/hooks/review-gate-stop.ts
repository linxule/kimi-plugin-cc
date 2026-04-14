import { readFileSync } from "node:fs";

import { runReviewGateStopHook, type StopHookInput } from "../commands/review-gate.js";
import { formatError } from "../errors.js";
import type { CommandContext } from "../types.js";

async function main(): Promise<void> {
  const raw = readFileSync(0, "utf8");
  const input = JSON.parse(raw) as StopHookInput;
  const context: CommandContext = {
    cwd: process.env.KIMI_PLUGIN_CC_WORKSPACE_CWD || process.cwd(),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  };

  const output = await runReviewGateStopHook(input, context);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${formatError(error)}\n`);
  process.exitCode = 1;
});
