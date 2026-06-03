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
import { KIMI_PURSUE_DEFAULT_BUDGET_MS } from "../kimi-timeouts.js";
import { probeKimiVersion } from "../kimi-version-probe.js";
import { writeInvocationLogHeader } from "../logging.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { parsePursueArgs } from "../parsing.js";
import { readArtifact, renderManagedJobOutput, writeArtifact } from "../render.js";
import type { GoalSummaryRecord } from "../stream-json.js";
import type { CommandContext } from "../types.js";
import { maybeWarnHookMissing, verifyHookInstalled } from "../hooks/install.js";
import { assertCliResultSuccess, reassembleProseFromRecords, warnIfSessionIdMissing } from "./cli-helpers.js";

// /kimi:pursue — autonomous goal mode (kimi-code 0.8.0+ headless `/goal`).
//
// PROTOTYPE SCOPE (v1.1 experimental). Deliberately narrow:
//   - FOREGROUND ONLY. No --background/--detach yet. Goal mode is experimental
//     upstream and its cancellation semantics want a human watching; a hard
//     wall-clock budget bounds the run. (kimi's own shape-consult, report 60.)
//   - NO --resume. In goal mode `goal.summary` emits a *goalId* that is
//     DISTINCT from the resume-hint *sessionId*; `kimi -r <sessionId>` re-enters
//     the session but not necessarily the goal continuation. Exposing resume
//     before that split is reconciled upstream would be a silent-failure trap,
//     so we capture+surface the goalId but don't offer resume yet.
//   - Reuses the RESCUE job lineage (command_type "rescue", KIMI_PLUGIN_CC_CMD=
//     "rescue") so the PreToolUse hook applies the workspace write allowlist to
//     EVERY continuation turn, and /kimi:status / /kimi:result / /kimi:cancel
//     work unchanged. Promoting pursue to a first-class command_type is a
//     follow-up (would ripple through ManagedCommandType + the registry).
//
// SAFETY: the hook fires on every tool call in every continuation turn (policy
// index 0, verified against kimi-code 0.9.0 — report 58). So a goal-mode run is
// exactly as write-gated as a single-turn rescue. The only NEW risk is
// unboundedness, bounded here by the AbortController wall-clock ceiling.

/** kimi-code minor that introduced headless goal mode (#270, 0.8.0). */
const GOAL_MODE_MIN_MINOR = 8;
const PURSUE_SUMMARY_MAX = 120;
const PURSUE_AGENT_PROFILE = "<goal-mode>";

/** Terminal goal status decoded from the process exit code (goal-prompt.ts). */
export type GoalExitStatus = "complete" | "blocked" | "paused" | "unknown";

/**
 * Map a headless goal-mode exit code to a terminal status. complete=0 is
 * success; blocked=3 and paused=6 are terminal-but-resumable (NOT failures);
 * anything else is a genuine process failure. Source:
 * apps/kimi-code/src/cli/goal-prompt.ts::GOAL_EXIT_CODES.
 */
export function classifyGoalExit(exitCode: number): GoalExitStatus {
  switch (exitCode) {
    case 0:
      return "complete";
    case 3:
      return "blocked";
    case 6:
      return "paused";
    default:
      return "unknown";
  }
}

/**
 * Build the headless goal prompt. The objective becomes the goal; an optional
 * turn cap is appended as a model INSTRUCTION (soft — headless create has no
 * argv/env to set a hard turn budget, so we ask the model to call SetGoalBudget
 * itself). The hard bound is always the wall-clock AbortController.
 */
export function buildGoalPrompt(objective: string, turns?: number): string {
  const trimmed = objective.trim();
  const turnHint =
    turns !== undefined ? ` Stop after at most ${turns} turns; call SetGoalBudget to enforce this.` : "";
  return `/goal ${trimmed}${turnHint}`;
}

function renderGoalHeader(
  summary: GoalSummaryRecord | undefined,
  exitStatus: GoalExitStatus,
): string {
  const status = summary?.status ?? exitStatus;
  const lines = [`**Goal status:** ${status}`];
  if (summary?.reason) {
    lines.push(`**Reason:** ${summary.reason}`);
  }
  const metrics: string[] = [];
  if (summary?.turnsUsed != null) metrics.push(`turns: ${summary.turnsUsed}`);
  if (summary?.tokensUsed != null) metrics.push(`tokens: ${summary.tokensUsed}`);
  if (summary?.wallClockMs != null) {
    metrics.push(`wall-clock: ${Math.round(summary.wallClockMs / 1000)}s`);
  }
  if (metrics.length > 0) {
    lines.push(`**Usage:** ${metrics.join(", ")}`);
  }
  if (summary?.goalId) {
    lines.push(
      `**Goal id:** \`${summary.goalId}\` (resume is not yet exposed for /kimi:pursue — see docs/safety.md)`,
    );
  }
  return lines.join("\n");
}

export async function runPursue(argv: string[], context: CommandContext): Promise<string> {
  const parsed = parsePursueArgs(argv);
  const objective = parsed.objective?.trim();
  if (!objective) {
    throw new RuntimeError(
      "INVALID_ARGS",
      "/kimi:pursue requires an objective. Usage: /kimi:pursue [--budget 30m] [--turns N] [-m model] <objective>",
      "pursue.parse",
    );
  }

  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);
  const repoIdentity = await resolveRepoIdentity(context.cwd);
  const store = new JobStore(paths);

  try {
    await sweepStaleJobs(store, paths);
    await assertGoalModeSupported(context);

    const prompt = buildGoalPrompt(objective, parsed.turns);
    const jobId = randomUUID();
    const logPath = path.join(paths.logsDir, `pursue-${jobId}.jsonl`);

    const job = store.createJob({
      job_id: jobId,
      repo_id: repoIdentity.repoId,
      // Reuse the rescue lineage: same write-trust boundary + allowlist.
      command_type: "rescue",
      cwd: context.cwd,
      model: parsed.model ?? null,
      thinking: parsed.thinking ?? null,
      background: false,
      pid: process.pid,
      kimi_pid: null,
      status: "running",
      kimi_session_id: null,
      agent_profile: PURSUE_AGENT_PROFILE,
      prompt_digest: digestPrompt(prompt),
      summary: `[pursue] ${shorten(objective, PURSUE_SUMMARY_MAX)}`,
      phase: "starting",
      final_output_path: null,
      stream_log_path: logPath,
      error: null,
    });

    try {
      await writeInvocationLogHeader(logPath, {
        commandType: "pursue",
        kimiSessionId: "(pending)",
        cwd: context.cwd,
      });
    } catch (error) {
      const classified = new RuntimeError(
        "PURSUE_LOG_HEADER_FAILED",
        `Failed to write pursue invocation log header: ${(error as Error).message ?? String(error)}`,
        "pursue.log-header",
        error instanceof Error ? { cause: error } : undefined,
      );
      await markJobFailed(store, paths, job, classified, "Pursue failed.", { phase: "failed" });
      throw classified;
    }

    const completed = await executePursueJob(
      job.job_id,
      prompt,
      objective,
      parsed.budgetMs ?? KIMI_PURSUE_DEFAULT_BUDGET_MS,
      context,
    );
    if (!completed.final_output_path) {
      throw new RuntimeError("PURSUE_RESULT_MISSING", "Pursue finished without a rendered result.", "pursue.result");
    }
    return readArtifact(completed.final_output_path);
  } finally {
    store.close();
  }
}

async function executePursueJob(
  jobId: string,
  prompt: string,
  objective: string,
  budgetMs: number,
  context: CommandContext,
): Promise<JobRecord> {
  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);
  const store = new JobStore(paths);
  const job = store.getJob(jobId);
  if (!job) {
    store.close();
    throw new RuntimeError("JOB_NOT_FOUND", `Pursue job ${jobId} was not found.`, "pursue.worker");
  }

  // Pursue is write-capable AND autonomous — refuse without the PreToolUse hook,
  // exactly like rescue. The hook gates every tool call in every goal
  // continuation turn; without it, kimi -p auto-approves destructive ops.
  if (context.env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK !== "1") {
    const installStatus = await verifyHookInstalled(context.env);
    if (!installStatus.installed) {
      maybeWarnHookMissing(installStatus, "rescue", context.stderr);
      const classified = new RuntimeError(
        "PURSUE_HOOK_NOT_INSTALLED",
        [
          "/kimi:pursue refuses to run without the kimi-plugin-cc PreToolUse hook.",
          `Hook check failed: ${installStatus.reason ?? "unknown"}.`,
          "Run /kimi:setup, or set KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1 if you've intentionally",
          "configured an alternative safety mechanism.",
        ].join(" "),
        "pursue.hook-check",
        { details: { config_path: installStatus.configPath } },
      );
      try {
        return await markJobFailed(store, paths, job, classified, "Pursue failed.", { phase: "failed" });
      } finally {
        store.close();
      }
    }
  }

  const handlers = createCliCancellationHandlers();
  const kimi = resolveKimiCliCommand(context.env);

  try {
    store.updateRunningJob(job.job_id, { phase: "turn-running" });

    const result = await runCliPromptWithBudget(
      {
        cwd: job.cwd,
        // Enable headless goal mode for THIS spawn only (per-job env block —
        // never exported to a shell). KIMI_PLUGIN_CC_CMD=rescue is overlaid by
        // cli-client from commandLabel below so the write allowlist applies.
        env: { ...context.env, KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND: "1" },
        command: kimi.command,
        prefixArgs: kimi.prefixArgs,
        prompt,
        commandLabel: "rescue",
        model: job.model ?? undefined,
        logPath: job.stream_log_path,
        signal: handlers.signal,
      },
      budgetMs,
      "pursue.prompt",
    );

    if (handlers.cancelling) {
      throw new RuntimeError("PURSUE_CANCELLED", "Pursue cancelled by user request.", "pursue.runtime");
    }

    const goalStatus = classifyGoalExit(result.exitCode);
    // 0/3/6 are terminal goal states (complete/blocked/paused) — NOT failures.
    // Any other exit code is a real process failure; assertCliResultSuccess
    // raises the canonical aborted / CLI_NONZERO_EXIT error for it.
    if (goalStatus === "unknown") {
      assertCliResultSuccess(result, "pursue.runtime");
    }

    if (
      result.sessionId !== undefined &&
      result.sessionId.length > 0 &&
      result.sessionId !== job.kimi_session_id
    ) {
      store.updateRunningJob(job.job_id, { kimi_session_id: result.sessionId });
    }
    warnIfSessionIdMissing(result, "pursue", job.job_id, context.stderr);

    const header = renderGoalHeader(result.goalSummary, goalStatus);
    const prose = reassembleProseFromRecords(result.records);
    const finalText = `${header}\n\n---\n\n${prose}`.trimEnd();
    const rendered = renderManagedJobOutput(job, finalText);

    let artifactPath: string;
    try {
      artifactPath = await writeArtifact(paths, job, rendered.rendered);
    } catch (writeError) {
      context.stderr.write(
        `[kimi-plugin-cc] pursue artifact write failed for job ${job.job_id}; raw output preserved in error details.\n`,
      );
      const classified = new RuntimeError(
        "PURSUE_ARTIFACT_WRITE_FAILED",
        `Failed to write pursue artifact: ${(writeError as Error).message ?? String(writeError)}`,
        "pursue.artifact",
        {
          ...(writeError instanceof Error ? { cause: writeError } : {}),
          details: { rawOutput: finalText },
        },
      );
      return await markJobFailed(store, paths, job, classified, "Pursue failed.", { phase: "failed" });
    }

    if (handlers.cancelling) {
      throw new RuntimeError("PURSUE_CANCELLED", "Pursue cancelled after artifact write.", "pursue.runtime");
    }

    const goalSummaryStatus = result.goalSummary?.status ?? goalStatus;
    return (
      store.markCompleted(job.job_id, {
        summary: `[pursue:${goalSummaryStatus}] ${shorten(objective, PURSUE_SUMMARY_MAX)}`,
        phase: "done",
        final_output_path: artifactPath,
        error: null,
      }) ?? job
    );
  } catch (error) {
    if (handlers.cancelling) {
      const cancelledError = new RuntimeError(
        "PURSUE_CANCELLED",
        "Pursue cancelled by user request.",
        "pursue.runtime",
        error instanceof Error ? { cause: error } : undefined,
      );
      return await markJobCancelled(store, paths, job, "Pursue cancelled by user request.", cancelledError, {
        phase: "cancelled",
      });
    }
    const classified = classifyManagedCommandFailure(error, "rescue", job.job_id, { preserveStage: true });
    return await markJobFailed(store, paths, job, classified, "Pursue failed.", { phase: "failed" });
  } finally {
    handlers.dispose();
    store.close();
  }
}

/**
 * Soft version gate. Goal mode shipped in kimi-code 0.8.0; on an older binary
 * the experimental flag is ignored and `/goal ...` is treated as a literal
 * prompt (degraded, not dangerous). Refuse on a confirmed-too-old version;
 * a failed probe (flaky spawn) does not block — the run surfaces real errors.
 * Honors KIMI_PLUGIN_CC_SKIP_VERSION_PROBE=1 (the smoke harness sets it).
 */
async function assertGoalModeSupported(context: CommandContext): Promise<void> {
  if (context.env.KIMI_PLUGIN_CC_SKIP_VERSION_PROBE === "1") return;
  const kimi = resolveKimiCliCommand(context.env);
  const probe = await probeKimiVersion({ kimiBin: kimi.command, env: context.env });
  if (probe.kind !== "ok") return;
  const supported = probe.major > 0 || (probe.major === 0 && probe.minor >= GOAL_MODE_MIN_MINOR);
  if (!supported) {
    throw new RuntimeError(
      "PURSUE_GOAL_MODE_UNSUPPORTED",
      `/kimi:pursue needs kimi-code >= 0.${GOAL_MODE_MIN_MINOR}.0 (headless goal mode); detected ${probe.version}. Upgrade kimi-code and retry.`,
      "pursue.version-gate",
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
