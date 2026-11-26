import { realpath } from "node:fs/promises";
import { RuntimeError } from "../errors.js";
export async function assertMcpJobBinding(task, job) {
    if (!job)
        throw bindingError(task, "The supervised job row does not exist.");
    if (job.job_id !== task.task_id)
        throw bindingError(task, "Task and job IDs differ.");
    if (job.operation_kind !== task.operation_kind)
        throw bindingError(task, "Task and job operation kinds differ.");
    if (job.repo_id !== task.repo_id)
        throw bindingError(task, "Task and job repositories differ.");
    if (job.background)
        throw bindingError(task, "Supervised MCP jobs must retain foreground companion ownership.");
    if (job.status === "running" && (task.companion_pid === null || job.pid !== task.companion_pid)) {
        throw bindingError(task, "Task and job companion process IDs differ or are missing.");
    }
    let jobCwd;
    try {
        jobCwd = await realpath(job.cwd);
    }
    catch (error) {
        throw bindingError(task, "The job workspace cannot be resolved.", error);
    }
    if (jobCwd !== task.workspace_cwd)
        throw bindingError(task, "Task and job workspaces differ.");
    return job;
}
export function mcpCompanionIdentity(task) {
    return parseIdentity(task.companion_identity, task.companion_pid, task.task_id, task.operation_kind, "companion");
}
export function mcpKimiIdentity(task, job) {
    return parseIdentity(task.kimi_identity, job.kimi_pid, task.task_id, task.operation_kind, "Kimi");
}
export function jobCompanionIdentity(job) {
    return parseIdentity(job.companion_identity ?? null, job.pid, job.job_id, job.operation_kind ?? job.command_type, "companion");
}
export function jobKimiIdentity(job) {
    return parseIdentity(job.kimi_identity ?? null, job.kimi_pid, job.job_id, job.operation_kind ?? job.command_type, "Kimi");
}
function parseIdentity(serialized, expectedPid, jobId, operationKind, label) {
    if (serialized === null)
        return null;
    try {
        const value = JSON.parse(serialized);
        if (!Number.isInteger(value.pid) || (value.pid ?? 0) <= 0 ||
            !Number.isInteger(value.processGroupId) ||
            typeof value.startToken !== "string" || value.startToken.length === 0 ||
            typeof value.state !== "string") {
            throw new Error("invalid identity shape");
        }
        if (expectedPid !== null && expectedPid !== value.pid)
            throw new Error("identity and recorded PID differ");
        return value;
    }
    catch (error) {
        throw new RuntimeError("MCP_JOB_BINDING_FAILED", `The ${label} process identity is invalid.`, "mcp.binding", {
            ...(error instanceof Error ? { cause: error } : {}),
            details: { job_id: jobId, operation_kind: operationKind },
        });
    }
}
function bindingError(task, message, cause) {
    return new RuntimeError("MCP_JOB_BINDING_FAILED", message, "mcp.binding", {
        ...(cause instanceof Error ? { cause } : {}),
        details: { job_id: task.task_id, operation_kind: task.operation_kind },
    });
}
