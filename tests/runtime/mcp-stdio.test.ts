import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";

import { createMcpMessageHandler } from "../../runtime/mcp/protocol.js";
import { serveMcpStdio } from "../../runtime/mcp/stdio.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import { createMcpFixture, modernMeta } from "../helpers/mcp.js";

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

async function runStdio(
  chunks: Array<Buffer | string>,
  handle: (message: unknown) => Promise<unknown | undefined>,
  yieldBetweenChunks = false,
): Promise<any[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  const outputChunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => outputChunks.push(chunk));

  const serving = serveMcpStdio(input, output, handle);
  for (const chunk of chunks) {
    input.write(chunk);
    if (yieldBetweenChunks) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  input.end();
  await serving;
  output.end();

  const stdout = Buffer.concat(outputChunks).toString("utf8");
  if (stdout.length === 0) return [];
  expect(stdout.endsWith("\n")).toBe(true);
  return stdout.slice(0, -1).split("\n").map((line) => JSON.parse(line));
}

function echoHandler(calls: unknown[]) {
  return async (message: unknown): Promise<unknown> => {
    calls.push(message);
    const request = message as { id?: unknown; params?: unknown };
    return { jsonrpc: "2.0", id: request.id, result: { echo: request.params } };
  };
}

function frame(message: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

describe("MCP stdio framing", () => {
  test("decodes multiple coalesced frames and emits one JSON frame per response", async () => {
    const calls: unknown[] = [];
    const first = { jsonrpc: "2.0", id: 1, method: "ping", params: { value: "first" } };
    const second = { jsonrpc: "2.0", id: 2, method: "tools/list", params: { value: "second" } };
    const frames = await runStdio([Buffer.concat([frame(first), frame(second)])], echoHandler(calls));

    expect(calls).toEqual([first, second]);
    expect(frames).toHaveLength(2);
    expect(frames.find((response) => response.id === 1)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { echo: { value: "first" } },
    });
    expect(frames.find((response) => response.id === 2)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { echo: { value: "second" } },
    });
  });

  test("reassembles frames split at every byte, including UTF-8 code-point boundaries", async () => {
    const calls: unknown[] = [];
    const unicode = { text: "before-🌊-漢字-é-🙂-after" };
    const first = { jsonrpc: "2.0", id: "unicode", method: "tools/call", params: unicode };
    const second = { jsonrpc: "2.0", id: "after", method: "ping", params: { text: "✓" } };
    const bytes = Buffer.concat([frame(first), frame(second)]);
    const chunks = Array.from({ length: bytes.length }, (_, index) => bytes.subarray(index, index + 1));

    const frames = await runStdio(chunks, echoHandler(calls), true);
    expect(calls).toEqual([first, second]);
    expect(frames).toHaveLength(2);
    expect(frames.find((response) => response.id === "unicode").result.echo).toEqual(unicode);
    expect(frames.find((response) => response.id === "after").result.echo).toEqual({ text: "✓" });
  }, 30_000);

  test("reports malformed JSON and continues with later valid frames", async () => {
    const calls: unknown[] = [];
    const valid = { jsonrpc: "2.0", id: "valid", method: "ping", params: { ok: true } };
    const frames = await runStdio([
      '{"jsonrpc":"2.0","id":bad}\n',
      " \t\n",
      frame(valid),
    ], echoHandler(calls));

    expect(calls).toEqual([valid]);
    expect(frames).toHaveLength(2);
    expect(frames.find((response) => response.id === null)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32_700, message: "Parse error" },
    });
    expect(frames.find((response) => response.id === "valid").result.echo).toEqual({ ok: true });
  });

  for (const terminated of [true, false]) {
    test(`rejects an over-limit ${terminated ? "newline-terminated" : "unterminated"} frame without invoking the handler`, async () => {
      const calls: unknown[] = [];
      const oversized = Buffer.alloc(MAX_MESSAGE_BYTES + 1, 0x20);
      const input = terminated ? Buffer.concat([oversized, Buffer.from("\n")]) : oversized;
      const frames = await runStdio([input], echoHandler(calls));

      expect(calls).toEqual([]);
      expect(frames).toEqual([{
        jsonrpc: "2.0",
        id: null,
        error: { code: -32_700, message: "MCP frame exceeds 8 MiB" },
      }]);
    }, 30_000);
  }

  test("ignores a tools/call notification with no response and no job-store side effect", async () => {
    const fixture = await createMcpFixture("mcp-stdio-notification");
    try {
      const discovery = {
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: { _meta: modernMeta() },
      };
      const notification = {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          _meta: modernMeta(),
          name: "kimi_read",
          arguments: { workspace: fixture.repo, mode: "ask", prompt: "A notification must never launch this" },
        },
      };
      const handler = createMcpMessageHandler({
        ...fixture.env,
        KIMI_PLUGIN_CC_MCP_WORKSPACE: fixture.repo,
      });
      const frames = await runStdio([frame(discovery), frame(notification)], handler, true);

      expect(frames).toHaveLength(1);
      expect(frames[0].id).toBe(1);
      expect(frames[0].result.resultType).toBe("complete");

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
      await fixture.cleanup();
    }
  }, 30_000);
});
