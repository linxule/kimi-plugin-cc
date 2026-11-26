import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { JobStore } from "../../runtime/job-store.js";
import { resolveRepoIdentity } from "../../runtime/git.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import { createMcpFixture, McpClient, modernMeta } from "../helpers/mcp.js";
import { cleanupTestPath, createGitRepoFixture } from "../helpers/test-env.js";

describe("MCP task ownership and data-root isolation", () => {
  test("enforces workspace boundaries and isolates cross-repo jobs and native task views", async () => {
    const first = await createMcpFixture("mcp-owner-first", { delayMs: "30000" });
    const secondRepo = await createGitRepoFixture("mcp-owner-second");
    const nested = path.join(first.repo, "nested");
    await mkdir(nested);
    let client: McpClient | undefined;
    let modernClient: McpClient | undefined;
    try {
      client = await McpClient.legacy(first);
      const started = await client.request("tools/call", {
        name: "kimi_read",
        arguments: { workspace: first.repo, mode: "ask", prompt: "Keep this job private", wait: false },
      });
      const jobId = started.structuredContent.job_id as string;
      for (const [workspace, code] of [[secondRepo, "MCP_WORKSPACE_OUTSIDE_DEFAULT"], [nested, "JOB_NOT_FOUND"]] as const) {
        const denied = await client.request("tools/call", {
          name: "kimi_job",
          arguments: { action: "status", job_id: jobId, workspace },
        });
        expect(denied.isError).toBe(true);
        expect(denied.structuredContent.error.code).toBe(code);
      }

      // Same-repo CLI job is inspectable through kimi_job (shared canonical data root),
      // while native MCP tasks/get remains scoped strictly to MCP tasks.
      const foregroundFirst = spawnSync(path.join(first.pluginRoot, "scripts/companion.sh"), ["ask", "--fresh", "Create a CLI job in repo 1"], {
        cwd: first.repo,
        env: { ...first.env, KIMI_PLUGIN_CC_MOCK_DELAY_MS: "0" },
        encoding: "utf8",
      });
      expect(foregroundFirst.status).toBe(0);

      // Another repo's CLI job in the same canonical store must never be readable from first.repo.
      const foregroundSecond = spawnSync(path.join(first.pluginRoot, "scripts/companion.sh"), ["ask", "--fresh", "Create a CLI job in repo 2"], {
        cwd: secondRepo,
        env: { ...first.env, KIMI_PLUGIN_CC_MOCK_DELAY_MS: "0" },
        encoding: "utf8",
      });
      expect(foregroundSecond.status).toBe(0);

      const store = new JobStore(resolvePluginPaths(first.env));
      let cliJobIdFirst: string | undefined;
      let cliJobIdSecond: string | undefined;
      try {
        const repo1 = await resolveRepoIdentity(first.repo);
        const repo2 = await resolveRepoIdentity(secondRepo);
        cliJobIdFirst = store.findLatestJob({ repoId: repo1.repoId, commandType: "ask", terminalOnly: true })?.job_id;
        cliJobIdSecond = store.findLatestJob({ repoId: repo2.repoId, commandType: "ask", terminalOnly: true })?.job_id;
      } finally {
        store.close();
      }
      expect(cliJobIdFirst).toBeDefined();
      expect(cliJobIdSecond).toBeDefined();
      expect(cliJobIdFirst).not.toBe(jobId);

      const sameRepoCli = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "status", job_id: cliJobIdFirst, workspace: first.repo },
      });
      expect(sameRepoCli.isError).toBe(false);
      expect(sameRepoCli.structuredContent.job_id).toBe(cliJobIdFirst);
      expect(sameRepoCli.structuredContent.status).toBe("completed");

      const otherRepoCli = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "status", job_id: cliJobIdSecond, workspace: first.repo },
      });
      expect(otherRepoCli.isError).toBe(true);
      expect(otherRepoCli.structuredContent.error.code).toBe("JOB_NOT_FOUND");

      modernClient = await McpClient.modern(first);
      let taskError: Error | undefined;
      try {
        await modernClient.request("tasks/get", { taskId: cliJobIdFirst, _meta: modernMeta() });
      } catch (error) {
        taskError = error as Error;
      }
      expect(taskError).toBeDefined();
      expect(JSON.parse(taskError!.message)).toMatchObject({
        code: -32_602,
        message: `Unknown task ID: ${cliJobIdFirst}`,
      });

      const cancelled = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "cancel", job_id: jobId },
      });
      expect(cancelled.structuredContent.cancellation.status).toBe("cancelled");
    } finally {
      if (modernClient) await modernClient.close();
      if (client) await client.close();
      await first.cleanup();
      await cleanupTestPath(secondRepo);
    }
  }, 60_000);

  test("invalid or missing KIMI_PLUGIN_CC_DATA fails before store access or model launch", async () => {
    const fixture = await createMcpFixture("mcp-data-validation");
    const relativeTarget = path.join(fixture.repo, "relative-data-dir");
    try {
      const relativeEnv: NodeJS.ProcessEnv = { ...fixture.env, KIMI_PLUGIN_CC_DATA: "relative-data-dir" };
      const relativeResult = spawnSync(path.join(fixture.pluginRoot, "scripts/companion.sh"), ["mcp"], {
        cwd: fixture.repo,
        env: relativeEnv,
        encoding: "utf8",
        input: "",
      });
      expect(relativeResult.status).not.toBe(0);
      expect(relativeResult.stderr).toContain("INVALID_PLUGIN_DATA");
      expect(existsSync(relativeTarget)).toBe(false);

      const missingEnv: NodeJS.ProcessEnv = {
        ...fixture.env,
        KIMI_PLUGIN_CC_TEST_NO_DEFAULT_DATA: "1",
      };
      delete missingEnv.KIMI_PLUGIN_CC_DATA;
      const missingResult = spawnSync(path.join(fixture.pluginRoot, "scripts/companion.sh"), ["mcp"], {
        cwd: fixture.repo,
        env: missingEnv,
        encoding: "utf8",
        input: "",
      });
      expect(missingResult.status).not.toBe(0);
      expect(missingResult.stderr).toContain("MISSING_PLUGIN_DATA");
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});
