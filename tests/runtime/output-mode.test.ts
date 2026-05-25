import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { JobRecord } from "../../runtime/job-store.js";
import { RuntimeError } from "../../runtime/errors.js";
import { ensurePluginPaths, resolvePluginPaths } from "../../runtime/paths.js";
import { renderManagedJobOutput, writeArtifact } from "../../runtime/render.js";
import type { ManagedCommandType } from "../../runtime/types.js";
import {
  cleanupTestPath,
  createGitRepoFixture,
  createTestPluginDataRoot,
} from "../helpers/test-env.js";

const companionPath = path.join(process.cwd(), "runtime/companion.ts");
const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli-v1.ts");
const rawReviewOutput = JSON.stringify({
  summary: "One correctness issue found.",
  verdict: "concern",
  findings: [
    {
      severity: "medium",
      confidence: "high",
      title: "Incorrect answer constant",
      file: "src.ts",
      start_line: 1,
      body: "The exported answer changed from 41 to 42 without corresponding test updates.",
      suggested_fix: null,
    },
  ],
});

function makeJob(commandType: ManagedCommandType): JobRecord {
  return {
    job_id: `job-${commandType}`,
    repo_id: "repo",
    command_type: commandType,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    cwd: process.cwd(),
    model: null,
    thinking: false,
    background: false,
    pid: null,
    kimi_pid: null,
    status: "running",
    kimi_session_id: "session",
    agent_profile: `runtime/agents/${commandType}.yaml`,
    prompt_digest: "digest",
    summary: "running",
    phase: null,
    final_output_path: null,
    stream_log_path: "stream.jsonl",
    error: null,
  };
}

describe("command output mode enforcement", () => {
  test("companion review stdout is raw runReview bytes plus trailing newline", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("companion-review-stdout");
    const repoRoot = await createGitRepoFixture("companion-review-repo");

    try {
      const result = await runCompanion(["review", "--no-thinking"], {
        ...process.env,
        CLAUDE_PLUGIN_DATA: pluginDataRoot,
        KIMI_PLUGIN_CC_KIMI_BIN: "bun",
        KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
        KIMI_PLUGIN_CC_MOCK_SCENARIO: "review-success",
        KIMI_PLUGIN_CC_WORKSPACE_CWD: repoRoot,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toEqual(Buffer.from(`${rawReviewOutput}\n`));
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("companion challenge stdout is raw runReview bytes plus trailing newline", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("companion-challenge-stdout");
    const repoRoot = await createGitRepoFixture("companion-challenge-repo");

    try {
      const result = await runCompanion(["task", "challenge", "--no-thinking"], {
        ...process.env,
        CLAUDE_PLUGIN_DATA: pluginDataRoot,
        KIMI_PLUGIN_CC_KIMI_BIN: "bun",
        KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
        KIMI_PLUGIN_CC_MOCK_SCENARIO: "review-success",
        KIMI_PLUGIN_CC_WORKSPACE_CWD: repoRoot,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toEqual(Buffer.from(`${rawReviewOutput}\n`));
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("parsed review_gate output throws before artifact rendering when JSON is malformed", () => {
    expect(() => renderManagedJobOutput(makeJob("review_gate"), "not-json")).toThrow(
      /review_gate is configured for parsed output but returned malformed JSON/,
    );
  });

  test("passthrough command writes JSON-shaped output without structural errors", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("output-mode-passthrough");
    const paths = resolvePluginPaths({ ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot });

    try {
      await ensurePluginPaths(paths);
      const job = makeJob("ask");
      const finalText = '{"decision":"BLOCK","confidence":"high","summary":"plain text","issues":[]}';
      const rendered = renderManagedJobOutput(job, finalText);
      const artifactPath = await writeArtifact(paths, job, rendered.rendered);

      expect(await readFile(artifactPath, "utf8")).toBe(`${finalText}\n`);
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("rescue empty final text throws RESCUE_EMPTY_OUTPUT", () => {
    expect(() => renderManagedJobOutput(makeJob("rescue"), "   \n")).toThrow(RuntimeError);

    try {
      renderManagedJobOutput(makeJob("rescue"), "   \n");
    } catch (error) {
      expect((error as RuntimeError).code).toBe("RESCUE_EMPTY_OUTPUT");
      expect((error as RuntimeError).stage).toBe("rescue.runtime");
      expect((error as RuntimeError).message).toBe("Rescue returned empty output.");
    }
  });

  test("parsed review_gate output renders and writes when JSON is valid", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("output-mode-parsed");
    const paths = resolvePluginPaths({ ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot });

    try {
      await ensurePluginPaths(paths);
      const job = makeJob("review_gate");
      const rendered = renderManagedJobOutput(
        job,
        JSON.stringify({
          decision: "ALLOW",
          confidence: "high",
          summary: "No blocking issues.",
          issues: [],
        }),
      );
      const artifactPath = await writeArtifact(paths, job, rendered.rendered);

      expect(await readFile(artifactPath, "utf8")).toBe(rendered.rendered);
      expect(rendered.summary).toBe("No blocking issues.");
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });
});

async function runCompanion(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<{
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--import", "tsx", companionPath, ...argv], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk) => {
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr.push(Buffer.from(chunk));
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}
