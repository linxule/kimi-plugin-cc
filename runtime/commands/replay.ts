import { access, stat, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { withJobStore, type JobRecord } from "../job-store.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { renderManagedJobOutput } from "../render.js";
import type { CommandContext } from "../types.js";
import { sweepStaleJobs } from "../jobs.js";

/**
 * Replay a completed job from its persisted stream-json diagnostics log.
 *
 * v1.0 log format (`runtime/cli-client.ts`):
 *
 *   Each line is a JSON object with a `ts` timestamp and an `event`
 *   discriminator. The events we care about:
 *
 *     {"ts":"...","event":"spawn", ...}
 *     {"ts":"...","event":"record","record":{"role":"assistant","content":"..."}}
 *     {"ts":"...","event":"record","record":{"role":"assistant","tool_calls":[...]}}
 *     {"ts":"...","event":"record","record":{"role":"tool","tool_call_id":"...","content":"..."}}
 *     {"ts":"...","event":"malformed","line":"...","reason":"..."}
 *     {"ts":"...","event":"process_error", ...}
 *     {"ts":"...","event":"exit","exit_code":0,"session_id":"...", ...}
 *
 *   This file format is OURS — written by cli-client when `logPath` is
 *   set. Replay only needs the assistant `content` chunks; tool_calls
 *   and tool responses are diagnostic and don't change the rendered
 *   artifact.
 *
 * v0.4 wire-format logs are NOT supported. The wire transport went
 * away in v1.0 along with the kimi-cli binary, and the new replay
 * source is this stream-json log. Jobs created under v0.4 produce a
 * REPLAY_LOG_UNREADABLE error explaining the cutover.
 */

export interface ReplayResult {
  rendered: string;
  output: ReturnType<typeof renderManagedJobOutput>["output"];
  summary: string;
}

const MAX_REPLAY_LOG_BYTES = 32 * 1024 * 1024;

interface StreamLogEntry {
  ts?: unknown;
  event?: unknown;
  record?: unknown;
  exit_code?: unknown;
  session_id?: unknown;
  signal?: unknown;
  aborted?: unknown;
  message?: unknown;
}

export async function runReplay(argv: string[], context: CommandContext): Promise<string> {
  const [jobId, ...rest] = argv;
  if (!jobId || rest.length > 0) {
    throw new RuntimeError(
      "INVALID_ARGS",
      "replay expects exactly one job id: replay <job-id>.",
      "replay.parse",
    );
  }

  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);
  const repoIdentity = await resolveRepoIdentity(context.cwd);

  return withJobStore(paths, async (store) => {
    await sweepStaleJobs(store, paths);

    const job = store.getJob(jobId);
    if (!job || job.repo_id !== repoIdentity.repoId) {
      throw new RuntimeError("JOB_NOT_FOUND", `No job matched ${jobId} for replay.`, "replay.lookup");
    }

    const replayed = await replayJob(job);
    return `${replayed.rendered}${replayed.rendered.endsWith("\n") ? "" : "\n"}`;
  });
}

export async function replayJob(job: JobRecord): Promise<ReplayResult> {
  if (!job.stream_log_path) {
    throw new RuntimeError(
      "REPLAY_LOG_MISSING",
      `Job ${job.job_id} does not have a stored stream log path to replay.`,
      "replay.lookup",
    );
  }

  try {
    await access(job.stream_log_path, fsConstants.R_OK);
  } catch {
    throw new RuntimeError(
      "REPLAY_LOG_MISSING",
      `Job ${job.job_id} cannot be replayed because ${job.stream_log_path} is missing.`,
      "replay.lookup",
    );
  }

  const stats = await stat(job.stream_log_path);
  if (stats.size > MAX_REPLAY_LOG_BYTES) {
    throw new RuntimeError(
      "REPLAY_LOG_TOO_LARGE",
      `Job ${job.job_id} stream log is ${stats.size} bytes, which exceeds the ${MAX_REPLAY_LOG_BYTES}-byte replay ceiling.`,
      "replay.lookup",
    );
  }

  const finalText = await replayFinalText(job.stream_log_path);
  const rendered = renderManagedJobOutput(job, finalText);

  return {
    rendered: rendered.rendered,
    output: rendered.output,
    summary: rendered.summary,
  };
}

async function replayFinalText(logPath: string): Promise<string> {
  const contents = await readFile(logPath, "utf8");
  const rawLines = contents.split("\n");
  let sawSpawn = false;
  let sawExit = false;
  let sawV1Event = false;
  let sawV04Direction = false;
  let assistantContent = "";

  for (let lineNumber = 0; lineNumber < rawLines.length; lineNumber += 1) {
    const line = rawLines[lineNumber]!.trim();
    if (!line) continue;

    let entry: StreamLogEntry;
    try {
      entry = JSON.parse(line) as StreamLogEntry;
    } catch (error) {
      // A truncated trailing line is the expected shape when a worker
      // was SIGKILL'd mid-write. Drop it silently so replay still works
      // on the consistent prefix.
      if (lineNumber === rawLines.length - 1) continue;
      throw new RuntimeError(
        "REPLAY_LOG_INVALID",
        `Stream log ${logPath}:${lineNumber + 1} is malformed JSON: ${(error as Error).message}`,
        "replay.log",
        { cause: error as Error },
      );
    }

    if (typeof entry.event === "string") sawV1Event = true;
    if (Object.prototype.hasOwnProperty.call(entry, "direction")) sawV04Direction = true;

    const event = typeof entry.event === "string" ? entry.event : "";
    switch (event) {
      case "spawn":
        sawSpawn = true;
        break;
      case "record": {
        const record = entry.record;
        if (typeof record !== "object" || record === null || Array.isArray(record)) {
          throw new RuntimeError(
            "REPLAY_LOG_INVALID",
            `Stream log ${logPath}:${lineNumber + 1} record entry is not an object.`,
            "replay.log",
          );
        }
        const role = (record as { role?: unknown }).role;
        const content = (record as { content?: unknown }).content;
        if (role === "assistant" && typeof content === "string") {
          assistantContent += content;
        }
        // Non-string content (null/undefined/object) silently skipped —
        // these are diagnostic-only records we don't render.
        break;
      }
      case "exit":
        sawExit = true;
        break;
      case "process_error": {
        const detail = typeof entry.message === "string" ? entry.message : "<unknown>";
        throw new RuntimeError(
          "REPLAY_LOG_PROCESS_ERROR",
          `Stream log ${logPath} captured a subprocess error and cannot be replayed: ${detail}`,
          "replay.log",
          { details: { logPath, line: lineNumber + 1 } },
        );
      }
      default:
        // Unknown / malformed-line / future events are diagnostics — skip.
        break;
    }
  }

  if (!sawSpawn) {
    // Differentiate "this is a v0.4 wire log" from "this is a v1.0 log
    // that died before reaching the spawn event". v0.4 logs had a
    // `direction` field on every entry (out/in/meta/stderr); v1.0 logs
    // use `event` instead.
    if (sawV04Direction && !sawV1Event) {
      throw new RuntimeError(
        "REPLAY_LOG_UNREADABLE",
        `Stream log ${logPath} is a v0.4 wire log (no \`event\` key). v0.4 wire logs are not supported by the v1.0 replay command.`,
        "replay.log",
        { details: { logPath } },
      );
    }
    throw new RuntimeError(
      "REPLAY_LOG_NO_SPAWN",
      `Stream log ${logPath} contains no spawn event — the worker likely failed before launching kimi (e.g., synchronous spawn failure, early cancellation). No assistant content to replay.`,
      "replay.log",
      { details: { logPath } },
    );
  }

  if (!sawExit && assistantContent.length === 0) {
    throw new RuntimeError(
      "REPLAY_LOG_INVALID",
      `Stream log ${logPath} did not capture any assistant content before truncation.`,
      "replay.log",
      { details: { logPath } },
    );
  }

  return assistantContent;
}
