import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, open, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeError } from "../errors.js";
import { preferStableNodePath } from "../hooks/install-paths.js";
import { JobStore } from "../job-store.js";
import { markJobFailed } from "../jobs.js";
import { resolveKimiHome } from "../kimi-home.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { readProcessIdentity, revalidateProcessIdentities, } from "../process-tree.js";
import { assertMcpJobBinding, mcpCompanionIdentity } from "./binding.js";
import { resolveMcpWorkspace } from "./workspace.js";
const compiled = import.meta.url.endsWith(".js");
const companionEntrypoint = fileURLToPath(new URL(compiled ? "../companion.js" : "../companion.ts", import.meta.url));
const companionProjectRoot = path.resolve(path.dirname(companionEntrypoint), "..");
export async function launchMcpOperation(invocation, env, options) {
    const attachTimeoutMs = options?.attachTimeoutMs ?? 60_000;
    const readIdentity = options?.identityReader ?? readProcessIdentity;
    let preserveStartingTask = false;
    const attachDeadline = Date.now() + attachTimeoutMs;
    const paths = resolvePluginPaths(env);
    await ensurePluginPaths(paths);
    const workspace = await resolveMcpWorkspace(env, invocation.workspace);
    const taskId = randomUUID();
    const stdoutPath = path.join(paths.logsDir, `mcp-${taskId}.stdout.log`);
    const stderrPath = path.join(paths.logsDir, `mcp-${taskId}.stderr.log`);
    const store = new JobStore(paths);
    let child;
    let stdoutHandle;
    let stderrHandle;
    let exited;
    let spawnError;
    try {
        const task = store.createMcpTask({
            task_id: taskId,
            operation_kind: invocation.operationKind,
            repo_id: workspace.repo.repoId,
            workspace_cwd: workspace.cwd,
            stdout_path: stdoutPath,
            stderr_path: stderrPath,
        });
        stdoutHandle = await open(stdoutPath, "wx", 0o600);
        stderrHandle = await open(stderrPath, "wx", 0o600);
        const nodeBinary = await resolveNodeBinary(env);
        const args = compiled
            ? [companionEntrypoint, "mcp-child", taskId, ...invocation.argv]
            : ["--import", "tsx", companionEntrypoint, "mcp-child", taskId, ...invocation.argv];
        const childEnv = sanitizedChildEnv(env, paths, workspace.cwd);
        child = spawn(nodeBinary, args, {
            cwd: companionProjectRoot,
            detached: process.platform !== "win32",
            stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
            env: childEnv,
        });
        child.once("error", (error) => { spawnError = error; });
        child.once("close", (code, signal) => { exited = { code, signal }; });
        if (child.pid !== undefined) {
            const identity = await readIdentity(child.pid);
            store.updateMcpTask(taskId, {
                companion_pid: child.pid,
                ...(identity ? { companion_identity: JSON.stringify(identity) } : {}),
            });
        }
        await stdoutHandle.close();
        await stderrHandle.close();
        stdoutHandle = undefined;
        stderrHandle = undefined;
        for (;;) {
            if (spawnError)
                throw await markLaunchFailure(store, task, spawnError);
            const job = store.getJob(taskId);
            if (job && (job.status !== "running" || job.phase === "turn-running" || job.phase === "worker-running")) {
                const currentTask = store.getMcpTask(taskId) ?? task;
                await assertMcpJobBinding(currentTask, job);
                let identity;
                if (job.status === "running") {
                    const expected = mcpCompanionIdentity(currentTask);
                    if (expected) {
                        const validation = await revalidateProcessIdentities([expected], {
                            identityReader: options?.identityReader,
                        });
                        if (!validation.complete) {
                            preserveStartingTask = true;
                            throw new RuntimeError("MCP_PROCESS_IDENTITY_UNAVAILABLE", "The attachment identity probe was inconclusive; the launch record was preserved.", "mcp.launch", { details: { job_id: taskId, operation_kind: invocation.operationKind } });
                        }
                        if (validation.identities.length === 0) {
                            preserveStartingTask = true;
                            throw new RuntimeError("MCP_PROCESS_IDENTITY_MISMATCH", "The recorded companion process identity changed before attachment; no process was adopted and the launch record was preserved.", "mcp.launch", { details: { job_id: taskId, operation_kind: invocation.operationKind } });
                        }
                        identity = validation.identities[0];
                    }
                    else if (child.pid !== undefined) {
                        identity = await readIdentity(child.pid);
                    }
                }
                const attached = store.updateMcpTask(taskId, {
                    launch_state: "attached",
                    attached_at: new Date().toISOString(),
                    ...(identity ? { companion_identity: JSON.stringify(identity) } : {}),
                });
                child.unref();
                return { task: attached, job };
            }
            if (exited) {
                const diagnostic = await readTail(stderrPath);
                const error = new RuntimeError("MCP_CHILD_LAUNCH_FAILED", `The companion exited before creating its job (code ${exited.code ?? "unknown"}${exited.signal ? `, signal ${exited.signal}` : ""}).${diagnostic ? `\n${diagnostic}` : ""}`, "mcp.launch", { details: { job_id: taskId, operation_kind: invocation.operationKind, exit_code: exited.code, signal: exited.signal } });
                throw await markLaunchFailure(store, task, error, diagnostic);
            }
            if (Date.now() >= attachDeadline) {
                const aborted = await abortMcpLaunch(store, paths, task, job, attachTimeoutMs, options?.identityReader);
                if ("result" in aborted) {
                    child.unref();
                    return aborted.result;
                }
                preserveStartingTask = aborted.preserveStarting;
                throw aborted.error;
            }
            await sleep(25);
        }
    }
    catch (error) {
        if (!preserveStartingTask && store.getMcpTask(taskId)?.launch_state === "starting") {
            store.updateMcpTask(taskId, {
                launch_state: "exited",
                launch_error: (error instanceof Error ? error.message : String(error)).slice(-8_000),
            });
        }
        child?.unref();
        throw error;
    }
    finally {
        store.close();
        await stdoutHandle?.close().catch(() => undefined);
        await stderrHandle?.close().catch(() => undefined);
    }
}
async function abortMcpLaunch(store, paths, task, job, timeoutMs, identityReader) {
    let signalDelivered = false;
    let preserveStarting = true;
    try {
        const current = store.getMcpTask(task.task_id) ?? task;
        const identity = mcpCompanionIdentity(current);
        if (identity) {
            const validation = await revalidateProcessIdentities([identity], { identityReader });
            if (!validation.complete) {
                throw new RuntimeError("MCP_PROCESS_IDENTITY_UNAVAILABLE", "The companion identity probe was inconclusive; no signal was sent and the launch record was preserved.", "mcp.launch", { details: { job_id: task.task_id, operation_kind: task.operation_kind } });
            }
            if (validation.identities.length === 0) {
                throw new RuntimeError("MCP_PROCESS_IDENTITY_MISMATCH", "The recorded companion process identity no longer matches; no signal was sent and the launch record was preserved.", "mcp.launch", { details: { job_id: task.task_id, operation_kind: task.operation_kind } });
            }
            signalVerifiedIdentity(identity, "SIGTERM");
            signalDelivered = true;
            await sleep(1_500);
            const remaining = await revalidateProcessIdentities([identity], { identityReader });
            if (!remaining.complete) {
                const error = new RuntimeError("MCP_PROCESS_IDENTITY_UNAVAILABLE", "The post-signal companion identity probe was inconclusive; the launch record was preserved.", "mcp.launch", { details: { job_id: task.task_id, operation_kind: task.operation_kind } });
                if (job) {
                    await assertMcpJobBinding(current, job);
                    return { result: { task: current, job } };
                }
                return { error, preserveStarting };
            }
            if (remaining.identities.length > 0) {
                signalVerifiedIdentity(identity, "SIGKILL");
            }
            preserveStarting = false;
        }
        const error = new RuntimeError("MCP_LAUNCH_TIMEOUT", `The companion did not become cancellation-ready within ${timeoutMs}ms.${signalDelivered ? " The companion was signalled." : " No verified process identity was available, so no signal was sent."}`, "mcp.launch", { details: { job_id: task.task_id, operation_kind: task.operation_kind, timeout_ms: timeoutMs, signal_delivered: signalDelivered } });
        if (signalDelivered) {
            if (job) {
                await markJobFailed(store, paths, job, error, "MCP launch timed out before cancellation was ready.", { phase: "failed" });
            }
            return { error: await markLaunchFailure(store, current, error), preserveStarting };
        }
        if (job) {
            await assertMcpJobBinding(current, job);
            return { result: { task: current, job } };
        }
        return { error, preserveStarting };
    }
    catch (error) {
        return { error: error instanceof Error ? error : new Error(String(error)), preserveStarting };
    }
}
function signalVerifiedIdentity(identity, signal) {
    try {
        process.kill(identity.processGroupId === identity.pid ? -identity.processGroupId : identity.pid, signal);
    }
    catch (error) {
        const code = error.code;
        if (code !== "ESRCH")
            throw error;
    }
}
async function resolveNodeBinary(env) {
    const override = env.KIMI_PLUGIN_CC_NODE_BIN;
    const binary = override ? override : preferStableNodePath(process.execPath);
    if (binary.includes("/") || binary.includes("\\")) {
        try {
            await access(binary, fsConstants.X_OK);
        }
        catch (error) {
            throw new RuntimeError("MCP_NODE_BIN_INVALID", `Configured Node binary is not executable: ${binary}`, "mcp.launch", {
                cause: error instanceof Error ? error : undefined,
            });
        }
    }
    return binary;
}
function sanitizedChildEnv(env, paths, workspace) {
    return {
        ...env,
        KIMI_PLUGIN_CC_WORKSPACE_CWD: workspace,
        KIMI_PLUGIN_CC_MCP_WORKSPACE: workspace,
        KIMI_PLUGIN_CC_DATA: path.resolve(paths.claudePluginData),
        KIMI_CODE_HOME: resolveKimiHome(env, workspace),
        KIMI_PLUGIN_CC_WORKSPACE_ROOT: undefined,
        KIMI_PLUGIN_CC_CMD: undefined,
        KIMI_PLUGIN_CC_OPERATION: undefined,
        KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: undefined,
        KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: undefined,
        KIMI_CODE_TRUST_WORKSPACE: undefined,
        KIMI_CODE_EXPERIMENTAL_FLAG: undefined,
    };
}
async function markLaunchFailure(store, task, error, diagnostic) {
    const failure = error instanceof Error ? error : new Error(String(error));
    store.updateMcpTask(task.task_id, {
        launch_state: "exited",
        launch_error: (diagnostic || failure.message).slice(-8_000),
    });
    return failure;
}
async function readTail(filePath, maximum = 8_000) {
    try {
        const info = await stat(filePath);
        const handle = await open(filePath, "r");
        try {
            const length = Math.min(maximum, info.size);
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, Math.max(0, info.size - length));
            return buffer.toString("utf8").trim();
        }
        finally {
            await handle.close();
        }
    }
    catch {
        return "";
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
