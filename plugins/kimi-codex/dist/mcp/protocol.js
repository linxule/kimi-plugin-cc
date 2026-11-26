import { formatError, RuntimeError } from "../errors.js";
import { isRecord } from "../util.js";
import { KIMI_PLUGIN_CC_VERSION } from "../version.js";
import { awaitMcpJob, cancelMcpJob, getMcpJobResult, getMcpTaskView, handleMcpJobTool, handleMcpSetupTool, taskView, } from "./job-control.js";
import { launchMcpOperation } from "./launcher.js";
import { buildMcpOperationInvocation, isMcpModelToolName, MCP_TOOL_DEFINITIONS, } from "./operations.js";
import { getMcpSkill, listMcpResources, listMcpSkills, readMcpResource } from "./skills.js";
import { textResult } from "./tool-result.js";
const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_META = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";
const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";
export const MCP_SERVER_INSTRUCTIONS = [
    "Read the `kimi` skill (`skill://kimi/SKILL.md`) via resources/read before complex Kimi orchestration.",
    "Use `kimi_read` (ask, review, challenge, swarm) for read-only analysis and `kimi_write` (rescue, pursue, swarm_patch) for workspace-confined edits or worktree patches; never mutates Git.",
    "Standard `kimi_read` and `kimi_write` calls wait for completion by default; pass `wait: false` for parallel fan-out and inspect/await/cancel via `kimi_job`.",
    "Run `kimi_setup` to verify or repair the Kimi PreToolUse safety hook (`check` / `install`), list model aliases (`models`), install a certified Kimi CLI (`install_kimi`), or repair session titles (`repair_sessions`).",
    "If a result includes a `Warnings:` block (such as uncertified releases or disabled trust), relay those warnings to the user.",
].join(" ");
function requestAbortKey(id) {
    return typeof id === "number" ? `n:${id}` : `s:${id}`;
}
export function createMcpMessageHandler(env) {
    let mode;
    const inFlight = new Map();
    return async (message, transportSignal) => {
        // Handle notifications/cancelled before parseRequest drops notifications.
        // Cancelling an MCP request aborts in-flight wait polling without cancelling
        // any durable Kimi job.
        if (isRecord(message) &&
            message.jsonrpc === "2.0" &&
            message.method === "notifications/cancelled" &&
            !("id" in message)) {
            const params = isRecord(message.params) ? message.params : undefined;
            const cancelledId = params?.requestId;
            if (typeof cancelledId === "string" ||
                (typeof cancelledId === "number" && Number.isFinite(cancelledId))) {
                inFlight.get(requestAbortKey(cancelledId))?.abort();
            }
            return undefined;
        }
        let requestId = isRecord(message) && "id" in message &&
            (typeof message.id === "string" || typeof message.id === "number" || message.id === null)
            ? message.id
            : null;
        let trackedKey;
        const requestAbort = new AbortController();
        const callSignal = transportSignal
            ? AbortSignal.any([transportSignal, requestAbort.signal])
            : requestAbort.signal;
        try {
            const request = parseRequest(message);
            if (!request)
                return undefined;
            requestId = request.id;
            if (request.id !== null) {
                trackedKey = requestAbortKey(request.id);
                inFlight.set(trackedKey, requestAbort);
            }
            const { id, method, params } = request;
            if (method === "server/discover") {
                requireModernMetadata(params);
                mode = "modern";
                return response(id, {
                    resultType: "complete",
                    supportedVersions: [MODERN_VERSION],
                    capabilities: {
                        tools: {},
                        resources: {},
                        extensions: { [TASKS_EXTENSION]: {}, [SKILLS_EXTENSION]: {} },
                    },
                    instructions: MCP_SERVER_INSTRUCTIONS,
                    _meta: { [SERVER_INFO_META]: { name: "kimi-plugin-cc", version: KIMI_PLUGIN_CC_VERSION } },
                    ttlMs: 0,
                    cacheScope: "private",
                });
            }
            if (method === "initialize") {
                const requested = params.protocolVersion;
                if (typeof requested !== "string" || !LEGACY_VERSIONS.has(requested)) {
                    throw rpcError(-32_602, "Unsupported protocol version", { supportedVersions: [...LEGACY_VERSIONS] });
                }
                mode = "legacy";
                return response(id, {
                    protocolVersion: requested,
                    capabilities: { tools: {}, resources: {}, experimental: { skills: {} } },
                    serverInfo: { name: "kimi-plugin-cc", version: KIMI_PLUGIN_CC_VERSION },
                    instructions: MCP_SERVER_INSTRUCTIONS,
                });
            }
            if (method === "notifications/initialized")
                return undefined;
            if (method.startsWith("notifications/"))
                return undefined;
            if (!mode && hasModernVersion(params))
                mode = "modern";
            if (!mode)
                throw rpcError(-32_002, "Server is not initialized");
            const modern = requireProtocolMode(mode, method);
            const capabilities = modern ? requireModernMetadata(params) : undefined;
            switch (method) {
                case "ping":
                    return response(id, modern ? { resultType: "complete" } : {});
                case "tools/list":
                    return response(id, modern
                        ? { resultType: "complete", tools: MCP_TOOL_DEFINITIONS, ttlMs: 0, cacheScope: "private" }
                        : { tools: MCP_TOOL_DEFINITIONS });
                case "tools/call": {
                    const toolResult = await callTool(env, params, modern, capabilities, callSignal);
                    if (toolResult === undefined)
                        return undefined;
                    return response(id, toolResult);
                }
                case "resources/list": {
                    const list = await listMcpResources();
                    return response(id, modern ? { resultType: "complete", ...list, ttlMs: 0, cacheScope: "private" } : list);
                }
                case "resources/read": {
                    if (typeof params.uri !== "string" || params.uri.length === 0) {
                        throw rpcError(-32_602, "resources/read requires a non-empty string uri");
                    }
                    const content = await readMcpResource(params.uri);
                    if (!content) {
                        throw rpcError(-32_602, `Unknown resource URI: ${params.uri}`);
                    }
                    return response(id, modern ? { resultType: "complete", ...content, ttlMs: 0, cacheScope: "private" } : content);
                }
                case "skills/list": {
                    const skills = await listMcpSkills();
                    return response(id, modern ? { resultType: "complete", ...skills, ttlMs: 0, cacheScope: "private" } : skills);
                }
                case "skills/get": {
                    if (typeof params.uri !== "string" || params.uri.length === 0) {
                        throw rpcError(-32_602, "skills/get requires a non-empty string uri");
                    }
                    const skill = await getMcpSkill(params.uri);
                    if (!skill) {
                        throw rpcError(-32_602, `Unknown skill URI: ${params.uri}`);
                    }
                    return response(id, modern ? { resultType: "complete", ...skill, ttlMs: 0, cacheScope: "private" } : skill);
                }
                case "tasks/get": {
                    requireModern(method, modern);
                    requireTasksCapability(method, capabilities);
                    const taskId = requiredTaskId(params);
                    try {
                        const view = await getMcpTaskView(env, { job_id: taskId });
                        return response(id, { resultType: "complete", ...view });
                    }
                    catch (error) {
                        if (error instanceof RuntimeError && error.code === "JOB_NOT_FOUND") {
                            throw rpcError(-32_602, `Unknown task ID: ${taskId}`);
                        }
                        throw error;
                    }
                }
                case "tasks/cancel": {
                    requireModern(method, modern);
                    requireTasksCapability(method, capabilities);
                    const taskId = requiredTaskId(params);
                    try {
                        await cancelMcpJob(env, { job_id: taskId }, { requireMcpTask: true });
                        return response(id, { resultType: "complete" });
                    }
                    catch (error) {
                        if (error instanceof RuntimeError && error.code === "JOB_NOT_FOUND") {
                            throw rpcError(-32_602, `Unknown task ID: ${taskId}`);
                        }
                        throw error;
                    }
                }
                default:
                    throw rpcError(-32_601, `Method not found: ${method}`);
            }
        }
        catch (error) {
            if (isRpcError(error))
                return response(requestId, undefined, error);
            if (error instanceof RuntimeError) {
                return response(requestId, undefined, rpcError(-32_603, formatError(error), error.details));
            }
            return response(requestId, undefined, rpcError(-32_603, error instanceof Error ? error.message : String(error)));
        }
        finally {
            if (trackedKey !== undefined && inFlight.get(trackedKey) === requestAbort) {
                inFlight.delete(trackedKey);
            }
        }
    };
}
async function callTool(env, params, modern, capabilities, signal) {
    const name = params.name;
    if (typeof name !== "string")
        throw rpcError(-32_602, "tools/call requires a tool name");
    try {
        let result;
        if (isMcpModelToolName(name)) {
            const invocation = buildMcpOperationInvocation(name, params.arguments);
            const launched = await launchMcpOperation(invocation, env);
            if (modern && hasTasksCapability(capabilities))
                return taskHandle(launched);
            if (!invocation.wait) {
                result = launchResult(launched);
            }
            else if (launched.job.status === "running") {
                if (signal?.aborted)
                    return undefined;
                result = await awaitMcpJob(env, {
                    jobId: launched.task.task_id,
                    workspace: launched.task.workspace_cwd,
                    waitTimeoutMs: invocation.waitTimeoutMs,
                    signal,
                });
                if (signal?.aborted && result.structuredContent?.wait_aborted === true) {
                    return undefined;
                }
            }
            else {
                result = await getMcpJobResult(env, {
                    job_id: launched.task.task_id,
                    workspace: launched.task.workspace_cwd,
                });
            }
        }
        else {
            switch (name) {
                case "kimi_job":
                    result = await handleMcpJobTool(env, params.arguments, signal);
                    if (signal?.aborted && result.structuredContent?.wait_aborted === true) {
                        return undefined;
                    }
                    break;
                case "kimi_setup":
                    result = await handleMcpSetupTool(env, params.arguments);
                    break;
                default:
                    throw rpcError(-32_602, `Unknown tool: ${name}`);
            }
        }
        return modern ? { resultType: "complete", ...result } : result;
    }
    catch (error) {
        if (isRpcError(error))
            throw error;
        if (error instanceof RuntimeError) {
            const result = textResult(formatError(error), {
                error: { code: error.code, stage: error.stage, details: error.details },
            }, true);
            return modern ? { resultType: "complete", ...result } : result;
        }
        throw error;
    }
}
function launchResult(launched) {
    const { task, job } = launched;
    const metadata = {
        job_id: task.task_id,
        operation_kind: task.operation_kind,
        workspace: task.workspace_cwd,
        status: job.status,
        phase: job.phase,
        created_at: task.created_at,
    };
    return textResult(`Started ${task.operation_kind} job ${task.task_id}. Use kimi_job({ action: "wait", job_id: ${JSON.stringify(task.task_id)} }) or action="result" when terminal, and action="cancel" to stop it.`, metadata);
}
function taskHandle({ task, job }) {
    const status = job.status === "running" ? "working" : job.status === "cancelled" ? "cancelled" : "completed";
    const statusMessage = job.status === "running" ? `${task.operation_kind}: ${job.phase ?? "running"}` : job.summary;
    return { resultType: "task", ...taskView(task, job, status, undefined, statusMessage) };
}
function parseRequest(message) {
    if (!isRecord(message))
        throw new McpJsonRpcError(-32_600, "Invalid JSON-RPC request");
    if (!("method" in message))
        return undefined;
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string" || message.method.length === 0) {
        throw new McpJsonRpcError(-32_600, "Invalid JSON-RPC request");
    }
    if (!("id" in message))
        return undefined;
    const id = message.id;
    if (id !== null && typeof id !== "string" &&
        (typeof id !== "number" || !Number.isFinite(id))) {
        throw new McpJsonRpcError(-32_600, "Invalid JSON-RPC request ID");
    }
    const params = message.params === undefined ? {} : message.params;
    if (!isRecord(params))
        throw new McpJsonRpcError(-32_602, "Request params must be an object");
    return { id, method: message.method, params };
}
function requireProtocolMode(mode, method) {
    if (mode === "modern")
        return true;
    if (method === "tasks/get" || method === "tasks/cancel") {
        throw new McpJsonRpcError(-32_601, `Method not found: ${method}`);
    }
    return false;
}
function requireModern(method, modern) {
    if (!modern)
        throw new McpJsonRpcError(-32_601, `Method not found: ${method}`);
}
function hasModernVersion(params) {
    return isRecord(params._meta) && params._meta[PROTOCOL_VERSION_META] === MODERN_VERSION;
}
function requireModernMetadata(params) {
    const meta = params._meta;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
        throw new McpJsonRpcError(-32_602, "Modern MCP requests require protocol metadata");
    }
    const record = meta;
    if (record[PROTOCOL_VERSION_META] !== MODERN_VERSION) {
        throw new McpJsonRpcError(-32_022, "Unsupported protocol version", {
            supported: [MODERN_VERSION],
            requested: record[PROTOCOL_VERSION_META],
        });
    }
    if (record[CLIENT_INFO_META] !== undefined && !isRecord(record[CLIENT_INFO_META])) {
        throw new McpJsonRpcError(-32_602, "clientInfo must be an object when supplied");
    }
    if (!isRecord(record[CLIENT_CAPABILITIES_META])) {
        throw new McpJsonRpcError(-32_602, "Modern MCP requests require client capabilities");
    }
    return record[CLIENT_CAPABILITIES_META];
}
function hasTasksCapability(capabilities) {
    if (!capabilities || !isRecord(capabilities.extensions))
        return false;
    return isRecord(capabilities.extensions[TASKS_EXTENSION]);
}
function requireTasksCapability(method, capabilities) {
    if (!hasTasksCapability(capabilities)) {
        throw new McpJsonRpcError(-32_021, "Missing required client capability", {
            requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
        });
    }
}
function requiredTaskId(params) {
    if (typeof params.taskId !== "string" || params.taskId.length === 0 || params.taskId.length > 128 || !/^[\x21-\x7e]+$/.test(params.taskId)) {
        throw new McpJsonRpcError(-32_602, "taskId must be 1-128 printable ASCII characters without spaces");
    }
    return params.taskId;
}
function response(id, result, error) {
    return error ? { jsonrpc: "2.0", id, error: { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) } } : { jsonrpc: "2.0", id, result };
}
function rpcError(code, message, data) {
    return new McpJsonRpcError(code, message, data);
}
class McpJsonRpcError extends Error {
    code;
    data;
    constructor(code, message, data) {
        super(message);
        this.code = code;
        this.data = data;
        this.name = "McpJsonRpcError";
    }
}
function isRpcError(error) {
    return error instanceof McpJsonRpcError || (error instanceof Error && "code" in error && typeof error.code === "number");
}
