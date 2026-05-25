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

const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli-v1.ts");

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
  test("runAsk returns prose and forwards the v1 cli flags + command label", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-command");
    const invocationPath = path.join(pluginDataRoot, "ask-invocation.jsonl");
    const env = makeMockEnv(pluginDataRoot, "ask-success", invocationPath);

    try {
      const result = await runAsk(["What", "changed?"], makeContext(process.cwd(), env));
      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as {
        argv: string[];
        env: { KIMI_PLUGIN_CC_CMD: string | null };
      };

      // v1.0 cli-client passes `--output-format stream-json` and `-p <prompt>`.
      // No `--session <uuid>` (kimi-code assigns the id) and no
      // `--agent-file` (kimi-code has no YAML agent profiles).
      expect(result).toBe("Ask answer from mock Kimi.");
      expect(invocation.argv).toContain("--output-format");
      expect(invocation.argv).toContain("stream-json");
      expect(invocation.argv).toContain("-p");
      expect(invocation.env.KIMI_PLUGIN_CC_CMD).toBe("ask");
      // v1.0 alpha.4: ask runs thinking-on always. Only review-gate's
      // internal caller pins thinking=false. (Kimi alpha.4 finding #1.)
      expect(invocation.argv).not.toContain("--no-thinking");
      expect(invocation.argv).not.toContain("--thinking");
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("runReview returns prose passthrough and sets the review command label", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("review-command");
    const repoRoot = await createGitRepoFixture("review-git");
    const invocationPath = path.join(pluginDataRoot, "review-invocation.jsonl");
    const env = makeMockEnv(pluginDataRoot, "review-success", invocationPath);

    try {
      const result = await runReview([], makeContext(repoRoot, env), "review");
      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as {
        argv: string[];
        env: { KIMI_PLUGIN_CC_CMD: string | null };
      };

      // Output passes through as prose — no schema parsing.
      expect(result).toContain("concern");
      expect(result).toContain("Incorrect answer constant");
      expect(invocation.env.KIMI_PLUGIN_CC_CMD).toBe("review");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("runReview accepts review output without enforcing a schema", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("review-empty");
    const repoRoot = await createGitRepoFixture("review-git-empty");
    const invocationPath = path.join(pluginDataRoot, "review-empty-invocation.jsonl");
    const env = makeMockEnv(pluginDataRoot, "review-missing-confidence", invocationPath);

    try {
      // The "review-missing-confidence" mock scenario emits JSON without a
      // confidence field. Before v0.2.3 this failed schema parsing; v0.2.3
      // dropped the schema and review now accepts any non-empty text. The
      // only remaining hard failure is empty output, which this mock does
      // not produce — so the call should succeed with non-empty stdout.
      const result = await runReview([], makeContext(repoRoot, env), "review");
      expect(result.length).toBeGreaterThan(0);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  // v0.4 surfaced a wire-protocol Approval Request through the runtime's
  // ApprovalDispatcher (rejectAllApprovals) so read-only commands would
  // fail loudly if kimi asked for permission. v1.0 moves that enforcement
  // out-of-band into the PreToolUse hook (runtime/hooks/approval-policy.ts),
  // which is exercised by approval-policy.test.ts. There is no
  // runtime-side equivalent in v1: the hook denies before the model can
  // emit a tool call, the model adapts, and the assistant prose comes
  // back as normal. Tests of the deny path live with the hook policy.
});
