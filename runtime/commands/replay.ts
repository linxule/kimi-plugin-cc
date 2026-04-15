import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { JobStore, type JobRecord } from "../job-store.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { renderManagedJobOutput } from "../render.js";
import type { CommandContext } from "../types.js";
import { sweepStaleBackgroundJobs } from "../jobs.js";
import type { IncomingWireMessage, PromptResult } from "../wire/types.js";
import {
  createTurnCapture,
  finalizeTurnCapture,
  observeTurnEvent,
} from "../wire/turn-capture.js";

export interface ReplayResult {
  rendered: string;
  output: ReturnType<typeof renderManagedJobOutput>["output"];
  summary: string;
}

interface WireLogEntry {
  direction: "meta" | "in" | "out" | "stderr";
  message: unknown;
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
  const store = new JobStore(paths);

  try {
    await sweepStaleBackgroundJobs(store, paths);

    const job = store.getJob(jobId);
    if (!job || job.repo_id !== repoIdentity.repoId) {
      throw new RuntimeError("JOB_NOT_FOUND", `No job matched ${jobId} for replay.`, "replay.lookup");
    }

    const replayed = await replayJob(job);
    return `${replayed.rendered}${replayed.rendered.endsWith("\n") ? "" : "\n"}`;
  } finally {
    store.close();
  }
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

  const completedTurn = await replayCompletedTurn(job.stream_log_path);
  const rendered = renderManagedJobOutput(job, completedTurn.finalText);

  return {
    rendered: rendered.rendered,
    output: rendered.output,
    summary: rendered.summary,
  };
}

async function replayCompletedTurn(logPath: string) {
  const contents = await readFile(logPath, "utf8");
  const lines = contents
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const turn = createTurnCapture();
  let promptRequestId: string | null = null;
  let promptResult: PromptResult | null = null;

  for (const line of lines) {
    const entry = JSON.parse(line) as WireLogEntry;

    if (entry.direction === "out") {
      const message = coerceWireObject(entry.message, "replay.log");
      if (message.method === "prompt" && typeof message.id === "string") {
        promptRequestId = message.id;
      }
      continue;
    }

    if (entry.direction !== "in") {
      continue;
    }

    const message = coerceWireObject(entry.message, "replay.log.in");

    if ("method" in message) {
      if (message.method === "event" && isEventPayload(message.params)) {
        observeTurnEvent(turn, message.params.type, message.params.payload);
      }
      continue;
    }

    if (
      promptRequestId &&
      message.id === promptRequestId &&
      isPromptResult(message.result)
    ) {
      promptResult = message.result;
    }
  }

  if (!promptRequestId || !promptResult) {
    throw new RuntimeError(
      "REPLAY_LOG_INVALID",
      `Wire log ${logPath} does not contain a replayable prompt result.`,
      "replay.log",
    );
  }

  return finalizeTurnCapture(turn, promptResult);
}

function coerceWireObject(value: unknown, stage: string): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RuntimeError(
      "REPLAY_LOG_INVALID",
      `Wire log entry at ${stage} is not a JSON object.`,
      stage,
    );
  }

  return parsed as Record<string, unknown>;
}

function isEventPayload(value: unknown): value is Extract<IncomingWireMessage, { method: "event" }>["params"] {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string" &&
    typeof (value as { payload?: unknown }).payload === "object" &&
    (value as { payload?: unknown }).payload !== null &&
    !Array.isArray((value as { payload?: unknown }).payload)
  );
}

function isPromptResult(value: unknown): value is PromptResult {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { status?: unknown }).status === "string"
  );
}
