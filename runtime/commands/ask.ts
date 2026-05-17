import { randomUUID } from "node:crypto";
import path from "node:path";

import { createCancellationHandlers } from "../cancellation.js";
import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { digestPrompt, markJobCancelled, markJobFailed, sweepStaleJobs } from "../jobs.js";
import { JobStore, type JobRecord } from "../job-store.js";
import { announceSessionTitle } from "../kimi-web-client.js";
import { buildAndStartWireClient, resolveAgentFile } from "../kimi-launch.js";
import { WireClient } from "../wire/client.js";
import { KIMI_WIRE_PROTOCOL_VERSION } from "../wire/types.js";
import {
  KIMI_ASK_PROMPT_TIMEOUT_MS,
  KIMI_INITIALIZE_TIMEOUT_MS,
  KIMI_START_TIMEOUT_MS,
  withTimeout,
} from "../kimi-timeouts.js";
import { buildSessionTitle } from "../session-title.js";
import { writeInvocationLogHeader } from "../logging.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { parseAskArgs } from "../parsing.js";
import { readArtifact, renderManagedJobOutput, writeArtifact } from "../render.js";
import type { CommandContext } from "../types.js";
import { KIMI_PLUGIN_CC_VERSION } from "../version.js";
import { rejectAllApprovals } from "../wire/approval-dispatcher.js";
import { classifyManagedCommandFailure } from "../kimi-errors.js";
import { startBackgroundJob } from "../background-spawn.js";

const ASK_SUMMARY_MAX = 120;

export async function runAsk(argv: string[], context: CommandContext): Promise<string> {
  const parsed = parseAskArgs(argv);
  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);
  const repoIdentity = await resolveRepoIdentity(context.cwd);
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
    const kimiSessionId = sessionResolution.sessionId;
    const logPath = path.join(paths.logsDir, `ask-${jobId}.jsonl`);
    const agentProfile = resolveAgentFile("runtime/agents/ask.yaml");
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
      kimi_session_id: kimiSessionId,
      agent_profile: agentProfile,
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
        kimiSessionId,
        cwd: context.cwd,
      });
    } catch (error) {
      const classified = new RuntimeError(
        "ASK_LOG_HEADER_FAILED",
        `Failed to write ask invocation log header: ${(error as Error).message ?? String(error)}`,
        "ask.log-header",
        error instanceof Error ? { cause: error } : undefined,
      );
      await markJobFailed(store, paths, job, classified, "Ask failed.", { phase: "failed" });
      throw classified;
    }

    const rawQuestion = parsed.prompt?.trim();

    if (parsed.background) {
      return startBackgroundJob(job, askPrompt, context, paths, {
        workerKind: "ask",
        wait: parsed.wait,
        promptEnvVar: "KIMI_PLUGIN_CC_ASK_PROMPT_B64",
        reusedSessionEnvVar: "KIMI_PLUGIN_CC_ASK_REUSED_SESSION",
        reusedSession: sessionResolution.reusedSession,
        failedSummary: "Ask failed.",
        missingResultErrorCode: "ASK_RESULT_MISSING",
        spawnFailedErrorCode: "ASK_WORKER_SPAWN_FAILED",
        earlyExitErrorCode: "ASK_WORKER_EXITED_EARLY",
        nodeBinInvalidErrorCode: "ASK_NODE_BIN_INVALID",
        waitStage: "ask.wait",
        spawnStage: "ask.worker.spawn",
        extraEnv: rawQuestion
          ? { KIMI_PLUGIN_CC_ASK_RAW_QUESTION_B64: Buffer.from(rawQuestion, "utf8").toString("base64") }
          : undefined,
      });
    }

    const completed = await executeAskJob(job.job_id, askPrompt, context, {
      reusedSession: sessionResolution.reusedSession,
      rawPrompt: rawQuestion,
    });

    if (!completed.final_output_path) {
      throw new RuntimeError("ASK_RESULT_MISSING", "Ask finished without a rendered result.", "ask.result");
    }

    // trimEnd() strips the trailing newline that writeArtifact appends but the
    // original runAsk did not include in its return value (it returned rendered.output
    // directly, which is already trimmed). The /kimi:result command reads the artifact
    // file directly so it still gets the newline — only the inline foreground return
    // needs to match the original contract.
    return (await readArtifact(completed.final_output_path)).trimEnd();
  } finally {
    store.close();
  }
}

export async function executeAskJob(
  jobId: string,
  prompt: string,
  context: CommandContext,
  options?: { workerPid?: number; reusedSession?: boolean; rawPrompt?: string },
): Promise<JobRecord> {
  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);
  const store = new JobStore(paths);
  const job = store.getJob(jobId);
  if (!job) {
    store.close();
    throw new RuntimeError("JOB_NOT_FOUND", `Ask job ${jobId} was not found.`, "ask.worker");
  }

  // v0.3.1: SIGTERM/SIGINT plumbing extracted into a shared helper so the
  // 30-line dance no longer drifts between ask/rescue/review. The helper
  // registers the listeners IMMEDIATELY so a signal during wire-client
  // startup still latches cancelling=true.
  const handlers = createCancellationHandlers({ escalationMs: 1_500 });
  let client: WireClient | undefined;

  try {
    client = await buildAndStartWireClient(
      {
        cwd: job.cwd,
        env: context.env,
        sessionId: job.kimi_session_id ?? randomUUID(),
        agentFile: job.agent_profile,
        model: job.model ?? undefined,
        thinking: job.thinking ?? undefined,
        logPath: job.stream_log_path,
        approvalPolicy: rejectAllApprovals("ask is read-only; approval requests fail the command."),
      },
      KIMI_START_TIMEOUT_MS,
      "ask.start",
      { shouldRetry: () => !handlers.cancelling },
    );
    handlers.attachClient(client);

    if (handlers.cancelling) {
      // Signal fired during startup and the first attempt happened to succeed
      // before the retry gate could short-circuit. Close the fresh client and
      // fall through the catch via a synthetic throw so the normal cancellation
      // teardown path (markJobCancelled + signal deregistration) runs.
      throw new RuntimeError(
        "ASK_CANCELLED_DURING_START",
        "Ask cancelled during startup.",
        "ask.start",
      );
    }

    if (options?.workerPid) {
      store.updateRunningJob(job.job_id, { pid: options.workerPid, phase: "worker-running" });
    }

    store.updateRunningJob(job.job_id, { kimi_pid: client.getChildPid() });
    await withTimeout(
      client.initialize({
        protocol_version: KIMI_WIRE_PROTOCOL_VERSION,
        client: { name: "kimi-plugin-cc", version: KIMI_PLUGIN_CC_VERSION },
        capabilities: {
          supports_question: false,
          supports_plan_mode: false,
        },
      }),
      KIMI_INITIALIZE_TIMEOUT_MS,
      "ask.initialize",
      "initialize",
    );

    // Skip the title announcement on resumed sessions: the title was set by the
    // original ask call and the current prompt here is either a continuation or
    // refinement — neither should clobber the original identifying title in
    // `kimi web`.
    if (!options?.reusedSession) {
      // Use the raw user question for the title, not the wrapped ask prompt
      // (`buildAskPrompt` prepends boilerplate like "Answer the user's question
      // directly..."; passing the wrapped form would collapse every fresh ask
      // session's kimi-web title to that boilerplate prefix instead of the
      // actual question). `rawPrompt` is threaded from runAsk in foreground
      // and via KIMI_PLUGIN_CC_ASK_RAW_QUESTION_B64 from the worker.
      await announceSessionTitle(job.kimi_session_id!, buildSessionTitle("ask", options?.rawPrompt ?? prompt), {
        env: context.env,
      });
    }

    const completed = await withTimeout(
      client.prompt(prompt, "ask"),
      KIMI_ASK_PROMPT_TIMEOUT_MS,
      "ask.prompt",
      "response",
    );
    // Cancel-after-prompt-success check: SIGTERM could have fired between
    // prompt completion and our terminal-state writes. Honour it.
    if (handlers.cancelling) {
      throw new RuntimeError(
        "ASK_CANCELLED",
        "Ask cancelled by user request after prompt completion.",
        "ask.runtime",
      );
    }
    const rendered = renderManagedJobOutput(job, completed.finalText);
    const artifactPath = await writeArtifact(paths, job, rendered.rendered);
    if (handlers.cancelling) {
      throw new RuntimeError(
        "ASK_CANCELLED",
        "Ask cancelled by user request after artifact write.",
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
      // Clear escalation timer NOW, before awaiting markJobCancelled
      // (disk I/O can exceed 1.5s under load and trigger a redundant SIGTERM).
      handlers.clearEscalation();
      // Always wrap into a canonical ASK_CANCELLED RuntimeError so callers
      // can distinguish user-cancel from infra failure via error.code.
      const cancelledError = new RuntimeError(
        "ASK_CANCELLED",
        "Ask cancelled by user request.",
        "ask.runtime",
        error instanceof Error ? { cause: error } : undefined,
      );
      return await markJobCancelled(
        store,
        paths,
        job,
        "Ask cancelled by user request.",
        cancelledError,
        { phase: "cancelled" },
      );
    }
    const classified = classifyManagedCommandFailure(error, "ask", job.job_id);
    await markJobFailed(store, paths, job, classified, "Ask failed.", { phase: "failed" });
    throw classified;
  } finally {
    handlers.dispose();
    // WireClient.close() has an internal `closed` latch (wire/client.ts:182)
    // that makes a second call a no-op, so we don't need a separate flag.
    await client?.close().catch(() => {});
    store.close();
  }
}

function resolveAskSession(
  store: JobStore,
  repoId: string,
  fresh: boolean,
  resume: boolean,
  resumeTarget: string | undefined,
): { sessionId: string; reusedSession: boolean } {
  if (fresh) {
    return { sessionId: randomUUID(), reusedSession: false };
  }

  if (resumeTarget) {
    const byJob = store.getJob(resumeTarget);
    const scoped = byJob?.repo_id === repoId && byJob.command_type === "ask" ? byJob : null;
    const exact = scoped ?? store.findAskJobBySession(repoId, resumeTarget);
    if (!exact?.kimi_session_id) {
      throw new RuntimeError(
        "ASK_RESUME_NOT_FOUND",
        `No ask job or session matched ${resumeTarget}.`,
        "ask.resume",
      );
    }
    ensureAskSessionIsNotRunning(exact);
    return { sessionId: exact.kimi_session_id, reusedSession: true };
  }

  if (resume) {
    const latest = store.findLatestJob({ repoId, commandType: "ask" });
    if (!latest?.kimi_session_id) {
      throw new RuntimeError(
        "ASK_RESUME_NOT_FOUND",
        "No prior ask session exists for this repository.",
        "ask.resume",
      );
    }
    ensureAskSessionIsNotRunning(latest);
    return { sessionId: latest.kimi_session_id, reusedSession: true };
  }

  return { sessionId: randomUUID(), reusedSession: false };
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
