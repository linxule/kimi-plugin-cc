import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createMcpFixture, McpClient } from "../helpers/mcp.js";

describe("MCP kimi_setup tool", () => {
  test("install writes and probes the PreToolUse hook, and check reports ok vs failed cleanly", async () => {
    const fixture = await createMcpFixture("mcp-setup-install-check", { skipSetup: true });
    let client: McpClient | undefined;
    try {
      client = await McpClient.legacy(fixture);

      // Before install, check reports failure cleanly with isError: true.
      const before = await client.request("tools/call", {
        name: "kimi_setup",
        arguments: { action: "check", workspace: fixture.repo },
      });
      expect(before.isError).toBe(true);
      expect(before.structuredContent.action).toBe("check");
      expect(before.structuredContent.probe).toBe("failed");
      expect(before.structuredContent.probe_error).toEqual(expect.any(String));

      // Install writes the canonical managed block and passes the hook probe.
      const installed = await client.request("tools/call", {
        name: "kimi_setup",
        arguments: { action: "install", workspace: fixture.repo },
      });
      expect(installed.isError).toBe(false);
      expect(installed.structuredContent.action).toBe("install");
      expect(installed.structuredContent.block_written).toBe(true);
      expect(installed.structuredContent.probe).toBe("ok");
      expect(installed.structuredContent.config_path).toBe(path.join(fixture.kimiHome, "config.toml"));
      expect(installed.structuredContent.hook_script_path).toContain("approval-hook.js");

      // Subsequent check (also verifying default action="check") passes.
      const after = await client.request("tools/call", {
        name: "kimi_setup",
        arguments: {},
      });
      expect(after.isError).toBe(false);
      expect(after.structuredContent.action).toBe("check");
      expect(after.structuredContent.probe).toBe("ok");
      expect(after.structuredContent.block_written).toBe(false);
    } finally {
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 60_000);

  test("models returns credential-safe JSON inventory without leaking secrets", async () => {
    const fixture = await createMcpFixture("mcp-setup-models");
    const secret = "sk-test-never-leak-this-credential";
    const configPath = path.join(fixture.kimiHome, "config.toml");
    const existingConfig = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      [
        'default_model = "kimi-k2"',
        "",
        "[providers.moonshot]",
        'type = "kimi"',
        `api_key = "${secret}"`,
        "",
        "[models.kimi-k2]",
        'provider = "moonshot"',
        'model = "kimi-k2-0905"',
        "",
        existingConfig,
      ].join("\n"),
      "utf8",
    );
    let client: McpClient | undefined;
    try {
      client = await McpClient.legacy(fixture);
      const res = await client.request("tools/call", {
        name: "kimi_setup",
        arguments: { action: "models" },
      });
      expect(res.isError).toBe(false);
      expect(res.structuredContent.schemaVersion).toBe(1);
      expect(res.structuredContent.configPresent).toBe(true);
      expect(res.structuredContent.validation).toBe("not-connection-tested");
      expect(res.structuredContent.configuredDefault).toBe("kimi-k2");
      expect(res.structuredContent.providers).toEqual([{ id: "moonshot", type: "kimi" }]);
      expect(res.structuredContent.models).toEqual([
        { alias: "kimi-k2", provider: "moonshot", model: "kimi-k2-0905" },
      ]);
      expect(res.content[0].text).not.toContain(secret);
      expect(JSON.stringify(res.structuredContent)).not.toContain(secret);
    } finally {
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 60_000);

  test("repair_sessions supports dry-run default, apply, and all-repo scope, and rejects misused flags", async () => {
    const fixture = await createMcpFixture("mcp-setup-repair");
    let client: McpClient | undefined;
    try {
      client = await McpClient.legacy(fixture);

      // Run one ask job so there is a real native-v2 session in the store.
      const ask = await client.request("tools/call", {
        name: "kimi_read",
        arguments: { mode: "ask", prompt: "Seed session for repair preview", workspace: fixture.repo },
      });
      expect(ask.isError).toBe(false);
      expect(ask.structuredContent.status).toBe("completed");

      const preview = await client.request("tools/call", {
        name: "kimi_setup",
        arguments: { action: "repair_sessions", workspace: fixture.repo },
      });
      expect(preview.isError).toBe(false);
      expect(preview.structuredContent.mode).toBe("dry-run");
      expect(preview.structuredContent.scope).toBe("repository");
      expect(preview.structuredContent.sessions).toBeGreaterThanOrEqual(1);

      const appliedAll = await client.request("tools/call", {
        name: "kimi_setup",
        arguments: { action: "repair_sessions", apply: true, all: true },
      });
      expect(appliedAll.isError).toBe(false);
      expect(appliedAll.structuredContent.mode).toBe("apply");
      expect(appliedAll.structuredContent.scope).toBe("host");

      const badArgs = await client.request("tools/call", {
        name: "kimi_setup",
        arguments: { action: "check", apply: true },
      });
      expect(badArgs.isError).toBe(true);
      expect(badArgs.structuredContent.error.code).toBe("MCP_INVALID_ARGUMENTS");
    } finally {
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 60_000);

  test("relative KIMI_CODE_HOME resolves consistently across kimi_setup install, check, and kimi_read", async () => {
    const fixture = await createMcpFixture("mcp-setup-relative-home", {
      skipSetup: true,
      scenario: "ask-success",
      delayMs: "0",
      extraEnv: {
        KIMI_CODE_HOME: "relative-kimi-home",
        KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "",
      },
    });
    let client: McpClient | undefined;
    try {
      client = await McpClient.legacy(fixture);

      const installed = await client.request("tools/call", {
        name: "kimi_setup",
        arguments: { action: "install", workspace: fixture.repo },
      });
      expect(installed.isError).toBe(false);
      expect(installed.structuredContent.probe).toBe("ok");
      expect(installed.structuredContent.config_path).toBe(
        path.join(fixture.repo, "relative-kimi-home", "config.toml"),
      );

      const checked = await client.request("tools/call", {
        name: "kimi_setup",
        arguments: { action: "check", workspace: fixture.repo },
      });
      expect(checked.isError).toBe(false);
      expect(checked.structuredContent.probe).toBe("ok");
      expect(checked.structuredContent.config_path).toBe(
        path.join(fixture.repo, "relative-kimi-home", "config.toml"),
      );

      const asked = await client.request("tools/call", {
        name: "kimi_read",
        arguments: { mode: "ask", prompt: "Verify relative KIMI_CODE_HOME end-to-end", workspace: fixture.repo },
      });
      expect(asked.isError).toBe(false);
      expect(asked.structuredContent.status).toBe("completed");
      expect(asked.content[0].text).toContain("Ask answer from mock Kimi.");
    } finally {
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 60_000);
});
