import { formatError, RuntimeError } from "../errors.js";
import { KIMI_PLUGIN_CC_VERSION } from "../version.js";
import { cancelMcpJob, getMcpJobResult, getMcpJobStatus, getMcpTaskView } from "./job-control.js";
import { launchMcpOperation } from "./launcher.js";
import { buildMcpOperationInvocation, isMcpModelToolName, MCP_TOOL_DEFINITIONS, } from "./operations.js";
import { textResult } from "./tool-result.js";
const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_META = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";
const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";
export function createMcpMessageHandler(env) {
    let mode;
    return async (message) => {
        let requestId = isRecord(message) && "id" in message &&
            (typeof message.id === "string" || typeof message.id === "number" || message.id === null)
            ? message.id
            : null;
        try {
            const request = parseRequest(message);
            if (!request)
                return undefined;
            requestId = request.id;
            const { id, method, params } = request;
            if (method === "server/discover") {
                requireModernMetadata(params);
                mode = "modern";
                return response(id, {
                    resultType: "complete",
                    supportedVersions: [MODERN_VERSION],
                    capabilities: { tools: {}, extensions: { [TASKS_EXTENSION]: {} } },
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
                    capabilities: { tools: {} },
                    serverInfo: { name: "kimi-plugin-cc", version: KIMI_PLUGIN_CC_VERSION },
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
                case "tools/call":
                    return response(id, await callTool(env, params, modern, capabilities));
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
                        await cancelMcpJob(env, { job_id: taskId });
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
    };
}
async function callTool(env, params, modern, capabilities) {
    const name = params.name;
    if (typeof name !== "string")
        throw rpcError(-32_602, "tools/call requires a tool name");
    try {
        let result;
        if (isMcpModelToolName(name)) {
            const launched = await launchMcpOperation(buildMcpOperationInvocation(name, params.arguments), env);
            if (modern && hasTasksCapability(capabilities))
                return taskHandle(launched);
            result = launched.job.status === "running"
                ? launchResult(launched)
                : await getMcpJobResult(env, { job_id: launched.task.task_id });
        }
        else {
            switch (name) {
                case "kimi_job_status":
                    result = await getMcpJobStatus(env, params.arguments);
                    break;
                case "kimi_job_result":
                    result = await getMcpJobResult(env, params.arguments);
                    break;
                case "kimi_job_cancel":
                    result = await cancelMcpJob(env, params.arguments);
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
    return textResult(`Started ${task.operation_kind} job ${task.task_id}. This is a launch handle, not the finished answer. Use kimi_job_status and kimi_job_result with this job_id until the job is terminal; use kimi_job_cancel to stop it.`, metadata);
}
function taskHandle({ task, job }) {
    return {
        resultType: "task",
        taskId: task.task_id,
        status: job.status === "running" ? "working" : job.status === "cancelled" ? "cancelled" : "completed",
        ...(job.status === "running" ? { statusMessage: `${task.operation_kind}: ${job.phase ?? "running"}` } : job.summary ? { statusMessage: job.summary } : {}),
        createdAt: task.created_at,
        lastUpdatedAt: job.updated_at,
        ttlMs: null,
        pollIntervalMs: 2_000,
    };
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
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
