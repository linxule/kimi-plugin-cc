import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runReviewGateStopHook } from "../../runtime/commands/review-gate.js";
import { replayJob, runReplay } from "../../runtime/commands/replay.js";
import { resolveRepoIdentity } from "../../runtime/git.js";
import { JobStore, type JobRecord } from "../../runtime/job-store.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import { WireClient } from "../../runtime/wire/client.js";
import { ApprovalDispatcher, rejectAllApprovals } from "../../runtime/wire/approval-dispatcher.js";
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

describe("replay command", () => {
  test("replay reproduces a stored review gate output from the event log", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("replay-review-gate");
    const env = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: pluginDataRoot,
      KIMI_PLUGIN_CC_KIMI_BIN: "bun",
      KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
      KIMI_PLUGIN_CC_MOCK_SCENARIO: "review-gate-block",
    };

    try {
      const paths = resolvePluginPaths(env);
      await mkdir(paths.pluginRoot, { recursive: true });
      await writeFile(paths.configPath, `${JSON.stringify({ reviewGateEnabled: true }, null, 2)}\n`, "utf8");

      const transcriptPath = path.join(pluginDataRoot, "transcript.jsonl");
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "Fix the failing path." }] } }),
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "I fixed the issue and everything is complete." }] },
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      await runReviewGateStopHook(
        {
          cwd: process.cwd(),
          hook_event_name: "Stop",
          transcript_path: transcriptPath,
        },
        makeContext(process.cwd(), env),
      );

      const repoIdentity = await resolveRepoIdentity(process.cwd());
      const store = new JobStore(paths);
      try {
        const job = store.findLatestJob({
          repoId: repoIdentity.repoId,
          commandType: "review_gate",
        });

        expect(job).toBeTruthy();

        const replayed = await replayJob(job!);
        const replayOutput = await runReplay([job!.job_id], makeContext(process.cwd(), env));
        const artifact = await readFile(job!.final_output_path!, "utf8");

        expect(replayed.output).toEqual({
          decision: "BLOCK",
          confidence: "high",
          summary: "The assistant claimed the requested work was complete without addressing the core fix.",
          issues: [
            {
              title: "Requested fix still missing",
              body: "The response says the task is done, but it does not address the user’s explicit request to fix the failing path.",
              severity: "high",
            },
          ],
        });
        expect(replayed.rendered).toBe(artifact.trimEnd());
        expect(replayOutput).toContain("# Review Gate Result");
        expect(replayOutput).toContain("Requested fix still missing");
      } finally {
        store.close();
      }
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("replay fails cleanly when the stored stream log is missing", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("replay-missing-log");
    const env = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: pluginDataRoot,
    };

    try {
      const repoIdentity = await resolveRepoIdentity(process.cwd());
      const paths = resolvePluginPaths(env);
      await mkdir(paths.pluginRoot, { recursive: true });
      const store = new JobStore(paths);
      const job = store.createJob({
        job_id: "job-missing-log",
        repo_id: repoIdentity.repoId,
        command_type: "review_gate",
        cwd: process.cwd(),
        model: null,
        thinking: false,
        background: false,
        pid: null,
        kimi_pid: null,
        status: "failed",
        kimi_session_id: "session-missing-log",
        agent_profile: "runtime/agents/review-gate.yaml",
        prompt_digest: "digest",
        summary: "failed",
        final_output_path: null,
        stream_log_path: path.join(pluginDataRoot, "missing.jsonl"),
        error: {
          code: "REVIEW_GATE_PARSE_FAILED",
          message: "missing",
          stage: "review_gate.parse",
        },
      });
      store.close();

      await expect(replayJob(job)).rejects.toThrow("cannot be replayed because");
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("replay reproduces interrupted-turn failures identically to the live path", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("replay-interrupted");
    const logPath = path.join(pluginDataRoot, "wire-log.jsonl");
    const env = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: pluginDataRoot,
    };
    const client = new WireClient({
      cwd: process.cwd(),
      command: "bun",
      args: ["run", "tests/helpers/mock-wire-server.ts", "cancelled"],
      env,
      logPath,
      approvalDispatcher: new ApprovalDispatcher(rejectAllApprovals("unexpected approval request in replay test")),
    });

    try {
      await client.start();
      await client.initialize({
        protocol_version: "1.9",
        client: { name: "test-client", version: "0.1.0" },
      });

      const liveError: Error = await client.prompt("hello", "setup").then(
        () => {
          throw new Error("Expected the live prompt to fail.");
        },
        (error) => error as Error,
      );
      const replayJobRecord = makeReplayJobRecord(logPath);
      const replayError: Error = await replayJob(replayJobRecord).then(
        () => {
          throw new Error("Expected replay to fail.");
        },
        (error) => error as Error,
      );

      expect((replayError as { code?: string }).code).toBe((liveError as { code?: string }).code);
      expect(replayError.message).toBe(liveError.message);
    } finally {
      await client.close();
      await cleanupTestPath(pluginDataRoot);
    }
  });
});

function makeReplayJobRecord(logPath: string): JobRecord {
  const now = new Date().toISOString();
  return {
    job_id: "replay-live-match",
    repo_id: "repo",
    command_type: "ask",
    created_at: now,
    updated_at: now,
    cwd: process.cwd(),
    model: null,
    thinking: false,
    background: false,
    pid: null,
    kimi_pid: null,
    status: "failed",
    kimi_session_id: "session",
    agent_profile: "runtime/agents/ask.yaml",
    prompt_digest: "digest",
    summary: "failed",
    final_output_path: null,
    stream_log_path: logPath,
    error: null,
  };
}
