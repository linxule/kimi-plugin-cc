import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createMcpFixture, McpClient } from "../helpers/mcp.js";

async function waitForTerminal(client: McpClient, jobId: string): Promise<any> {
  let result: any;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    result = await client.request("tools/call", { name: "kimi_job_result", arguments: { job_id: jobId } });
    if (result.structuredContent?.status && result.structuredContent.status !== "running") return result;
    await Bun.sleep(100);
  }
  return result;
}

describe("MCP read scope reaches the runtime", () => {
  test("an absolute read root runs; the companion parser, not the MCP layer, refuses a relative one", async () => {
    const fixture = await createMcpFixture("mcp-scope", { scenario: "ask-success" });
    const extra = await mkdtemp(path.join(os.tmpdir(), "kimi-mcp-read-root-"));
    let client: McpClient | undefined;
    try {
      client = await McpClient.legacy(fixture);
      const started = await client.request("tools/call", {
        name: "kimi_ask",
        arguments: { prompt: "q", fresh: true, read_roots: [extra], workspace: fixture.repo },
      });
      expect(started.isError).toBe(false);
      const finished = await waitForTerminal(client, started.structuredContent.job_id);
      expect(finished.isError).toBe(false);
      expect(finished.structuredContent.operation_kind).toBe("ask");
      expect(finished.structuredContent.status).toBe("completed");

      const refused = await client.request("tools/call", {
        name: "kimi_ask",
        arguments: { prompt: "q", fresh: true, read_roots: ["relative/dir"], workspace: fixture.repo },
      });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain("[INVALID_ARGS] [ask.parse] --read-root must be an absolute directory path");
    } finally {
      if (client) await client.close();
      await rm(extra, { recursive: true, force: true });
      await fixture.cleanup();
    }
  }, 60_000);
});
