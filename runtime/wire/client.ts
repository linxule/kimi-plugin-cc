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
}

export class WireClient {
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly command: string;
  private readonly args: string[];
  private readonly logPath?: string;
  private readonly approvalDispatcher: ApprovalDispatcher;
  private child?: ChildProcessWithoutNullStreams;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private currentTurn?: TurnEventBuffer;
  private currentCommandType?: RuntimeCommandType;
  private nextRequestId = 0;
  private stderrBuffer = "";
  private stdoutBuffer = "";
  private suppressExitError = false;
  private approvalFailure?: RuntimeError;

  constructor(options: WireClientOptions) {
    this.cwd = options.cwd;
    this.env = { ...process.env, ...options.env };
    this.command = options.command ?? "kimi";
    this.args = options.args ?? ["--wire"];
    this.logPath = options.logPath;
    this.approvalDispatcher = options.approvalDispatcher;
  }

  async start(): Promise<void> {
    if (this.child) {
      return;
    }

    this.suppressExitError = false;

    if (this.logPath) {
      await mkdir(path.dirname(this.logPath), { recursive: true });
    }

    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.command, this.args, {
        cwd: this.cwd,
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let settled = false;

      child.once("spawn", () => {
        settled = true;
        this.child = child;
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          this.stdoutBuffer += chunk;
          void this.handleStdoutBuffer();
        });
        child.stderr.on("data", (chunk) => {
          const text = chunk.toString("utf8");
          this.stderrBuffer += text;
          void this.logWire("stderr", text.trimEnd());
        });
        child.once("exit", (code, signal) => {
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

    try {
      const result = await this.sendRequest<PromptResult>("prompt", { user_input: userInput });
      if (this.approvalFailure) {
        throw this.approvalFailure;
      }
      return this.currentTurn.finalize(result);
    } finally {
      this.currentTurn = undefined;
      this.currentCommandType = undefined;
      this.approvalFailure = undefined;
    }
  }

  async cancel(): Promise<CancelResult> {
    return this.sendRequest<CancelResult>("cancel", {});
  }

  async replay(): Promise<never> {
    throw new RuntimeError("NOT_IMPLEMENTED", "replay is not implemented in phase 1a.", "wire.replay");
  }

  async steer(): Promise<never> {
    throw new RuntimeError("NOT_IMPLEMENTED", "steer is not implemented in phase 1a.", "wire.steer");
  }

  async setPlanMode(): Promise<never> {
    throw new RuntimeError(
      "NOT_IMPLEMENTED",
      "set_plan_mode is not implemented in phase 1a.",
      "wire.set_plan_mode",
    );
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
    const decision = await this.approvalDispatcher.handle(payload, {
      commandType: this.currentCommandType,
    });

    const response = {
      jsonrpc: "2.0" as const,
      id: message.id,
      result: {
        request_id: payload.id,
        response: decision.response,
        ...(decision.feedback ? { feedback: decision.feedback } : {}),
      },
    };

    if (decision.response === "reject") {
      this.approvalFailure = new RuntimeError(
        "APPROVAL_REJECTED",
        decision.feedback ?? `Approval rejected for ${payload.action}.`,
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

    await appendFile(this.logPath, `${JSON.stringify(entry)}\n`, "utf8");
  }
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
