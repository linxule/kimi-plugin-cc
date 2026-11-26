import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "./test-env.js";

const repoRoot = process.cwd();
const mockCli = path.join(repoRoot, "tests/helpers/mock-kimi-cli.ts");
export const MCP_MODERN_VERSION = "2026-07-28";

export interface McpFixture {
  data: string;
  repo: string;
  kimiHome: string;
  pluginRoot: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

export async function createMcpFixture(
  prefix: string,
  options: {
    pluginRoot?: string;
    delayMs?: string;
    scenario?: string;
    skipSetup?: boolean;
    extraEnv?: NodeJS.ProcessEnv;
  } = {},
): Promise<McpFixture> {
  const data = await createTestPluginDataRoot(prefix);
  const repo = await createGitRepoFixture(`${prefix}-repo`);
  const kimiHome = path.join(data, "kimi-home");
  const pluginRoot = options.pluginRoot ?? repoRoot;
  await mkdir(kimiHome, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KIMI_PLUGIN_CC_DATA: data,
    KIMI_CODE_HOME: kimiHome,
    KIMI_PLUGIN_CC_DISABLE_WEB_ANNOUNCE: "1",
    KIMI_PLUGIN_CC_KIMI_BIN: "bun",
    KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCli]),
    KIMI_PLUGIN_CC_MOCK_SCENARIO: options.scenario ?? "ask-success",
    KIMI_PLUGIN_CC_MOCK_DELAY_MS: options.delayMs ?? "0",
    ...options.extraEnv,
  };
  delete env.KIMI_PLUGIN_CC_NODE_BIN;
  delete env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK;
  if (!options.skipSetup) {
    const setup = spawnSync(path.join(pluginRoot, "scripts/companion.sh"), ["setup"], {
      cwd: repo,
      env,
      encoding: "utf8",
    });
    if (setup.status !== 0) {
      await cleanupTestPath(data);
      await cleanupTestPath(repo);
      throw new Error(`MCP fixture setup failed: ${setup.stdout}\n${setup.stderr}`);
    }
  }
  return {
    data,
    repo,
    kimiHome,
    pluginRoot,
    env,
    cleanup: async () => {
      await cleanupTestPath(data);
      await cleanupTestPath(repo);
    },
  };
}

export function modernMeta(tasks = true): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": MCP_MODERN_VERSION,
    "io.modelcontextprotocol/clientInfo": { name: "mcp-test", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {
      extensions: tasks ? { "io.modelcontextprotocol/tasks": {} } : {},
    },
  };
}

export class McpClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private readonly closed: Promise<void>;
  private buffer = "";
  private nextId = 1;
  private stderr = "";

  constructor(private readonly fixture: McpFixture) {
    this.child = spawn(path.join(fixture.pluginRoot, "scripts/companion.sh"), ["mcp"], {
      cwd: fixture.repo,
      env: { ...fixture.env, KIMI_PLUGIN_CC_MCP_WORKSPACE: fixture.repo },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout!.on("data", (chunk) => this.accept(chunk));
    this.child.stderr!.on("data", (chunk) => { this.stderr += chunk; });
    this.closed = new Promise((resolve, reject) => {
      this.child.once("error", reject);
      this.child.once("close", (code) => {
        if (code !== 0) {
          const error = new Error(`MCP server exited ${code}: ${this.stderr}`);
          this.rejectAll(error);
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  static async modern(fixture: McpFixture): Promise<McpClient> {
    const client = new McpClient(fixture);
    const result = await client.request("server/discover", { _meta: modernMeta() });
    if (result.resultType !== "complete") throw new Error("modern discovery failed");
    return client;
  }

  static async legacy(fixture: McpFixture): Promise<McpClient> {
    const client = new McpClient(fixture);
    const result = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "codex-test", version: "1" },
    });
    if (result.protocolVersion !== "2025-06-18") throw new Error("legacy initialize failed");
    return client;
  }

  request(method: string, params: Record<string, unknown>): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 20_000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async close(): Promise<void> {
    this.child.stdin!.end();
    await this.closed;
  }

  private accept(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) break;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = this.pending.get(message.id);
      if (!waiter) continue;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  }

  private rejectAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}
