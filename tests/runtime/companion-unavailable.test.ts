import { describe, expect, test } from "bun:test";
import path from "node:path";
import { spawn } from "node:child_process";

import { resolveRepoIdentity } from "../../runtime/git.js";
import { JobStore } from "../../runtime/job-store.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import {
  cleanupTestPath,
  createGitRepoFixture,
  createTestPluginDataRoot,
} from "../helpers/test-env.js";

const companionPath = path.join(process.cwd(), "runtime/companion.ts");

describe("companion Kimi-unavailable handling", () => {
  test("ask, review, adversarial review, and rescue report actionable startup failures and persist failed jobs", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("companion-unavailable");
    const repoRoot = await createGitRepoFixture("companion-unavailable-repo");
    const env = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: pluginDataRoot,
      KIMI_PLUGIN_CC_KIMI_BIN: "/nonexistent/path",
      KIMI_PLUGIN_CC_WORKSPACE_CWD: repoRoot,
    };

    try {
      await assertUnavailableCommand(env, ["ask", "What", "changed?"], "ask", "ASK_KIMI_BINARY_UNAVAILABLE");
      await assertUnavailableCommand(env, ["review"], "review", "REVIEW_KIMI_BINARY_UNAVAILABLE");
      await assertUnavailableCommand(
        env,
        ["task", "adversarial-review", "Challenge", "this"],
        "adversarial_review",
        "ADVERSARIAL_REVIEW_KIMI_BINARY_UNAVAILABLE",
      );
      await assertUnavailableCommand(env, ["task", "rescue", "Fix", "this"], "rescue", "RESCUE_KIMI_BINARY_UNAVAILABLE");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });
});

async function assertUnavailableCommand(
  env: NodeJS.ProcessEnv,
  argv: string[],
  commandType: "ask" | "review" | "adversarial_review" | "rescue",
  errorCode: string,
): Promise<void> {
  const failure = await runCompanion(argv, env);
  const output = [failure.stdout, failure.stderr].join("\n");
  const paths = resolvePluginPaths(env);
  const repoId = (await resolveRepoIdentity(env.KIMI_PLUGIN_CC_WORKSPACE_CWD || process.cwd())).repoId;
  const jobStore = new JobStore(paths);
  try {
    const latest = jobStore.findLatestJob({
      repoId,
      commandType,
    });

    expect(failure.exitCode).not.toBeNull();
    expect(output).toContain("Run `/kimi:setup`");
    expect(output).toContain("persisted as failed");
    expect(latest?.status).toBe("failed");
    expect(latest?.error?.code).toBe(errorCode);
    expect(output).toContain(`Job ${latest?.job_id} was persisted as failed.`);
  } finally {
    jobStore.close();
  }
}

async function runCompanion(argv: string[], env: NodeJS.ProcessEnv): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--import", "tsx", companionPath, ...argv], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        exitCode: code,
        stdout,
        stderr,
      });
    });
  });
}
