import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { MCP_TOOL_DEFINITIONS } from "../../runtime/mcp/operations.js";
import { MCP_SERVER_INSTRUCTIONS } from "../../runtime/mcp/protocol.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import { KIMI_PLUGIN_CC_VERSION } from "../../runtime/version.js";
import { createMcpFixture, MCP_MODERN_VERSION, McpClient, modernMeta, type McpFixture } from "../helpers/mcp.js";

const expectedToolNames = [
  "kimi_read",
  "kimi_write",
  "kimi_job",
  "kimi_setup",
];

const expectedAnnotations: Record<string, Record<string, unknown>> = {
  kimi_read: { title: "kimi read", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  kimi_write: { title: "kimi write", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  kimi_job: { title: "kimi job", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  kimi_setup: { title: "kimi setup", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

interface FrameWaiter {
  resolve: (frame: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class RawMcpClient {
  readonly nonJsonLines: string[] = [];
  private readonly child: ChildProcess;
  private readonly closed: Promise<number | null>;
  private readonly frames: any[] = [];
  private readonly waiters: FrameWaiter[] = [];
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private stderr = "";
  private closeRequested = false;

  constructor(fixture: McpFixture) {
    this.child = spawn(path.join(fixture.pluginRoot, "scripts/companion.sh"), ["mcp"], {
      cwd: fixture.repo,
      env: { ...fixture.env, KIMI_PLUGIN_CC_MCP_WORKSPACE: fixture.repo },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout!.on("data", (chunk: Buffer) => this.accept(chunk));
    this.child.stderr!.on("data", (chunk: Buffer) => { this.stderr += chunk.toString("utf8"); });
    this.closed = new Promise((resolve) => {
      this.child.once("error", (error) => this.fail(error));
      this.child.once("close", (code) => resolve(code));
    });
  }

  send(message: unknown): void {
    this.writeRaw(`${JSON.stringify(message)}\n`);
  }

  writeRaw(frame: string): void {
    this.child.stdin!.write(frame);
  }

  request(method: string, params: Record<string, unknown>): Promise<any> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return this.nextFrame();
  }

  exchange(message: unknown): Promise<any> {
    this.send(message);
    return this.nextFrame();
  }

  nextFrame(): Promise<any> {
    const queued = this.frames.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const waiter: FrameWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for an MCP stdout frame. stderr: ${this.stderr}`));
        }, 10_000),
      };
      this.waiters.push(waiter);
    });
  }

  async close(): Promise<number | null> {
    if (!this.closeRequested) {
      this.closeRequested = true;
      this.child.stdin!.end();
    }
    return this.closed;
  }

  private accept(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      try {
        this.push(JSON.parse(line.toString("utf8")));
      } catch {
        this.nonJsonLines.push(line.toString("utf8"));
        this.fail(new Error(`MCP stdout contained a non-JSON frame: ${line.toString("utf8")}`));
      }
    }
  }

  private push(frame: any): void {
    const waiter = this.waiters.shift();
    if (!waiter) {
      this.frames.push(frame);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(frame);
  }

  private fail(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

async function expectClientRpcError(
  request: Promise<unknown>,
  code: number,
  message?: string | RegExp,
): Promise<Record<string, unknown>> {
  let thrown: unknown;
  try {
    await request;
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  const rpcError = JSON.parse((thrown as Error).message) as Record<string, unknown>;
  expect(rpcError.code).toBe(code);
  if (typeof message === "string") expect(rpcError.message).toContain(message);
  if (message instanceof RegExp) expect(rpcError.message).toMatch(message);
  return rpcError;
}

function expectFrameError(frame: any, code: number, message?: string | RegExp): void {
  expect(frame.jsonrpc).toBe("2.0");
  expect(frame.error.code).toBe(code);
  expect(frame.result).toBeUndefined();
  if (typeof message === "string") expect(frame.error.message).toContain(message);
  if (message instanceof RegExp) expect(frame.error.message).toMatch(message);
}

function expectToolContract(tools: readonly any[]): void {
  expect(tools.map((tool) => tool.name)).toEqual(expectedToolNames);
  expect(new Set(tools.map((tool) => tool.name)).size).toBe(4);
  expect(tools).toEqual(MCP_TOOL_DEFINITIONS);
  for (const tool of tools) {
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.annotations).toEqual(expectedAnnotations[tool.name]);
  }
}

describe("MCP protocol discovery and tool schemas", () => {
  test("modern discovery and tools/list expose the complete deterministic 4-tool + SEP-2640 contract", async () => {
    const fixture = await createMcpFixture("mcp-protocol-modern");
    const client = new McpClient(fixture);
    try {
      const discovery = await client.request("server/discover", { _meta: modernMeta() });
      expect(discovery).toEqual({
        resultType: "complete",
        supportedVersions: [MCP_MODERN_VERSION],
        capabilities: {
          tools: {},
          resources: {},
          extensions: {
            "io.modelcontextprotocol/tasks": {},
            "io.modelcontextprotocol/skills": {},
          },
        },
        instructions: MCP_SERVER_INSTRUCTIONS,
        _meta: {
          "io.modelcontextprotocol/serverInfo": { name: "kimi-plugin-cc", version: KIMI_PLUGIN_CC_VERSION },
        },
        ttlMs: 0,
        cacheScope: "private",
      });

      const listed = await client.request("tools/list", { _meta: modernMeta() });
      expect(listed.resultType).toBe("complete");
      expect(listed.ttlMs).toBe(0);
      expect(listed.cacheScope).toBe("private");
      expectToolContract(listed.tools);
    } finally {
      await client.close();
      await fixture.cleanup();
    }
  }, 30_000);

  test("legacy initialize and tools/list retain the legacy response shapes with resources and skills", async () => {
    const fixture = await createMcpFixture("mcp-protocol-legacy");
    const client = new McpClient(fixture);
    try {
      const initialized = await client.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "legacy-test", version: "1" },
      });
      expect(initialized).toEqual({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: {}, experimental: { skills: {} } },
        serverInfo: { name: "kimi-plugin-cc", version: KIMI_PLUGIN_CC_VERSION },
        instructions: MCP_SERVER_INSTRUCTIONS,
      });

      const listed = await client.request("tools/list", {});
      expect(listed).toEqual({ tools: MCP_TOOL_DEFINITIONS });
      expectToolContract(listed.tools);

      const unsupported = await expectClientRpcError(client.request("initialize", {
        protocolVersion: "1900-01-01",
        capabilities: {},
        clientInfo: { name: "legacy-test", version: "1" },
      }), -32_602, "Unsupported protocol version");
      expect(unsupported.data).toEqual({
        supportedVersions: ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"],
      });
    } finally {
      await client.close();
      await fixture.cleanup();
    }
  }, 30_000);
});

describe("MCP task negotiation and task errors", () => {
  test("tasks capability is negotiated per call and its absence never returns a task handle", async () => {
    const fixture = await createMcpFixture("mcp-protocol-capability", { delayMs: "30000" });
    let client: McpClient | undefined;
    let capableTaskId: string | undefined;
    let ordinaryJobId: string | undefined;
    try {
      client = await McpClient.modern(fixture);
      const capable = await client.request("tools/call", {
        name: "kimi_read",
        arguments: { workspace: fixture.repo, mode: "ask", prompt: "Task-capable mock launch" },
        _meta: modernMeta(true),
      });
      expect(capable.resultType).toBe("task");
      expect(capable.status).toBe("working");
      capableTaskId = capable.taskId;

      const withoutCapability = await client.request("tools/call", {
        name: "kimi_read",
        arguments: { workspace: fixture.repo, mode: "ask", prompt: "Ordinary mock launch", wait: false },
        _meta: modernMeta(false),
      });
      expect(withoutCapability.resultType).toBe("complete");
      expect(withoutCapability.taskId).toBeUndefined();
      expect(withoutCapability.structuredContent.status).toBe("running");
      ordinaryJobId = withoutCapability.structuredContent.job_id;

      const status = await client.request("tools/call", {
        name: "kimi_job",
        arguments: { action: "status", job_id: ordinaryJobId },
        _meta: modernMeta(true),
      });
      expect(status.resultType).toBe("complete");
      expect(status.taskId).toBeUndefined();
      expect(status.structuredContent.job_id).toBe(ordinaryJobId);

      const taskView = await client.request("tasks/get", { taskId: capableTaskId, _meta: modernMeta(true) });
      expect(taskView.resultType).toBe("complete");
      expect(taskView.taskId).toBe(capableTaskId);

      const missingCapability = await expectClientRpcError(
        client.request("tasks/get", { taskId: capableTaskId, _meta: modernMeta(false) }),
        -32_021,
        "Missing required client capability",
      );
      expect(missingCapability.data).toEqual({
        requiredCapabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } },
      });
    } finally {
      if (client) {
        if (capableTaskId) {
          await client.request("tasks/cancel", { taskId: capableTaskId, _meta: modernMeta(true) }).catch(() => undefined);
        }
        if (ordinaryJobId) {
          await client.request("tools/call", {
            name: "kimi_job",
            arguments: { action: "cancel", job_id: ordinaryJobId },
            _meta: modernMeta(false),
          }).catch(() => undefined);
        }
        await client.close();
      }
      await fixture.cleanup();
    }
  }, 60_000);

  test("legacy tasks/get and tasks/cancel are method-not-found", async () => {
    const fixture = await createMcpFixture("mcp-protocol-legacy-tasks");
    let client: McpClient | undefined;
    try {
      client = await McpClient.legacy(fixture);
      await expectClientRpcError(client.request("tasks/get", { taskId: "anything" }), -32_601, "Method not found: tasks/get");
      await expectClientRpcError(client.request("tasks/cancel", { taskId: "anything" }), -32_601, "Method not found: tasks/cancel");
    } finally {
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 30_000);

  test("unknown modern task IDs are invalid params for both get and cancel", async () => {
    const fixture = await createMcpFixture("mcp-protocol-unknown-task");
    let client: McpClient | undefined;
    try {
      client = await McpClient.modern(fixture);
      const taskId = "00000000-0000-4000-8000-000000000000";
      await expectClientRpcError(
        client.request("tasks/get", { taskId, _meta: modernMeta() }),
        -32_602,
        `Unknown task ID: ${taskId}`,
      );
      await expectClientRpcError(
        client.request("tasks/cancel", { taskId, _meta: modernMeta() }),
        -32_602,
        `Unknown task ID: ${taskId}`,
      );
    } finally {
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 30_000);
});

describe("MCP JSON-RPC validation and stdout discipline", () => {
  test("malformed JSON, envelopes, params, methods, and tools return JSON errors only", async () => {
    const fixture = await createMcpFixture("mcp-protocol-validation");
    const client = new RawMcpClient(fixture);
    try {
      const direct = await client.request("ping", { _meta: modernMeta() });
      expect(direct.result.resultType).toBe("complete");

      client.writeRaw('{"jsonrpc":"2.0","id":\n');
      expectFrameError(await client.nextFrame(), -32_700, "Parse error");

      const invalidEnvelopes: Array<[unknown, number]> = [
        [null, -32_600],
        [[], -32_600],
        [{ jsonrpc: "1.0", id: 10, method: "ping" }, -32_600],
        [{ jsonrpc: "2.0", id: 11, method: "" }, -32_600],
        [{ jsonrpc: "2.0", id: 12, method: 42 }, -32_600],
        [{ jsonrpc: "2.0", id: true, method: "ping" }, -32_600],
        [{ jsonrpc: "2.0", id: 13, method: "ping", params: [] }, -32_602],
        [{ jsonrpc: "2.0", id: 14, method: "ping", params: null }, -32_602],
      ];
      for (const [envelope, code] of invalidEnvelopes) {
        expectFrameError(await client.exchange(envelope), code);
      }

      const discovery = await client.request("server/discover", { _meta: modernMeta() });
      expect(discovery.result.resultType).toBe("complete");

      expectFrameError(
        await client.exchange({ jsonrpc: "2.0", id: "missing-meta", method: "ping", params: {} }),
        -32_602,
        "Modern MCP requests require protocol metadata",
      );
      expectFrameError(
        await client.exchange({ jsonrpc: "2.0", id: "unknown-method", method: "unknown/method", params: { _meta: modernMeta() } }),
        -32_601,
        "Method not found: unknown/method",
      );
      expectFrameError(
        await client.exchange({ jsonrpc: "2.0", id: "missing-name", method: "tools/call", params: { _meta: modernMeta(), arguments: {} } }),
        -32_602,
        "tools/call requires a tool name",
      );
      expectFrameError(
        await client.exchange({
          jsonrpc: "2.0",
          id: "unknown-tool",
          method: "tools/call",
          params: { _meta: modernMeta(), name: "kimi_not_a_tool", arguments: {} },
        }),
        -32_602,
        "Unknown tool: kimi_not_a_tool",
      );
      expectFrameError(
        await client.exchange({
          jsonrpc: "2.0",
          id: "removed-legacy-tool",
          method: "tools/call",
          params: { _meta: modernMeta(), name: "kimi_ask", arguments: { prompt: "x" } },
        }),
        -32_602,
        "Unknown tool: kimi_ask",
      );

      for (const [index, taskId] of ["", "has spaces", 7, "x".repeat(129)].entries()) {
        expectFrameError(
          await client.exchange({
            jsonrpc: "2.0",
            id: `bad-task-${index}`,
            method: "tasks/get",
            params: { _meta: modernMeta(), taskId },
          }),
          -32_602,
          "taskId must be 1-128 printable ASCII characters without spaces",
        );
      }

      const invalidToolArguments = await client.exchange({
        jsonrpc: "2.0",
        id: "invalid-tool-arguments",
        method: "tools/call",
        params: { _meta: modernMeta(), name: "kimi_read", arguments: null },
      });
      expect(invalidToolArguments.id).toBe("invalid-tool-arguments");
      expect(invalidToolArguments.error).toBeUndefined();
      expect(invalidToolArguments.result.resultType).toBe("complete");
      expect(invalidToolArguments.result.isError).toBe(true);
      expect(invalidToolArguments.result.structuredContent.error.code).toBe("MCP_INVALID_ARGUMENTS");
      expect(client.nonJsonLines).toEqual([]);
    } finally {
      await client.close();
      await fixture.cleanup();
    }
  }, 30_000);

  test("a tools/call notification emits no response and launches no work", async () => {
    const fixture = await createMcpFixture("mcp-protocol-notification");
    const client = new RawMcpClient(fixture);
    try {
      const discovery = await client.request("server/discover", { _meta: modernMeta() });
      expect(discovery.result.resultType).toBe("complete");

      client.send({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          _meta: modernMeta(),
          name: "kimi_read",
          arguments: { workspace: fixture.repo, mode: "ask", prompt: "This notification must not start a job" },
        },
      });
      const ping = await client.request("ping", { _meta: modernMeta() });
      expect(ping.id).toBe(2);
      expect(ping.result).toEqual({ resultType: "complete" });
      expect(await client.close()).toBe(0);
      expect(client.nonJsonLines).toEqual([]);

      const stateDbPath = resolvePluginPaths(fixture.env).stateDbPath;
      let taskCount = 0;
      if (existsSync(stateDbPath)) {
        const database = new Database(stateDbPath, { readonly: true });
        try {
          taskCount = (database.query("SELECT COUNT(*) AS count FROM mcp_tasks").get() as { count: number }).count;
        } finally {
          database.close();
        }
      }
      expect(taskCount).toBe(0);
    } finally {
      await client.close();
      await fixture.cleanup();
    }
  }, 30_000);
});

describe("MCP server instructions", () => {
  test("every supported legacy version receives the same instructions", async () => {
    for (const protocolVersion of ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]) {
      const fixture = await createMcpFixture(`mcp-instructions-${protocolVersion}`);
      const client = new McpClient(fixture);
      try {
        const initialized = await client.request("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "t", version: "1" } });
        expect(initialized.instructions, protocolVersion).toBe(MCP_SERVER_INSTRUCTIONS);
      } finally {
        await client.close();
        await fixture.cleanup();
      }
    }
  }, 60_000);

  test("instructions name the skill URI, 4 tools, wait semantics, setup, and warnings", () => {
    for (const phrase of [
      "skill://kimi/SKILL.md",
      "resources/read",
      "kimi_read",
      "kimi_write",
      "wait: false",
      "kimi_job",
      "kimi_setup",
      "Warnings:",
    ]) {
      expect(MCP_SERVER_INSTRUCTIONS).toContain(phrase);
    }
    for (const removed of [
      "kimi_ask",
      "kimi_review",
      "kimi_challenge",
      "kimi_rescue",
      "kimi_pursue",
      "kimi_swarm",
      "kimi_swarm_write",
      "kimi_job_status",
      "kimi_job_result",
      "kimi_job_cancel",
    ]) {
      expect(MCP_SERVER_INSTRUCTIONS).not.toContain(removed);
    }
  });
});
