import { randomUUID } from "node:crypto";
import path from "node:path";
import { createCliCancellationHandlers } from "../cli-cancellation.js";
import { runCliPromptWithBudget } from "../cli-client.js";
import { resolveKimiCliCommand } from "../kimi-command.js";
import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { digestPrompt, markJobCancelled, markJobFailed, sweepStaleJobs } from "../jobs.js";
import { JobStore } from "../job-store.js";
import { classifyManagedCommandFailure } from "../kimi-errors.js";
import { KIMI_SWARM_DEFAULT_BUDGET_MS } from "../kimi-timeouts.js";
import { probeKimiVersion } from "../kimi-version-probe.js";
import { writeInvocationLogHeader } from "../logging.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { parseSwarmArgs } from "../parsing.js";
import { readArtifact, renderManagedJobOutput, writeArtifact } from "../render.js";
import { maybeWarnHookMissing, verifyHookInstalled } from "../hooks/install.js";
import { assertCliResultSuccess, reassembleProseFromRecords, warnIfSessionIdMissing } from "./cli-helpers.js";
// /kimi:swarm — READ-ONLY parallel fan-out (kimi-code 0.12.0 AgentSwarm tool).
//
// PROTOTYPE SCOPE (v1.2). The lowest-risk swarm shape: parallel review/analysis
// over N targets, with NO write surface. Deliberately narrow:
//   - FOREGROUND ONLY. No --background/--detach. A hard wall-clock budget
//     (--budget) bounds the whole run. Two distinct subagent bounds: --cap is a
//     SOFT total-count hint injected into the prompt, and --max-concurrency is a
//     HARD ceiling on how many subagents run AT ONCE via
//     KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY on kimi-code 0.18.0+ (PR #888; older
//     binaries ignore the unknown env var).
//   - READ-ONLY. The PreToolUse hook runs under the "swarm" label, which
//     allowlists the read-only tool set PLUS the AgentSwarm tool. Every
//     subagent inherits that label and fires the SAME hook at policy index 0
//     (kimi-code createPermissionDecisionPolicies puts the hook at index 0 for
//     ALL agents — verified against 0.12.0), so a subagent's Write/Edit/Bash is
//     denied exactly like a single-turn review's.
//   - Reuses the REVIEW job lineage (command_type "review") so /kimi:status /
//     /kimi:result / /kimi:cancel work unchanged. The hook label ("swarm") is
//     independent of the job lineage — mirrors how /kimi:pursue reuses the
//     rescue lineage with its own label. Promoting swarm to a first-class
//     command_type is a follow-up.
//
// SAFETY — why swarm REFUSES without the hook (unlike single-turn review):
//   review/challenge/ask only WARN if the hook is missing (degraded enforcement
//   on ONE agent). A swarm fans out up to `cap` subagents, each capable of
//   attempting writes; without the index-0 hook there is ZERO enforcement on
//   ALL of them — an N-fold blast radius. So swarm fail-CLOSES (refuses) like
//   rescue/pursue. The KIMI_PLUGIN_CC_SKIP_HOOK_CHECK escape hatch remains.
/** kimi-code minor that introduced the AgentSwarm tool (#424, 0.12.0). */
const SWARM_MIN_MINOR = 12;
const SWARM_SUMMARY_MAX = 120;
const SWARM_AGENT_PROFILE = "<swarm>";
/**
 * Build the swarm coordination prompt. Instructs Kimi to use the AgentSwarm
 * tool to fan READ-ONLY review work over the targets implied by the objective,
 * then consolidate. The optional `cap` is a SOFT subagent-count hint (the hook
 * cannot enforce a count, so the model may exceed it). The HARD concurrency
 * ceiling is separate: --max-concurrency → KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY
 * (see executeSwarmJob / cli-client buildEnv). The --budget wall-clock ceiling
 * is the always-on hard bound on the whole run regardless of kimi-code version.
 */
export function buildSwarmPrompt(objective, cap) {
    const trimmed = objective.trim();
    const capClause = cap !== undefined
        ? `Launch at most ${cap} subagents (soft cap — split or group targets to stay within it).`
        : "Launch one subagent per distinct target; group related targets if there are many.";
    return [
        "Coordinate a READ-ONLY parallel review using the AgentSwarm tool.",
        "",
        `Objective: ${trimmed}`,
        "",
        "Use the AgentSwarm tool to fan the work out across subagents (it requires at least 2",
        'items). Set subagent_type to "explore" — a read-only exploration profile that has no',
        "file-editing tools at all (defense-in-depth on top of the safety hook). Give each subagent",
        "a distinct target (a file, module, directory, or question) via the prompt_template + items.",
        capClause,
        "Each subagent must inspect the workspace using read tools only (Read, Grep, Glob) and",
        "must NOT write, edit, run shell commands, or mutate anything. This is a read-only command,",
        "so the safety hook denies any write/edit/shell/web tool call — instruct subagents to report",
        "findings rather than attempt fixes, and to rely on Read/Grep/Glob.",
        "",
        "After the subagents return, consolidate their findings into a single markdown report:",
        "a short verdict line, a brief summary, then one section per target with file:line references.",
        "Return plain markdown — no JSON wrapper, no outer code fences.",
    ].join("\n");
}
export async function runSwarm(argv, context) {
    const parsed = parseSwarmArgs(argv);
    const objective = parsed.objective?.trim();
    if (!objective) {
        throw new RuntimeError("INVALID_ARGS", "/kimi:swarm requires an objective. Usage: /kimi:swarm [--budget 30m] [--cap N] [--max-concurrency N] [-m model] <what to review across the workspace>", "swarm.parse");
    }
    const paths = resolvePluginPaths(context.env);
    await ensurePluginPaths(paths);
    const repoIdentity = await resolveRepoIdentity(context.cwd);
    const store = new JobStore(paths);
    try {
        await sweepStaleJobs(store, paths);
        await assertSwarmSupported(context);
        const prompt = buildSwarmPrompt(objective, parsed.cap);
        const jobId = randomUUID();
        const logPath = path.join(paths.logsDir, `swarm-${jobId}.jsonl`);
        const job = store.createJob({
            job_id: jobId,
            repo_id: repoIdentity.repoId,
            // Reuse the read-only review lineage; the hook label below ("swarm") is
            // what actually drives the allowlist.
            command_type: "review",
            cwd: context.cwd,
            model: parsed.model ?? null,
            thinking: parsed.thinking ?? null,
            background: false,
            pid: process.pid,
            kimi_pid: null,
            status: "running",
            kimi_session_id: null,
            agent_profile: SWARM_AGENT_PROFILE,
            prompt_digest: digestPrompt(prompt),
            summary: `[swarm] ${shorten(objective, SWARM_SUMMARY_MAX)}`,
            phase: "starting",
            final_output_path: null,
            stream_log_path: logPath,
            error: null,
        });
        try {
            await writeInvocationLogHeader(logPath, {
                commandType: "swarm",
                kimiSessionId: "(pending)",
                cwd: context.cwd,
            });
        }
        catch (error) {
            const classified = new RuntimeError("SWARM_LOG_HEADER_FAILED", `Failed to write swarm invocation log header: ${error.message ?? String(error)}`, "swarm.log-header", error instanceof Error ? { cause: error } : undefined);
            await markJobFailed(store, paths, job, classified, "Swarm failed.", { phase: "failed" });
            throw classified;
        }
        const completed = await executeSwarmJob(job.job_id, prompt, objective, parsed.budgetMs ?? KIMI_SWARM_DEFAULT_BUDGET_MS, parsed.maxConcurrency, context);
        if (!completed.final_output_path) {
            throw new RuntimeError("SWARM_RESULT_MISSING", "Swarm finished without a rendered result.", "swarm.result");
        }
        return readArtifact(completed.final_output_path);
    }
    finally {
        store.close();
    }
}
async function executeSwarmJob(jobId, prompt, objective, budgetMs, maxConcurrency, context) {
    const paths = resolvePluginPaths(context.env);
    await ensurePluginPaths(paths);
    const store = new JobStore(paths);
    const job = store.getJob(jobId);
    if (!job) {
        store.close();
        throw new RuntimeError("JOB_NOT_FOUND", `Swarm job ${jobId} was not found.`, "swarm.worker");
    }
    // Swarm is read-only BY POLICY, but it fans out N subagents — without the
    // PreToolUse hook there is no enforcement on ANY of them. Unlike single-turn
    // review (which only warns), swarm fail-CLOSES: refuse without the hook.
    if (context.env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK !== "1") {
        const installStatus = await verifyHookInstalled(context.env);
        if (!installStatus.installed) {
            maybeWarnHookMissing(installStatus, "swarm", context.stderr);
            const classified = new RuntimeError("SWARM_HOOK_NOT_INSTALLED", [
                "/kimi:swarm refuses to run without the kimi-plugin-cc PreToolUse hook.",
                "Swarm fans out multiple subagents; the hook is the ONLY thing keeping every",
                "one of them read-only, so a missing hook means no enforcement across the fan-out.",
                `Hook check failed: ${installStatus.reason ?? "unknown"}.`,
                "Run /kimi:setup, or set KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1 if you've intentionally",
                "configured an alternative safety mechanism.",
            ].join(" "), "swarm.hook-check", { details: { config_path: installStatus.configPath } });
            try {
                return await markJobFailed(store, paths, job, classified, "Swarm failed.", { phase: "failed" });
            }
            finally {
                store.close();
            }
        }
    }
    const handlers = createCliCancellationHandlers();
    const kimi = resolveKimiCliCommand(context.env);
    try {
        store.updateRunningJob(job.job_id, { phase: "turn-running" });
        const result = await runCliPromptWithBudget({
            cwd: job.cwd,
            env: context.env,
            command: kimi.command,
            prefixArgs: kimi.prefixArgs,
            prompt,
            // The "swarm" label drives the read-only-plus-AgentSwarm allowlist in
            // the PreToolUse hook, for the coordinator AND every spawned subagent.
            commandLabel: "swarm",
            // --max-concurrency is the HARD concurrency ceiling on kimi-code 0.18.0+
            // (exported as KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY); ignored by older
            // binaries. Distinct from --cap (the soft total-count prompt hint).
            swarmMaxConcurrency: maxConcurrency,
            model: job.model ?? undefined,
            logPath: job.stream_log_path,
            signal: handlers.signal,
        }, budgetMs, "swarm.prompt");
        if (handlers.cancelling) {
            throw new RuntimeError("SWARM_CANCELLED", "Swarm cancelled by user request.", "swarm.runtime");
        }
        assertCliResultSuccess(result, "swarm.runtime");
        if (result.sessionId !== undefined &&
            result.sessionId.length > 0 &&
            result.sessionId !== job.kimi_session_id) {
            store.updateRunningJob(job.job_id, { kimi_session_id: result.sessionId });
        }
        warnIfSessionIdMissing(result, "swarm", job.job_id, context.stderr);
        const finalText = reassembleProseFromRecords(result.records);
        const rendered = renderManagedJobOutput(job, finalText);
        let artifactPath;
        try {
            artifactPath = await writeArtifact(paths, job, rendered.rendered);
        }
        catch (writeError) {
            context.stderr.write(`[kimi-plugin-cc] swarm artifact write failed for job ${job.job_id}; raw output preserved in error details.\n`);
            const classified = new RuntimeError("SWARM_ARTIFACT_WRITE_FAILED", `Failed to write swarm artifact: ${writeError.message ?? String(writeError)}`, "swarm.artifact", {
                ...(writeError instanceof Error ? { cause: writeError } : {}),
                details: { rawOutput: finalText },
            });
            return await markJobFailed(store, paths, job, classified, "Swarm failed.", { phase: "failed" });
        }
        if (handlers.cancelling) {
            throw new RuntimeError("SWARM_CANCELLED", "Swarm cancelled after artifact write.", "swarm.runtime");
        }
        return (store.markCompleted(job.job_id, {
            summary: `[swarm] ${shorten(objective, SWARM_SUMMARY_MAX)}`,
            phase: "done",
            final_output_path: artifactPath,
            error: null,
        }) ?? job);
    }
    catch (error) {
        if (handlers.cancelling) {
            const cancelledError = new RuntimeError("SWARM_CANCELLED", "Swarm cancelled by user request.", "swarm.runtime", error instanceof Error ? { cause: error } : undefined);
            return await markJobCancelled(store, paths, job, "Swarm cancelled by user request.", cancelledError, {
                phase: "cancelled",
            });
        }
        const classified = classifyManagedCommandFailure(error, "review", job.job_id, { preserveStage: true });
        return await markJobFailed(store, paths, job, classified, "Swarm failed.", { phase: "failed" });
    }
    finally {
        handlers.dispose();
        store.close();
    }
}
/**
 * Soft version gate. The AgentSwarm tool shipped in kimi-code 0.12.0; on an
 * older binary the tool does not exist and the coordinator's AgentSwarm call
 * fails inside kimi (degraded, not dangerous — the read-only hook still holds).
 * Refuse on a confirmed-too-old version; a failed probe (flaky spawn) does not
 * block. Honors KIMI_PLUGIN_CC_SKIP_VERSION_PROBE=1 (the smoke harness sets it).
 */
async function assertSwarmSupported(context) {
    if (context.env.KIMI_PLUGIN_CC_SKIP_VERSION_PROBE === "1")
        return;
    const kimi = resolveKimiCliCommand(context.env);
    const probe = await probeKimiVersion({ kimiBin: kimi.command, env: context.env });
    if (probe.kind !== "ok")
        return;
    const supported = probe.major > 0 || (probe.major === 0 && probe.minor >= SWARM_MIN_MINOR);
    if (!supported) {
        throw new RuntimeError("SWARM_UNSUPPORTED", `/kimi:swarm needs kimi-code >= 0.${SWARM_MIN_MINOR}.0 (the AgentSwarm tool); detected ${probe.version}. Upgrade kimi-code and retry.`, "swarm.version-gate");
    }
}
function shorten(text, max) {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= max) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
