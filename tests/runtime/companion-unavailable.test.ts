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
  test("ask, review, challenge, and rescue fail actionably before creating a model job", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("companion-unavailable");
    const repoRoot = await createGitRepoFixture("companion-unavailable-repo");
    const env = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: pluginDataRoot,
      KIMI_PLUGIN_CC_KIMI_BIN: "/nonexistent/path",
      KIMI_PLUGIN_CC_WORKSPACE_CWD: repoRoot,
      // This test exercises the kimi-binary-unavailable code path
      // across all four commands. Rescue would otherwise short-circuit
      // on the v1.0 hook-installation refusal before reaching the
      // spawn; bypass that check so the binary-unavailable assertion
      // still runs for rescue. (Hook-refusal is covered separately.)
      KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
    };

    try {
      await assertUnavailableCommand(env, ["ask", "What", "changed?"], "ask");
      await assertUnavailableCommand(env, ["review"], "review");
      await assertUnavailableCommand(
        env,
        ["task", "challenge", "Challenge", "this"],
        "challenge",
      );
      await assertUnavailableCommand(env, ["task", "rescue", "Fix", "this"], "rescue");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });
});

async function assertUnavailableCommand(
  env: NodeJS.ProcessEnv,
  argv: string[],
  commandType: "ask" | "review" | "challenge" | "rescue",
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
    expect(output).toContain("KIMI_EXECUTION_PLAN_UNRESOLVED");
    expect(output).toContain("Run Claude Code `/kimi:setup` or Codex `$kimi-setup`");
    expect(output).not.toContain("persisted as failed");
    expect(latest).toBeNull();
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
