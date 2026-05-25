import { randomUUID } from "node:crypto";
import path from "node:path";

import { createCliCancellationHandlers } from "../cli-cancellation.js";
import { runCliPromptWithBudget } from "../cli-client.js";
import { resolveKimiCliCommand } from "../kimi-command.js";
import { getManagedCommandConfig } from "./registry.js";
import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { digestPrompt, markJobCancelled, markJobFailed, sweepStaleJobs } from "../jobs.js";
import { JobStore, type JobRecord } from "../job-store.js";
import { KIMI_ASK_PROMPT_TIMEOUT_MS } from "../kimi-timeouts.js";
import { writeInvocationLogHeader } from "../logging.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { parseAskArgs } from "../parsing.js";
import { readArtifact, renderManagedJobOutput, writeArtifact } from "../render.js";
import type { CommandContext } from "../types.js";
import { classifyManagedCommandFailure } from "../kimi-errors.js";
import { startBackgroundJob } from "../background-spawn.js";
import { maybeWarnHookMissing, verifyHookInstalled } from "../hooks/install.js";
import { assertCliResultSuccess, reassembleProseFromRecords, warnIfSessionIdMissing } from "./cli-helpers.js";

// v1.0 cutover note (PR 2):
//
//   The v0.4 wire client/initialize/prompt sequence is replaced with a
//   single `runCliPrompt` against `kimi -p --output-format stream-json`.
//   The PreToolUse hook reads `KIMI_PLUGIN_CC_CMD=ask` and applies the
//   "allow everything" policy (conversational, user-watched).
//
// Session id handling differs from v0.4:
//
//   - v0.4 the client assigned the kimi session id upfront (passed via
//     `--session <uuid>` on the wire command line).
//   - v1.0 kimi-code assigns the session id and announces it via stderr
//     ("To resume this session: kimi -r <uuid>"). We capture that id
//     after the call and update the JobStore row.
//   - For `--resume`, we pass the prior session id via `-r`; kimi-code
//     keeps it across resumes.

const ASK_SUMMARY_MAX = 120;
const ASK_AGENT_PROFILE_PLACEHOLDER = "<cli-client>";

interface AskSessionResolution {
  /** Prior kimi session id to resume; null means start a fresh session. */
  kimiSessionId: string | null;
  reusedSession: boolean;
}

export async function runAsk(argv: string[], context: CommandContext): Promise<string> {
  const parsed = parseAskArgs(argv);
  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);
  const repoIdentity = await resolveRepoIdentity(context.cwd);
  const askConfig = getManagedCommandConfig("ask");
  const store = new JobStore(paths);
  try {
    await sweepStaleJobs(store, paths);

    const jobId = randomUUID();
    const sessionResolution = resolveAskSession(
      store,
      repoIdentity.repoId,
      parsed.fresh,
      parsed.resume,
      parsed.resumeTarget,
    );
    const askPrompt = buildAskPrompt(parsed.prompt, sessionResolution.reusedSession);
    const logPath = path.join(paths.logsDir, `ask-${jobId}.jsonl`);
    const job = store.createJob({
      job_id: jobId,
      repo_id: repoIdentity.repoId,
      command_type: "ask",
      cwd: context.cwd,
      model: parsed.model ?? null,
      thinking: parsed.thinking ?? null,
      background: parsed.background,
      pid: parsed.background ? null : process.pid,
      kimi_pid: null,
      status: "running",
      kimi_session_id: sessionResolution.kimiSessionId,
      agent_profile: ASK_AGENT_PROFILE_PLACEHOLDER,
      prompt_digest: digestPrompt(askPrompt),
      summary: shorten(parsed.prompt ?? askPrompt, ASK_SUMMARY_MAX),
      phase: parsed.background ? "queued" : "starting",
      final_output_path: null,
      stream_log_path: logPath,
      error: null,
    });

    try {
      await writeInvocationLogHeader(logPath, {
        commandType: "ask",
        kimiSessionId: sessionResolution.kimiSessionId ?? "(pending)",
        cwd: context.cwd,
      });
    } catch (error) {
      const classified = new RuntimeError(
        "ASK_LOG_HEADER_FAILED",
        `Failed to write ask invocation log header: ${(error as Error).message ?? String(error)}`,
        "ask.log-header",
        error instanceof Error ? { cause: error } : undefined,
      );
      await markJobFailed(store, paths, job, classified, askConfig.cancellation.failedSummary, { phase: "failed" });
      throw classified;
    }

    if (parsed.background) {
      return startBackgroundJob(job, askPrompt, context, paths, {
        workerKind: "ask",
        wait: parsed.wait,
        promptEnvVar: "KIMI_PLUGIN_CC_ASK_PROMPT_B64",
        reusedSessionEnvVar: "KIMI_PLUGIN_CC_ASK_REUSED_SESSION",
        reusedSession: sessionResolution.reusedSession,
        failedSummary: askConfig.cancellation.failedSummary,
        missingResultErrorCode: "ASK_RESULT_MISSING",
        spawnFailedErrorCode: "ASK_WORKER_SPAWN_FAILED",
        earlyExitErrorCode: "ASK_WORKER_EXITED_EARLY",
        nodeBinInvalidErrorCode: "ASK_NODE_BIN_INVALID",
        waitStage: "ask.wait",
        spawnStage: "ask.worker.spawn",
      });
    }

    const completed = await executeAskJob(job.job_id, askPrompt, context);

    if (!completed.final_output_path) {
      throw new RuntimeError("ASK_RESULT_MISSING", "Ask finished without a rendered result.", "ask.result");
    }

    return (await readArtifact(completed.final_output_path)).trimEnd();
  } finally {
    store.close();
  }
}

export async function executeAskJob(
  jobId: string,
  prompt: string,
  context: CommandContext,
  options?: { workerPid?: number },
): Promise<JobRecord> {
  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);
  const store = new JobStore(paths);
  const job = store.getJob(jobId);
  if (!job) {
    store.close();
    throw new RuntimeError("JOB_NOT_FOUND", `Ask job ${jobId} was not found.`, "ask.worker");
  }

  const askConfig = getManagedCommandConfig("ask");
  const cancel = askConfig.cancellation;
  const handlers = createCliCancellationHandlers();
  const kimi = resolveKimiCliCommand(context.env);

  if (context.env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK !== "1") {
    const installStatus = await verifyHookInstalled(context.env);
    maybeWarnHookMissing(installStatus, "ask", context.stderr);
  }

  try {
    if (options?.workerPid) {
      store.updateRunningJob(job.job_id, { pid: options.workerPid, phase: "worker-running" });
    }

    const result = await runCliPromptWithBudget(
      {
        cwd: job.cwd,
        env: context.env,
        command: kimi.command,
        prefixArgs: kimi.prefixArgs,
        prompt,
        commandLabel: "ask",
        model: job.model ?? undefined,
        resumeSessionId: job.kimi_session_id ?? undefined,
        logPath: job.stream_log_path,
        signal: handlers.signal,
      },
      KIMI_ASK_PROMPT_TIMEOUT_MS,
      "ask.prompt",
    );

    if (handlers.cancelling) {
      throw new RuntimeError(
        cancel.errorCodes.cancelled,
        cancel.cancelMessages.afterPrompt,
        "ask.runtime",
      );
    }

    assertCliResultSuccess(result, "ask.runtime");

    // Persist whichever session id kimi actually announced. For fresh
    // sessions this is the only chance to record it. For resumed
    // sessions it should match the input, but capture anyway in case
    // kimi-code mints a new id on each turn.
    if (
      result.sessionId !== undefined &&
      result.sessionId.length > 0 &&
      result.sessionId !== job.kimi_session_id
    ) {
      // length>0 guard: empty-string capture would poison the row. The
      // warning helper's null-ish check would also fire but only after
      // the bad write. (Kimi alpha.4 challenge finding #3.)
      store.updateRunningJob(job.job_id, { kimi_session_id: result.sessionId });
    }
    // For ask, missing session id breaks both -r (latest-resume) and
    // explicit --resume <id>. Warn loudly so the user notices before
    // they try to continue the conversation.
    if (job.kimi_session_id === null) {
      warnIfSessionIdMissing(result, "ask", job.job_id, context.stderr);
    }

    const finalText = reassembleProseFromRecords(result.records);
    const rendered = renderManagedJobOutput(job, finalText);
    const artifactPath = await writeArtifact(paths, job, rendered.rendered);
    if (handlers.cancelling) {
      throw new RuntimeError(
        cancel.errorCodes.cancelled,
        cancel.cancelMessages.afterArtifact,
        "ask.runtime",
      );
    }
    return (
      store.markCompleted(job.job_id, {
        summary: rendered.summary,
        phase: "done",
        final_output_path: artifactPath,
        error: null,
      }) ?? job
    );
  } catch (error) {
    if (handlers.cancelling) {
      const cancelledError = new RuntimeError(
        cancel.errorCodes.cancelled,
        cancel.cancelMessages.default,
        "ask.runtime",
        error instanceof Error ? { cause: error } : undefined,
      );
      return await markJobCancelled(
        store,
        paths,
        job,
        cancel.cancelledSummary,
        cancelledError,
        { phase: "cancelled" },
      );
    }
    const classified = classifyManagedCommandFailure(error, "ask", job.job_id);
    await markJobFailed(store, paths, job, classified, cancel.failedSummary, { phase: "failed" });
    throw classified;
  } finally {
    handlers.dispose();
    store.close();
  }
}

function resolveAskSession(
  store: JobStore,
  repoId: string,
  fresh: boolean,
  resume: boolean,
  resumeTarget: string | undefined,
): AskSessionResolution {
  if (fresh) {
    return { kimiSessionId: null, reusedSession: false };
  }

  if (resumeTarget) {
    const byJob = store.getJob(resumeTarget);
    const scoped = byJob?.repo_id === repoId && byJob.command_type === "ask" ? byJob : null;
    const exact = scoped ?? store.findAskJobBySession(repoId, resumeTarget);
    if (!exact) {
      throw new RuntimeError(
        "ASK_RESUME_NOT_FOUND",
        `No ask job or session matched ${resumeTarget}.`,
        "ask.resume",
      );
    }
    // Order matters: surface ASK_ALREADY_RUNNING before complaining that
    // the session id is missing. In v1.0 a running ask row carries
    // kimi_session_id=NULL (kimi-code assigns the id post-call), so the
    // legacy "no session id → not found" check would mask the more
    // accurate "already running" error.
    ensureAskSessionIsNotRunning(exact);
    if (!exact.kimi_session_id) {
      throw new RuntimeError(
        "ASK_RESUME_NOT_FOUND",
        `No ask job or session matched ${resumeTarget}.`,
        "ask.resume",
      );
    }
    return { kimiSessionId: exact.kimi_session_id, reusedSession: true };
  }

  if (resume) {
    const latest = store.findLatestJob({ repoId, commandType: "ask" });
    if (!latest) {
      throw new RuntimeError(
        "ASK_RESUME_NOT_FOUND",
        "No prior ask session exists for this repository.",
        "ask.resume",
      );
    }
    ensureAskSessionIsNotRunning(latest);
    if (!latest.kimi_session_id) {
      throw new RuntimeError(
        "ASK_RESUME_NOT_FOUND",
        "No prior ask session exists for this repository.",
        "ask.resume",
      );
    }
    return { kimiSessionId: latest.kimi_session_id, reusedSession: true };
  }

  return { kimiSessionId: null, reusedSession: false };
}

function ensureAskSessionIsNotRunning(job: JobRecord): void {
  if (job.status === "running") {
    throw new RuntimeError(
      "ASK_ALREADY_RUNNING",
      `Ask session ${job.kimi_session_id ?? "<unknown>"} is already active under job ${job.job_id}.`,
      "ask.resume",
    );
  }
}

function buildAskPrompt(question: string | undefined, reusedSession: boolean): string {
  if (question?.trim()) {
    return [
      "Answer the user's question directly in free-form prose.",
      "Stay read-only.",
      "Do not emit JSON unless the user explicitly asks for it.",
      "",
      "User question:",
      question.trim(),
    ].join("\n");
  }

  if (reusedSession) {
    return [
      "Continue the previous ask conversation in free-form prose.",
      "Stay read-only.",
      "Do not emit JSON unless the user explicitly asks for it.",
    ].join("\n");
  }

  throw new RuntimeError("INVALID_ARGS", "ask requires a question after the flags.", "ask.parse");
}

function shorten(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
