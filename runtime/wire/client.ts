import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { RuntimeError, formatError } from "../errors.js";
import type { RuntimeCommandType } from "../types.js";
import { ApprovalDispatcher } from "./approval-dispatcher.js";
import { TurnEventBuffer } from "./event-buffer.js";
import type {
  ApprovalRequestPayload,
  CancelResult,
  CompletedTurn,
  IncomingWireMessage,
  InitializeParams,
  InitializeResult,
  PromptResult,
} from "./types.js";

interface JsonRpcSuccess<T> {
  jsonrpc: "2.0";
  id: string;
  result: T;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: string;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export interface WireClientOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  command?: string;
  args?: string[];
  logPath?: string;
  approvalDispatcher: ApprovalDispatcher;
  /**
   * Threshold (ms) for the think-stall watchdog. If Kimi emits only
   * `ContentPart{type:"think"}` events for this long without any other
   * event type (StepBegin, StepRetry, ToolCall, ToolResult, text
   * ContentPart, StatusUpdate, TurnEnd, etc.), the client sends `cancel`
   * to recover the session.
   *
   * Default 120s. Set to 0 to disable. Investigation for v0.3.1 (task
   * #23/#41) traced the thinking-on hang to kimi-cli 1.44.0 entering an
   * indefinite reasoning-only loop where the upstream HTTP stream never
   * terminates, so the soul never reaches its `finally` and the wire
   * server never sends `PromptResult`. The watchdog detects this pattern
   * client-side instead of waiting for the 10-min prompt timeout.
   */
  thinkStallMs?: number;
}

const DEFAULT_THINK_STALL_MS = 120_000;

export class WireClient {
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly command: string;
  private readonly args: string[];
  private readonly logPath?: string;
  private readonly approvalDispatcher: ApprovalDispatcher;
  private child?: ChildProcessWithoutNullStreams;
  // closed latches true the first time close() is called. Guards the race where
  // start() is mid-flight (e.g. awaiting mkdir or the spawn event) and close()
  // is invoked before this.child has been assigned — start() checks this.closed
  // at each async boundary and, if a child has already been spawn()ed but not
  // yet bound to this.child, kills it in the "spawn" handler.
  private closed = false;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private currentTurn?: TurnEventBuffer;
  private currentCommandType?: RuntimeCommandType;
  private nextRequestId = 0;
  private stderrBuffer = "";
  private stdoutBuffer = "";
  private suppressExitError = false;
  private approvalFailure?: RuntimeError;
  private rejectApprovals = false;
  private processingChain: Promise<void> = Promise.resolve();
  // Think-stall watchdog state (see WireClientOptions.thinkStallMs).
  private readonly thinkStallMs: number;
  private thinkStallTimer?: ReturnType<typeof setTimeout>;
  private thinkStalled = false;

  constructor(options: WireClientOptions) {
    this.cwd = options.cwd;
    this.env = { ...process.env, ...options.env };
    this.command = options.command ?? "kimi";
    this.args = options.args ?? ["--wire"];
    this.logPath = options.logPath;
    this.approvalDispatcher = options.approvalDispatcher;
    this.thinkStallMs = options.thinkStallMs ?? DEFAULT_THINK_STALL_MS;
  }

  async start(): Promise<void> {
    if (this.closed) {
      throw new RuntimeError(
        "WIRE_CLIENT_CLOSED",
        "Cannot start a closed wire client.",
        "wire.start",
      );
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
      throw new RuntimeError(
        "WIRE_CLIENT_CLOSED",
        "Wire client was closed during startup.",
        "wire.start",
      );
    }

    await new Promise<void>((resolve, reject) => {
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
          } catch {
            // best-effort — child may already be dying
          }
          reject(
            new RuntimeError(
              "WIRE_CLIENT_CLOSED",
              "Wire client was closed during spawn.",
              "wire.start",
            ),
          );
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
          reject(
            new RuntimeError(
              "WIRE_SPAWN_FAILED",
              `Failed to start ${this.command}: ${formatError(error)}`,
              "wire.start",
              { cause: error },
            ),
          );
        }
      });
    });
  }

  async close(): Promise<void> {
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

    await new Promise<void>((resolve) => {
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

  async initialize(params: InitializeParams): Promise<InitializeResult> {
    return this.sendRequest<InitializeResult>("initialize", params);
  }

  async prompt(userInput: string, commandType: RuntimeCommandType): Promise<CompletedTurn> {
    this.currentTurn = new TurnEventBuffer();
    this.currentCommandType = commandType;
    this.approvalFailure = undefined;
    this.rejectApprovals = false;
    this.thinkStalled = false;
    this.armThinkStallWatchdog();

    try {
      const result = await this.sendRequest<PromptResult>("prompt", { user_input: userInput });
      if (this.approvalFailure) {
        throw this.approvalFailure;
      }
      if (this.thinkStalled) {
        throw new RuntimeError(
          "KIMI_THINK_STALLED",
          `Kimi reasoning stream produced only \`think\` events for over ${this.thinkStallMs}ms; ` +
            `cancelled to recover the session. Retry with --no-thinking or a more focused prompt.`,
          "wire.prompt",
        );
      }
      return this.currentTurn.finalize(result);
    } finally {
      this.disarmThinkStallWatchdog();
      this.currentTurn = undefined;
      this.currentCommandType = undefined;
      this.approvalFailure = undefined;
    }
  }

  private armThinkStallWatchdog(): void {
    this.disarmThinkStallWatchdog();
    if (this.thinkStallMs <= 0) {
      return;
    }
    this.thinkStallTimer = setTimeout(() => {
      this.thinkStalled = true;
      // Best-effort cancel; the server emits TurnEnd + cancelled PromptResult
      // via its own finally, which unblocks our pending prompt request. If
      // cancel itself hangs, the outer withTimeout still fires.
      void this.cancel().catch(() => {});
    }, this.thinkStallMs);
    this.thinkStallTimer.unref();
  }

  private disarmThinkStallWatchdog(): void {
    if (this.thinkStallTimer) {
      clearTimeout(this.thinkStallTimer);
      this.thinkStallTimer = undefined;
    }
  }

  /** Test seam: visible for unit tests that want to fast-forward the watchdog. */
  public _fireThinkStallWatchdog(): void {
    this.thinkStalled = true;
    void this.cancel().catch(() => {});
  }

  async cancel(): Promise<CancelResult> {
    return this.sendRequest<CancelResult>("cancel", {});
  }

  beginCancellation(): void {
    this.rejectApprovals = true;
  }

  terminateChild(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.child) {
      return;
    }

    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill(signal);
    }
  }

  getStderrBuffer(): string {
    return this.stderrBuffer;
  }

  getChildPid(): number | null {
    return this.child?.pid ?? null;
  }

  private async sendRequest<T>(method: string, params: object): Promise<T> {
    if (!this.child) {
      throw new RuntimeError("WIRE_NOT_STARTED", "Wire client was used before start().", "wire.request");
    }

    const id = String(++this.nextRequestId);
    const request = {
      jsonrpc: "2.0" as const,
      method,
      id,
      params,
    };

    await this.logWire("out", request);

    const responsePromise = new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });

    this.child.stdin.write(`${JSON.stringify(request)}\n`);

    return responsePromise;
  }

  private async handleLine(line: string): Promise<void> {
    if (!line.trim()) {
      return;
    }

    await this.logWire("in", line);

    let message: IncomingWireMessage | JsonRpcSuccess<unknown> | JsonRpcError;
    try {
      message = JSON.parse(line) as IncomingWireMessage | JsonRpcSuccess<unknown> | JsonRpcError;
    } catch (error) {
      this.rejectAll(
        new RuntimeError(
          "WIRE_INVALID_JSON",
          `Failed to parse Wire JSON line: ${formatError(error)}`,
          "wire.read",
          { cause: error },
        ),
      );
      return;
    }

    if ("method" in message) {
      if (message.method === "event") {
        // Think-stall watchdog: any event that ISN'T a `ContentPart{type:"think"}`
        // signals forward progress, so re-arm the timer. (Think parts alone are
        // the kimi-cli 1.44.0 reasoning-only loop signature — see task #41.)
        if (!isThinkOnlyEvent(message.params.type, message.params.payload)) {
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
      pending.reject(
        new RuntimeError(
          "WIRE_REQUEST_FAILED",
          `${message.error.message} (code ${message.error.code})`,
          "wire.request",
        ),
      );
      return;
    }

    pending.resolve(message.result);
  }

  private async handleStdoutBuffer(): Promise<void> {
    while (this.stdoutBuffer.includes("\n")) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      await this.handleLine(line);
    }
  }

  private async handleWireRequest(message: Extract<IncomingWireMessage, { method: "request" }>): Promise<void> {
    if (!this.child) {
      return;
    }

    try {
      await this.dispatchWireRequest(message);
    } catch (error) {
      // Any throw from payload parsing, approval dispatch, or realpath calls in the policy must
      // still unblock Kimi. Send a JSON-RPC error response so the peer drops the pending request,
      // and stash the failure so prompt() surfaces it to the command layer.
      this.approvalFailure =
        error instanceof RuntimeError
          ? error
          : new RuntimeError(
              "APPROVAL_DISPATCHER_FAILED",
              `Approval dispatcher threw: ${formatError(error)}`,
              "wire.approval",
              error instanceof Error ? { cause: error } : undefined,
            );

      if (this.child) {
        const errorResponse = {
          jsonrpc: "2.0" as const,
          id: message.id,
          error: {
            code: -32603,
            message: this.approvalFailure.message,
          },
        };
        await this.logWire("out", errorResponse).catch(() => {});
        try {
          this.child.stdin.write(`${JSON.stringify(errorResponse)}\n`);
        } catch {
          // stdin may already be closed during cancellation; ignore.
        }
      }
    }
  }

  private async dispatchWireRequest(
    message: Extract<IncomingWireMessage, { method: "request" }>,
  ): Promise<void> {
    if (!this.child) {
      return;
    }

    if (message.params.type !== "ApprovalRequest") {
      const error = {
        jsonrpc: "2.0" as const,
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
      throw new RuntimeError(
        "WIRE_PROTOCOL_ERROR",
        "Received an ApprovalRequest outside an active command turn.",
        "wire.approval",
      );
    }

    const payload = parseApprovalRequestPayload(message.params.payload);
    const decision = this.rejectApprovals
      ? {
          response: "reject" as const,
          feedback: "Command cancellation is in progress.",
        }
      : await this.approvalDispatcher.handle(payload, {
          commandType: this.currentCommandType,
        });

    const finalDecision =
      this.rejectApprovals && decision.response !== "reject"
        ? {
            response: "reject" as const,
            feedback: "Command cancellation is in progress.",
          }
        : decision;

    const response = {
      jsonrpc: "2.0" as const,
      id: message.id,
      result: {
        request_id: payload.id,
        response: finalDecision.response,
        ...(finalDecision.feedback ? { feedback: finalDecision.feedback } : {}),
      },
    };

    if (finalDecision.response === "reject") {
      this.approvalFailure = new RuntimeError(
        "APPROVAL_REJECTED",
        finalDecision.feedback ?? `Approval rejected for ${payload.action}.`,
        "wire.approval",
      );
    }

    await this.logWire("out", response);
    this.child.stdin.write(`${JSON.stringify(response)}\n`);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.suppressExitError) {
      return;
    }

    const stderr = this.stderrBuffer.trim();
    const message = stderr
      ? `Wire process exited unexpectedly (code=${String(code)}, signal=${String(signal)}). ${stderr}`
      : `Wire process exited unexpectedly (code=${String(code)}, signal=${String(signal)}).`;

    this.rejectAll(new RuntimeError("WIRE_PROCESS_EXITED", message, "wire.process"));
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private async logWire(direction: "in" | "out" | "stderr", message: unknown): Promise<void> {
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
    } catch (error) {
      // If the log directory was removed mid-run (e.g. the user nuked ${CLAUDE_PLUGIN_DATA}),
      // recreate it once and retry so the turn doesn't disappear into the filesystem. Other
      // failures are swallowed since logging must not take down the hot path.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          await mkdir(path.dirname(this.logPath), { recursive: true });
          await appendFile(this.logPath, `${JSON.stringify(entry)}\n`, "utf8");
        } catch {
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
function isThinkOnlyEvent(type: string, payload: Record<string, unknown>): boolean {
  if (type !== "ContentPart") {
    return false;
  }
  return payload.type === "think";
}

function parseApprovalRequestPayload(payload: Record<string, unknown>): ApprovalRequestPayload {
  if (
    typeof payload.id !== "string" ||
    typeof payload.sender !== "string" ||
    typeof payload.action !== "string" ||
    typeof payload.description !== "string" ||
    !Array.isArray(payload.display)
  ) {
    throw new RuntimeError(
      "WIRE_PROTOCOL_ERROR",
      "Received an ApprovalRequest with an invalid payload shape.",
      "wire.approval",
    );
  }

  return payload as unknown as ApprovalRequestPayload;
}
