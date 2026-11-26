import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createTestPluginDataRoot, cleanupTestPath } from "../helpers/test-env.js";
const exec = promisify(execFile);
const companion = path.resolve("dist/companion.js");

for (const command of [["ask"], ["review"], ["task", "challenge"], ["task", "rescue"], ["task", "pursue"], ["task", "swarm", "--max-concurrency", "1"]]) {
  test(`compiled ${command.join(" ")} forwards and persists requested effort, leaves ambient alone`, async () => {
    const data = await createTestPluginDataRoot("thinking-effort");
    const invocation = path.join(data, "invocation.json");
    const env: NodeJS.ProcessEnv = { ...process.env, KIMI_PLUGIN_CC_DATA: data,
      KIMI_CODE_HOME: path.join(data, "home"), KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
      KIMI_PLUGIN_CC_KIMI_BIN: "bun", KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify([path.resolve("tests/helpers/mock-kimi-cli.ts")]),
      KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH: invocation, KIMI_PLUGIN_CC_MOCK_SCENARIO: "ask-success" };
    delete env.KIMI_MODEL_THINKING_EFFORT;
    try {
      for (const [flags, ambient, expected] of [
        [["--thinking", "off"], undefined, "off"], [[], undefined, null], [[], "high", "high"],
      ] as const) {
        if (ambient) env.KIMI_MODEL_THINKING_EFFORT = ambient;
        else delete env.KIMI_MODEL_THINKING_EFFORT;
        await exec("node", [companion, ...command, ...flags, "inspect"], { env });
        const logged = JSON.parse(await readFile(invocation, "utf8"));
        expect(logged.env.KIMI_MODEL_THINKING_EFFORT).toBe(expected);
        expect(logged.argv).not.toContain("--thinking");
        const status = JSON.parse((await exec("node", [companion, "status"], { env })).stdout);
        expect(status.status).toBe("completed");
        expect(status.thinking).toBeNull();
        expect(status.thinking_effort_requested).toBe(flags.length ? "off" : null);
        const result = JSON.parse((await exec("node", [companion, "result", status.job_id, "--json"], { env })).stdout);
        expect(result.thinking_effort_requested).toBe(flags.length ? "off" : null);
      }
    } finally { await cleanupTestPath(data); }
  }, 20000);
}

test("resume does not inherit requested thinking effort", async () => {
  const data = await createTestPluginDataRoot("thinking-resume");
  const invocation = path.join(data, "invocation.json");
  const env: NodeJS.ProcessEnv = { ...process.env, KIMI_PLUGIN_CC_DATA: data,
    KIMI_CODE_HOME: path.join(data, "home"), KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
    KIMI_PLUGIN_CC_KIMI_BIN: "bun", KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify([path.resolve("tests/helpers/mock-kimi-cli.ts")]),
    KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH: invocation, KIMI_PLUGIN_CC_MOCK_SCENARIO: "ask-success" };
  delete env.KIMI_MODEL_THINKING_EFFORT;
  try {
    await exec("node", [companion, "ask", "--thinking", "off", "inspect"], { env });
    await exec("node", [companion, "ask", "-r", "continue"], { env });
    expect(JSON.parse(await readFile(invocation, "utf8")).env.KIMI_MODEL_THINKING_EFFORT).toBeNull();
    expect(JSON.parse((await exec("node", [companion, "status"], { env })).stdout).thinking_effort_requested).toBeNull();
  } finally { await cleanupTestPath(data); }
});
