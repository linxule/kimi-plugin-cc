import { formatError, RuntimeError } from "../errors.js";
import { markJobFailed, STALE_SWEEP_GRACE_MS } from "../jobs.js";
import { JobStore, parseHookEscapes, renderBudgetSource, } from "../job-store.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { readProcessIdentity, revalidateProcessIdentities, revalidateProcessIdentity, } from "../process-tree.js";
import { readArtifact, renderTerminalJobArtifact } from "../render.js";
import { runCancel } from "../commands/cancel.js";
import { assertMcpJobBinding, mcpCompanionIdentity, mcpKimiIdentity } from "./binding.js";
import { readJobControlArguments } from "./operations.js";
import { textResult } from "./tool-result.js";
import { resolveMcpWorkspace } from "./workspace.js";
export async function getMcpJobStatus(env, input) {
    const { task, job } = await loadMcpJob(env, input);
    const metadata = mcpJobMetadata(task, job);
    return textResult(`${JSON.stringify(metadata, null, 2)}\n`, metadata);
}
export async function getMcpJobResult(env, input) {
    const { task, job } = await loadMcpJob(env, input);
    if (!job) {
        if (task.launch_error)
            return launchFailureResult(task);
        throw new RuntimeError("JOB_NOT_TERMINAL", `MCP job ${task.task_id} is still starting.`, "mcp.result");
    }
    if (job.status === "running") {
        throw new RuntimeError("JOB_NOT_TERMINAL", `Job ${job.job_id} is still running.`, "mcp.result");
    }
    return terminalJobResult(task, job);
}
export async function cancelMcpJob(env, input) {
    const { task, job } = await loadMcpJob(env, input);
    if (!job) {
        if (task.launch_error)
            return launchFailureResult(task);
        throw new RuntimeError("JOB_NOT_TERMINAL", `MCP job ${task.task_id} has not attached to a companion job.`, "mcp.cancel");
    }
    if (job.status !== "running") {
        const metadata = mcpJobMetadata(task, job);
        return textResult(`${JSON.stringify({ ...metadata, message: "cancel is a no-op for terminal jobs." }, null, 2)}\n`, metadata);
    }
    const output = await runCancel([task.task_id], {
        cwd: task.workspace_cwd,
        env,
        stdout: process.stdout,
        stderr: process.stderr,
        mcpCompanionIdentity: mcpCompanionIdentity(task),
        mcpKimiIdentity: mcpKimiIdentity(task, job),
    });
    const current = await loadMcpJob(env, input);
    const metadata = mcpJobMetadata(current.task, current.job);
    return textResult(output, { ...metadata, cancellation: JSON.parse(output) });
}
export async function getMcpTaskView(env, input) {
    let boundTask;
    try {
        const { task, job } = await loadMcpJob(env, input, (found) => { boundTask = found; });
        if (!job) {
            if (task.launch_error) {
                return taskView(task, null, "completed", launchFailureResult(task), task.launch_error);
            }
            return taskView(task, null, "working", undefined, "Starting the supervised companion.");
        }
        switch (job.status) {
            case "running":
                return taskView(task, job, "working", undefined, `${task.operation_kind}: ${job.phase ?? "running"}`);
            case "completed":
                return taskView(task, job, "completed", await terminalJobResult(task, job), job.summary);
            case "failed":
                return taskView(task, job, "completed", await terminalJobResult(task, job), job.summary);
            case "cancelled":
                return taskView(task, job, "cancelled", undefined, job.summary);
        }
    }
    catch (error) {
        if (boundTask && error instanceof RuntimeError && error.code === "MCP_PROCESS_IDENTITY_UNAVAILABLE") {
            return taskView(boundTask, null, "working", undefined, formatError(error));
        }
        if (boundTask && error instanceof RuntimeError && error.code !== "JOB_NOT_FOUND") {
            return {
                taskId: boundTask.task_id,
                status: "failed",
                createdAt: boundTask.created_at,
                lastUpdatedAt: new Date().toISOString(),
                ttlMs: null,
                pollIntervalMs: 2_000,
                error: {
                    code: -32_603,
                    message: formatError(error),
                    data: { job_id: boundTask.task_id, operation_kind: boundTask.operation_kind },
                },
            };
        }
        throw error;
    }
}
async function loadMcpJob(env, input, observeTask) {
    const args = readJobControlArguments(input);
    const paths = resolvePluginPaths(env);
    await ensurePluginPaths(paths);
    const store = new JobStore(paths);
    try {
        let task = store.getMcpTask(args.jobId);
        if (!task) {
            throw new RuntimeError("JOB_NOT_FOUND", `MCP job ${args.jobId} was not found.`, "mcp.lookup");
        }
        const workspace = await resolveMcpWorkspace(env, args.workspace ?? task.workspace_cwd);
        if (task.workspace_cwd !== workspace.cwd || task.repo_id !== workspace.repo.repoId) {
            throw new RuntimeError("JOB_NOT_FOUND", `MCP job ${args.jobId} was not found in this workspace.`, "mcp.lookup");
        }
        observeTask?.(task);
        let job = store.getJob(task.task_id);
        if (!job) {
            task = await reconcileUnattachedTask(store, task);
            return { task, job: null };
        }
        await assertMcpJobBinding(task, job);
        if (task.launch_state === "starting") {
            let identity;
            if (job.status === "running") {
                const expected = mcpCompanionIdentity(task);
                if (expected) {
                    const validation = await revalidateProcessIdentities([expected]);
                    if (!validation.complete) {
                        throw new RuntimeError("MCP_PROCESS_IDENTITY_UNAVAILABLE", "The companion identity probe was inconclusive; the starting task was not attached or changed.", "mcp.reconcile");
                    }
                    if (validation.identities.length === 0) {
                        const taskUpdatedAt = Date.parse(task.updated_at);
                        const jobUpdatedAt = Date.parse(job.updated_at);
                        const stale = Number.isFinite(taskUpdatedAt) && Number.isFinite(jobUpdatedAt) &&
                            Date.now() - taskUpdatedAt >= STALE_SWEEP_GRACE_MS &&
                            Date.now() - jobUpdatedAt >= STALE_SWEEP_GRACE_MS;
                        if (!stale) {
                            throw new RuntimeError("MCP_PROCESS_IDENTITY_MISMATCH", "The recorded companion process identity no longer matches; the starting task was not attached and no process was adopted.", "mcp.reconcile");
                        }
                        task = await reconcileStaleCompanion(store, paths, task, job);
                        job = store.getJob(task.task_id);
                        return { task, job };
                    }
                    identity = validation.identities[0];
                }
                else if (job.pid !== null) {
                    const updatedAt = Date.parse(task.updated_at);
                    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt >= STALE_SWEEP_GRACE_MS) {
                        throw new RuntimeError("MCP_PROCESS_IDENTITY_UNAVAILABLE", "The starting task has no reusable identity after the attach grace period; refusing to adopt a process by PID alone.", "mcp.reconcile");
                    }
                    identity = await readProcessIdentity(job.pid);
                }
            }
            if (job.status !== "running" || identity) {
                task = store.updateMcpTask(task.task_id, {
                    launch_state: "attached",
                    attached_at: new Date().toISOString(),
                    companion_pid: job.pid ?? task.companion_pid,
                    ...(identity ? { companion_identity: JSON.stringify(identity) } : {}),
                });
            }
        }
        else if (task.launch_error) {
            throw new RuntimeError("MCP_JOB_BINDING_FAILED", task.launch_error, "mcp.binding");
        }
        if (job.status === "running") {
            task = await refreshCompanionIdentity(store, task, job);
            task = await captureKimiIdentity(store, task, job);
            task = await reconcileStaleCompanion(store, paths, task, job);
            job = store.getJob(task.task_id);
        }
        return { task, job };
    }
    finally {
        store.close();
    }
}
async function reconcileUnattachedTask(store, task) {
    if (task.launch_state !== "starting")
        return task;
    const updatedAt = Date.parse(task.updated_at);
    const fresh = Number.isFinite(updatedAt) && Date.now() - updatedAt < STALE_SWEEP_GRACE_MS;
    if (task.companion_identity === null) {
        if (fresh) {
            if (task.companion_pid === null)
                return task;
            const current = await readProcessIdentity(task.companion_pid);
            return current
                ? store.updateMcpTask(task.task_id, { companion_identity: JSON.stringify(current) })
                : task;
        }
        if (task.companion_pid !== null) {
            throw new RuntimeError("MCP_PROCESS_IDENTITY_UNAVAILABLE", "The unattached companion has no reusable identity; refusing to adopt a process by PID alone.", "mcp.reconcile");
        }
        return store.updateMcpTask(task.task_id, {
            launch_state: "exited",
            launch_error: `No companion process was recorded before creating job ${task.task_id}.`,
        });
    }
    if (fresh)
        return task;
    const validation = await revalidateProcessIdentities([mcpCompanionIdentity(task)]);
    if (!validation.complete) {
        throw new RuntimeError("MCP_PROCESS_IDENTITY_UNAVAILABLE", "The unattached companion identity probe was inconclusive; the task was not changed.", "mcp.reconcile");
    }
    if (validation.identities.length > 0)
        return task;
    return store.updateMcpTask(task.task_id, {
        launch_state: "exited",
        launch_error: `Companion pid ${task.companion_pid} disappeared before creating job ${task.task_id}.`,
    });
}
async function refreshCompanionIdentity(store, task, job) {
    if (task.companion_identity !== null || job.pid === null)
        return task;
    const updatedAt = Date.parse(task.updated_at);
    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt >= STALE_SWEEP_GRACE_MS) {
        throw new RuntimeError("MCP_PROCESS_IDENTITY_UNAVAILABLE", "The companion identity is missing after the attach grace period; refusing to adopt a process by PID alone.", "mcp.reconcile");
    }
    const identity = await readProcessIdentity(job.pid);
    if (!identity)
        return task;
    return store.updateMcpTask(task.task_id, {
        companion_pid: job.pid,
        companion_identity: JSON.stringify(identity),
    });
}
async function captureKimiIdentity(store, task, job) {
    if (task.kimi_identity !== null)
        return task;
    const companion = mcpCompanionIdentity(task);
    if (!companion || !(await revalidateProcessIdentity(companion)))
        return task;
    const identity = job.kimi_pid !== null
        ? await readProcessIdentity(job.kimi_pid)
        : undefined;
    if (!identity)
        return task;
    return store.updateMcpTask(task.task_id, { kimi_identity: JSON.stringify(identity) });
}
async function reconcileStaleCompanion(store, paths, task, job) {
    const updatedAt = Date.parse(job.updated_at);
    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt < STALE_SWEEP_GRACE_MS)
        return task;
    const companion = mcpCompanionIdentity(task);
    if (!companion) {
        throw new RuntimeError("MCP_PROCESS_IDENTITY_UNAVAILABLE", "The stale companion has no reusable process identity; refusing PID-only reconciliation.", "mcp.reconcile");
    }
    const validation = await revalidateProcessIdentities([companion]);
    if (!validation.complete) {
        throw new RuntimeError("MCP_PROCESS_IDENTITY_UNAVAILABLE", "The companion process identity probe was inconclusive; no process was signalled and the job was not changed.", "mcp.reconcile");
    }
    if (validation.identities.length > 0)
        return task;
    const orphanWarning = await terminateRecordedKimi(task, job);
    await markJobFailed(store, paths, job, new RuntimeError("MCP_COMPANION_DISAPPEARED", `The supervised companion disappeared before settling the job.${orphanWarning ? ` ${orphanWarning}` : ""}`, "mcp.reconcile", orphanWarning ? { details: { orphan_warning: orphanWarning, kimi_pid: job.kimi_pid } } : undefined), "Supervised MCP companion disappeared before reporting a terminal state.", { phase: "failed" });
    return store.getMcpTask(task.task_id);
}
async function terminateRecordedKimi(task, job) {
    const identity = mcpKimiIdentity(task, job);
    if (!identity) {
        return job.kimi_pid === null
            ? null
            : `Kimi pid ${job.kimi_pid} was not signalled because no verified identity had been captured.`;
    }
    if (!(await revalidateProcessIdentity(identity)))
        return null;
    signalVerifiedIdentity(identity, "SIGTERM");
    await sleep(1_500);
    if (await revalidateProcessIdentity(identity))
        signalVerifiedIdentity(identity, "SIGKILL");
    return null;
}
function signalVerifiedIdentity(identity, signal) {
    try {
        process.kill(identity.processGroupId === identity.pid ? -identity.processGroupId : identity.pid, signal);
    }
    catch (error) {
        const code = error.code;
        if (code !== "ESRCH" && code !== "EPERM")
            throw error;
    }
}
async function terminalJobResult(task, job) {
    const metadata = mcpJobMetadata(task, job);
    const body = job.final_output_path
        ? await readArtifact(job.final_output_path)
        : `${renderTerminalJobArtifact(job)}\n`;
    return textResult(body, {
        ...metadata,
        artifact_path: job.final_output_path,
        partial_output: job.status === "failed" && Number(job.error?.details?.partial_output_chars ?? 0) > 0,
    }, job.status !== "completed");
}
function launchFailureResult(task) {
    const message = task.launch_error ?? "The companion failed before creating its job.";
    return textResult(message, {
        job_id: task.task_id,
        operation_kind: task.operation_kind,
        launch_state: task.launch_state,
        error: { code: "MCP_CHILD_LAUNCH_FAILED", message },
    }, true);
}
function mcpJobMetadata(task, job) {
    if (!job) {
        return {
            job_id: task.task_id,
            operation_kind: task.operation_kind,
            workspace: task.workspace_cwd,
            status: task.launch_error ? "failed" : "starting",
            launch_state: task.launch_state,
            created_at: task.created_at,
            updated_at: task.updated_at,
            error: task.launch_error,
        };
    }
    return {
        job_id: job.job_id,
        operation_kind: job.operation_kind,
        command_type: job.command_type,
        workspace: task.workspace_cwd,
        status: job.status,
        phase: job.phase,
        summary: job.summary,
        created_at: job.created_at,
        updated_at: job.updated_at,
        budget_ms: job.budget_ms,
        budget_source: renderBudgetSource(job),
        model: job.model,
        thinking_effort_requested: job.thinking_effort ?? null,
        kimi_session_id: job.kimi_session_id,
        kimi_session_id_source: job.kimi_session_id_source,
        hook_escapes: parseHookEscapes(job.hook_escapes),
        error: job.error,
    };
}
function taskView(task, job, status, result, statusMessage) {
    return {
        taskId: task.task_id,
        status,
        ...(statusMessage ? { statusMessage } : {}),
        createdAt: task.created_at,
        lastUpdatedAt: job?.updated_at ?? task.updated_at,
        ttlMs: null,
        pollIntervalMs: 2_000,
        ...(result ? { result: { resultType: "complete", ...result } } : {}),
    };
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
