import { randomUUID } from "node:crypto";
import path from "node:path";
import { createCancellationHandlers } from "../cancellation.js";
import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { digestPrompt, markJobCancelled, markJobFailed, sweepStaleJobs } from "../jobs.js";
import { JobStore } from "../job-store.js";
import { announceSessionTitle } from "../kimi-web-client.js";
import { buildAndStartWireClient, resolveAgentFile } from "../kimi-launch.js";
import { KIMI_WIRE_PROTOCOL_VERSION } from "../wire/types.js";
import { classifyManagedCommandFailure } from "../kimi-errors.js";
import { KIMI_INITIALIZE_TIMEOUT_MS, KIMI_START_TIMEOUT_MS, withTimeout } from "../kimi-timeouts.js";
import { buildSessionTitle } from "../session-title.js";
import { writeInvocationLogHeader } from "../logging.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { parseRescueArgs } from "../parsing.js";
import { firstMeaningfulLine, readArtifact, renderRescueArtifact, writeArtifact } from "../render.js";
import { createRescueApprovalPolicy } from "../rescue-approval.js";
import { KIMI_PLUGIN_CC_VERSION } from "../version.js";
import { startBackgroundJob } from "../background-spawn.js";
export { describeMissingResult } from "../background-spawn.js";
const AUTO_RESUME_PATTERN = /\b(continue|resume|keep going|keep working|apply the top fix|dig deeper)\b/i;
const RESCUE_SUMMARY_MAX = 120;
export async function runRescue(argv, context) {
    const parsed = parseRescueArgs(argv);
    const paths = resolvePluginPaths(context.env);
    await ensurePluginPaths(paths);
    const repoIdentity = await resolveRepoIdentity(context.cwd);
    const store = new JobStore(paths);
    try {
        await sweepStaleJobs(store, paths);
        const sessionResolution = resolveRescueSession(store, repoIdentity.repoId, parsed.prompt, parsed.fresh, parsed.resume, parsed.resumeTarget);
        const prompt = buildRescuePrompt(parsed.prompt, sessionResolution.reusedSession);
        const jobId = randomUUID();
        const logPath = path.join(paths.logsDir, `rescue-${jobId}.jsonl`);
        const agentProfile = resolveAgentFile("runtime/agents/rescue.yaml");
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
            kimi_session_id: sessionResolution.sessionId,
            agent_profile: agentProfile,
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
                kimiSessionId: sessionResolution.sessionId,
                cwd: context.cwd,
            });
        }
        catch (error) {
            const classified = new RuntimeError("RESCUE_LOG_HEADER_FAILED", `Failed to write rescue invocation log header: ${error.message ?? String(error)}`, "rescue.log-header", error instanceof Error ? { cause: error } : undefined);
            await markJobFailed(store, paths, job, classified, "Rescue failed.", { phase: "failed" });
            throw classified;
        }
        if (parsed.background) {
            return startBackgroundJob(job, prompt, context, paths, {
                workerKind: "rescue",
                wait: parsed.wait,
                promptEnvVar: "KIMI_PLUGIN_CC_RESCUE_PROMPT_B64",
                reusedSessionEnvVar: "KIMI_PLUGIN_CC_RESCUE_REUSED_SESSION",
                reusedSession: sessionResolution.reusedSession,
                failedSummary: "Rescue failed.",
                missingResultErrorCode: "RESCUE_RESULT_MISSING",
                spawnFailedErrorCode: "RESCUE_WORKER_SPAWN_FAILED",
                earlyExitErrorCode: "RESCUE_WORKER_EXITED_EARLY",
                nodeBinInvalidErrorCode: "RESCUE_NODE_BIN_INVALID",
                waitStage: "rescue.wait",
                spawnStage: "rescue.worker.spawn",
            });
        }
        const completed = await executeRescueJob(job.job_id, prompt, context, {
            reusedSession: sessionResolution.reusedSession,
        });
        if (!completed.final_output_path) {
            throw new RuntimeError("RESCUE_RESULT_MISSING", "Rescue finished without a rendered result.", "rescue.result");
        }
        return readArtifact(completed.final_output_path);
    }
    finally {
        store.close();
    }
}
export async function executeRescueJob(jobId, prompt, context, options) {
    const paths = resolvePluginPaths(context.env);
    await ensurePluginPaths(paths);
    const store = new JobStore(paths);
    const job = store.getJob(jobId);
    if (!job) {
        store.close();
        throw new RuntimeError("JOB_NOT_FOUND", `Rescue job ${jobId} was not found.`, "rescue.worker");
    }
    // Shared cancellation handler — registers SIGTERM/SIGINT immediately
    // so a signal during wire-client startup still latches
    // cancelling=true. See runtime/cancellation.ts.
    const handlers = createCancellationHandlers({ escalationMs: 1_500 });
    let client;
    try {
        let approvalPolicy;
        try {
            approvalPolicy = await createRescueApprovalPolicy(job.cwd);
        }
        catch (error) {
            const classified = new RuntimeError("RESCUE_SETUP_FAILED", `Rescue setup failed: ${error.message ?? String(error)}`, "rescue.setup", error instanceof Error ? { cause: error } : undefined);
            return await markJobFailed(store, paths, job, classified, "Rescue failed.", { phase: "failed" });
        }
        client = await buildAndStartWireClient({
            cwd: job.cwd,
            env: context.env,
            sessionId: job.kimi_session_id ?? randomUUID(),
            agentFile: job.agent_profile,
            model: job.model ?? undefined,
            thinking: job.thinking ?? undefined,
            logPath: job.stream_log_path,
            approvalPolicy,
        }, KIMI_START_TIMEOUT_MS, "rescue.start", { shouldRetry: () => !handlers.cancelling });
        handlers.attachClient(client);
        if (handlers.cancelling) {
            // Signal fired during startup; the first attempt succeeded before the
            // retry gate could short-circuit. Synthesize a throw so the normal
            // cancellation teardown path runs.
            throw new RuntimeError("RESCUE_CANCELLED_DURING_START", "Rescue cancelled during startup.", "rescue.start");
        }
        if (options?.workerPid) {
            store.updateRunningJob(job.job_id, { pid: options.workerPid, phase: "worker-running" });
        }
        store.updateRunningJob(job.job_id, {
            kimi_pid: client.getChildPid(),
            phase: "turn-running",
        });
        await withTimeout(client.initialize({
            protocol_version: KIMI_WIRE_PROTOCOL_VERSION,
            client: { name: "kimi-plugin-cc", version: KIMI_PLUGIN_CC_VERSION },
            capabilities: {
                supports_question: false,
                supports_plan_mode: false,
            },
        }), KIMI_INITIALIZE_TIMEOUT_MS, "rescue.initialize", "initialize");
        // Skip the rename on resumed sessions: the title was set by the original
        // rescue call and the current prompt here is either the generic
        // "Continue the previous rescue task..." string or a user-supplied
        // refinement — neither should clobber the original identifying excerpt
        // in `kimi web`. A future enhancement could update the title when the
        // user explicitly supplies a new prompt on resume, but the no-op on
        // reuse is the conservative choice.
        if (job.kimi_session_id && !options?.reusedSession) {
            await announceSessionTitle(job.kimi_session_id, buildSessionTitle("rescue", prompt), {
                env: context.env,
            });
        }
        const completedTurn = await client.prompt(prompt, "rescue");
        // Cancel-after-prompt-success check: SIGTERM could have fired between
        // prompt completion and our terminal-state writes. Honour it.
        if (handlers.cancelling) {
            throw new RuntimeError("RESCUE_CANCELLED", "Rescue cancelled by user request after prompt completion.", "rescue.runtime");
        }
        let artifactPath;
        try {
            if (context.env.KIMI_PLUGIN_CC_TEST_FAIL_WRITE_ARTIFACT === "1") {
                throw new Error("Simulated artifact write failure (test seam).");
            }
            artifactPath = await writeArtifact(paths, job, renderRescueArtifact(completedTurn.finalText));
        }
        catch (writeError) {
            process.stderr.write(`[kimi-plugin-cc] rescue artifact write failed for job ${job.job_id}; raw output follows:\n${completedTurn.finalText}\n`);
            const classified = new RuntimeError("RESCUE_ARTIFACT_WRITE_FAILED", `Failed to write rescue artifact: ${writeError.message ?? String(writeError)}`, "rescue.artifact", writeError instanceof Error ? { cause: writeError } : undefined);
            return await markJobFailed(store, paths, job, classified, "Rescue failed.", { phase: "failed" });
        }
        // Re-check after the artifact write (disk I/O window) — cancel could
        // have landed there too.
        if (handlers.cancelling) {
            throw new RuntimeError("RESCUE_CANCELLED", "Rescue cancelled by user request after artifact write.", "rescue.runtime");
        }
        return (store.markCompleted(job.job_id, {
            summary: firstMeaningfulLine(completedTurn.finalText),
            phase: "done",
            final_output_path: artifactPath,
            error: null,
        }) ?? job);
    }
    catch (error) {
        if (handlers.cancelling) {
            // Clear escalation timer NOW, before awaiting markJobCancelled
            // (disk I/O can exceed 1.5s under load and trigger a redundant SIGTERM).
            handlers.clearEscalation();
            // Always wrap into a canonical RESCUE_CANCELLED RuntimeError so callers
            // can distinguish user-cancel from infra failure via error.code.
            const cancelledError = new RuntimeError("RESCUE_CANCELLED", "Rescue cancelled by user request.", "rescue.runtime", error instanceof Error ? { cause: error } : undefined);
            return await markJobCancelled(store, paths, job, "Rescue cancelled by user request.", cancelledError, { phase: "cancelled" });
        }
        const classified = classifyManagedCommandFailure(error, "rescue", job.job_id, {
            preserveStage: true,
        });
        return await markJobFailed(store, paths, job, classified, "Rescue failed.", { phase: "failed" });
    }
    finally {
        handlers.dispose();
        // WireClient.close() has an internal `closed` latch so a second call
        // is a no-op — drop the separate clientClosed flag (dead code).
        await client?.close().catch(() => { });
        store.close();
    }
}
function buildRescuePrompt(prompt, reusedSession) {
    if (prompt?.trim()) {
        return prompt.trim();
    }
    if (reusedSession) {
        return "Continue the previous rescue task using the latest repository state.";
    }
    throw new RuntimeError("INVALID_ARGS", "rescue requires a task description.", "rescue.parse");
}
function resolveRescueSession(store, repoId, prompt, fresh, resume, resumeTarget) {
    if (fresh) {
        return { sessionId: randomUUID(), reusedSession: false };
    }
    if (resumeTarget) {
        const byJob = store.getJob(resumeTarget);
        const scoped = byJob?.repo_id === repoId && byJob.command_type === "rescue" ? byJob : null;
        const exact = scoped ?? store.findRescueJobBySession(repoId, resumeTarget);
        if (!exact?.kimi_session_id) {
            throw new RuntimeError("RESCUE_RESUME_NOT_FOUND", `No rescue job or session matched ${resumeTarget}.`, "rescue.resume");
        }
        ensureSessionIsNotRunning(exact);
        return { sessionId: exact.kimi_session_id, reusedSession: true };
    }
    if (resume) {
        const latest = store.findLatestJob({ repoId, commandType: "rescue" });
        if (!latest?.kimi_session_id) {
            throw new RuntimeError("RESCUE_RESUME_NOT_FOUND", "No prior rescue session exists for this repository.", "rescue.resume");
        }
        ensureSessionIsNotRunning(latest);
        return { sessionId: latest.kimi_session_id, reusedSession: true };
    }
    if (prompt && AUTO_RESUME_PATTERN.test(prompt)) {
        const latest = store.findLatestJob({ repoId, commandType: "rescue" });
        if (latest?.kimi_session_id) {
            ensureSessionIsNotRunning(latest);
            return { sessionId: latest.kimi_session_id, reusedSession: true };
        }
    }
    return { sessionId: randomUUID(), reusedSession: false };
}
function ensureSessionIsNotRunning(job) {
    if (job.status === "running") {
        throw new RuntimeError("RESCUE_ALREADY_RUNNING", `Rescue session ${job.kimi_session_id ?? "<unknown>"} is already active under job ${job.job_id}.`, "rescue.resume");
    }
}
function shorten(text, max) {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= max) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
