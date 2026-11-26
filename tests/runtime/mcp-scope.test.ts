import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createMcpFixture, McpClient } from "../helpers/mcp.js";

describe("MCP read scope reaches the runtime", () => {
  test("an absolute read root runs; the companion parser, not the MCP layer, refuses a relative one", async () => {
    const fixture = await createMcpFixture("mcp-scope", { scenario: "ask-success" });
    const extra = await mkdtemp(path.join(os.tmpdir(), "kimi-mcp-read-root-"));
    let client: McpClient | undefined;
    try {
      client = await McpClient.legacy(fixture);
      const finished = await client.request("tools/call", {
        name: "kimi_read",
        arguments: { mode: "ask", prompt: "q", read_roots: [extra], workspace: fixture.repo },
      });
      expect(finished.isError).toBe(false);
      expect(finished.structuredContent.operation_kind).toBe("ask");
      expect(finished.structuredContent.status).toBe("completed");

      const refused = await client.request("tools/call", {
        name: "kimi_read",
        arguments: { mode: "ask", prompt: "q", read_roots: ["relative/dir"], workspace: fixture.repo },
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
