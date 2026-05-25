import { describe, expect, test, beforeEach } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  __resetHookMissingWarning,
  formatHookMissingWarning,
  maybeWarnHookMissing,
  verifyHookInstalled,
} from "../../runtime/hooks/install.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

beforeEach(() => {
  __resetHookMissingWarning();
});

describe("verifyHookInstalled", () => {
  test("reports missing when KIMI_CODE_HOME directory has no config", async () => {
    const home = await createTestPluginDataRoot("hook-install-no-config");
    try {
      const status = await verifyHookInstalled({ KIMI_CODE_HOME: home });
      expect(status.installed).toBe(false);
      expect(status.reason).toContain("does not exist");
      expect(status.configPath).toBe(path.join(home, "config.toml"));
    } finally {
      await cleanupTestPath(home);
    }
  });

  test("reports missing when config exists but has no hook block", async () => {
    const home = await createTestPluginDataRoot("hook-install-no-block");
    try {
      await mkdir(home, { recursive: true });
      await writeFile(
        path.join(home, "config.toml"),
        `default_model = "kimi-for-coding"\n`,
        "utf8",
      );
      const status = await verifyHookInstalled({ KIMI_CODE_HOME: home });
      expect(status.installed).toBe(false);
      expect(status.reason).toContain("no kimi-plugin-cc PreToolUse hook");
    } finally {
      await cleanupTestPath(home);
    }
  });

  test("reports missing when a stray comment mentions the marker but no real block exists", async () => {
    // PR 4 hardening: the old substring-based verifier returned installed
    // here because the raw text included both `kimi-plugin-cc-managed`
    // and `approval-hook.js`. The shared grammar parser now requires a
    // proper BEGIN/END block with a `[[hooks]]` table inside.
    const home = await createTestPluginDataRoot("hook-install-stray-comment");
    try {
      await mkdir(home, { recursive: true });
      await writeFile(
        path.join(home, "config.toml"),
        "# notes: don't reinstall kimi-plugin-cc-managed approval-hook.js by hand\n",
        "utf8",
      );
      const status = await verifyHookInstalled({ KIMI_CODE_HOME: home });
      expect(status.installed).toBe(false);
      expect(status.reason).toContain("no kimi-plugin-cc PreToolUse hook");
    } finally {
      await cleanupTestPath(home);
    }
  });

  test("reports missing when an unmanaged [[hooks]] block points at the script", async () => {
    // Same situation as above but with a real hooks block. The verifier
    // still rejects because there is no BEGIN/END managed marker — the
    // user installed something manually and we can't safely confirm it
    // matches the contract we depend on.
    const home = await createTestPluginDataRoot("hook-install-unmanaged-block");
    try {
      await mkdir(home, { recursive: true });
      await writeFile(
        path.join(home, "config.toml"),
        `[[hooks]]\nevent = "PreToolUse"\ncommand = "node /elsewhere/approval-hook.js"\n`,
        "utf8",
      );
      const status = await verifyHookInstalled({ KIMI_CODE_HOME: home });
      expect(status.installed).toBe(false);
      expect(status.reason).toContain("no kimi-plugin-cc PreToolUse hook");
    } finally {
      await cleanupTestPath(home);
    }
  });

  test("reports installed when a complete valid managed block is present", async () => {
    const home = await createTestPluginDataRoot("hook-install-ok");
    try {
      await mkdir(home, { recursive: true });
      await writeFile(
        path.join(home, "config.toml"),
        [
          "# === BEGIN kimi-plugin-cc-managed (v1.0.0) ===",
          "[[hooks]]",
          'event = "PreToolUse"',
          'command = "node /abs/path/dist/hooks/approval-hook.js"',
          "timeout = 15",
          "# === END kimi-plugin-cc-managed ===",
        ].join("\n"),
        "utf8",
      );
      const status = await verifyHookInstalled({ KIMI_CODE_HOME: home });
      expect(status.installed).toBe(true);
      expect(status.reason).toBeUndefined();
    } finally {
      await cleanupTestPath(home);
    }
  });

  test("reports missing when the managed block contains a matcher line (kimi-code would silently disable)", async () => {
    const home = await createTestPluginDataRoot("hook-install-matcher");
    try {
      await mkdir(home, { recursive: true });
      await writeFile(
        path.join(home, "config.toml"),
        [
          "# === BEGIN kimi-plugin-cc-managed (v0.9.0) ===",
          "[[hooks]]",
          'matcher = "*"',
          'event = "PreToolUse"',
          'command = "node /abs/path/dist/hooks/approval-hook.js"',
          "timeout = 15",
          "# === END kimi-plugin-cc-managed ===",
        ].join("\n"),
        "utf8",
      );
      const status = await verifyHookInstalled({ KIMI_CODE_HOME: home });
      expect(status.installed).toBe(false);
      expect(status.reason).toContain("matcher");
    } finally {
      await cleanupTestPath(home);
    }
  });

  test("reports missing when expectedHookPath is supplied and the block points elsewhere", async () => {
    const home = await createTestPluginDataRoot("hook-install-stale-path");
    try {
      await mkdir(home, { recursive: true });
      await writeFile(
        path.join(home, "config.toml"),
        [
          "# === BEGIN kimi-plugin-cc-managed (v0.9.0) ===",
          "[[hooks]]",
          'event = "PreToolUse"',
          'command = "node /old/dist/hooks/approval-hook.js"',
          "timeout = 15",
          "# === END kimi-plugin-cc-managed ===",
        ].join("\n"),
        "utf8",
      );
      const status = await verifyHookInstalled(
        { KIMI_CODE_HOME: home },
        { expectedHookPath: "/new/dist/hooks/approval-hook.js" },
      );
      expect(status.installed).toBe(false);
      expect(status.reason).toContain("different hook script");
    } finally {
      await cleanupTestPath(home);
    }
  });
});

describe("maybeWarnHookMissing", () => {
  test("is a no-op when status.installed is true", () => {
    let writes = "";
    const stream = {
      write(chunk: string): boolean {
        writes += chunk;
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    maybeWarnHookMissing({ installed: true, configPath: "/x" }, "review", stream);
    expect(writes).toBe("");
  });

  test("writes a single warning per process when status.installed is false", () => {
    let writes = "";
    const stream = {
      write(chunk: string): boolean {
        writes += chunk;
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    const status = { installed: false, configPath: "/x", reason: "missing" };
    maybeWarnHookMissing(status, "review", stream);
    maybeWarnHookMissing(status, "review", stream);
    maybeWarnHookMissing(status, "ask", stream);
    expect((writes.match(/safety hook is NOT installed/g) ?? []).length).toBe(1);
  });
});

describe("formatHookMissingWarning", () => {
  test("mentions the config path, reason, and command label", () => {
    const text = formatHookMissingWarning(
      {
        installed: false,
        configPath: "/home/u/.kimi-code/config.toml",
        reason: "no hook block",
      },
      "review_gate",
    );
    expect(text).toContain("/home/u/.kimi-code/config.toml");
    expect(text).toContain("no hook block");
    expect(text).toContain("review_gate");
    expect(text).toContain("/kimi:setup");
    expect(text).toContain("KIMI_PLUGIN_CC_SKIP_HOOK_CHECK");
  });
});
