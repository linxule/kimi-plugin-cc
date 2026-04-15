import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, constants as fsConstants } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { digestPrompt, markJobCancelled, markJobFailed, sweepStaleBackgroundJobs, waitForTerminalJob } from "../jobs.js";
import { JobStore } from "../job-store.js";
import { announceSessionTitle } from "../kimi-web-client.js";
import { buildWireClient, resolveAgentFile } from "../kimi-launch.js";
import { classifyManagedCommandFailure } from "../kimi-errors.js";
import { KIMI_INITIALIZE_TIMEOUT_MS, KIMI_START_TIMEOUT_MS, withTimeout } from "../kimi-timeouts.js";
import { buildSessionTitle } from "../session-title.js";
import { writeInvocationLogHeader } from "../logging.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { parseRescueArgs } from "../parsing.js";
import { firstMeaningfulLine, readArtifact, renderRescueArtifact, writeArtifact } from "../render.js";
import { createRescueApprovalPolicy } from "../rescue-approval.js";
import { KIMI_PLUGIN_CC_VERSION } from "../version.js";
// Resolves to runtime/companion.ts in dev (via tsx) and dist/companion.js in production (compiled
// with tsc to the same relative layout). The extension is derived from the running module so the
// child-process spawn in startBackgroundRescue targets the right entrypoint in both modes.
const isCompiledRuntime = import.meta.url.endsWith(".js");
const companionEntrypoint = fileURLToPath(new URL(isCompiledRuntime ? "../companion.js" : "../companion.ts", import.meta.url));
const companionProjectRoot = path.resolve(path.dirname(companionEntrypoint), "..");
const AUTO_RESUME_PATTERN = /\b(continue|resume|keep going|keep working|apply the top fix|dig deeper)\b/i;
const RESCUE_SUMMARY_MAX = 120;
export async function runRescue(argv, context) {
    const parsed = parseRescueArgs(argv);
    const paths = resolvePluginPaths(context.env);
    await ensurePluginPaths(paths);
    const repoIdentity = await resolveRepoIdentity(context.cwd);
    const store = new JobStore(paths);
    try {
        await sweepStaleBackgroundJobs(store, paths);
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
            pid: null,
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
            return startBackgroundRescue(job, prompt, context, paths, parsed.wait, {
                reusedSession: sessionResolution.reusedSession,
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
    let cancelling = false;
    let clientClosed = false;
    let cancelEscalationTimer;
    let client;
    let signalsRegistered = false;
    const requestCancellation = () => {
        if (cancelling || !client) {
            return;
        }
        cancelling = true;
        client.beginCancellation();
        void client.cancel().catch(() => { });
        cancelEscalationTimer = setTimeout(() => {
            client?.terminateChild("SIGTERM");
        }, 1_500);
        cancelEscalationTimer.unref();
    };
    try {
        let approvalPolicy;
        try {
            approvalPolicy = await createRescueApprovalPolicy(job.cwd);
            client = buildWireClient({
                cwd: job.cwd,
                env: context.env,
                sessionId: job.kimi_session_id ?? randomUUID(),
                agentFile: job.agent_profile,
                model: job.model ?? undefined,
                thinking: job.thinking ?? undefined,
                logPath: job.stream_log_path,
                approvalPolicy,
            });
        }
        catch (error) {
            const classified = new RuntimeError("RESCUE_SETUP_FAILED", `Rescue setup failed: ${error.message ?? String(error)}`, "rescue.setup", error instanceof Error ? { cause: error } : undefined);
            return await markJobFailed(store, paths, job, classified, "Rescue failed.", { phase: "failed" });
        }
        process.once("SIGTERM", requestCancellation);
        process.once("SIGINT", requestCancellation);
        signalsRegistered = true;
        if (options?.workerPid) {
            store.updateRunningJob(job.job_id, { pid: options.workerPid, phase: "worker-running" });
        }
        await withTimeout(client.start(), KIMI_START_TIMEOUT_MS, "rescue.start");
        store.updateRunningJob(job.job_id, {
            kimi_pid: client.getChildPid(),
            phase: "turn-running",
        });
        await withTimeout(client.initialize({
            protocol_version: "1.9",
            client: { name: "kimi-plugin-cc", version: KIMI_PLUGIN_CC_VERSION },
            capabilities: {
                supports_question: false,
                supports_plan_mode: false,
            },
        }), KIMI_INITIALIZE_TIMEOUT_MS, "rescue.initialize");
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
        return (store.markCompleted(job.job_id, {
            summary: firstMeaningfulLine(completedTurn.finalText),
            phase: "done",
            final_output_path: artifactPath,
            error: null,
        }) ?? job);
    }
    catch (error) {
        if (cancelling) {
            return await markJobCancelled(store, paths, job, "Rescue cancelled by user request.", error, { phase: "cancelled" });
        }
        const classified = classifyManagedCommandFailure(error, "rescue", job.job_id);
        return await markJobFailed(store, paths, job, classified, "Rescue failed.", { phase: "failed" });
    }
    finally {
        if (signalsRegistered) {
            process.removeListener("SIGTERM", requestCancellation);
            process.removeListener("SIGINT", requestCancellation);
        }
        if (cancelEscalationTimer) {
            clearTimeout(cancelEscalationTimer);
        }
        if (client && !clientClosed) {
            await client.close().catch(() => { });
            clientClosed = true;
        }
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
async function startBackgroundRescue(job, prompt, context, paths, wait, options) {
    const nodeBinary = context.env.KIMI_PLUGIN_CC_NODE_BIN || process.execPath;
    // Only fast-path the `fs.access` check for absolute/relative paths. A bare
    // name like "node" is resolved by spawn() via PATH; the spawn `error` listener
    // will still surface ENOENT on nextTick for that path, classified as
    // RESCUE_WORKER_SPAWN_FAILED via the listener below.
    if (nodeBinary.includes("/") || nodeBinary.includes("\\")) {
        try {
            await access(nodeBinary, fsConstants.X_OK);
        }
        catch (accessError) {
            const code = accessError.code;
            if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
                const classified = new RuntimeError("RESCUE_NODE_BIN_INVALID", `Configured Node binary is not executable: ${nodeBinary}. Set KIMI_PLUGIN_CC_NODE_BIN to a valid Node >=22.5 executable and retry.`, "rescue.worker.spawn", accessError instanceof Error ? { cause: accessError } : undefined);
                const failStore = new JobStore(paths);
                try {
                    await markJobFailed(failStore, paths, job, classified, "Rescue failed.", { phase: "failed" });
                }
                finally {
                    failStore.close();
                }
                throw classified;
            }
            // Any other errno (EIO, etc.) — fall through to the spawn attempt and let the
            // existing spawn error path surface it.
        }
    }
    const spawnArgs = isCompiledRuntime
        ? [companionEntrypoint, "worker", "rescue", job.job_id]
        : ["--import", "tsx", companionEntrypoint, "worker", "rescue", job.job_id];
    const child = spawn(nodeBinary, spawnArgs, {
        cwd: companionProjectRoot,
        env: {
            ...context.env,
            KIMI_PLUGIN_CC_WORKSPACE_CWD: context.cwd,
            KIMI_PLUGIN_CC_RESCUE_PROMPT_B64: Buffer.from(prompt, "utf8").toString("base64"),
            KIMI_PLUGIN_CC_RESCUE_REUSED_SESSION: options?.reusedSession ? "1" : "0",
        },
        detached: true,
        stdio: "ignore",
    });
    let spawnReportedFailure = false;
    const spawnErrorPromise = new Promise((resolve) => {
        let settled = false;
        const settle = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(value);
        };
        child.once("error", (spawnError) => {
            spawnReportedFailure = true;
            settle(new RuntimeError("RESCUE_WORKER_SPAWN_FAILED", `Background rescue worker failed to spawn: ${spawnError.message}`, "rescue.worker.spawn", { cause: spawnError }));
        });
        // Give the event loop one tick to deliver a synchronous spawn error
        // (ENOENT fires on process.nextTick). If nothing fires by then, the
        // child is live and we can proceed.
        setImmediate(() => settle(null));
    });
    child.on("close", (exitCode, signal) => {
        if (spawnReportedFailure) {
            return;
        }
        if (exitCode === null || exitCode === 0) {
            return;
        }
        // The worker exited non-zero before any state update. If the job is
        // still in its spawn phase, the worker never reached `executeRescueJob`.
        const classified = new RuntimeError("RESCUE_WORKER_EXITED_EARLY", `Background rescue worker exited with code ${exitCode}${signal ? ` (signal ${signal})` : ""} before reporting a result.`, "rescue.worker.spawn");
        void markEarlyExit(paths, job.job_id, classified);
    });
    child.unref();
    const spawnError = await spawnErrorPromise;
    if (spawnError) {
        await markSpawnFailure(paths, job.job_id, spawnError);
        throw spawnError;
    }
    const store = new JobStore(paths);
    try {
        store.updateRunningJob(job.job_id, {
            pid: child.pid ?? null,
            phase: "worker-spawned",
        });
    }
    finally {
        store.close();
    }
    if (wait) {
        const completed = await waitForTerminalJob(() => new JobStore(paths), job.job_id);
        if (!completed.final_output_path) {
            throw new RuntimeError("RESCUE_RESULT_MISSING", `Background rescue job ${job.job_id} finished without a rendered result.`, "rescue.wait");
        }
        return readArtifact(completed.final_output_path);
    }
    return `${JSON.stringify({
        job_id: job.job_id,
        command_type: job.command_type,
    }, null, 2)}\n`;
}
async function markSpawnFailure(paths, jobId, classified) {
    const store = new JobStore(paths);
    try {
        const current = store.getJob(jobId);
        if (!current || current.status !== "running") {
            return;
        }
        await markJobFailed(store, paths, current, classified, "Rescue failed.", { phase: "failed" });
    }
    catch (writeError) {
        process.stderr.write(`[kimi-plugin-cc] failed to mark rescue ${jobId} as spawn-failed: ${writeError.message ?? String(writeError)}\n`);
    }
    finally {
        store.close();
    }
}
async function markEarlyExit(paths, jobId, classified) {
    const store = new JobStore(paths);
    try {
        const current = store.getJob(jobId);
        if (!current || current.status !== "running") {
            return;
        }
        // Only mark failure if the worker exited before advancing past the spawn phase.
        // Once the worker reaches worker-running or turn-running, the child owns the
        // job state and the parent's close listener must not race with it.
        if (current.phase !== "worker-spawned" && current.phase !== "queued") {
            return;
        }
        await markJobFailed(store, paths, current, classified, "Rescue failed.", { phase: "failed" });
    }
    catch (writeError) {
        process.stderr.write(`[kimi-plugin-cc] failed to mark rescue ${jobId} as early-exit: ${writeError.message ?? String(writeError)}\n`);
    }
    finally {
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
