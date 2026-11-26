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
  reconcileHistoricalJobProvenance,
} from "../kimi-engine.js";
import { getManagedCommandConfig } from "./registry.js";
import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import {
  digestPrompt,
  markJobCancelled,
  markJobFailed,
  recordKimiSpawnIdentity,
  serializedProcessIdentity,
  sweepStaleJobs,
} from "../jobs.js";
import { JobStore, type JobRecord } from "../job-store.js";
import { classifyManagedCommandFailure } from "../kimi-errors.js";
import { KIMI_RESCUE_PROMPT_TIMEOUT_MS } from "../kimi-timeouts.js";
import { writeInvocationLogHeader } from "../logging.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { parseRescueArgs } from "../parsing.js";
import { readArtifact, renderManagedJobOutput, writeArtifact } from "../render.js";
import type { CommandContext } from "../types.js";
import { startBackgroundJob } from "../background-spawn.js";
import { warnInheritedBudget, captureTimeoutPartialOutput, assertCliResultSuccess, reassembleProseFromRecords, warnIfSessionIdMissing, warnHookEscapes, resolveResumeSession, resumeBudget, type SessionResolution, hookRefusal } from "./cli-helpers.js";
import { buildKimiSessionTitle, syncKimiSessionTitle } from "../session-title.js";
import { appendSessionReferences, resolveSessionReferences, stripSessionReferences } from "../session-references.js";
import { shorten } from "../util.js";

// "Continue working on the bug" verbs that auto-attach to the latest
// rescue session. Documented UX trap: a prompt matching this pattern
// will resume the most recent rescue session regardless of whether
// that session was about the same bug. Users should pass an explicit
// `--resume <job-id>` or `--fresh` when the topic switches.
const AUTO_RESUME_PATTERN = /\b(continue|resume|keep going|keep working|apply the top fix|dig deeper)\b/i;
const RESCUE_SUMMARY_MAX = 120;
const RESCUE_AGENT_PROFILE_PLACEHOLDER = "<cli-client>";
const RESCUE_CONTINUE_TASK = "Continue the previous rescue task using the latest repository state.";
const RESCUE_PROMPT_PREFIX = [
  "Follow repository instructions and inspect the current state before editing.",
  "Implement the smallest complete change that satisfies the task instead of stopping at a plan.",
  "Do not mutate git state.",
  "Run proportionate relevant checks, and never claim unrun checks passed.",
  "Do not narrate progress.",
  "Finish with a self-contained report of changed files, verification commands and results, and unfinished work or blockers.",
  "",
  "Rescue task:",
  "",
].join("\n");

export async function runRescue(argv: string[], context: CommandContext): Promise<string> {
  const parsed = parseRescueArgs(argv);
  if (parsed.help) return companionHelp(["task", "rescue", ...argv])!;
  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);
  const repoIdentity = await resolveRepoIdentity(context.cwd);
  const rescueConfig = getManagedCommandConfig("rescue");
  const store = new JobStore(paths);

  try {
    await sweepStaleJobs(store, paths);

    const sessionResolution = await resolveRescueSession(store, repoIdentity.repoId, parsed);
    const basePrompt = buildRescuePrompt(parsed.prompt, sessionResolution.reusedSession);
    const executionPlan = await prepareKimiExecutionPlan({
      operationKind: "rescue",
      cwd: context.cwd,
      env: context.env,
      stderr: context.stderr,
      resumedFromJobId: sessionResolution.resumedFromJobId,
      resumeSessionId: sessionResolution.kimiSessionId ?? undefined,
      resumeSource: sessionResolution.sourceJob,
    });
    const prompt = appendSessionReferences(basePrompt, await resolveSessionReferences(parsed.referenceSessions, {
      store, env: context.env, spawnCwd: context.cwd, plan: executionPlan,
      resumeSessionId: sessionResolution.kimiSessionId, stage: "rescue.reference-session",
    }));
    const jobId = allocateJobId(context);
    const logPath = path.join(paths.logsDir, `rescue-${jobId}.jsonl`);

    const job = store.createJob({
      job_id: jobId,
      repo_id: repoIdentity.repoId,
      command_type: "rescue",
      cwd: context.cwd,
      model: parsed.model ?? null,
      thinking: null,
      thinking_effort: parsed.thinkingEffort ?? null,
      background: parsed.background,
      ...resumeBudget("rescue", parsed.budgetMs, sessionResolution.sourceJob),
      pid: parsed.background ? null : process.pid,
      kimi_pid: null,
      companion_identity: parsed.background ? null : await serializedProcessIdentity(process.pid),
      status: "running",
      kimi_session_id: sessionResolution.kimiSessionId,
      kimi_session_id_source: sessionResolution.sourceJob?.kimi_session_id_source ?? null,
      ...persistedExecutionPlanFields(executionPlan),
      agent_profile: RESCUE_AGENT_PROFILE_PLACEHOLDER,
      prompt_digest: digestPrompt(prompt),
      summary: shorten(stripRescuePromptPrefix(prompt), RESCUE_SUMMARY_MAX),
      phase: parsed.background ? "queued" : "starting",
      final_output_path: null,
      stream_log_path: logPath,
      error: null,
    });

    try {
      await writeInvocationLogHeader(logPath, {
        commandType: "rescue",
        kimiSessionId: sessionResolution.kimiSessionId ?? "(pending)",
        cwd: context.cwd,
      });
    } catch (error) {
      const classified = new RuntimeError(
        "RESCUE_LOG_HEADER_FAILED",
        `Failed to write rescue invocation log header: ${(error as Error).message ?? String(error)}`,
        "rescue.log-header",
        error instanceof Error ? { cause: error } : undefined,
      );
      await markJobFailed(store, paths, job, classified, rescueConfig.cancellation.failedSummary, { phase: "failed" });
      throw classified;
    }

    warnInheritedBudget(job, context.stderr);

    if (parsed.background) {
      return startBackgroundJob(job, prompt, context, paths, {
        workerKind: "rescue",
        wait: parsed.wait,
        failedSummary: rescueConfig.cancellation.failedSummary,
      });
    }

    const completed = await executeRescueJob(job.job_id, prompt, context);
    if (!completed.final_output_path) {
      throw new RuntimeError("RESCUE_RESULT_MISSING", "Rescue finished without a rendered result.", "rescue.result");
    }

    return readArtifact(completed.final_output_path);
  } finally {
    store.close();
  }
}

export async function executeRescueJob(
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
    throw new RuntimeError("JOB_NOT_FOUND", `Rescue job ${jobId} was not found.`, "rescue.worker");
  }

  const rescueConfig = getManagedCommandConfig("rescue");
  const cancel = rescueConfig.cancellation;

  // Rescue writes directly to the workspace. Without the PreToolUse hook,
  // kimi-code's `-p` mode auto-approves every Bash/Write/Edit, including
  // destructive ones. Refuse before the worker can spawn Kimi.
  //
  // The hook check happens BEFORE `createCliCancellationHandlers()` so
  // an early return doesn't leak SIGTERM/SIGINT listeners. Tests /
  // setup probes / intentional bypass: KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1.
  if (context.env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK !== "1") {
    const classified = await hookRefusal(context, "rescue");
    if (classified) {
      try {
        return await markJobFailed(
          store,
          paths,
          job,
          classified,
          cancel.failedSummary,
          { phase: "failed" },
        );
      } finally {
        store.close();
      }
    }
  }

  const handlers = createCliCancellationHandlers();

  try {
    const executionPlan = executionPlanFromPersisted(job);

    // Re-validate resume lineage from the store before spawning: a detached
    // worker (or a forged queued row) reloads the persisted plan and would
    // otherwise hand kimi_session_id to the spawn without the dispatch-time
    // lineage check. Fresh sessions (no resumedFromJobId) are exempt.
    if (job.kimi_session_id !== null) {
      await assertPersistedResumeLineage(store, executionPlan, job.kimi_session_id, "rescue");
    }
    if (options?.workerPid) {
      const workerIdentity = await serializedProcessIdentity(options.workerPid);
      store.updateRunningJob(job.job_id, {
        pid: options.workerPid,
        ...(workerIdentity ? { companion_identity: workerIdentity } : {}),
        phase: "worker-running",
      });
    }
    store.updateRunningJob(job.job_id, { phase: "turn-running" });

    const result = await runCliPromptWithBudget(
      {
        cwd: job.cwd,
        env: context.env,
        command: executionPlan.command,
        prefixArgs: [...executionPlan.prefixArgs],
        executionPlan,
        prompt,
        commandLabel: "rescue",
        trustedWorkspaceRoot: job.cwd,
        model: job.model ?? undefined,
        thinkingEffort: job.thinking_effort ?? undefined,
        resumeSessionId: job.kimi_session_id ?? undefined,
        logPath: job.stream_log_path,
        onSpawn: async (pid) => { await recordKimiSpawnIdentity(store, job.job_id, pid); },
        signal: handlers.signal,
      },
      job.budget_ms ?? KIMI_RESCUE_PROMPT_TIMEOUT_MS,
      "rescue.prompt",
    );

    store.updateRunningJob(job.job_id, observedExecutionFields(result));

    if (handlers.cancelling) {
      throw new RuntimeError(
        cancel.errorCodes.cancelled,
        cancel.cancelMessages.afterPrompt,
        "rescue.runtime",
      );
    }

    assertCliResultSuccess(result, "rescue.runtime");
    warnHookEscapes(result, "rescue", context.stderr);

    if (
      result.sessionId !== undefined &&
      result.sessionId.length > 0
    ) {
      // Never persist an empty ID because NULL represents a missing session ID.
      store.updateRunningJob(job.job_id, { kimi_session_id_source: "announced", kimi_session_id: result.sessionId });
    }
    await syncKimiSessionTitle({
      promptText: stripRescuePromptPrefix(prompt),
      env: context.env,
      cwd: job.cwd,
      sessionId: result.sessionId ?? job.kimi_session_id,
      title: buildKimiSessionTitle("rescue", stripRescuePromptPrefix(prompt)),
      stderr: context.stderr,
    });
    if (job.kimi_session_id === null) {
      warnIfSessionIdMissing(result, "rescue", job.job_id, context.stderr);
    }

    const finalText = reassembleProseFromRecords(result.records);
    const rendered = renderManagedJobOutput(job, finalText);
    let artifactPath: string;
    try {
      if (context.env.KIMI_PLUGIN_CC_TEST_FAIL_WRITE_ARTIFACT === "1") {
        throw new Error("Simulated artifact write failure (test seam).");
      }
      artifactPath = await writeArtifact(paths, job, rendered.rendered);
    } catch (writeError) {
      // LLM-caller discipline: writing the raw model output to stderr
      // for a wrapper LLM-caller would corrupt its prose stream. Keep
      // the raw text in the RuntimeError details — surfaces via
      // /kimi:status / /kimi:result --json — and emit only a short
      // human-facing line on stderr.
      context.stderr.write(
        `[kimi-plugin-cc] rescue artifact write failed for job ${job.job_id}; raw output preserved in error details.\n`,
      );
      const classified = new RuntimeError(
        "RESCUE_ARTIFACT_WRITE_FAILED",
        `Failed to write rescue artifact: ${(writeError as Error).message ?? String(writeError)}`,
        "rescue.artifact",
        {
          ...(writeError instanceof Error ? { cause: writeError } : {}),
          details: { rawOutput: finalText },
        },
      );
      return await markJobFailed(store, paths, job, classified, cancel.failedSummary, { phase: "failed" });
    }

    if (handlers.cancelling) {
      throw new RuntimeError(
        cancel.errorCodes.cancelled,
        cancel.cancelMessages.afterArtifact,
        "rescue.runtime",
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
    const classified = classifyManagedCommandFailure(error, "rescue", job.job_id, {
      preserveStage: true,
      background: job.background,
      budgetMs: job.budget_ms ?? KIMI_RESCUE_PROMPT_TIMEOUT_MS,
    });
    const partialOutput = await captureTimeoutPartialOutput(classified, store, job, context.env, handlers.signal);
    if (handlers.cancelling) {
      const cancelledError = new RuntimeError(
        cancel.errorCodes.cancelled,
        cancel.cancelMessages.default,
        "rescue.runtime",
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

    return await markJobFailed(store, paths, job, classified, cancel.failedSummary, { phase: "failed", partialOutput });
  } finally {
    handlers.dispose();
    store.close();
  }
}

function buildRescuePrompt(prompt: string | undefined, reusedSession: boolean): string {
  if (prompt?.trim()) {
    return RESCUE_PROMPT_PREFIX + prompt.trim();
  }

  if (reusedSession) {
    return RESCUE_PROMPT_PREFIX + RESCUE_CONTINUE_TASK;
  }

  throw new RuntimeError("INVALID_ARGS", "rescue requires a task description.", "rescue.parse");
}

export function stripRescuePromptPrefix(prompt: string): string {
  const body = stripSessionReferences(prompt);
  return body.startsWith(RESCUE_PROMPT_PREFIX) ? body.slice(RESCUE_PROMPT_PREFIX.length) : body;
}

async function resolveRescueSession(
  store: JobStore,
  repoId: string,
  parsed: { prompt?: string; fresh: boolean; resume: boolean; resumeTarget?: string },
): Promise<SessionResolution> {
  if (!parsed.fresh && !parsed.resumeTarget && !parsed.resume && parsed.prompt && AUTO_RESUME_PATTERN.test(parsed.prompt)) {
    const latest = store.findLatestJob({ repoId, commandType: "rescue" });
    if (latest?.kimi_session_id && latest.status !== "running") {
      const source = await reconcileHistoricalJobProvenance(store, latest);
      return {
        kimiSessionId: source.kimi_session_id,
        reusedSession: true,
        resumedFromJobId: source.job_id,
        sourceJob: source,
      };
    }
  }

  return resolveResumeSession(store, "rescue", repoId, parsed);
}
