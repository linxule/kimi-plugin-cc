import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { runAsk } from "../../runtime/commands/ask.js";
import { runResult } from "../../runtime/commands/result.js";
import { runStatus } from "../../runtime/commands/status.js";
import { JobStore } from "../../runtime/job-store.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import type { CommandContext } from "../../runtime/types.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli.ts");

function makeContext(cwd: string, env: NodeJS.ProcessEnv): CommandContext {
  return {
    cwd,
    env,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

function makeMockEnv(pluginDataRoot: string, scenario: string, invocationPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginDataRoot,
    KIMI_PLUGIN_CC_KIMI_BIN: "bun",
    KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
    KIMI_PLUGIN_CC_MOCK_SCENARIO: scenario,
    KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH: invocationPath,
  };
}

describe("job-backed ask/status/result", () => {
  test("ask is persisted and visible through status/result", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("job-ask");
    const invocationPath = path.join(pluginDataRoot, "ask-invocation.jsonl");
    const env = makeMockEnv(pluginDataRoot, "ask-success", invocationPath);

    try {
      const askResult = await runAsk(["What", "changed?"], makeContext(process.cwd(), env));
      const statusOutput = await runStatus(["--type", "ask"], makeContext(process.cwd(), env));
      const resultOutput = await runResult(["--type", "ask"], makeContext(process.cwd(), env));
      const status = JSON.parse(statusOutput) as { job_id: string; status: string; command_type: string };
      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
      const sessionIndex = invocation.argv.indexOf("--session");
      const store = new JobStore(resolvePluginPaths(env));

      try {
        const storedJob = store.getJob(status.job_id);
        expect(storedJob?.kimi_session_id).toBe(invocation.argv[sessionIndex + 1]);
      } finally {
        store.close();
      }

      expect(askResult).toBe("Ask answer from mock Kimi.");
      expect(status.command_type).toBe("ask");
      expect(status.status).toBe("completed");
      expect(resultOutput).toContain("Ask answer from mock Kimi.");
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });
});
