#!/usr/bin/env -S node --import tsx
import { readFileSync } from "node:fs";
import { runReviewGateStopHook } from "../commands/review-gate.js";
import { formatError } from "../errors.js";
async function main() {
    const raw = readFileSync(0, "utf8");
    const input = JSON.parse(raw);
    const context = {
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
