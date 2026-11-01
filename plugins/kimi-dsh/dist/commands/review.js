import { allocateJobId } from "../job-id.js";
import path from "node:path";
import process from "node:process";
import { createCliCancellationHandlers } from "../cli-cancellation.js";
import { runCliPromptWithBudget } from "../cli-client.js";
import { observedExecutionFields, persistedExecutionPlanFields, prepareKimiExecutionPlan, } from "../kimi-engine.js";
import { getManagedCommandConfig } from "./registry.js";
import { collectReviewContext } from "../git.js";
import { digestPrompt, markJobCancelled, markJobFailed } from "../jobs.js";
import { JobStore } from "../job-store.js";
import { classifyManagedCommandFailure } from "../kimi-errors.js";
import { KIMI_REVIEW_PROMPT_TIMEOUT_MS } from "../kimi-timeouts.js";
import { writeInvocationLogHeader } from "../logging.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { parseReviewArgs } from "../parsing.js";
import { renderManagedJobOutput, writeArtifact } from "../render.js";
import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { hookRefusalDetails, hookRefusalRetryProtocol, maybeWarnHookMissing, verifyHookInstalled, } from "../hooks/install.js";
import { captureTimeoutPartialOutput, assertCliResultSuccess, reassembleProseFromRecords, warnIfSessionIdMissing, warnHookEscapes } from "./cli-helpers.js";
import { buildKimiSessionTitle, syncKimiSessionTitle } from "../session-title.js";
const REVIEW_AGENT_PROFILE_PLACEHOLDER = "<cli-client>";
export async function runReview(argv, context, commandType) {
    const parsed = parseReviewArgs(argv, commandType);
    if (parsed.background || parsed.wait) {
        throw new RuntimeError("INVALID_FLAGS", `${commandType} does not support --background or --wait in v1; review runs foreground-synchronously.`, `${commandType}.parse`);
    }
    if (context.env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK !== "1") {
        await requireReadOnlyHookInstalled(context, commandType);
    }
    const reviewContext = await collectReviewContext(context.cwd, parsed.base);
    const paths = resolvePluginPaths(context.env);
    await ensurePluginPaths(paths);
    const repoIdentity = await resolveRepoIdentity(context.cwd);
    const executionPlan = await prepareKimiExecutionPlan({
        operationKind: commandType,
        cwd: context.cwd,
        env: context.env,
    });
    const store = new JobStore(paths);
    const jobId = allocateJobId(context);
    // Leave kimi_session_id NULL until kimi announces an actual ID; never invent
    // one that no on-disk session matches.
    const reviewSessionId = null;
    const logPath = path.join(paths.logsDir, `${commandType}-${jobId}.jsonl`);
    const previewPrompt = buildReviewPrompt(commandType, reviewContext, parsed.focus);
    const job = store.createJob({
        job_id: jobId,
        repo_id: repoIdentity.repoId,
        command_type: commandType,
        cwd: context.cwd,
        model: parsed.model ?? null,
        thinking: null,
        thinking_effort: parsed.thinkingEffort ?? null,
        background: false,
        budget_ms: parsed.budgetMs ?? null,
        budget_source: parsed.budgetMs !== undefined ? "explicit" : "default",
        pid: process.pid,
        kimi_pid: null,
        status: "running",
        kimi_session_id: reviewSessionId,
        ...persistedExecutionPlanFields(executionPlan),
        agent_profile: REVIEW_AGENT_PROFILE_PLACEHOLDER,
        prompt_digest: digestPrompt(previewPrompt),
        summary: `Running ${commandType}.`,
        final_output_path: null,
        stream_log_path: logPath,
        error: null,
    });
    await writeInvocationLogHeader(logPath, {
        commandType,
        kimiSessionId: reviewSessionId ?? "(pending)",
        cwd: context.cwd,
    });
    const reviewConfig = getManagedCommandConfig(commandType);
    const cancel = reviewConfig.cancellation;
    const handlers = createCliCancellationHandlers();
    store.updateRunningJob(job.job_id, { phase: "turn-running" });
    try {
        const result = await runCliPromptWithBudget({
            cwd: context.cwd,
            env: context.env,
            command: executionPlan.command,
            prefixArgs: [...executionPlan.prefixArgs],
            executionPlan,
            prompt: previewPrompt,
            commandLabel: commandType,
            model: parsed.model,
            thinkingEffort: parsed.thinkingEffort,
            logPath,
            onSpawn: (pid) => { store.updateRunningJob(job.job_id, { kimi_pid: pid }); },
            signal: handlers.signal,
        }, job.budget_ms ?? KIMI_REVIEW_PROMPT_TIMEOUT_MS, `${commandType}.prompt`);
        store.updateRunningJob(job.job_id, observedExecutionFields(result));
        if (handlers.cancelling) {
            throw new RuntimeError(cancel.errorCodes.cancelled, cancel.cancelMessages.afterPrompt, `${commandType}.runtime`);
        }
        assertCliResultSuccess(result, `${commandType}.runtime`);
        warnHookEscapes(result, commandType, context.stderr);
        // Persist whichever session id kimi announced. Review never resumes,
        // but the id is the only handle for post-hoc replay against
        // ~/.kimi-code/sessions/.
        if (result.sessionId !== undefined && result.sessionId.length > 0) {
            // Never persist an empty ID because NULL represents a missing session ID.
            store.updateRunningJob(job.job_id, { kimi_session_id_source: "announced", kimi_session_id: result.sessionId });
        }
        await syncKimiSessionTitle({
            promptText: previewPrompt,
            env: context.env,
            cwd: job.cwd,
            sessionId: result.sessionId ?? job.kimi_session_id,
            title: buildKimiSessionTitle(commandType, parsed.focus ?? reviewContext.targetDescription),
            stderr: context.stderr,
        });
        // Match ask/rescue: gate on the JOB row's pre-call session id so that
        // a future --resume code path won't warn on a resumed review whose
        // prior session id remains valid even if this turn didn't re-announce.
        // Today review never resumes, so the gate is always true at call time.
        if (job.kimi_session_id === null) {
            warnIfSessionIdMissing(result, commandType, job.job_id, context.stderr);
        }
        const finalText = reassembleProseFromRecords(result.records);
        const rendered = renderManagedJobOutput(job, finalText);
        const artifactPath = await writeArtifact(paths, job, rendered.rendered);
        if (handlers.cancelling) {
            throw new RuntimeError(cancel.errorCodes.cancelled, cancel.cancelMessages.afterArtifact, `${commandType}.runtime`);
        }
        store.markCompleted(job.job_id, {
            summary: rendered.summary,
            final_output_path: artifactPath,
            error: null,
        });
        return rendered.output;
    }
    catch (error) {
        const classified = classifyManagedCommandFailure(error, commandType, job.job_id, { background: job.background, budgetMs: job.budget_ms ?? KIMI_REVIEW_PROMPT_TIMEOUT_MS });
        const partialOutput = await captureTimeoutPartialOutput(classified, store, job, context.env, handlers.signal);
        if (handlers.cancelling) {
            const cancelledError = new RuntimeError(cancel.errorCodes.cancelled, cancel.cancelMessages.default, `${commandType}.runtime`, error instanceof Error ? { cause: error } : undefined);
            await markJobCancelled(store, paths, job, cancel.cancelledSummary, cancelledError);
            throw cancelledError;
        }
        await markJobFailed(store, paths, job, classified, cancel.failedSummary, { partialOutput });
        throw classified;
    }
    finally {
        handlers.dispose();
        store.close();
    }
}
async function requireReadOnlyHookInstalled(context, commandType) {
    if (context.env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK === "1") {
        return;
    }
    const installStatus = await verifyHookInstalled(context.env);
    if (installStatus.installed) {
        return;
    }
    maybeWarnHookMissing(installStatus, commandType, context.stderr);
    throw new RuntimeError(`${commandType.toUpperCase()}_HOOK_NOT_INSTALLED`, [
        `${commandType} refuses to run without the canonical kimi-plugin-cc PreToolUse hook.`,
        `Hook check failed: ${installStatus.reason ?? "unknown"}.`,
        "Run /kimi:setup or $kimi-setup to install or repair this host's managed block.",
        "Set KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1 only if you intentionally accept un-enforced execution.",
        hookRefusalRetryProtocol(context.env),
    ].join(" "), `${commandType}.hook-check`, { details: hookRefusalDetails(installStatus) });
}
function buildReviewPrompt(commandType, reviewContext, focus) {
    const modeInstructions = commandType === "challenge"
        ? [
            "Steelman the current approach first, then challenge its assumptions, brittle design choices, and alternatives.",
            "Say when the current approach is preferable instead of assuming change is necessary.",
        ]
        : ["Focus on concrete bugs, regressions, and missing safeguards in the supplied changes."];
    const hasReviewInputs = reviewContext.scope === "base"
        ? reviewContext.diffText.trim().length > 0
        : reviewContext.diffText.trim().length > 0 || reviewContext.statusSummary.length > 0;
    const hasUntrackedInputs = reviewContext.scope === "working-tree" &&
        reviewContext.statusSummary.split("\n").some((line) => line.startsWith("?? "));
    const baseTreeDirty = reviewContext.scope === "base" &&
        reviewContext.statusSummary.split("\n").some((line) => line.length > 0 && !line.startsWith("?? "));
    const inspectionInstruction = reviewContext.scope === "working-tree"
        ? "Read each complete changed file, relevant surrounding code, and related tests rather than reviewing only the diff excerpt."
        : baseTreeDirty
            ? "Treat the supplied branch diff as the source of truth. Current working-tree files may differ; do not use their contents or line numbers as evidence for committed changes."
            : "Read each complete changed file at HEAD, relevant surrounding code, and related tests rather than reviewing only the diff excerpt.";
    return [
        "Perform a read-only code review of the supplied repository changes.",
        ...modeInstructions,
        "Use only the allowed repository read tools; do not use shell/Bash, writes, background tasks, or delegated operations.",
        hasReviewInputs ? inspectionInstruction : undefined,
        "Return plain markdown with a short verdict line (approve / concern / block), a brief summary, and findings with file:line references.",
        "For every finding, provide concrete evidence, impact, severity, and confidence. Do not manufacture findings; if there are none, say so honestly and note residual verification gaps.",
        "Do not emit JSON or wrap the whole response in code fences.",
        hasReviewInputs
            ? undefined
            : "There are no changes in the declared review scope. Return immediately with a one-line note that there were no changes; do not explore the repository.",
        hasUntrackedInputs
            ? "Files marked ?? in git status are untracked review inputs absent from the unified diff; read their complete contents with allowed read tools."
            : undefined,
        reviewContext.diffTruncated
            ? baseTreeDirty
                ? "The unified diff is truncated, and the dirty working tree cannot supply reliable committed snapshots. Do not claim full coverage; report the omitted hunks as a verification gap."
                : "The unified diff is truncated. Inspect all omitted hunks and files with allowed read tools before claiming full coverage, and report any remaining verification gaps."
            : undefined,
        focus ? `Review focus: ${focus}` : undefined,
        "",
        `Target: ${reviewContext.targetDescription}`,
        `Scope: ${reviewContext.scope === "base" ? "branch diff only; all working-tree changes are out of scope" : "current working tree, including tracked and untracked changes"}`,
        `Repository root: ${reviewContext.repoRoot}`,
        ...(reviewContext.scope === "working-tree"
            ? ["", "git status --short:", reviewContext.statusSummary || "(clean)"]
            : []),
        "",
        "Unified diff context:",
        reviewContext.diffText || "(no diff text available)",
    ]
        .filter((line) => typeof line === "string")
        .join("\n");
}
