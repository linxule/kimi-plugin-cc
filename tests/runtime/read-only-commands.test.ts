import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { runAsk } from "../../runtime/commands/ask.js";
import { runReview } from "../../runtime/commands/review.js";
import type { CommandContext } from "../../runtime/types.js";
import {
  cleanupTestPath,
  createGitRepoFixture,
  createTestPluginDataRoot,
} from "../helpers/test-env.js";

const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli.ts");

function makeContext(cwd: string, env: NodeJS.ProcessEnv): CommandContext {
  return {
    cwd,
    env,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

function makeMockEnv(
  pluginDataRoot: string,
  scenario: string,
  invocationPath: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginDataRoot,
    KIMI_PLUGIN_CC_KIMI_BIN: "bun",
    KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
    KIMI_PLUGIN_CC_MOCK_SCENARIO: scenario,
    KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH: invocationPath,
  };
}

describe("read-only command handlers", () => {
  test("runAsk returns prose and passes fresh session plus ask profile", async () => {
const pluginDataRoot = await createTestPluginDataRoot("ask-command");
    const invocationPath = path.join(pluginDataRoot, "ask-invocation.jsonl");
    const env = makeMockEnv(pluginDataRoot, "ask-success", invocationPath);

    try {
      const result = await runAsk(["--no-thinking", "What", "changed?"], makeContext(process.cwd(), env));
      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
      const sessionIndex = invocation.argv.indexOf("--session");
      const agentIndex = invocation.argv.indexOf("--agent-file");

      expect(result).toBe("Ask answer from mock Kimi.");
      expect(sessionIndex).toBeGreaterThan(-1);
      expect(invocation.argv[sessionIndex + 1]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(invocation.argv[agentIndex + 1]).toBe(
        path.join(process.cwd(), "runtime/agents/ask.yaml"),
      );
      expect(invocation.argv).toContain("--no-thinking");
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("runReview validates only the final text after ToolResult and passes review profile", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("review-command");
    const repoRoot = await createGitRepoFixture("review-git");
    const invocationPath = path.join(pluginDataRoot, "review-invocation.jsonl");
    const env = makeMockEnv(pluginDataRoot, "review-success", invocationPath);

    try {
      const result = await runReview(["--no-thinking"], makeContext(repoRoot, env), "review");
      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
      const agentIndex = invocation.argv.indexOf("--agent-file");

      expect(result.verdict).toBe("concern");
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.confidence).toBe("high");
      expect(invocation.argv[agentIndex + 1]).toBe(
        path.join(process.cwd(), "runtime/agents/review.yaml"),
      );
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("runReview fails malformed output that omits confidence", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("review-malformed");
    const repoRoot = await createGitRepoFixture("review-git-malformed");
    const invocationPath = path.join(pluginDataRoot, "review-malformed-invocation.jsonl");
    const env = makeMockEnv(pluginDataRoot, "review-missing-confidence", invocationPath);

    try {
      await expect(runReview([], makeContext(repoRoot, env), "review")).rejects.toThrow(
        "missing a required field",
      );
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("read-only commands fail when Kimi requests approval", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("approval-reject");
    const invocationPath = path.join(pluginDataRoot, "approval-invocation.jsonl");
    const env = makeMockEnv(pluginDataRoot, "approval-request", invocationPath);

    try {
      await expect(runAsk(["Is", "this", "safe?"], makeContext(process.cwd(), env))).rejects.toThrow(
        "ask is read-only; approval requests fail the command.",
      );
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });
});
