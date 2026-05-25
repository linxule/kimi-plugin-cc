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
import { classifyManagedCommandFailure } from "../kimi-errors.js";
import { KIMI_RESCUE_PROMPT_TIMEOUT_MS } from "../kimi-timeouts.js";
import { writeInvocationLogHeader } from "../logging.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { parseRescueArgs } from "../parsing.js";
import { readArtifact, renderManagedJobOutput, writeArtifact } from "../render.js";
import type { CommandContext } from "../types.js";
import { startBackgroundJob } from "../background-spawn.js";
import { maybeWarnHookMissing, verifyHookInstalled } from "../hooks/install.js";
import { assertCliResultSuccess, reassembleProseFromRecords, warnIfSessionIdMissing } from "./cli-helpers.js";

export { describeMissingResult } from "../background-spawn.js";

// v1.0 cutover note (PR 3):
//
//   Rescue is the only write-capable command. v0.4 enforced safety
//   in-band via `WireClient.approvalPolicy = createRescueApprovalPolicy(cwd)`,
//   which called back into our runtime on every kimi-side approval
//   request. v1.0 moves that enforcement into the PreToolUse hook
//   (`runtime/hooks/approval-hook.ts`), which spawns under kimi-code
//   and calls `evaluateRescueHookRequest` for `KIMI_PLUGIN_CC_CMD=rescue`
//   tool calls. The runtime side now just sets the env var and lets
//   the hook gate everything.
//
//   The security helpers in `runtime/rescue-approval.ts` are unchanged.

// "Continue working on the bug" verbs that auto-attach to the latest
// rescue session. Documented UX trap: a prompt matching this pattern
// will resume the most recent rescue session regardless of whether
// that session was about the same bug. Users should pass an explicit
// `--resume <job-id>` or `--fresh` when the topic switches.
const AUTO_RESUME_PATTERN = /\b(continue|resume|keep going|keep working|apply the top fix|dig deeper)\b/i;
const RESCUE_SUMMARY_MAX = 120;
const RESCUE_AGENT_PROFILE_PLACEHOLDER = "<cli-client>";
// Rescue runs multi-step apply/test/verify loops under thinking-on by
// default — uses the longest budget. See KIMI_RESCUE_PROMPT_TIMEOUT_MS
// in kimi-timeouts.ts for the rationale on the 1800s value.

interface RescueSessionResolution {
  /** Prior kimi session id to resume; null means start a fresh session. */
  kimiSessionId: string | null;
  reusedSession: boolean;
}

export async function runRescue(argv: string[], context: CommandContext): Promise<string> {
  const parsed = parseRescueArgs(argv);
  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);
  const repoIdentity = await resolveRepoIdentity(context.cwd);
  const rescueConfig = getManagedCommandConfig("rescue");
  const store = new JobStore(paths);

  try {
    await sweepStaleJobs(store, paths);

    const sessionResolution = resolveRescueSession(
      store,
      repoIdentity.repoId,
      parsed.prompt,
      parsed.fresh,
      parsed.resume,
      parsed.resumeTarget,
    );
    const prompt = buildRescuePrompt(parsed.prompt, sessionResolution.reusedSession);
    const jobId = randomUUID();
    const logPath = path.join(paths.logsDir, `rescue-${jobId}.jsonl`);

    const job = store.createJob({
      job_id: jobId,
      repo_id: repoIdentity.repoId,
      command_type: "rescue",
      cwd: context.cwd,
      model: parsed.model ?? null,
      thinking: parsed.thinking ?? null,
      background: parsed.background,
      pid: parsed.background ? null : process.pid,
      kimi_pid: null,
      status: "running",
      kimi_session_id: sessionResolution.kimiSessionId,
      agent_profile: RESCUE_AGENT_PROFILE_PLACEHOLDER,
      prompt_digest: digestPrompt(prompt),
      summary: shorten(prompt, RESCUE_SUMMARY_MAX),
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

    if (parsed.background) {
      return startBackgroundJob(job, prompt, context, paths, {
        workerKind: "rescue",
        wait: parsed.wait,
        promptEnvVar: "KIMI_PLUGIN_CC_RESCUE_PROMPT_B64",
        reusedSessionEnvVar: "KIMI_PLUGIN_CC_RESCUE_REUSED_SESSION",
        reusedSession: sessionResolution.reusedSession,
        failedSummary: rescueConfig.cancellation.failedSummary,
        missingResultErrorCode: "RESCUE_RESULT_MISSING",
        spawnFailedErrorCode: "RESCUE_WORKER_SPAWN_FAILED",
        earlyExitErrorCode: "RESCUE_WORKER_EXITED_EARLY",
        nodeBinInvalidErrorCode: "RESCUE_NODE_BIN_INVALID",
        waitStage: "rescue.wait",
        spawnStage: "rescue.worker.spawn",
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
  options?: { workerPid?: number; reusedSession?: boolean },
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

  // Rescue is the only write-capable command. Without the PreToolUse
  // hook, kimi-code's `-p` mode auto-approves every Bash/Write/Edit —
  // including destructive ones. ask/review/challenge are loud-warn
  // because their failure mode is silent broadening of a documented
  // read-only contract. Rescue's failure mode is the model executing
  // an `rm -rf` because the user happens not to have run
  // `/kimi:setup` yet. Refuse rather than warn.
  //
  // The hook check happens BEFORE `createCliCancellationHandlers()` so
  // an early return doesn't leak SIGTERM/SIGINT listeners. Tests /
  // setup probes / intentional bypass: KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1.
  if (context.env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK !== "1") {
    const installStatus = await verifyHookInstalled(context.env);
    if (!installStatus.installed) {
      maybeWarnHookMissing(installStatus, "rescue", context.stderr);
      const classified = new RuntimeError(
        "RESCUE_HOOK_NOT_INSTALLED",
        [
          "rescue refuses to run without the kimi-plugin-cc PreToolUse hook.",
          `Hook check failed: ${installStatus.reason ?? "unknown"}.`,
          "Run /kimi:setup (PR 4 owns the installer) or set KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1",
          "if you've intentionally configured an alternative safety mechanism.",
        ].join(" "),
        "rescue.hook-check",
        { details: { config_path: installStatus.configPath } },
      );
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
  const kimi = resolveKimiCliCommand(context.env);

  try {
    if (options?.workerPid) {
      store.updateRunningJob(job.job_id, { pid: options.workerPid, phase: "worker-running" });
    }
    store.updateRunningJob(job.job_id, { phase: "turn-running" });

    const result = await runCliPromptWithBudget(
      {
        cwd: job.cwd,
        env: context.env,
        command: kimi.command,
        prefixArgs: kimi.prefixArgs,
        prompt,
        commandLabel: "rescue",
        model: job.model ?? undefined,
        resumeSessionId: job.kimi_session_id ?? undefined,
        logPath: job.stream_log_path,
        signal: handlers.signal,
        // SIGKILL escalation defaults to 1500ms inside cli-client —
        // matches v0.4's cancellation.ts behavior for the wire client.
      },
      KIMI_RESCUE_PROMPT_TIMEOUT_MS,
      "rescue.prompt",
    );

    if (handlers.cancelling) {
      throw new RuntimeError(
        cancel.errorCodes.cancelled,
        cancel.cancelMessages.afterPrompt,
        "rescue.runtime",
      );
    }

    assertCliResultSuccess(result, "rescue.runtime");

    if (
      result.sessionId !== undefined &&
      result.sessionId.length > 0 &&
      result.sessionId !== job.kimi_session_id
    ) {
      // length>0 guard: empty-string capture would poison the row. (Kimi
      // alpha.4 challenge finding #3.)
      store.updateRunningJob(job.job_id, { kimi_session_id: result.sessionId });
    }
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

    const classified = classifyManagedCommandFailure(error, "rescue", job.job_id, {
      preserveStage: true,
    });
    return await markJobFailed(store, paths, job, classified, cancel.failedSummary, { phase: "failed" });
  } finally {
    handlers.dispose();
    store.close();
  }
}

function buildRescuePrompt(prompt: string | undefined, reusedSession: boolean): string {
  if (prompt?.trim()) {
    return prompt.trim();
  }

  if (reusedSession) {
    return "Continue the previous rescue task using the latest repository state.";
  }

  throw new RuntimeError("INVALID_ARGS", "rescue requires a task description.", "rescue.parse");
}

function resolveRescueSession(
  store: JobStore,
  repoId: string,
  prompt: string | undefined,
  fresh: boolean,
  resume: boolean,
  resumeTarget: string | undefined,
): RescueSessionResolution {
  if (fresh) {
    return { kimiSessionId: null, reusedSession: false };
  }

  if (resumeTarget) {
    const byJob = store.getJob(resumeTarget);
    const scoped = byJob?.repo_id === repoId && byJob.command_type === "rescue" ? byJob : null;
    const exact = scoped ?? store.findRescueJobBySession(repoId, resumeTarget);
    if (!exact) {
      throw new RuntimeError(
        "RESCUE_RESUME_NOT_FOUND",
        `No rescue job or session matched ${resumeTarget}.`,
        "rescue.resume",
      );
    }
    ensureSessionIsNotRunning(exact);
    if (!exact.kimi_session_id) {
      throw new RuntimeError(
        "RESCUE_RESUME_NOT_FOUND",
        `No rescue job or session matched ${resumeTarget}.`,
        "rescue.resume",
      );
    }
    return { kimiSessionId: exact.kimi_session_id, reusedSession: true };
  }

  if (resume) {
    const latest = store.findLatestJob({ repoId, commandType: "rescue" });
    if (!latest) {
      throw new RuntimeError(
        "RESCUE_RESUME_NOT_FOUND",
        "No prior rescue session exists for this repository.",
        "rescue.resume",
      );
    }
    ensureSessionIsNotRunning(latest);
    if (!latest.kimi_session_id) {
      throw new RuntimeError(
        "RESCUE_RESUME_NOT_FOUND",
        "No prior rescue session exists for this repository.",
        "rescue.resume",
      );
    }
    return { kimiSessionId: latest.kimi_session_id, reusedSession: true };
  }

  if (prompt && AUTO_RESUME_PATTERN.test(prompt)) {
    const latest = store.findLatestJob({ repoId, commandType: "rescue" });
    if (latest?.kimi_session_id && latest.status !== "running") {
      return { kimiSessionId: latest.kimi_session_id, reusedSession: true };
    }
  }

  return { kimiSessionId: null, reusedSession: false };
}

function ensureSessionIsNotRunning(job: JobRecord): void {
  if (job.status === "running") {
    throw new RuntimeError(
      "RESCUE_ALREADY_RUNNING",
      `Rescue session ${job.kimi_session_id ?? "<unknown>"} is already active under job ${job.job_id}.`,
      "rescue.resume",
    );
  }
}

function shorten(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
