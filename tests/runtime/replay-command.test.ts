import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { replayJob, runReplay } from "../../runtime/commands/replay.js";
import { resolveRepoIdentity } from "../../runtime/git.js";
import { JobStore, type JobRecord } from "../../runtime/job-store.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import type { CommandContext } from "../../runtime/types.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

// v1.0 cli-client emits NDJSON diagnostic entries that look like:
//   {"ts":"2026-01-01T00:00:00.000Z","event":"spawn","command":"kimi",...}
//   {"ts":"...","event":"record","record":{"role":"assistant","content":"..."}}
//   {"ts":"...","event":"exit","exit_code":0,...}
// Replay needs to reassemble assistant content from those records.

function makeContext(cwd: string, env: NodeJS.ProcessEnv): CommandContext {
  return {
    cwd,
    env,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

interface LogEntry {
  ts?: string;
  event: string;
  [key: string]: unknown;
}

async function writeStreamLog(logPath: string, entries: LogEntry[]): Promise<void> {
  const lines = entries.map((entry) => {
    const withTs = { ts: entry.ts ?? "2026-01-01T00:00:00.000Z", ...entry };
    return JSON.stringify(withTs);
  });
  await writeFile(logPath, `${lines.join("\n")}\n`, "utf8");
}

function makeAskJob(logPath: string): JobRecord {
  const now = new Date().toISOString();
  return {
    job_id: "replay-ask-001",
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
    status: "completed",
    kimi_session_id: "session-ask-001",
    agent_profile: "<cli-client>",
    prompt_digest: "digest",
    summary: "ask",
    phase: null,
    final_output_path: null,
    stream_log_path: logPath,
    error: null,
  };
}

describe("replay command", () => {
  test("replay reassembles assistant content from a stream-json log", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("replay-stream-json");
    const logPath = path.join(pluginDataRoot, "ask-log.jsonl");
    try {
      await mkdir(path.dirname(logPath), { recursive: true });
      await writeStreamLog(logPath, [
        { event: "spawn", command: "kimi", args: ["--output-format", "stream-json", "-p", "hi"], cwd: process.cwd() },
        { event: "record", record: { role: "assistant", content: "Reassembled " } },
        { event: "record", record: { role: "assistant", content: "ask answer." } },
        { event: "exit", exit_code: 0, session_id: "session-ask-001", malformed_count: 0, record_count: 2 },
      ]);

      const replayed = await replayJob(makeAskJob(logPath));
      expect(replayed.output).toBe("Reassembled ask answer.");
      expect(replayed.rendered).toContain("Reassembled ask answer.");
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("replay tolerates a truncated trailing line (worker SIGKILL mid-write)", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("replay-truncated");
    const logPath = path.join(pluginDataRoot, "ask-log.jsonl");
    try {
      const validLines = [
        JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", event: "spawn", command: "kimi", args: ["-p", "hi"] }),
        JSON.stringify({
          ts: "2026-01-01T00:00:00.001Z",
          event: "record",
          record: { role: "assistant", content: "partial answer text" },
        }),
      ];
      // Synthesize a truncated final line (no closing brace).
      const truncated = '{"ts":"2026-01-01T00:00:00.002Z","event":"exi';
      await writeFile(logPath, `${validLines.join("\n")}\n${truncated}`, "utf8");

      const replayed = await replayJob(makeAskJob(logPath));
      expect(replayed.output).toBe("partial answer text");
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("replay fails with REPLAY_LOG_UNREADABLE for a v0.4-style wire log", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("replay-v04-log");
    const logPath = path.join(pluginDataRoot, "wire-log.jsonl");
    try {
      // v0.4 wire log shape — no `event` discriminator, has `direction`.
      const wireEntries = [
        { direction: "out", message: { jsonrpc: "2.0", method: "prompt", id: "p1", params: { user_input: "hi" } } },
        { direction: "in", message: { jsonrpc: "2.0", method: "event", params: { type: "TurnEnd", payload: {} } } },
        { direction: "in", message: { jsonrpc: "2.0", id: "p1", result: { status: "finished" } } },
      ];
      await writeFile(logPath, `${wireEntries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");

      let caught: unknown;
      try {
        await replayJob(makeAskJob(logPath));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeTruthy();
      expect((caught as { code?: string }).code).toBe("REPLAY_LOG_UNREADABLE");
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("replay surfaces a process_error event as REPLAY_LOG_PROCESS_ERROR", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("replay-process-error");
    const logPath = path.join(pluginDataRoot, "ask-log.jsonl");
    try {
      await writeStreamLog(logPath, [
        { event: "spawn", command: "kimi", args: ["-p", "hi"], cwd: process.cwd() },
        { event: "process_error", message: "spawn ENOENT" },
      ]);
      let caught: unknown;
      try {
        await replayJob(makeAskJob(logPath));
      } catch (err) {
        caught = err;
      }
      expect((caught as { code?: string }).code).toBe("REPLAY_LOG_PROCESS_ERROR");
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
        agent_profile: "<cli-client>",
        prompt_digest: "digest",
        summary: "failed",
        phase: null,
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

  test("runReplay enforces argv shape and returns the rendered artifact", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("replay-runreplay");
    const env = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: pluginDataRoot,
    };
    try {
      const repoIdentity = await resolveRepoIdentity(process.cwd());
      const paths = resolvePluginPaths(env);
      await mkdir(paths.pluginRoot, { recursive: true });

      const logPath = path.join(pluginDataRoot, "review-log.jsonl");
      await writeStreamLog(logPath, [
        { event: "spawn", command: "kimi" },
        { event: "record", record: { role: "assistant", content: "Review pass-through prose." } },
        { event: "exit", exit_code: 0 },
      ]);

      const store = new JobStore(paths);
      const job = store.createJob({
        job_id: "replay-review-001",
        repo_id: repoIdentity.repoId,
        command_type: "review",
        cwd: process.cwd(),
        model: null,
        thinking: false,
        background: false,
        pid: null,
        kimi_pid: null,
        status: "completed",
        kimi_session_id: "session-r",
        agent_profile: "<cli-client>",
        prompt_digest: "d",
        summary: "review",
        phase: null,
        final_output_path: null,
        stream_log_path: logPath,
        error: null,
      });
      store.close();

      const rendered = await runReplay([job.job_id], makeContext(process.cwd(), env));
      expect(rendered).toContain("# Review Result");
      expect(rendered).toContain("Review pass-through prose.");

      // Argv validation: trailing garbage rejected
      await expect(
        runReplay([job.job_id, "junk"], makeContext(process.cwd(), env)),
      ).rejects.toThrow("expects exactly one job id");
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });
});
