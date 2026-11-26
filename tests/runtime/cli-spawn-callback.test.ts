import { describe, expect, test } from "bun:test";
import path from "node:path";

import { runCliPrompt } from "../../runtime/cli-client.js";
import { prepareKimiExecutionPlan } from "../../runtime/kimi-engine.js";
import { cleanupTestPath, createGitRepoFixture } from "../helpers/test-env.js";

const mockCli = path.join(process.cwd(), "tests/helpers/mock-kimi-cli.ts");

describe("spawn-time PID callback", () => {
  test("receives the real child PID before the result settles", async () => {
    const repo = await createGitRepoFixture("spawn-callback");
    let spawnedPid: number | undefined;
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: "1",
        KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
        KIMI_PLUGIN_CC_KIMI_BIN: "bun",
        KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCli]),
        KIMI_PLUGIN_CC_MOCK_SCENARIO: "ask-success",
      };
      const executionPlan = await prepareKimiExecutionPlan({ operationKind: "ask", cwd: repo, env });
      let pidAtResult: number | undefined;
      const result = await runCliPrompt({
        cwd: repo,
        env,
        command: executionPlan.command,
        prefixArgs: [...executionPlan.prefixArgs],
        executionPlan,
        prompt: "Return the mock answer",
        commandLabel: "ask",
        onSpawn: (pid) => { spawnedPid = pid; },
        onRecord: () => { pidAtResult = spawnedPid; },
      });
      expect(spawnedPid).toBeGreaterThan(0);
      expect(pidAtResult).toBe(spawnedPid);
      expect(result.records[0]).toMatchObject({ role: "assistant", content: "Ask answer from mock Kimi." });
    } finally {
      await cleanupTestPath(repo);
    }
  }, 30_000);

  test("a callback failure tears down the spawned child", async () => {
    const repo = await createGitRepoFixture("spawn-callback-failure");
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: "1",
        KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
        KIMI_PLUGIN_CC_KIMI_BIN: "bun",
        KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCli]),
        KIMI_PLUGIN_CC_MOCK_DELAY_MS: "30000",
      };
      const executionPlan = await prepareKimiExecutionPlan({ operationKind: "ask", cwd: repo, env });
      await expect(runCliPrompt({
        cwd: repo,
        env,
        command: executionPlan.command,
        prefixArgs: [...executionPlan.prefixArgs],
        executionPlan,
        prompt: "Fail the spawn callback",
        commandLabel: "ask",
        onSpawn: () => { throw new Error("callback failed"); },
      })).rejects.toMatchObject({ code: "CLI_SPAWN_CALLBACK_FAILED" });
    } finally {
      await cleanupTestPath(repo);
    }
  }, 30_000);
});
