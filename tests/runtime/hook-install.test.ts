import { describe, expect, test, beforeEach } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  __resetHookMissingWarning,
  formatHookMissingWarning,
  maybeWarnHookMissing,
  verifyHookInstalled,
} from "../../runtime/hooks/install.js";
import { buildHookShellCommand } from "../../runtime/hooks/install-paths.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

/**
 * Helper: produce the canonical shell command string this companion
 * would write for a given hook script path, using process.execPath as
 * the node binary. Tests embed this exact byte string into the managed
 * block so the verifier's equality check passes.
 */
function canonicalCommandFor(hookPath: string): string {
  return buildHookShellCommand(hookPath, {});
}

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
      expect(status.reason).toContain("managed block is not present");
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
      expect(status.reason).toContain("managed block is not present");
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
      expect(status.reason).toContain("managed block is not present");
    } finally {
      await cleanupTestPath(home);
    }
  });

  test("reports installed when a complete valid managed block is present", async () => {
    const home = await createTestPluginDataRoot("hook-install-ok");
    try {
      const hookPath = "/abs/path/dist/hooks/approval-hook.js";
      const canonical = canonicalCommandFor(hookPath);
      await mkdir(home, { recursive: true });
      await writeFile(
        path.join(home, "config.toml"),
        [
          "# === BEGIN kimi-plugin-cc-managed (v1.0.0) ===",
          "[[hooks]]",
          'event = "PreToolUse"',
          `command = ${JSON.stringify(canonical)}`,
          "timeout = 15",
          "# === END kimi-plugin-cc-managed ===",
        ].join("\n"),
        "utf8",
      );
      const status = await verifyHookInstalled({
        KIMI_CODE_HOME: home,
        KIMI_PLUGIN_CC_HOOK_SCRIPT: hookPath,
        KIMI_PLUGIN_CC_KIMI_BIN: "/definitely/not-needed-for-baseline-events",
      });
      expect(status.installed).toBe(true);
      expect(status.reason).toBeUndefined();
    } finally {
      await cleanupTestPath(home);
    }
  });

  test("reports missing when an invalid foreign hook makes upstream drop every hook", async () => {
    const home = await createTestPluginDataRoot("hook-install-invalid-foreign");
    try {
      const hookPath = "/abs/path/dist/hooks/approval-hook.js";
      const canonical = canonicalCommandFor(hookPath);
      await mkdir(home, { recursive: true });
      await writeFile(
        path.join(home, "config.toml"),
        [
          "# === BEGIN kimi-plugin-cc-managed (v1.7.2) ===",
          "[[hooks]]",
          'event = "PreToolUse"',
          `command = ${JSON.stringify(canonical)}`,
          "timeout = 15",
          "# === END kimi-plugin-cc-managed ===",
          "",
          "[[hooks]]",
          'event = "PreToolUse"',
          'command = "foreign-hook"',
          'env = { TOKEN = "value" }',
        ].join("\n"),
        "utf8",
      );
      const status = await verifyHookInstalled({
        KIMI_CODE_HOME: home,
        KIMI_PLUGIN_CC_HOOK_SCRIPT: hookPath,
      });
      expect(status.installed).toBe(false);
      expect(status.reason).toContain('unknown field "env"');
      expect(status.reason).toContain("drops the entire hooks array");
    } finally {
      await cleanupTestPath(home);
    }
  });

  test("rejects [hooks.foo] and [[hooks.foo]] section shapes", async () => {
    for (const [name, header] of [
      ["table", "[hooks.foo]"],
      ["array-table", "[[hooks.foo]]"],
    ] as const) {
      const home = await createTestPluginDataRoot(`hook-install-nested-${name}`);
      try {
        const hookPath = "/abs/path/dist/hooks/approval-hook.js";
        const canonical = canonicalCommandFor(hookPath);
        await mkdir(home, { recursive: true });
        await writeFile(
          path.join(home, "config.toml"),
          [
            "# === BEGIN kimi-plugin-cc-managed (v1.7.2) ===",
            "[[hooks]]",
            'event = "PreToolUse"',
            `command = ${JSON.stringify(canonical)}`,
            "timeout = 15",
            "# === END kimi-plugin-cc-managed ===",
            "",
            header,
            'command = "foreign-hook"',
          ].join("\n"),
          "utf8",
        );
        const status = await verifyHookInstalled({
          KIMI_CODE_HOME: home,
          KIMI_PLUGIN_CC_HOOK_SCRIPT: hookPath,
        });
        expect(status.installed).toBe(false);
        expect(status.reason).toContain("no configured PreToolUse hook");
      } finally {
        await cleanupTestPath(home);
      }
    }
  });

  test("checks additive hook events against the installed kimi-code minor", async () => {
    if (process.platform === "win32") return;
    for (const testCase of [
      { event: "PermissionRequest", version: "0.7.0", minimum: "0.8", installed: false },
      { event: "PermissionRequest", version: "0.8.0", minimum: "0.8", installed: true },
      { event: "Interrupt", version: "0.13.0", minimum: "0.14", installed: false },
      { event: "Interrupt", version: "0.14.0", minimum: "0.14", installed: true },
    ] as const) {
      const suffix = `${testCase.event.toLowerCase()}-${testCase.version.replaceAll(".", "-")}`;
      const home = await createTestPluginDataRoot(`hook-install-version-${suffix}`);
      try {
        const hookPath = "/abs/path/dist/hooks/approval-hook.js";
        const canonical = canonicalCommandFor(hookPath);
        const kimiBin = path.join(home, "fake-kimi-version.js");
        await mkdir(home, { recursive: true });
        await writeFile(
          kimiBin,
          `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(testCase.version)}\n`,
          "utf8",
        );
        await chmod(kimiBin, 0o700);
        await writeFile(
          path.join(home, "config.toml"),
          [
            "# === BEGIN kimi-plugin-cc-managed (v1.7.2) ===",
            "[[hooks]]",
            'event = "PreToolUse"',
            `command = ${JSON.stringify(canonical)}`,
            "timeout = 15",
            "# === END kimi-plugin-cc-managed ===",
            "",
            "[[hooks]]",
            `event = ${JSON.stringify(testCase.event)}`,
            'command = "foreign-hook"',
          ].join("\n"),
          "utf8",
        );

        const status = await verifyHookInstalled({
          KIMI_CODE_HOME: home,
          KIMI_PLUGIN_CC_HOOK_SCRIPT: hookPath,
          KIMI_PLUGIN_CC_KIMI_BIN: kimiBin,
        });
        expect(status.installed).toBe(testCase.installed);
        if (!testCase.installed) {
          expect(status.reason).toContain(`requires kimi-code >= ${testCase.minimum}`);
          expect(status.reason).toContain(`installed version is ${testCase.version.slice(0, -2)}`);
        }
      } finally {
        await cleanupTestPath(home);
      }
    }
  });

  test("reports missing when the command is smuggled under a non-[[hooks]] table (Codex review)", async () => {
    // The [[hooks]] table has only an event; the canonical command lives under
    // a DIFFERENT table. kimi-code would run a command-less hook (no
    // enforcement), so the verifier must NOT bless this as installed.
    const home = await createTestPluginDataRoot("hook-install-table-smuggle");
    try {
      const hookPath = "/abs/path/dist/hooks/approval-hook.js";
      const canonical = canonicalCommandFor(hookPath);
      await mkdir(home, { recursive: true });
      await writeFile(
        path.join(home, "config.toml"),
        [
          "# === BEGIN kimi-plugin-cc-managed (v1.0.0) ===",
          "[[hooks]]",
          'event = "PreToolUse"',
          "[not_hooks]",
          `command = ${JSON.stringify(canonical)}`,
          "# === END kimi-plugin-cc-managed ===",
        ].join("\n"),
        "utf8",
      );
      const status = await verifyHookInstalled({
        KIMI_CODE_HOME: home,
        KIMI_PLUGIN_CC_HOOK_SCRIPT: hookPath,
      });
      expect(status.installed).toBe(false);
      expect(status.reason).toContain("missing required field `command`");
    } finally {
      await cleanupTestPath(home);
    }
  });

  test("reports missing when command is a substring-match disguise (true # /path/to/approval-hook.js)", async () => {
    // Audit finding (reports 27/28 Codex C1 + Claude HIGH-2): the
    // old substring check `commandPath.includes(expectedHookPath)`
    // accepted this shape. `/bin/sh -c "true # ..."` runs only `true`
    // (exit 0 → kimi-code treats as ALLOW). The verifier now does
    // exact equality on the canonical shell command.
    const home = await createTestPluginDataRoot("hook-install-substring-disguise");
    try {
      const hookPath = "/abs/path/dist/hooks/approval-hook.js";
      await mkdir(home, { recursive: true });
      await writeFile(
        path.join(home, "config.toml"),
        [
          "# === BEGIN kimi-plugin-cc-managed (v1.0.0) ===",
          "[[hooks]]",
          'event = "PreToolUse"',
          `command = "true # ${hookPath}"`,
          "timeout = 15",
          "# === END kimi-plugin-cc-managed ===",
        ].join("\n"),
        "utf8",
      );
      const status = await verifyHookInstalled({
        KIMI_CODE_HOME: home,
        KIMI_PLUGIN_CC_HOOK_SCRIPT: hookPath,
      });
      expect(status.installed).toBe(false);
      expect(status.reason).toContain("does not match the canonical command");
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

  test("reports missing when the block references a stale hook script path", async () => {
    // Audit finding (report 27 Claude CRITICAL-1): rescue/ask/review
    // previously called verifyHookInstalled without an expected path,
    // so a managed block pointing at a stale dist directory passed
    // even though kimi-code's `/bin/sh -c <stale-path>` exits non-2,
    // which kimi-code's hook runner treats as ALLOW. The verifier
    // now always reconstructs the canonical command and rejects
    // path drift unconditionally.
    const home = await createTestPluginDataRoot("hook-install-stale-path");
    try {
      // Same host (both under ~/.claude → host id `claude-code`, which is
      // version-independent), only the version-stamped path moved — the real
      // plugin-upgrade drift the diagnosis is for.
      const oldHookPath =
        "/Users/x/.claude/plugins/cache/kimi-marketplace/kimi/1.5.0/dist/hooks/approval-hook.js";
      const newHookPath =
        "/Users/x/.claude/plugins/cache/kimi-marketplace/kimi/1.7.0/dist/hooks/approval-hook.js";
      const staleCommand = canonicalCommandFor(oldHookPath);
      await mkdir(home, { recursive: true });
      await writeFile(
        path.join(home, "config.toml"),
        [
          "# === BEGIN kimi-plugin-cc-managed (v0.9.0) ===",
          "[[hooks]]",
          'event = "PreToolUse"',
          `command = ${JSON.stringify(staleCommand)}`,
          "timeout = 15",
          "# === END kimi-plugin-cc-managed ===",
        ].join("\n"),
        "utf8",
      );
      const status = await verifyHookInstalled({
        KIMI_CODE_HOME: home,
        KIMI_PLUGIN_CC_HOOK_SCRIPT: newHookPath,
      });
      expect(status.installed).toBe(false);
      // H4: the verifier now classifies the mismatch. Same node (process.execPath),
      // different hook script path → a "hook script path drift" diagnosis with the
      // actionable /kimi:setup fix, instead of the raw expected-vs-got dump.
      expect(status.reason).toContain("Hook script path drift");
      expect(status.reason).toContain(oldHookPath);
      expect(status.reason).toContain("Run /kimi:setup");
    } finally {
      await cleanupTestPath(home);
    }
  });

  test("classifies a Node-binary drift (pinned interpreter gone) — the live H4 case", async () => {
    // The hook was installed pinning an absolute Node path; Node later upgraded
    // (Homebrew Cellar bump / nvm/asdf switch) and that path vanished. The block
    // is structurally valid — only the Node token drifted and the old binary is
    // gone — so the verifier should say exactly that, not a raw expected-vs-got dump.
    const home = await createTestPluginDataRoot("hook-install-node-drift");
    try {
      const hookPath = "/abs/plugin/dist/hooks/approval-hook.js";
      const goneNode = "/opt/homebrew/Cellar/node/26.0.0/bin/node"; // upgraded away
      const staleCommand = buildHookShellCommand(hookPath, {
        KIMI_PLUGIN_CC_NODE_BIN: goneNode,
      });
      await mkdir(home, { recursive: true });
      await writeFile(
        path.join(home, "config.toml"),
        [
          "# === BEGIN kimi-plugin-cc-managed (v1.2.0) ===",
          "[[hooks]]",
          'event = "PreToolUse"',
          `command = ${JSON.stringify(staleCommand)}`,
          "timeout = 15",
          "# === END kimi-plugin-cc-managed ===",
        ].join("\n"),
        "utf8",
      );
      // Verify env pins the SAME hook path but no NODE_BIN override, so expected
      // Node = process.execPath (a real, existing binary) ≠ the gone path.
      const status = await verifyHookInstalled({
        KIMI_CODE_HOME: home,
        KIMI_PLUGIN_CC_HOOK_SCRIPT: hookPath,
      });
      expect(status.installed).toBe(false);
      expect(status.reason).toContain("Node binary drift");
      expect(status.reason).toContain(goneNode);
      expect(status.reason).toContain("no longer exists");
      expect(status.reason).toContain("Run /kimi:setup");
      // Pure Node drift — the hook path matched, so don't mislabel it as path drift.
      expect(status.reason).not.toContain("Hook script path drift");
    } finally {
      await cleanupTestPath(home);
    }
  });

  test("rejects KIMI_PLUGIN_CC_NODE_BIN that is not an absolute path", async () => {
    const home = await createTestPluginDataRoot("hook-install-bad-node-bin");
    try {
      const status = await verifyHookInstalled({
        KIMI_CODE_HOME: home,
        KIMI_PLUGIN_CC_HOOK_SCRIPT: "/abs/path/dist/hooks/approval-hook.js",
        KIMI_PLUGIN_CC_NODE_BIN: "node",
      });
      expect(status.installed).toBe(false);
      expect(status.reason).toContain("KIMI_PLUGIN_CC_NODE_BIN must be an absolute path");
    } finally {
      await cleanupTestPath(home);
    }
  });

  test("rejects KIMI_PLUGIN_CC_HOOK_SCRIPT that is not an absolute path (audit re-review M)", async () => {
    const home = await createTestPluginDataRoot("hook-install-bad-script-path");
    try {
      const status = await verifyHookInstalled({
        KIMI_CODE_HOME: home,
        KIMI_PLUGIN_CC_HOOK_SCRIPT: "./relative/hook.js",
      });
      expect(status.installed).toBe(false);
      expect(status.reason).toContain("KIMI_PLUGIN_CC_HOOK_SCRIPT must be an absolute path");
    } finally {
      await cleanupTestPath(home);
    }
  });

  test("verifier accepts an apostrophe in the hook script path (TOML round-trip)", async () => {
    // Audit re-review (reports 33/34 convergent MEDIUM): the canonical
    // expected command has a `\` from shell-quoting the apostrophe; the
    // installer TOML-escapes that `\` to `\\` on write; the parser must
    // TOML-decode it back to `\` before equality, or every install on
    // an apostrophe path false-fails the verifier.
    const home = await createTestPluginDataRoot("hook-install-apostrophe-path");
    try {
      const hookPath = "/home/o'reilly/dist/hooks/approval-hook.js";
      const canonical = canonicalCommandFor(hookPath);
      // tomlBasicString equivalent: escape \ to \\ and " to \"
      const tomlEscaped = canonical.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
      await mkdir(home, { recursive: true });
      await writeFile(
        path.join(home, "config.toml"),
        [
          "# === BEGIN kimi-plugin-cc-managed (v1.0.0) ===",
          "[[hooks]]",
          'event = "PreToolUse"',
          `command = "${tomlEscaped}"`,
          "timeout = 15",
          "# === END kimi-plugin-cc-managed ===",
        ].join("\n"),
        "utf8",
      );
      const status = await verifyHookInstalled({
        KIMI_CODE_HOME: home,
        KIMI_PLUGIN_CC_HOOK_SCRIPT: hookPath,
      });
      expect(status.installed).toBe(true);
      expect(status.reason).toBeUndefined();
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
