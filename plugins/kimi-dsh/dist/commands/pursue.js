import { allocateJobId } from "../job-id.js";
import path from "node:path";
import { createCliCancellationHandlers } from "../cli-cancellation.js";
import { runCliPromptWithBudget } from "../cli-client.js";
import { executionPlanFromPersisted, observedExecutionFields, persistedExecutionPlanFields, prepareKimiExecutionPlan, } from "../kimi-engine.js";
import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { digestPrompt, markJobCancelled, markJobFailed, sweepStaleJobs } from "../jobs.js";
import { JobStore } from "../job-store.js";
import { classifyManagedCommandFailure } from "../kimi-errors.js";
import { KIMI_PURSUE_DEFAULT_BUDGET_MS } from "../kimi-timeouts.js";
import { writeInvocationLogHeader } from "../logging.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { parsePursueArgs } from "../parsing.js";
import { readArtifact, renderManagedJobOutput, writeArtifact } from "../render.js";
import { hookRefusalDetails, hookRefusalRetryProtocol, maybeWarnHookMissing, verifyHookInstalled, } from "../hooks/install.js";
import { assertCliResultSuccess, reassembleProseFromRecords, warnIfSessionIdMissing, warnHookEscapes } from "./cli-helpers.js";
import { buildKimiSessionTitle, syncKimiSessionTitle } from "../session-title.js";
// /kimi:pursue — experimental autonomous goal mode (kimi-code 0.8.0+).
// Runtime-foreground-only, with a mandatory finite wall-clock budget. No resume:
// goalId is distinct from sessionId. Rescue lineage and the "rescue" hook label
// apply the workspace write allowlist on every continuation turn, and the hook
// is mandatory. Status, result, and cancellation use the same rescue lineage.
const PURSUE_SUMMARY_MAX = 120;
const PURSUE_AGENT_PROFILE = "<goal-mode>";
/**
 * Goal-terminal exits (3 = blocked, 6 = paused) are NOT failures, so
 * `assertCliResultSuccess` never runs for them — which means a native-v2 plan
 * whose child exited 3/6 emitting nothing would otherwise resolve with an
 * empty artifact and unproven provenance (cli-client enforces marker-first on
 * every emitted line and on a clean exit, but not on a silent non-zero exit).
 * Require the marker on every non-aborted goal-terminal result of a v2 plan.
 * (Kimi second-round finding 2.)
 */
export function assertGoalRunProvenance(plan, result) {
    if (plan.intendedEngine !== "native-v2" || result.aborted || result.systemVersion !== undefined) {
        return;
    }
    throw new RuntimeError("CLI_ENGINE_PROVENANCE_MISMATCH", `Refusing pursue result: the execution plan required native-v2, but the child exited ${String(result.exitCode)} without the system.version marker, so the engine that ran cannot be established.`, "pursue.provenance", {
        details: {
            operation_kind: "pursue",
            intended_engine: "native-v2",
            observed_engine: result.observedEngine ?? null,
            exit_code: result.exitCode,
            retryable_after_setup: false,
        },
    });
}
/**
 * Map a headless goal-mode exit code to a terminal status. complete=0 is
 * success; blocked=3 and paused=6 are terminal non-failures; anything else is
 * a genuine process failure. Source:
 * apps/kimi-code/src/cli/goal-prompt.ts::GOAL_EXIT_CODES.
 */
export function classifyGoalExit(exitCode) {
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
 * argv/env to set a hard turn budget). The hard bound is always the
 * wall-clock AbortController; goal budget mutation is not authorized.
 */
export function buildGoalPrompt(objective, turns) {
    const trimmed = objective.trim().split(/\s+/).join(" ");
    const turnHint = turns !== undefined
        ? ` The plugin owns the outer wall-clock budget; do not call SetGoalBudget. Stop after at most ${turns} turns (soft instruction). Unfinished work at the soft stop is not completion.`
        : "";
    if (trimmed.length + turnHint.length > 4_000) {
        throw new RuntimeError("INVALID_ARGS", turns === undefined
            ? "pursue objective exceeds Kimi's 4000-character goal limit; shorten the objective."
            : "pursue objective plus --turns guidance exceeds Kimi's 4000-character goal limit; shorten the objective or omit --turns.", "pursue.parse");
    }
    return `/goal -- ${trimmed}${turnHint}`;
}
function renderGoalHeader(summary, exitStatus) {
    const status = summary?.status ?? exitStatus;
    const lines = [`**Goal status:** ${status}`];
    if (summary?.reason) {
        lines.push(`**Reason:** ${summary.reason}`);
    }
    const metrics = [];
    if (summary?.turnsUsed != null)
        metrics.push(`turns: ${summary.turnsUsed}`);
    if (summary?.tokensUsed != null)
        metrics.push(`tokens: ${summary.tokensUsed}`);
    if (summary?.wallClockMs != null) {
        metrics.push(`wall-clock: ${Math.round(summary.wallClockMs / 1000)}s`);
    }
    if (metrics.length > 0) {
        lines.push(`**Usage:** ${metrics.join(", ")}`);
    }
    if (summary?.goalId) {
        lines.push(`**Goal id:** \`${summary.goalId}\` (resume is not yet exposed for /kimi:pursue — see docs/safety.md)`);
    }
    return lines.join("\n");
}
export async function runPursue(argv, context) {
    const parsed = parsePursueArgs(argv);
    const objective = parsed.objective?.trim();
    if (!objective) {
        throw new RuntimeError("INVALID_ARGS", "/kimi:pursue requires an objective. Usage: /kimi:pursue [--budget 30m] [--turns N] [-m model] <objective>", "pursue.parse");
    }
    const paths = resolvePluginPaths(context.env);
    await ensurePluginPaths(paths);
    const repoIdentity = await resolveRepoIdentity(context.cwd);
    const store = new JobStore(paths);
    try {
        await sweepStaleJobs(store, paths);
        const executionPlan = await prepareKimiExecutionPlan({
            operationKind: "pursue",
            cwd: context.cwd,
            env: context.env,
        });
        const prompt = buildGoalPrompt(objective, parsed.turns);
        const jobId = allocateJobId(context);
        const logPath = path.join(paths.logsDir, `pursue-${jobId}.jsonl`);
        const job = store.createJob({
            job_id: jobId,
            repo_id: repoIdentity.repoId,
            // Reuse the rescue lineage: same write-trust boundary + allowlist.
            command_type: "rescue",
            cwd: context.cwd,
            model: parsed.model ?? null,
            thinking: null,
            thinking_effort: parsed.thinkingEffort ?? null,
            background: false,
            budget_ms: parsed.budgetMs ?? KIMI_PURSUE_DEFAULT_BUDGET_MS,
            budget_source: parsed.budgetMs !== undefined ? "explicit" : "default",
            pid: process.pid,
            kimi_pid: null,
            status: "running",
            kimi_session_id: null,
            ...persistedExecutionPlanFields(executionPlan),
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
        }
        catch (error) {
            const classified = new RuntimeError("PURSUE_LOG_HEADER_FAILED", `Failed to write pursue invocation log header: ${error.message ?? String(error)}`, "pursue.log-header", error instanceof Error ? { cause: error } : undefined);
            await markJobFailed(store, paths, job, classified, "Pursue failed.", { phase: "failed" });
            throw classified;
        }
        const completed = await executePursueJob(job.job_id, prompt, objective, job.budget_ms, context);
        if (!completed.final_output_path) {
            throw new RuntimeError("PURSUE_RESULT_MISSING", "Pursue finished without a rendered result.", "pursue.result");
        }
        return readArtifact(completed.final_output_path);
    }
    finally {
        store.close();
    }
}
async function executePursueJob(jobId, prompt, objective, budgetMs, context) {
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
            const classified = new RuntimeError("PURSUE_HOOK_NOT_INSTALLED", [
                "/kimi:pursue refuses to run without the kimi-plugin-cc PreToolUse hook.",
                `Hook check failed: ${installStatus.reason ?? "unknown"}.`,
                "Repair by running Claude Code /kimi:setup or Codex $kimi-setup, then retry.",
                "KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1 is only for deliberate tests or diagnostics.",
                hookRefusalRetryProtocol(context.env),
            ].join(" "), "pursue.hook-check", { details: hookRefusalDetails(installStatus) });
            try {
                return await markJobFailed(store, paths, job, classified, "Pursue failed.", { phase: "failed" });
            }
            finally {
                store.close();
            }
        }
    }
    const handlers = createCliCancellationHandlers();
    try {
        const executionPlan = executionPlanFromPersisted(job);
        store.updateRunningJob(job.job_id, { phase: "turn-running" });
        const result = await runCliPromptWithBudget({
            cwd: job.cwd,
            // Enable headless goal mode for THIS spawn only (per-job env block —
            // never exported to a shell). KIMI_PLUGIN_CC_CMD=rescue is overlaid by
            // cli-client from commandLabel below so the write allowlist applies.
            // The env flag gates goal mode on kimi-code 0.8–0.11; 0.12.0 removed the
            // gate (PR #569) so it is now redundant there but harmless — unknown
            // experimental flag ids resolve to undefined and never error. Kept for
            // 0.8–0.11 compat. The /goal prompt prefix (buildGoalPrompt) is the
            // actual trigger on every supported version.
            env: { ...context.env, KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND: "1" },
            command: executionPlan.command,
            prefixArgs: [...executionPlan.prefixArgs],
            executionPlan,
            prompt,
            commandLabel: "rescue",
            trustedWorkspaceRoot: job.cwd,
            model: job.model ?? undefined,
            thinkingEffort: job.thinking_effort ?? undefined,
            logPath: job.stream_log_path,
            onSpawn: (pid) => { store.updateRunningJob(job.job_id, { kimi_pid: pid }); },
            signal: handlers.signal,
        }, budgetMs, "pursue.prompt");
        store.updateRunningJob(job.job_id, observedExecutionFields(result));
        warnHookEscapes(result, "pursue", context.stderr);
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
        assertGoalRunProvenance(executionPlan, result);
        if (result.sessionId !== undefined &&
            result.sessionId.length > 0 &&
            result.sessionId !== job.kimi_session_id) {
            store.updateRunningJob(job.job_id, { kimi_session_id_source: "announced", kimi_session_id: result.sessionId });
        }
        await syncKimiSessionTitle({
            promptText: objective,
            env: context.env,
            cwd: job.cwd,
            sessionId: result.sessionId ?? job.kimi_session_id,
            title: buildKimiSessionTitle("pursue", objective),
            stderr: context.stderr,
        });
        warnIfSessionIdMissing(result, "pursue", job.job_id, context.stderr);
        const header = renderGoalHeader(result.goalSummary, goalStatus);
        const prose = reassembleProseFromRecords(result.records);
        const finalText = `${header}\n\n---\n\n${prose}`.trimEnd();
        const rendered = renderManagedJobOutput(job, finalText);
        let artifactPath;
        try {
            artifactPath = await writeArtifact(paths, job, rendered.rendered);
        }
        catch (writeError) {
            context.stderr.write(`[kimi-plugin-cc] pursue artifact write failed for job ${job.job_id}; raw output preserved in error details.\n`);
            const classified = new RuntimeError("PURSUE_ARTIFACT_WRITE_FAILED", `Failed to write pursue artifact: ${writeError.message ?? String(writeError)}`, "pursue.artifact", {
                ...(writeError instanceof Error ? { cause: writeError } : {}),
                details: { rawOutput: finalText },
            });
            return await markJobFailed(store, paths, job, classified, "Pursue failed.", { phase: "failed" });
        }
        if (handlers.cancelling) {
            throw new RuntimeError("PURSUE_CANCELLED", "Pursue cancelled after artifact write.", "pursue.runtime");
        }
        const goalSummaryStatus = result.goalSummary?.status ?? goalStatus;
        return (store.markCompleted(job.job_id, {
            summary: `[pursue:${goalSummaryStatus}] ${shorten(objective, PURSUE_SUMMARY_MAX)}`,
            phase: "done",
            final_output_path: artifactPath,
            error: null,
        }) ?? job);
    }
    catch (error) {
        if (handlers.cancelling) {
            const cancelledError = new RuntimeError("PURSUE_CANCELLED", "Pursue cancelled by user request.", "pursue.runtime", error instanceof Error ? { cause: error } : undefined);
            return await markJobCancelled(store, paths, job, "Pursue cancelled by user request.", cancelledError, {
                phase: "cancelled",
            });
        }
        const classified = classifyManagedCommandFailure(error, "rescue", job.job_id, { preserveStage: true });
        return await markJobFailed(store, paths, job, classified, "Pursue failed.", { phase: "failed" });
    }
    finally {
        handlers.dispose();
        store.close();
    }
}
function shorten(text, max) {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= max) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
