import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { runAsk } from "../../runtime/commands/ask.js";
import { runResult } from "../../runtime/commands/result.js";
import { runStatus } from "../../runtime/commands/status.js";
import { resolveRepoIdentity } from "../../runtime/git.js";
import { JobStore, type CreateJobInput, type JobRecord } from "../../runtime/job-store.js";
import { persistedExecutionPlanFields, type KimiExecutionPlan } from "../../runtime/kimi-engine.js";
import { getMcpJobResult, getMcpJobStatus } from "../../runtime/mcp/job-control.js";
import { ensurePluginPaths, resolvePluginPaths } from "../../runtime/paths.js";
import { renderManagedJobOutput, renderTerminalJobArtifact, withWarningsBlock } from "../../runtime/render.js";
import type { CommandContext } from "../../runtime/types.js";
import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";

const WARNINGS = ["kimi-code 2.8.0 is not certified by this plugin release; running ask read-only with 2.7.3 mechanics."];
const WARNINGS_JSON = JSON.stringify(WARNINGS);

const PLAN: KimiExecutionPlan = {
  schemaVersion: 1,
  operationKind: "ask",
  intendedEngine: "native-v2",
  command: "/bin/kimi",
  prefixArgs: [],
  kimiVersion: "2.7.3",
  certification: "certified",
  resumedFromJobId: null,
  safetyProfile: "native-v2-no-plan/1",
};

function jobInput(jobId: string, repoId: string, cwd: string, warnings: string | null): CreateJobInput {
  return {
    job_id: jobId, repo_id: repoId, command_type: "ask", cwd, model: null, thinking: null, background: false,
    pid: null, kimi_pid: null, status: "running", kimi_session_id: null,
    ...persistedExecutionPlanFields(PLAN), warnings,
    agent_profile: "<cli-client>", prompt_digest: "d", summary: "s", phase: "starting",
    final_output_path: null, stream_log_path: "/l", error: null,
  };
}

function record(overrides: Partial<JobRecord>): JobRecord {
  return { job_id: "j", command_type: "ask", status: "completed", summary: "s", kimi_session_id: null, error: null,
    ...overrides } as JobRecord;
}

describe("channel W rendering", () => {
  test("no warnings leaves every rendered byte unchanged", () => {
    const job = record({ command_type: "review" });
    expect(withWarningsBlock(job, "body")).toBe("body");
    const plain = renderManagedJobOutput(job, "Finding one.");
    expect(plain.output).toBe("Finding one.");
    expect(plain.rendered).not.toContain("Warnings:");
    expect(renderTerminalJobArtifact(record({ status: "failed" }))).not.toContain("Warnings:");
    expect(persistedExecutionPlanFields(PLAN).warnings).toBeNull();
  });

  test("warnings head stdout and the artifact for prose commands", () => {
    for (const commandType of ["ask", "review", "challenge", "rescue"] as const) {
      const rendered = renderManagedJobOutput(record({ command_type: commandType, warnings: WARNINGS_JSON }), "Answer.");
      expect(rendered.output).toBe(`Warnings:\n- ${WARNINGS[0]}\n\nAnswer.`);
      expect((rendered.rendered as string).startsWith(`Warnings:\n- ${WARNINGS[0]}\n\n`)).toBe(true);
    }
  });

  test("review_gate keeps its parsed decision and carries warnings in the artifact", () => {
    const decision = JSON.stringify({ decision: "ALLOW", confidence: "high", summary: "ok", issues: [] });
    const rendered = renderManagedJobOutput(record({ command_type: "review_gate", warnings: WARNINGS_JSON }), decision);
    expect(typeof rendered.output).toBe("object");
    expect(rendered.rendered.startsWith("Warnings:\n")).toBe(true);
  });

  test("terminal artifacts list warnings", () => {
    const text = renderTerminalJobArtifact(record({ status: "failed", warnings: WARNINGS_JSON }));
    expect(text).toContain(`Warnings:\n- ${WARNINGS[0]}`);
  });

  test("plan warnings persist as JSON", () => {
    expect(persistedExecutionPlanFields({ ...PLAN, warnings: WARNINGS }).warnings).toBe(WARNINGS_JSON);
  });
});

describe("channel W JSON surfaces", () => {
  test("status, result --json and MCP metadata expose warnings only when present", async () => {
    const root = await createTestPluginDataRoot("job-warnings-surfaces");
    const repo = await realpath(await createGitRepoFixture("job-warnings-repo"));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PLUGIN_DATA: root };
      const paths = resolvePluginPaths(env);
      await ensurePluginPaths(paths);
      const { repoId } = await resolveRepoIdentity(repo);
      const warned = randomUUID();
      const plain = randomUUID();
      const store = new JobStore(paths);
      try {
        for (const [jobId, warnings] of [[plain, null], [warned, WARNINGS_JSON]] as const) {
          store.createMcpTask({ task_id: jobId, operation_kind: "ask", repo_id: repoId, workspace_cwd: repo,
            stdout_path: path.join(root, `${jobId}.out`), stderr_path: path.join(root, `${jobId}.err`) });
          store.createJob(jobInput(jobId, repoId, repo, warnings));
          const artifact = path.join(paths.artifactsDir, `ask-${jobId}.md`);
          await writeFile(artifact, "Answer.\n", "utf8");
          store.markCompleted(jobId, { summary: "done", final_output_path: artifact, error: null });
        }
      } finally {
        store.close();
      }
      const context: CommandContext = { cwd: repo, env, stdout: process.stdout, stderr: process.stderr };

      const plainStatus = JSON.parse(await runStatus([plain], context));
      expect("warnings" in plainStatus).toBe(false);
      expect(JSON.parse(await runStatus([warned], context)).warnings).toEqual(WARNINGS);

      expect("warnings" in JSON.parse(await runResult([plain, "--json"], context))).toBe(false);
      expect(JSON.parse(await runResult([warned, "--json"], context)).warnings).toEqual(WARNINGS);

      const plainMcp = await getMcpJobStatus(env, { job_id: plain, workspace: repo });
      expect("warnings" in (plainMcp.structuredContent as Record<string, unknown>)).toBe(false);
      const warnedMcp = await getMcpJobResult(env, { job_id: warned, workspace: repo });
      expect((warnedMcp.structuredContent as Record<string, unknown>).warnings).toEqual(WARNINGS);
    } finally {
      await cleanupTestPath(root);
      await cleanupTestPath(repo);
    }
  });
});

describe("channel W end to end", () => {
  test("an uncertified ask carries its warning in stdout, the artifact, status and result --json", async () => {
    const root = await createTestPluginDataRoot("job-warnings-e2e");
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CLAUDE_PLUGIN_DATA: root,
        KIMI_CODE_HOME: path.join(root, "home"),
        KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
        KIMI_PLUGIN_CC_KIMI_BIN: "bun",
        KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", path.resolve("tests/helpers/mock-kimi-cli-v1.ts")]),
        KIMI_PLUGIN_CC_MOCK_VERSION: "2.8.0",
        KIMI_PLUGIN_CC_MOCK_RECOVERABLE_V2: "1",
        KIMI_PLUGIN_CC_STRICT_VERSIONS: "",
      };
      const warning = "kimi-code 2.8.0 is not certified by this plugin release; running ask read-only with 2.7.3 mechanics.";
      const context: CommandContext = { cwd: process.cwd(), env, stdout: process.stdout, stderr: process.stderr };
      const output = await runAsk(["What", "changed?"], context);
      expect(output.startsWith(`Warnings:\n- ${warning}\n\n`)).toBe(true);
      const status = JSON.parse(await runStatus(["--type", "ask"], context));
      expect(status.warnings).toEqual([warning]);
      expect(status.plan_certification).toBe("uncertified");
      expect(JSON.parse(await runResult([status.job_id, "--json"], context)).warnings).toEqual([warning]);
      expect(await Bun.file(status.final_output_path).text()).toContain(warning);
    } finally {
      await cleanupTestPath(root);
    }
  }, 30_000);
});
