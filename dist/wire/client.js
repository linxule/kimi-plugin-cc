import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { RuntimeError, formatError } from "../errors.js";
import { TurnEventBuffer } from "./event-buffer.js";
export class WireClient {
    cwd;
    env;
    command;
    args;
    logPath;
    approvalDispatcher;
    child;
    // closed latches true the first time close() is called. Guards the race where
    // start() is mid-flight (e.g. awaiting mkdir or the spawn event) and close()
    // is invoked before this.child has been assigned — start() checks this.closed
    // at each async boundary and, if a child has already been spawn()ed but not
    // yet bound to this.child, kills it in the "spawn" handler.
    closed = false;
    pendingRequests = new Map();
    currentTurn;
    currentCommandType;
    nextRequestId = 0;
    stderrBuffer = "";
    stdoutBuffer = "";
    suppressExitError = false;
    approvalFailure;
    rejectApprovals = false;
    processingChain = Promise.resolve();
    constructor(options) {
        this.cwd = options.cwd;
        this.env = { ...process.env, ...options.env };
        this.command = options.command ?? "kimi";
        this.args = options.args ?? ["--wire"];
        this.logPath = options.logPath;
        this.approvalDispatcher = options.approvalDispatcher;
    }
    async start() {
        if (this.closed) {
            throw new RuntimeError("WIRE_CLIENT_CLOSED", "Cannot start a closed wire client.", "wire.start");
        }
        if (this.child) {
            return;
        }
        this.suppressExitError = false;
        if (this.logPath) {
            await mkdir(path.dirname(this.logPath), { recursive: true });
        }
        // Re-check after mkdir — close() may have latched the flag while we awaited.
        if (this.closed) {
            throw new RuntimeError("WIRE_CLIENT_CLOSED", "Wire client was closed during startup.", "wire.start");
        }
        await new Promise((resolve, reject) => {
            const child = spawn(this.command, this.args, {
                cwd: this.cwd,
                env: this.env,
                stdio: ["pipe", "pipe", "pipe"],
            });
            let settled = false;
            child.once("spawn", () => {
                if (settled) {
                    return;
                }
                // If close() was called between the outer reject-of-start (e.g. via
                // withTimeout) and the "spawn" event firing, the child exists but we
                // never attached it to this.child. Kill it here to avoid a zombie and
                // reject the start promise.
                if (this.closed) {
                    settled = true;
                    try {
                        child.kill("SIGTERM");
                    }
                    catch {
                        // best-effort — child may already be dying
                    }
                    reject(new RuntimeError("WIRE_CLIENT_CLOSED", "Wire client was closed during spawn.", "wire.start"));
                    return;
                }
                settled = true;
                this.child = child;
                child.stdout.setEncoding("utf8");
                child.stdout.on("data", (chunk) => {
                    this.stdoutBuffer += chunk;
                    this.processingChain = this.processingChain.then(() => this.handleStdoutBuffer());
                });
                child.stderr.on("data", (chunk) => {
                    const text = chunk.toString("utf8");
                    this.stderrBuffer += text;
                    void this.logWire("stderr", text.trimEnd());
                });
                // Use 'close' rather than 'exit' to guarantee all buffered stdout data
                // has been delivered before we reject pending requests. 'exit' can fire
                // while the stdio streams still hold the final JSON-RPC response.
                child.once("close", (code, signal) => {
                    this.handleExit(code, signal);
                });
                resolve();
            });
            child.once("error", (error) => {
                if (!settled) {
                    reject(new RuntimeError("WIRE_SPAWN_FAILED", `Failed to start ${this.command}: ${formatError(error)}`, "wire.start", { cause: error }));
                }
            });
        });
    }
    async close() {
        // Latch the flag FIRST so any in-flight start() sees it at the next await
        // boundary (post-mkdir re-check, or the "spawn" event handler).
        this.closed = true;
        if (!this.child) {
            return;
        }
        const child = this.child;
        this.suppressExitError = true;
        this.child = undefined;
        this.rejectAll(new RuntimeError("WIRE_CLIENT_CLOSED", "Wire client closed.", "wire.close"));
        child.stdin.end();
        await new Promise((resolve) => {
            let resolved = false;
            const finish = () => {
                if (!resolved) {
                    resolved = true;
                    resolve();
                }
            };
            child.once("exit", finish);
            child.kill("SIGTERM");
            setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) {
                    child.kill("SIGKILL");
                }
                finish();
            }, 1000);
        });
    }
    async initialize(params) {
        return this.sendRequest("initialize", params);
    }
    async prompt(userInput, commandType) {
        this.currentTurn = new TurnEventBuffer();
        this.currentCommandType = commandType;
        this.approvalFailure = undefined;
        this.rejectApprovals = false;
        try {
            const result = await this.sendRequest("prompt", { user_input: userInput });
            if (this.approvalFailure) {
                throw this.approvalFailure;
            }
            return this.currentTurn.finalize(result);
        }
        finally {
            this.currentTurn = undefined;
            this.currentCommandType = undefined;
            this.approvalFailure = undefined;
        }
    }
    async cancel() {
        return this.sendRequest("cancel", {});
    }
    beginCancellation() {
        this.rejectApprovals = true;
    }
    terminateChild(signal = "SIGTERM") {
        if (!this.child) {
            return;
        }
        if (this.child.exitCode === null && this.child.signalCode === null) {
            this.child.kill(signal);
        }
    }
    getStderrBuffer() {
        return this.stderrBuffer;
    }
    getChildPid() {
        return this.child?.pid ?? null;
    }
    async sendRequest(method, params) {
        if (!this.child) {
            throw new RuntimeError("WIRE_NOT_STARTED", "Wire client was used before start().", "wire.request");
        }
        const id = String(++this.nextRequestId);
        const request = {
            jsonrpc: "2.0",
            method,
            id,
            params,
        };
        await this.logWire("out", request);
        const responsePromise = new Promise((resolve, reject) => {
            this.pendingRequests.set(id, {
                resolve: (value) => resolve(value),
                reject,
            });
        });
        this.child.stdin.write(`${JSON.stringify(request)}\n`);
        return responsePromise;
    }
    async handleLine(line) {
        if (!line.trim()) {
            return;
        }
        await this.logWire("in", line);
        let message;
        try {
            message = JSON.parse(line);
        }
        catch (error) {
            this.rejectAll(new RuntimeError("WIRE_INVALID_JSON", `Failed to parse Wire JSON line: ${formatError(error)}`, "wire.read", { cause: error }));
            return;
        }
        if ("method" in message) {
            if (message.method === "event") {
                this.currentTurn?.observeEvent(message.params.type, message.params.payload);
                return;
            }
            if (message.method === "request") {
                await this.handleWireRequest(message);
            }
            return;
        }
        const pending = this.pendingRequests.get(message.id);
        if (!pending) {
            return;
        }
        this.pendingRequests.delete(message.id);
        if ("error" in message) {
            pending.reject(new RuntimeError("WIRE_REQUEST_FAILED", `${message.error.message} (code ${message.error.code})`, "wire.request"));
            return;
        }
        pending.resolve(message.result);
    }
    async handleStdoutBuffer() {
        while (this.stdoutBuffer.includes("\n")) {
            const newlineIndex = this.stdoutBuffer.indexOf("\n");
            const line = this.stdoutBuffer.slice(0, newlineIndex);
            this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
            await this.handleLine(line);
        }
    }
    async handleWireRequest(message) {
        if (!this.child) {
            return;
        }
        try {
            await this.dispatchWireRequest(message);
        }
        catch (error) {
            // Any throw from payload parsing, approval dispatch, or realpath calls in the policy must
            // still unblock Kimi. Send a JSON-RPC error response so the peer drops the pending request,
            // and stash the failure so prompt() surfaces it to the command layer.
            this.approvalFailure =
                error instanceof RuntimeError
                    ? error
                    : new RuntimeError("APPROVAL_DISPATCHER_FAILED", `Approval dispatcher threw: ${formatError(error)}`, "wire.approval", error instanceof Error ? { cause: error } : undefined);
            if (this.child) {
                const errorResponse = {
                    jsonrpc: "2.0",
                    id: message.id,
                    error: {
                        code: -32603,
                        message: this.approvalFailure.message,
                    },
                };
                await this.logWire("out", errorResponse).catch(() => { });
                try {
                    this.child.stdin.write(`${JSON.stringify(errorResponse)}\n`);
                }
                catch {
                    // stdin may already be closed during cancellation; ignore.
                }
            }
        }
    }
    async dispatchWireRequest(message) {
        if (!this.child) {
            return;
        }
        if (message.params.type !== "ApprovalRequest") {
            const error = {
                jsonrpc: "2.0",
                id: message.id,
                error: {
                    code: -32601,
                    message: `${message.params.type} is not supported by the plugin runtime.`,
                },
            };
            await this.logWire("out", error);
            this.child.stdin.write(`${JSON.stringify(error)}\n`);
            return;
        }
        if (!this.currentCommandType) {
            throw new RuntimeError("WIRE_PROTOCOL_ERROR", "Received an ApprovalRequest outside an active command turn.", "wire.approval");
        }
        const payload = parseApprovalRequestPayload(message.params.payload);
        const decision = this.rejectApprovals
            ? {
                response: "reject",
                feedback: "Command cancellation is in progress.",
            }
            : await this.approvalDispatcher.handle(payload, {
                commandType: this.currentCommandType,
            });
        const finalDecision = this.rejectApprovals && decision.response !== "reject"
            ? {
                response: "reject",
                feedback: "Command cancellation is in progress.",
            }
            : decision;
        const response = {
            jsonrpc: "2.0",
            id: message.id,
            result: {
                request_id: payload.id,
                response: finalDecision.response,
                ...(finalDecision.feedback ? { feedback: finalDecision.feedback } : {}),
            },
        };
        if (finalDecision.response === "reject") {
            this.approvalFailure = new RuntimeError("APPROVAL_REJECTED", finalDecision.feedback ?? `Approval rejected for ${payload.action}.`, "wire.approval");
        }
        await this.logWire("out", response);
        this.child.stdin.write(`${JSON.stringify(response)}\n`);
    }
    handleExit(code, signal) {
        if (this.suppressExitError) {
            return;
        }
        const stderr = this.stderrBuffer.trim();
        const message = stderr
            ? `Wire process exited unexpectedly (code=${String(code)}, signal=${String(signal)}). ${stderr}`
            : `Wire process exited unexpectedly (code=${String(code)}, signal=${String(signal)}).`;
        this.rejectAll(new RuntimeError("WIRE_PROCESS_EXITED", message, "wire.process"));
    }
    rejectAll(error) {
        for (const pending of this.pendingRequests.values()) {
            pending.reject(error);
        }
        this.pendingRequests.clear();
    }
    async logWire(direction, message) {
        if (!this.logPath) {
            return;
        }
        const entry = {
            ts: new Date().toISOString(),
            direction,
            message,
        };
        try {
            await appendFile(this.logPath, `${JSON.stringify(entry)}\n`, "utf8");
        }
        catch (error) {
            // If the log directory was removed mid-run (e.g. the user nuked ${CLAUDE_PLUGIN_DATA}),
            // recreate it once and retry so the turn doesn't disappear into the filesystem. Other
            // failures are swallowed since logging must not take down the hot path.
            if (error.code === "ENOENT") {
                try {
                    await mkdir(path.dirname(this.logPath), { recursive: true });
                    await appendFile(this.logPath, `${JSON.stringify(entry)}\n`, "utf8");
                }
                catch {
                    // Intentional: best-effort.
                }
            }
        }
    }
}
function parseApprovalRequestPayload(payload) {
    if (typeof payload.id !== "string" ||
        typeof payload.sender !== "string" ||
        typeof payload.action !== "string" ||
        typeof payload.description !== "string" ||
        !Array.isArray(payload.display)) {
        throw new RuntimeError("WIRE_PROTOCOL_ERROR", "Received an ApprovalRequest with an invalid payload shape.", "wire.approval");
    }
    return payload;
}
