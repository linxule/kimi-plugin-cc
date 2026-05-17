import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { RuntimeError, formatError } from "../errors.js";
import { ApprovalRequestRouter } from "./approval-request-router.js";
import { TurnEventBuffer } from "./event-buffer.js";
import { ThinkStallGuard } from "./think-stall-guard.js";
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
    approvalRouter;
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
    // Think-stall watchdog. Constructed fresh inside prompt() and disposed
    // in the surrounding finally so timers never outlive a turn.
    // ThinkStallGuard owns the timer, hash window, and verdict; WireClient
    // routes events into it and reads the verdict once prompt() settles.
    thinkStallMs;
    thinkLoopDuplicateThreshold;
    thinkStallGuard;
    // Coalesces wire-side cancellation across the watchdog and the public
    // cancel() entry point. Set to true BEFORE the JSON-RPC dispatch so a
    // concurrent caller cannot also pass the gate. Cleared in the catch
    // path on ANY throw — that includes the early WIRE_NOT_STARTED guard
    // and synchronous stdin.write failures (EPIPE / ERR_STREAM_DESTROYED
    // when the child has exited). Without the unconditional clear, a
    // transport hiccup would leave the flag stuck and silently suppress
    // every future cancel for the lifetime of the client. The cost of
    // clearing-then-retrying is at most a duplicate cancel JSON-RPC,
    // which the Kimi wire server tolerates.
    cancelInFlight = false;
    // Forward-compat telemetry: log a warning the first time we see a
    // ContentPart subtype that isn't in KNOWN_CONTENT_PART_SUBTYPES so
    // operators know the watchdog may be miscategorizing it.
    warnedUnknownContentPartSubtypes = new Set();
    // Per-instance one-shot for think-payload shape drift. Lives here
    // (not on ThinkStallGuard) so the suppression scope matches its
    // sibling `warnedUnknownContentPartSubtypes` — both are
    // upstream-shape telemetry, both should warn once per WireClient.
    warnedUnknownThinkPayloadShape = false;
    constructor(options) {
        this.cwd = options.cwd;
        this.env = { ...process.env, ...options.env };
        this.command = options.command ?? "kimi";
        this.args = options.args ?? ["--wire"];
        this.logPath = options.logPath;
        this.approvalRouter = new ApprovalRequestRouter(options.approvalDispatcher);
        this.thinkStallMs = options.thinkStallMs;
        this.thinkLoopDuplicateThreshold = options.thinkLoopDuplicateThreshold;
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
        // Single-prompt state below (currentTurn, the guard's timer, the
        // cancelInFlight flag) cannot be safely shared across concurrent
        // calls; reject the second caller rather than clobber the first.
        if (this.currentTurn) {
            throw new RuntimeError("WIRE_PROMPT_CONCURRENT", "Wire client cannot run two prompts concurrently; await the first prompt before calling again.", "wire.prompt");
        }
        this.currentTurn = new TurnEventBuffer();
        this.currentCommandType = commandType;
        this.approvalFailure = undefined;
        this.rejectApprovals = false;
        this.cancelInFlight = false;
        this.thinkStallGuard = new ThinkStallGuard({
            thinkStallMs: this.thinkStallMs,
            thinkLoopDuplicateThreshold: this.thinkLoopDuplicateThreshold,
            // Guard reports the verdict; WireClient decides the action. The
            // current action is "cancel the in-flight prompt," but the guard
            // does not own that decision — a future caller could choose to
            // log-and-continue, retry with --no-thinking, etc. Accept the
            // `reason` argument even though the current action is uniform, so
            // the contract is honest and a future per-reason handler doesn't
            // need a signature widening.
            onStallVerdict: (_reason) => this.maybeCancelInFlight(),
            onUnknownPayloadShape: () => this.warnOnUnknownThinkPayloadShape(),
        });
        try {
            const result = await this.sendRequest("prompt", { user_input: userInput });
            if (this.approvalFailure) {
                throw this.approvalFailure;
            }
            const stallError = this.thinkStallGuard.stallError();
            if (stallError) {
                throw stallError;
            }
            return this.currentTurn.finalize(result);
        }
        finally {
            this.thinkStallGuard?.dispose();
            this.thinkStallGuard = undefined;
            this.currentTurn = undefined;
            this.currentCommandType = undefined;
            this.approvalFailure = undefined;
        }
    }
    /**
     * Internal entry point for the stall watchdog and loop detector to
     * fire a wire-side cancel without awaiting. The flag itself is owned
     * by `cancel()`; this method exists to wrap the fire-and-forget
     * pattern and the early-exit when a cancel is already in-flight.
     */
    maybeCancelInFlight() {
        if (this.cancelInFlight) {
            return;
        }
        void this.cancel().catch(() => { });
    }
    /**
     * Emit a one-shot warning the first time the stall guard reports a
     * `ContentPart{type:"think"}` whose payload lacks a recognized text
     * field (e.g., upstream rename of `text` → `delta`). Lives on
     * WireClient (not on the per-prompt guard) so the suppression scope
     * is per-client, matching its sibling `warnOnUnknownContentPartSubtype`.
     */
    warnOnUnknownThinkPayloadShape() {
        if (this.warnedUnknownThinkPayloadShape) {
            return;
        }
        this.warnedUnknownThinkPayloadShape = true;
        const stallMs = this.thinkStallMs ?? "default";
        process.stderr.write(`[kimi-plugin-cc] think ContentPart payload missing recognized text field; loop detector cannot hash it. Time-based watchdog (${stallMs}ms) still active.\n`);
    }
    /**
     * Emit a one-shot warning the first time we see a ContentPart subtype
     * that isn't in the known set. Forward-compat surveillance: if kimi-cli
     * adds a new reasoning subtype, the watchdog would silently treat it
     * as forward progress without this telemetry.
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
    async cancel() {
        // Single chokepoint for wire-side cancellation; coalesces the
        // watchdog and external-cancel races. The flag is set BEFORE the
        // await so a concurrent caller (e.g., the stall watchdog firing
        // while /kimi:cancel is in-flight) cannot also pass the gate and
        // dispatch a duplicate `cancel` JSON-RPC. The flag is cleared on
        // ANY throw — `WIRE_NOT_STARTED` from the child-null guard, an
        // `EPIPE` / `ERR_STREAM_DESTROYED` from `stdin.write` after the
        // child exits, or anything else. Otherwise a single transport
        // hiccup would brick cancellation for the lifetime of the client.
        // The cost of clearing is at most a duplicate cancel JSON-RPC,
        // which the wire server tolerates.
        if (this.cancelInFlight) {
            return {};
        }
        this.cancelInFlight = true;
        try {
            return await this.sendRequest("cancel", {});
        }
        catch (error) {
            this.cancelInFlight = false;
            throw error;
        }
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
                // WireClient is transport-only here: hand every event to the
                // guard, which owns the routing policy (think-only vs
                // forward-progress). The subtype warning stays in WireClient
                // because it's about ContentPart subtype telemetry, not stall
                // detection.
                this.warnOnUnknownContentPartSubtype(message.params.type, message.params.payload);
                this.thinkStallGuard?.observeEvent(message.params.type, message.params.payload);
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
        const child = this.child;
        const result = await this.approvalRouter.route(message, {
            getCurrentCommandType: () => this.currentCommandType,
            getRejectApprovals: () => this.rejectApprovals,
        }, async (frame) => {
            await this.logWire("out", frame).catch(() => { });
            try {
                child.stdin.write(`${JSON.stringify(frame)}\n`);
            }
            catch {
                // stdin may already be closed during cancellation; ignore.
            }
        });
        if (result.failure) {
            this.approvalFailure = result.failure;
        }
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
