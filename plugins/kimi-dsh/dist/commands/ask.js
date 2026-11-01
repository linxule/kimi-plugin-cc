import { companionHelp } from "../help.js";
import { allocateJobId } from "../job-id.js";
import path from "node:path";
import { createCliCancellationHandlers } from "../cli-cancellation.js";
import { runCliPromptWithBudget } from "../cli-client.js";
import { assertPersistedResumeLineage, executionPlanFromPersisted, observedExecutionFields, persistedExecutionPlanFields, prepareKimiExecutionPlan, reconcileHistoricalJobProvenance, } from "../kimi-engine.js";
import { getManagedCommandConfig } from "./registry.js";
import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { digestPrompt, markJobCancelled, markJobFailed, sweepStaleJobs } from "../jobs.js";
import { JobStore } from "../job-store.js";
import { KIMI_ASK_PROMPT_TIMEOUT_MS } from "../kimi-timeouts.js";
import { writeInvocationLogHeader } from "../logging.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { parseAskArgs } from "../parsing.js";
import { readArtifact, renderManagedJobOutput, writeArtifact } from "../render.js";
import { classifyManagedCommandFailure } from "../kimi-errors.js";
import { startBackgroundJob } from "../background-spawn.js";
import { hookRefusalDetails, hookRefusalRetryProtocol, maybeWarnHookMissing, verifyHookInstalled, } from "../hooks/install.js";
import { warnInheritedBudget, captureTimeoutPartialOutput, assertCliResultSuccess, reassembleProseFromRecords, warnIfSessionIdMissing, warnHookEscapes } from "./cli-helpers.js";
import { buildKimiSessionTitle, syncKimiSessionTitle } from "../session-title.js";
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
export async function runAsk(argv, context) {
    const parsed = parseAskArgs(argv);
    if (parsed.help)
        return companionHelp(["ask", ...argv]);
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
        const sessionResolution = await resolveAskSession(store, repoIdentity.repoId, parsed.fresh, parsed.resume, parsed.resumeTarget);
        const askPrompt = buildAskPrompt(parsed.prompt, sessionResolution.reusedSession);
        const executionPlan = await prepareKimiExecutionPlan({
            operationKind: "ask",
            cwd: context.cwd,
            env: context.env,
            resumedFromJobId: sessionResolution.resumedFromJobId,
            resumeSessionId: sessionResolution.kimiSessionId ?? undefined,
            resumeSource: sessionResolution.sourceJob,
        });
        const logPath = path.join(paths.logsDir, `ask-${jobId}.jsonl`);
        const job = store.createJob({
            job_id: jobId,
            repo_id: repoIdentity.repoId,
            command_type: "ask",
            cwd: context.cwd,
            model: parsed.model ?? null,
            thinking: null,
            thinking_effort: parsed.thinkingEffort ?? null,
            background: parsed.background,
            budget_ms: parsed.budgetMs ?? (sessionResolution.sourceJob?.operation_kind === "ask" ? sessionResolution.sourceJob.budget_ms : null) ?? null,
            budget_source: parsed.budgetMs !== undefined ? "explicit"
                : sessionResolution.sourceJob?.operation_kind === "ask" && sessionResolution.sourceJob.budget_ms !== null ? "inherited" : "default",
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
        }
        catch (error) {
            const classified = new RuntimeError("ASK_LOG_HEADER_FAILED", `Failed to write ask invocation log header: ${error.message ?? String(error)}`, "ask.log-header", error instanceof Error ? { cause: error } : undefined);
            await markJobFailed(store, paths, job, classified, askConfig.cancellation.failedSummary, { phase: "failed" });
            throw classified;
        }
        warnInheritedBudget(job, context.stderr);
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
    }
    finally {
        store.close();
    }
}
export async function executeAskJob(jobId, prompt, context, options) {
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
    let handlers;
    try {
        // Re-verify in the worker so a background job cannot outlive or bypass
        // enforcement drift between the user invocation and the actual Kimi spawn.
        if (context.env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK !== "1") {
            await requireAskHookInstalled(context);
        }
        handlers = createCliCancellationHandlers();
        const executionPlan = executionPlanFromPersisted(job);
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
        const result = await runCliPromptWithBudget({
            cwd: job.cwd,
            env: context.env,
            command: executionPlan.command,
            prefixArgs: [...executionPlan.prefixArgs],
            executionPlan,
            prompt,
            commandLabel: "ask",
            model: job.model ?? undefined,
            thinkingEffort: job.thinking_effort ?? undefined,
            resumeSessionId: job.kimi_session_id ?? undefined,
            logPath: job.stream_log_path,
            onSpawn: (pid) => { store.updateRunningJob(job.job_id, { kimi_pid: pid }); },
            signal: handlers.signal,
        }, job.budget_ms ?? KIMI_ASK_PROMPT_TIMEOUT_MS, "ask.prompt");
        store.updateRunningJob(job.job_id, observedExecutionFields(result));
        if (handlers.cancelling) {
            throw new RuntimeError(cancel.errorCodes.cancelled, cancel.cancelMessages.afterPrompt, "ask.runtime");
        }
        assertCliResultSuccess(result, "ask.runtime");
        warnHookEscapes(result, "ask", context.stderr);
        // Persist whichever session id kimi actually announced. For fresh
        // sessions this is the only chance to record it. For resumed
        // sessions it should match the input, but capture anyway in case
        // kimi-code mints a new id on each turn.
        if (result.sessionId !== undefined &&
            result.sessionId.length > 0) {
            // Never persist an empty ID because NULL represents a missing session ID.
            store.updateRunningJob(job.job_id, { kimi_session_id_source: "announced", kimi_session_id: result.sessionId });
        }
        await syncKimiSessionTitle({
            promptText: prompt,
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
            throw new RuntimeError(cancel.errorCodes.cancelled, cancel.cancelMessages.afterArtifact, "ask.runtime");
        }
        return (store.markCompleted(job.job_id, {
            summary: rendered.summary,
            phase: "done",
            final_output_path: artifactPath,
            error: null,
        }) ?? job);
    }
    catch (error) {
        const classified = error instanceof RuntimeError && error.stage === "ask.hook-check" ? error
            : classifyManagedCommandFailure(error, "ask", job.job_id, { background: job.background, budgetMs: job.budget_ms ?? KIMI_ASK_PROMPT_TIMEOUT_MS });
        const partialOutput = await captureTimeoutPartialOutput(classified, store, job, context.env, handlers?.signal);
        if (handlers?.cancelling) {
            const cancelledError = new RuntimeError(cancel.errorCodes.cancelled, cancel.cancelMessages.default, "ask.runtime", error instanceof Error ? { cause: error } : undefined);
            return await markJobCancelled(store, paths, job, cancel.cancelledSummary, cancelledError, { phase: "cancelled" });
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
    }
    finally {
        handlers?.dispose();
        store.close();
    }
}
async function requireAskHookInstalled(context) {
    if (context.env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK === "1") {
        return;
    }
    const installStatus = await verifyHookInstalled(context.env);
    if (installStatus.installed) {
        return;
    }
    maybeWarnHookMissing(installStatus, "ask", context.stderr);
    throw new RuntimeError("ASK_HOOK_NOT_INSTALLED", [
        "ask refuses to run without the canonical kimi-plugin-cc PreToolUse hook.",
        `Hook check failed: ${installStatus.reason ?? "unknown"}.`,
        "Run /kimi:setup or $kimi-setup to install or repair this host's managed block.",
        "Set KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1 only if you intentionally accept un-enforced execution.",
        hookRefusalRetryProtocol(context.env),
    ].join(" "), "ask.hook-check", { details: hookRefusalDetails(installStatus) });
}
async function resolveAskSession(store, repoId, fresh, resume, resumeTarget) {
    if (fresh) {
        return { kimiSessionId: null, reusedSession: false, resumedFromJobId: null, sourceJob: null };
    }
    if (resumeTarget) {
        const byJob = store.getJob(resumeTarget);
        const scoped = byJob?.repo_id === repoId && byJob.command_type === "ask" ? byJob : null;
        const exact = scoped ?? store.findAskJobBySession(repoId, resumeTarget);
        if (!exact) {
            throw new RuntimeError("ASK_RESUME_NOT_FOUND", `No ask job or session matched ${resumeTarget}.`, "ask.resume");
        }
        // Order matters: surface ASK_ALREADY_RUNNING before complaining that
        // the session id is missing. In v1.0 a running ask row carries
        // kimi_session_id=NULL (kimi-code assigns the id post-call), so the
        // legacy "no session id → not found" check would mask the more
        // accurate "already running" error.
        const source = await reconcileHistoricalJobProvenance(store, exact);
        ensureAskSessionIsNotRunning(source);
        if (!source.kimi_session_id) {
            throw new RuntimeError("ASK_RESUME_NOT_FOUND", `No ask job or session matched ${resumeTarget}.`, "ask.resume");
        }
        return {
            kimiSessionId: source.kimi_session_id,
            reusedSession: true,
            resumedFromJobId: source.job_id,
            sourceJob: source,
        };
    }
    if (resume) {
        const latest = store.findLatestJob({ repoId, commandType: "ask" });
        if (!latest) {
            throw new RuntimeError("ASK_RESUME_NOT_FOUND", "No prior ask session exists for this repository.", "ask.resume");
        }
        const source = await reconcileHistoricalJobProvenance(store, latest);
        ensureAskSessionIsNotRunning(source);
        if (!source.kimi_session_id) {
            throw new RuntimeError("ASK_RESUME_NOT_FOUND", "No prior ask session exists for this repository.", "ask.resume");
        }
        return {
            kimiSessionId: source.kimi_session_id,
            reusedSession: true,
            resumedFromJobId: source.job_id,
            sourceJob: source,
        };
    }
    return { kimiSessionId: null, reusedSession: false, resumedFromJobId: null, sourceJob: null };
}
function ensureAskSessionIsNotRunning(job) {
    if (job.status === "running") {
        throw new RuntimeError("ASK_ALREADY_RUNNING", `Ask session ${job.kimi_session_id ?? "<unknown>"} is already active under job ${job.job_id}.`, "ask.resume");
    }
}
function buildAskPrompt(question, reusedSession) {
    if (question?.trim()) {
        return ASK_PROMPT_PREFIX + question.trim();
    }
    if (reusedSession) {
        return ASK_RESUME_PROMPT;
    }
    throw new RuntimeError("INVALID_ARGS", "ask requires a question after the flags.", "ask.parse");
}
function askPromptSubject(prompt) {
    if (prompt.startsWith(ASK_PROMPT_PREFIX))
        return prompt.slice(ASK_PROMPT_PREFIX.length);
    return prompt === ASK_RESUME_PROMPT ? ASK_CONTINUE_TASK : prompt;
}
function shorten(text, max) {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= max) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
