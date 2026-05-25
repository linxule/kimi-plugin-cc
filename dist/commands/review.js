import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { createCliCancellationHandlers } from "../cli-cancellation.js";
import { runCliPromptWithBudget } from "../cli-client.js";
import { resolveKimiCliCommand } from "../kimi-command.js";
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
import { maybeWarnHookMissing, verifyHookInstalled } from "../hooks/install.js";
import { assertCliResultSuccess, reassembleProseFromRecords } from "./cli-helpers.js";
// v1.0 cutover note (PR 2):
//
//   Replaced the v0.4 wire client + initialize + prompt sequence with a
//   single `runCliPrompt` call against `kimi -p --output-format
//   stream-json`. The PreToolUse hook (installed via /kimi:setup) reads
//   `KIMI_PLUGIN_CC_CMD=review` (or `=challenge`) and denies anything
//   but Read/Grep/Glob — so the read-only contract that v0.4 enforced
//   via WireClient.approvalPolicy is now enforced out-of-band by the
//   hook. The command no longer needs to wire its own approval policy.
//
// What stays:
//
//   - SQLite job store, prompt digest, artifact rendering, withTimeout
//     for the prompt phase.
//   - Cancellation: still SIGTERM/SIGINT-driven, but via AbortController
//     instead of WireClient.cancel().
//   - Job error classification via classifyManagedCommandFailure.
//
// What's gone:
//
//   - announceSessionTitle — vis-server has no PATCH endpoint; the
//     kimi-web title cannot be written from the plugin in v1.0.
//   - agent_profile — kimi-code doesn't load YAML agent profiles. The
//     SQLite column stays for backward compatibility; we write a
//     placeholder "<cli-client>" until PR 4 makes it nullable.
//   - KIMI_INITIALIZE_TIMEOUT_MS / KIMI_START_TIMEOUT_MS — there's no
//     separate initialize/start phase under -p mode.
const REVIEW_AGENT_PROFILE_PLACEHOLDER = "<cli-client>";
export async function runReview(argv, context, commandType) {
    const parsed = parseReviewArgs(argv, commandType);
    if (parsed.background || parsed.wait) {
        throw new RuntimeError("INVALID_FLAGS", `${commandType} does not support --background or --wait in v1; review runs foreground-synchronously.`, `${commandType}.parse`);
    }
    const reviewContext = await collectReviewContext(context.cwd, parsed.base);
    const paths = resolvePluginPaths(context.env);
    await ensurePluginPaths(paths);
    const repoIdentity = await resolveRepoIdentity(context.cwd);
    const store = new JobStore(paths);
    // Hook installation warning surfaces BEFORE any kimi spawn so the
    // user notices it on every command, not just on a successful run.
    if (context.env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK !== "1") {
        const installStatus = await verifyHookInstalled(context.env);
        maybeWarnHookMissing(installStatus, commandType, context.stderr);
    }
    const jobId = randomUUID();
    // kimi-code mints the actual session id and announces it on stderr;
    // we leave the row's kimi_session_id NULL until the call returns to
    // avoid storing a fictional id that no on-disk session matches.
    // (See PR 2 review feedback in reports/17-pr2-claude-review.md.)
    const reviewSessionId = null;
    const logPath = path.join(paths.logsDir, `${commandType}-${jobId}.jsonl`);
    const previewPrompt = buildReviewPrompt(commandType, reviewContext, parsed.focus);
    const job = store.createJob({
        job_id: jobId,
        repo_id: repoIdentity.repoId,
        command_type: commandType,
        cwd: context.cwd,
        model: parsed.model ?? null,
        thinking: parsed.thinking ?? null,
        background: false,
        pid: process.pid,
        kimi_pid: null,
        status: "running",
        kimi_session_id: reviewSessionId,
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
    const kimi = resolveKimiCliCommand(context.env);
    try {
        const result = await runCliPromptWithBudget({
            cwd: context.cwd,
            env: context.env,
            command: kimi.command,
            prefixArgs: kimi.prefixArgs,
            prompt: previewPrompt,
            commandLabel: commandType,
            model: parsed.model,
            logPath,
            signal: handlers.signal,
        }, KIMI_REVIEW_PROMPT_TIMEOUT_MS, `${commandType}.prompt`);
        if (handlers.cancelling) {
            throw new RuntimeError(cancel.errorCodes.cancelled, cancel.cancelMessages.afterPrompt, `${commandType}.runtime`);
        }
        assertCliResultSuccess(result, `${commandType}.runtime`);
        // Persist whichever session id kimi announced. Review never resumes,
        // but the id is the only handle for post-hoc replay against
        // ~/.kimi-code/sessions/.
        if (result.sessionId !== undefined) {
            store.updateRunningJob(job.job_id, { kimi_session_id: result.sessionId });
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
        if (handlers.cancelling) {
            const cancelledError = new RuntimeError(cancel.errorCodes.cancelled, cancel.cancelMessages.default, `${commandType}.runtime`, error instanceof Error ? { cause: error } : undefined);
            await markJobCancelled(store, paths, job, cancel.cancelledSummary, cancelledError);
            throw cancelledError;
        }
        const classified = classifyManagedCommandFailure(error, commandType, job.job_id);
        await markJobFailed(store, paths, job, classified, cancel.failedSummary);
        throw classified;
    }
    finally {
        handlers.dispose();
        store.close();
    }
}
function buildReviewPrompt(commandType, reviewContext, focus) {
    const modeInstructions = commandType === "challenge"
        ? [
            "Take a challenging stance.",
            "Challenge assumptions, identify brittle design choices, and surface safer alternatives.",
        ]
        : ["Focus on concrete bugs, regressions, and missing safeguards in the supplied changes."];
    return [
        "Perform a read-only code review of the supplied repository changes.",
        ...modeInstructions,
        "Use repository read tools as needed, but do not attempt any write, shell, background, or delegated operations.",
        "Return your review as plain markdown — a short verdict line (approve / concern / block), then a brief summary, then one section per finding with file:line refs. No JSON wrapper, no code fences around the whole response.",
        "If the supplied diff context is empty or shows no changes to review, return immediately with a one-line note that there were no changes — do not explore the repository.",
        focus ? `Review focus: ${focus}` : undefined,
        "",
        `Target: ${reviewContext.targetDescription}`,
        `Repository root: ${reviewContext.repoRoot}`,
        "",
        "git status --short:",
        reviewContext.statusSummary || "(clean)",
        "",
        "Unified diff context:",
        reviewContext.diffText || "(no diff text available)",
    ]
        .filter((line) => typeof line === "string")
        .join("\n");
}
