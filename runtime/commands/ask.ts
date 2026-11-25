import { companionHelp } from "../help.js";
import { allocateJobId } from "../job-id.js";
import path from "node:path";

import { createCliCancellationHandlers } from "../cli-cancellation.js";
import { runCliPromptWithBudget } from "../cli-client.js";
import {
  assertPersistedResumeLineage,
  executionPlanFromPersisted,
  observedExecutionFields,
  persistedExecutionPlanFields,
  prepareKimiExecutionPlan,
} from "../kimi-engine.js";
import { getManagedCommandConfig } from "./registry.js";
import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { digestPrompt, markJobCancelled, markJobFailed, sweepStaleJobs } from "../jobs.js";
import { JobStore, type JobRecord } from "../job-store.js";
import { KIMI_ASK_PROMPT_TIMEOUT_MS } from "../kimi-timeouts.js";
import { writeInvocationLogHeader } from "../logging.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { parseAskArgs } from "../parsing.js";
import { assertScopeSupported, parseJobReadScope, resolveReadScope, serializeReadScope } from "../read-scope.js";
import { readArtifact, renderManagedJobOutput, writeArtifact } from "../render.js";
import type { CommandContext } from "../types.js";
import { classifyManagedCommandFailure } from "../kimi-errors.js";
import { startBackgroundJob } from "../background-spawn.js";
import { warnInheritedBudget, captureTimeoutPartialOutput, assertCliResultSuccess, reassembleProseFromRecords, warnIfSessionIdMissing, warnHookEscapes, resolveResumeSession, resumeBudget, hookRefusal, READ_ONLY_HOOK_REPAIR } from "./cli-helpers.js";
import { buildKimiSessionTitle, syncKimiSessionTitle } from "../session-title.js";
import { shorten } from "../util.js";

const ASK_SUMMARY_MAX = 120;
const ASK_AGENT_PROFILE_PLACEHOLDER = "<cli-client>";
const ASK_PROMPT_CONTRACT = [
  "Answer directly in free-form prose.",
  "For repository-dependent questions, inspect the relevant code with the allowed read tools and cite file:line for concrete code claims where useful.",
  "Distinguish evidence from inference and state unknowns explicitly.",
  "Do not use shell/Bash, writes, background tasks, or delegated operations.",
  "Do not emit JSON unless the user explicitly asks for it.",
  "Do not narrate tool progress; make the final response self-contained.",
];
const ASK_PROMPT_PREFIX = [
  ...ASK_PROMPT_CONTRACT,
  "",
  "User question:",
  "",
].join("\n");
const ASK_CONTINUE_TASK = "Continue the previous ask conversation and answer any outstanding question.";
const ASK_RESUME_PROMPT = [
  ...ASK_PROMPT_CONTRACT,
  "",
  ASK_CONTINUE_TASK,
].join("\n");

export async function runAsk(argv: string[], context: CommandContext): Promise<string> {
  const parsed = parseAskArgs(argv);
  if (parsed.help) return companionHelp(["ask", ...argv])!;
  // Scope always comes from this invocation, never from a resumed job.
  const readScope = parsed.readRoots === undefined && parsed.network === undefined ? undefined
    : await resolveReadScope(parsed.readRoots, parsed.network, "ask.parse");
  if (context.env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK !== "1") {
    await requireAskHookInstalled(context);
  }

  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);
  const repoIdentity = await resolveRepoIdentity(context.cwd);
  const askConfig = getManagedCommandConfig("ask");
  const store = new JobStore(paths);
  try {
    await sweepStaleJobs(store, paths);

    const jobId = allocateJobId(context);
    const sessionResolution = await resolveResumeSession(store, "ask", repoIdentity.repoId, parsed);
    const askPrompt = buildAskPrompt(parsed.prompt, sessionResolution.reusedSession);
    const executionPlan = await prepareKimiExecutionPlan({
      operationKind: "ask",
      cwd: context.cwd,
      env: context.env,
      stderr: context.stderr,
      resumedFromJobId: sessionResolution.resumedFromJobId,
      resumeSessionId: sessionResolution.kimiSessionId ?? undefined,
      resumeSource: sessionResolution.sourceJob,
    });
    assertScopeSupported(readScope, executionPlan.certification, "INVALID_ARGS", "ask.parse");
    const logPath = path.join(paths.logsDir, `ask-${jobId}.jsonl`);
    const job = store.createJob({
      job_id: jobId,
      repo_id: repoIdentity.repoId,
      command_type: "ask",
      cwd: context.cwd,
      model: parsed.model ?? null,
      thinking: null,
      thinking_effort: parsed.thinkingEffort ?? null,
      read_scope: serializeReadScope(readScope),
      background: parsed.background,
      ...resumeBudget("ask", parsed.budgetMs, sessionResolution.sourceJob),
      pid: parsed.background ? null : process.pid,
      kimi_pid: null,
      status: "running",
      kimi_session_id: sessionResolution.kimiSessionId,
      kimi_session_id_source: sessionResolution.sourceJob?.kimi_session_id_source ?? null,
      ...persistedExecutionPlanFields(executionPlan),
      agent_profile: ASK_AGENT_PROFILE_PLACEHOLDER,
      prompt_digest: digestPrompt(askPrompt),
      summary: shorten(askPromptSubject(askPrompt), ASK_SUMMARY_MAX),
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

    warnInheritedBudget(job, context.stderr);

    if (parsed.background) {
      return startBackgroundJob(job, askPrompt, context, paths, {
        workerKind: "ask",
        wait: parsed.wait,
        failedSummary: askConfig.cancellation.failedSummary,
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
  let handlers: ReturnType<typeof createCliCancellationHandlers> | undefined;

  try {
    // Re-verify in the worker so a background job cannot outlive or bypass
    // enforcement drift between the user invocation and the actual Kimi spawn.
    if (context.env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK !== "1") {
      await requireAskHookInstalled(context);
    }
    handlers = createCliCancellationHandlers();
    const executionPlan = executionPlanFromPersisted(job);
    const readScope = parseJobReadScope(job.read_scope);
    store.updateRunningJob(job.job_id, { phase: "turn-running" });

    // Re-validate resume lineage from the store before spawning: a detached
    // worker (or a forged queued row) reloads the persisted plan and would
    // otherwise hand kimi_session_id to the spawn without the dispatch-time
    // lineage check. Fresh sessions (no resumedFromJobId) are exempt.
    if (job.kimi_session_id !== null) {
      await assertPersistedResumeLineage(store, executionPlan, job.kimi_session_id, "ask");
    }

    if (options?.workerPid) {
      store.updateRunningJob(job.job_id, { pid: options.workerPid, phase: "worker-running" });
    }

    const result = await runCliPromptWithBudget(
      {
        cwd: job.cwd,
        env: context.env,
        command: executionPlan.command,
        prefixArgs: [...executionPlan.prefixArgs],
        executionPlan,
        prompt,
        commandLabel: "ask",
        model: job.model ?? undefined,
        thinkingEffort: job.thinking_effort ?? undefined,
        readScope,
        resumeSessionId: job.kimi_session_id ?? undefined,
        logPath: job.stream_log_path,
        onSpawn: (pid) => { store.updateRunningJob(job.job_id, { kimi_pid: pid }); },
        signal: handlers.signal,
      },
      job.budget_ms ?? KIMI_ASK_PROMPT_TIMEOUT_MS,
      "ask.prompt",
    );

    store.updateRunningJob(job.job_id, observedExecutionFields(result));

    if (handlers.cancelling) {
      throw new RuntimeError(
        cancel.errorCodes.cancelled,
        cancel.cancelMessages.afterPrompt,
        "ask.runtime",
      );
    }

    assertCliResultSuccess(result, "ask.runtime");
    warnHookEscapes(result, "ask", context.stderr);

    // Persist whichever session id kimi actually announced. For fresh
    // sessions this is the only chance to record it. For resumed
    // sessions it should match the input, but capture anyway in case
    // kimi-code mints a new id on each turn.
    if (
      result.sessionId !== undefined &&
      result.sessionId.length > 0
    ) {
      // Never persist an empty ID because NULL represents a missing session ID.
      store.updateRunningJob(job.job_id, { kimi_session_id_source: "announced", kimi_session_id: result.sessionId });
    }
    await syncKimiSessionTitle({
      promptText: askPromptSubject(prompt),
      env: context.env,
      cwd: job.cwd,
      sessionId: result.sessionId ?? job.kimi_session_id,
      title: buildKimiSessionTitle("ask", askPromptSubject(prompt)),
      stderr: context.stderr,
    });
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
    const classified = error instanceof RuntimeError && error.stage === "ask.hook-check" ? error
      : classifyManagedCommandFailure(error, "ask", job.job_id, { background: job.background, budgetMs: job.budget_ms ?? KIMI_ASK_PROMPT_TIMEOUT_MS });
    const partialOutput = await captureTimeoutPartialOutput(classified, store, job, context.env, handlers?.signal);
    if (handlers?.cancelling) {
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
    // Hook preflight errors are already fully classified. Running them through
    // the generic availability classifier can mistake words in the verifier's
    // reason (for example "timed out") for a Kimi runtime timeout and erase the
    // load-bearing hook-check code/stage from the persisted background job.
    if (error instanceof RuntimeError && error.stage === "ask.hook-check") {
      await markJobFailed(store, paths, job, error, cancel.failedSummary, { phase: "failed" });
      throw error;
    }
    await markJobFailed(store, paths, job, classified, cancel.failedSummary, { phase: "failed", partialOutput });
    throw classified;
  } finally {
    handlers?.dispose();
    store.close();
  }
}

async function requireAskHookInstalled(context: CommandContext): Promise<void> {
  if (context.env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK === "1") {
    return;
  }

  const refusal = await hookRefusal(context, "ask", "ASK_HOOK_NOT_INSTALLED", "ask.hook-check",
    "ask refuses to run without the canonical kimi-plugin-cc PreToolUse hook.", READ_ONLY_HOOK_REPAIR);
  if (refusal) throw refusal;
}

function buildAskPrompt(question: string | undefined, reusedSession: boolean): string {
  if (question?.trim()) {
    return ASK_PROMPT_PREFIX + question.trim();
  }

  if (reusedSession) {
    return ASK_RESUME_PROMPT;
  }

  throw new RuntimeError("INVALID_ARGS", "ask requires a question after the flags.", "ask.parse");
}

export function askPromptSubject(prompt: string): string {
  if (prompt.startsWith(ASK_PROMPT_PREFIX)) return prompt.slice(ASK_PROMPT_PREFIX.length);
  return prompt === ASK_RESUME_PROMPT ? ASK_CONTINUE_TASK : prompt;
}
