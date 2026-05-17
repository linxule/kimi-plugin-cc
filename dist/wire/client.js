import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { RuntimeError, formatError } from "../errors.js";
import { TurnEventBuffer } from "./event-buffer.js";
const DEFAULT_THINK_STALL_MS = 120_000;
const DEFAULT_THINK_LOOP_DUPLICATE_THRESHOLD = 8;
/** Maximum recognized ContentPart subtypes we treat as "forward progress". */
const KNOWN_CONTENT_PART_SUBTYPES = new Set([
    "text",
    "think",
]);
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
    // Think-stall watchdog state (see WireClientOptions.thinkStallMs).
    thinkStallMs;
    thinkLoopDuplicateThreshold;
    thinkStallTimer;
    thinkStalled = false;
    thinkLoopDetected = false;
    thinkPayloadHashes = [];
    // Guards against double `cancel` JSON-RPC requests when /kimi:cancel and
    // the think-stall watchdog fire concurrently (Claude reviewer caught the
    // race in v0.3.1 review). Set when EITHER path issues a wire-side cancel.
    cancelInFlight = false;
    // Forward-compat telemetry: log a warning the first time we see a
    // ContentPart subtype that isn't in KNOWN_CONTENT_PART_SUBTYPES so
    // operators know the watchdog may be miscategorizing it (Kimi
    // adversarial reviewer flagged the `payload.type === "think"`
    // hard-code as a forward-compat hazard).
    warnedUnknownContentPartSubtypes = new Set();
    // v0.3.3 (Claude M3): one-shot warning for payload-shape drift on
    // `type:"think"` ContentParts that lack a recognized text field.
    warnedUnknownThinkPayloadShape = false;
    constructor(options) {
        this.cwd = options.cwd;
        this.env = { ...process.env, ...options.env };
        this.command = options.command ?? "kimi";
        this.args = options.args ?? ["--wire"];
        this.logPath = options.logPath;
        this.approvalDispatcher = options.approvalDispatcher;
        this.thinkStallMs = options.thinkStallMs ?? DEFAULT_THINK_STALL_MS;
        this.thinkLoopDuplicateThreshold =
            options.thinkLoopDuplicateThreshold ?? DEFAULT_THINK_LOOP_DUPLICATE_THRESHOLD;
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
        // v0.3.2: guard against concurrent callers. currentTurn, thinkStalled,
        // and the watchdog timer are single-prompt state — a second concurrent
        // call would clobber the first's turn buffer and timer. Codex reviewer
        // caught this gap in the v0.3.1 watchdog review.
        if (this.currentTurn) {
            throw new RuntimeError("WIRE_PROMPT_CONCURRENT", "Wire client cannot run two prompts concurrently; await the first prompt before calling again.", "wire.prompt");
        }
        this.currentTurn = new TurnEventBuffer();
        this.currentCommandType = commandType;
        this.approvalFailure = undefined;
        this.rejectApprovals = false;
        this.thinkStalled = false;
        this.thinkLoopDetected = false;
        this.cancelInFlight = false;
        this.thinkPayloadHashes = [];
        this.armThinkStallWatchdog();
        try {
            const result = await this.sendRequest("prompt", { user_input: userInput });
            if (this.approvalFailure) {
                throw this.approvalFailure;
            }
            if (this.thinkLoopDetected) {
                throw new RuntimeError("KIMI_THINK_LOOP_DETECTED", `Kimi emitted ${this.thinkLoopDuplicateThreshold} consecutive identical \`think\` payloads; ` +
                    `cancelled to recover the session. Likely an upstream reasoning-loop bug (kimi-cli ≥1.44.0). ` +
                    `Retry with --no-thinking or a more focused prompt.`, "wire.prompt");
            }
            if (this.thinkStalled) {
                throw new RuntimeError("KIMI_THINK_STALLED", `Kimi reasoning stream produced only \`think\` events for over ${this.thinkStallMs}ms; ` +
                    `cancelled to recover the session. Retry with --no-thinking or a more focused prompt.`, "wire.prompt");
            }
            return this.currentTurn.finalize(result);
        }
        finally {
            this.disarmThinkStallWatchdog();
            this.currentTurn = undefined;
            this.currentCommandType = undefined;
            this.approvalFailure = undefined;
        }
    }
    armThinkStallWatchdog() {
        this.disarmThinkStallWatchdog();
        if (this.thinkStallMs <= 0) {
            return;
        }
        this.thinkStallTimer = setTimeout(() => {
            this.thinkStalled = true;
            process.stderr.write(`[kimi-plugin-cc] think-stall watchdog fired after ${this.thinkStallMs}ms with no non-think events; cancelling.\n`);
            this.maybeCancelInFlight();
        }, this.thinkStallMs);
        this.thinkStallTimer.unref();
    }
    /**
     * Internal entry point for the stall watchdog and loop detector to
     * fire a wire-side cancel without awaiting. The flag itself is owned
     * by `cancel()`; this method exists to wrap the fire-and-forget
     * pattern and the early-exit when a cancel is already in-flight
     * (avoids the noise of `cancel()`'s redundant short-circuit log).
     */
    maybeCancelInFlight() {
        if (this.cancelInFlight) {
            return;
        }
        void this.cancel().catch(() => { });
    }
    /**
     * Route a `ContentPart{type:"think"}` payload to the loop detector.
     * v0.3.3 (Claude M3) adds payload-shape surveillance: if the payload
     * carries no recognized text field, emit a one-shot warning so
     * operators see drift in the same way the subtype warning surfaces
     * type-level drift. The time-based watchdog still fires at
     * `thinkStallMs` either way.
     */
    observeThinkPart(payload) {
        const text = extractThinkPayloadText(payload);
        if (text === null) {
            if (!this.warnedUnknownThinkPayloadShape) {
                this.warnedUnknownThinkPayloadShape = true;
                process.stderr.write(`[kimi-plugin-cc] think ContentPart payload missing recognized text field; loop detector cannot hash it. Time-based watchdog (${this.thinkStallMs}ms) still active.\n`);
            }
            return;
        }
        this.observeThinkPayload(text);
    }
    /**
     * Forward-compat surveillance: emit a one-shot warning the first time
     * we see a ContentPart subtype that isn't in the known set, so the
     * watchdog isn't silently miscategorizing it. Kimi adversarial
     * reviewer flagged the v0.3.1 watchdog's hard-coded `"think"` literal
     * as a hazard if kimi-cli 1.45+ renames the field.
     */
    warnOnUnknownContentPartSubtype(type, payload) {
        if (type !== "ContentPart") {
            return;
        }
        const subtype = typeof payload.type === "string" ? payload.type : undefined;
        if (!subtype || KNOWN_CONTENT_PART_SUBTYPES.has(subtype)) {
            return;
        }
        if (this.warnedUnknownContentPartSubtypes.has(subtype)) {
            return;
        }
        this.warnedUnknownContentPartSubtypes.add(subtype);
        process.stderr.write(`[kimi-plugin-cc] unrecognized ContentPart subtype '${subtype}'; think-stall watchdog will treat it as forward progress (re-arm). If this is a new reasoning event, update KNOWN_CONTENT_PART_SUBTYPES.\n`);
    }
    /**
     * Hash a string to a 32-bit signed integer. Used by the duplicate-think
     * detector — collision rate is negligible for streaming reasoning
     * chunks, and the alternative (full payload retention) would balloon
     * memory on long thinking-on turns.
     */
    hashThinkPayload(text) {
        let hash = 5381;
        for (let i = 0; i < text.length; i += 1) {
            hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
        }
        return hash;
    }
    /**
     * Detect tight reasoning loops by tracking the last
     * THINK_LOOP_DUPLICATE_THRESHOLD think-payload hashes. If they're all
     * identical, fire `KIMI_THINK_LOOP_DETECTED` immediately. Catches the
     * kimi-cli 1.44.0 bug class in seconds rather than the 120s stall
     * timer's wall-clock cliff.
     */
    observeThinkPayload(text) {
        if (this.thinkLoopDetected || this.thinkStalled) {
            return;
        }
        const threshold = this.thinkLoopDuplicateThreshold;
        if (threshold <= 0) {
            // Loop detection disabled — time-based stall watchdog still runs.
            return;
        }
        const hash = this.hashThinkPayload(text);
        this.thinkPayloadHashes.push(hash);
        if (this.thinkPayloadHashes.length > threshold) {
            this.thinkPayloadHashes.shift();
        }
        if (this.thinkPayloadHashes.length < threshold) {
            return;
        }
        const first = this.thinkPayloadHashes[0];
        if (this.thinkPayloadHashes.every((h) => h === first)) {
            this.thinkLoopDetected = true;
            process.stderr.write(`[kimi-plugin-cc] think-loop detected: ${threshold} consecutive identical think payloads; cancelling.\n`);
            this.maybeCancelInFlight();
        }
    }
    disarmThinkStallWatchdog() {
        if (this.thinkStallTimer) {
            clearTimeout(this.thinkStallTimer);
            this.thinkStallTimer = undefined;
        }
    }
    async cancel() {
        // v0.3.3: single chokepoint for wire-side cancellation. Coalesces
        // BOTH directions of the watchdog/external-cancel race that Claude
        // and Kimi flagged in the v0.3.1 review:
        //
        //   - watchdog → external: external cancel() consults the flag and
        //     short-circuits to an empty CancelResult. Pre-v0.3.3 it sent a
        //     second JSON-RPC (benign per Kimi server, but wasteful).
        //   - external → watchdog: maybeCancelInFlight() already consults
        //     the flag set below.
        //
        // The flag is set ONLY after sendRequest dispatches successfully
        // (Kimi defect MOD): pre-v0.3.3 the flag was set unconditionally; if
        // sendRequest threw (e.g. WIRE_NOT_STARTED when child is null), the
        // flag stayed `true` and silently suppressed every subsequent
        // cancel attempt — including legitimate ones from a re-armed
        // prompt(). Set-after-success means a throw leaves the flag clear
        // so the next caller can retry.
        if (this.cancelInFlight) {
            return {};
        }
        const result = await this.sendRequest("cancel", {});
        this.cancelInFlight = true;
        return result;
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
                // Watchdog routing: any event that ISN'T a `ContentPart{type:"think"}`
                // counts as forward progress and re-arms the stall timer. Think
                // payloads feed the duplicate-content detector — if N consecutive
                // are identical we fire KIMI_THINK_LOOP_DETECTED immediately
                // instead of waiting for thinkStallMs (see v0.3.1 review).
                this.warnOnUnknownContentPartSubtype(message.params.type, message.params.payload);
                if (isThinkOnlyEvent(message.params.type, message.params.payload)) {
                    this.observeThinkPart(message.params.payload);
                }
                else {
                    // v0.3.3 (Codex MOD): any forward-progress event also clears
                    // the duplicate-think buffer so `[think_A, text, think_A,
                    // text, ...]` cannot accumulate enough identical hashes to
                    // trip KIMI_THINK_LOOP_DETECTED. The "consecutive" semantics
                    // in the loop-detector log now matches what the code does.
                    this.thinkPayloadHashes = [];
                    this.armThinkStallWatchdog();
                }
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
/**
 * Returns true if the event is a reasoning-only `ContentPart`. Used by the
 * think-stall watchdog to decide whether to re-arm the timer: every other
 * event type (StepBegin, StepRetry, text ContentPart, ToolCall, ToolResult,
 * StatusUpdate, TurnEnd, ...) counts as "forward progress" and resets the
 * stall window.
 */
function isThinkOnlyEvent(type, payload) {
    if (type !== "ContentPart") {
        return false;
    }
    return payload.type === "think";
}
/**
 * Extract the textual content from a think `ContentPart` payload for
 * hashing by the duplicate-content detector. Returns null when the
 * payload shape is unfamiliar (e.g., Kimi added a `delta` field instead
 * of `text` — caller skips loop-detection in that case but still
 * benefits from the time-based watchdog).
 */
function extractThinkPayloadText(payload) {
    if (typeof payload.text === "string") {
        return payload.text;
    }
    return null;
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
