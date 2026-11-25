import { describe, expect, test, beforeEach } from "bun:test";
import { realpathSync } from "node:fs";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  __resetHookMissingWarning,
  formatHookMissingWarning,
  hookRefusalDetails,
  maybeWarnHookMissing,
  verifyHookInstalled,
} from "../../runtime/hooks/install.js";
import { buildHookShellCommand, resolveHostId } from "../../runtime/hooks/install-paths.js";
import { evaluateInstalled } from "../../runtime/hooks/managed-block.js";
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
      const hookPath = path.join(home, "dist", "hooks", "approval-hook.js");
      const canonical = canonicalCommandFor(hookPath);
      await mkdir(home, { recursive: true });
      await mkdir(path.dirname(hookPath), { recursive: true });
      await writeFile(hookPath, "// fake hook script for tests\n", "utf8");
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

  test("reports missing when the command matches byte-for-byte but the hook script was deleted", async () => {
    // Security fix: a byte-exact `command` match alone doesn't prove the
    // hook can run. If dist/hooks/approval-hook.js (or the whole versioned
    // plugin cache dir) is deleted after install, the managed block still
    // matches the canonical command while kimi-code's `/bin/sh -c '<node>'
    // '<script>'` fails to spawn. kimi-code's hook runner only treats exit
    // code 2 as a deny — any other exit (including a spawn failure) is
    // ALLOW — so a missing script previously left `verifyHookInstalled`
    // reporting `installed: true` and every refusal gate silently
    // auto-approved. The verifier now also confirms the script file exists
    // and is readable before blessing a command match as installed.
    const home = await createTestPluginDataRoot("hook-install-script-deleted");
    try {
      const hookPath = path.join(home, "dist", "hooks", "approval-hook.js");
      const canonical = canonicalCommandFor(hookPath);
      await mkdir(home, { recursive: true });
      await mkdir(path.dirname(hookPath), { recursive: true });
      await writeFile(hookPath, "// fake hook script for tests\n", "utf8");
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

      // Sanity: the same setup passes as installed while the script exists.
      const beforeDelete = await verifyHookInstalled({
        KIMI_CODE_HOME: home,
        KIMI_PLUGIN_CC_HOOK_SCRIPT: hookPath,
      });
      expect(beforeDelete.installed).toBe(true);

      // Simulate the versioned dist dir being pruned after install.
      await rm(hookPath, { force: true });

      const status = await verifyHookInstalled({
        KIMI_CODE_HOME: home,
        KIMI_PLUGIN_CC_HOOK_SCRIPT: hookPath,
      });
      expect(status.installed).toBe(false);
      expect(status.reason).toContain(hookPath);
      expect(status.reason).toContain("missing or unreadable");
      expect(status.reason).toContain("/kimi:setup");
    } finally {
      await cleanupTestPath(home);
    }
  });

  test("reports missing when the pinned node symlink is retargeted to nothing (command bytes unchanged)", async () => {
    // The v1.9.0 residual risk, NARROWED (not closed — see install.ts for the
    // honest scope). This constructs the one shape the X_OK probe actually
    // catches: an explicit KIMI_PLUGIN_CC_NODE_BIN override naming a binary
    // that is NOT the running interpreter and has since gone away — e.g. a
    // pinned nvm version later `nvm uninstall`ed.
    //
    // The override is what makes it reachable, and that is the point rather
    // than a test artifact: on the DEFAULT path the pinned node is the binary
    // this process is executing from, so it necessarily exists. A dangling
    // symlink is NOT this case — it cannot be exec'd, so companion.sh resolves
    // a different node and plain byte-exact equality refuses first, with a
    // recoverable drift.
    //
    // The load-bearing assertion is not just installed=false: it is that the
    // canonical command is byte-IDENTICAL before and after. That is precisely
    // why the existing equality check cannot see this one, and why the probe
    // earns its two syscalls.
    const home = await createTestPluginDataRoot("hook-install-node-symlink-dead");
    try {
      const hookPath = path.join(home, "dist", "hooks", "approval-hook.js");
      await mkdir(path.dirname(hookPath), { recursive: true });
      await writeFile(hookPath, "// fake hook script for tests\n", "utf8");

      // A stand-in for /opt/homebrew/bin/node: a symlink to the real
      // interpreter. This is what gets pinned into the managed block.
      const nodeSymlink = path.join(home, "bin", "node");
      await mkdir(path.dirname(nodeSymlink), { recursive: true });
      await symlink(realpathSync(process.execPath), nodeSymlink);

      const env = {
        KIMI_CODE_HOME: home,
        KIMI_PLUGIN_CC_HOOK_SCRIPT: hookPath,
        KIMI_PLUGIN_CC_NODE_BIN: nodeSymlink,
      };
      const canonical = buildHookShellCommand(hookPath, env);
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

      // Sanity: enforcing while the symlink resolves.
      expect((await verifyHookInstalled(env)).installed).toBe(true);

      // `brew upgrade` prunes the Cellar dir the symlink pointed at, leaving a
      // dangling link at the SAME path.
      await rm(nodeSymlink, { force: true });
      await symlink(path.join(home, "bin", "node-that-does-not-exist"), nodeSymlink);

      // The pin is still byte-exact — this is why the command check cannot see it.
      expect(buildHookShellCommand(hookPath, env)).toBe(canonical);

      const status = await verifyHookInstalled(env);
      expect(status.installed).toBe(false);
      expect(status.reason).toContain(nodeSymlink);
      expect(status.reason).toContain("not executable");
      // kimi-code's fail-open semantics are the reason this must fail closed.
      expect(status.reason).toContain("ALLOW");

      // NOT re-pin-recoverable: /kimi:setup cannot conjure a working Node, so an
      // agent caller must not be told to loop on it. It gets a machine-readable
      // discriminator instead, because every other refusal emits an identical
      // {config_path} payload and prose is invisible to an LLM caller.
      const details = hookRefusalDetails(status);
      expect(details.retryable_after_setup).toBeUndefined();
      expect(details.drift_axis).toBeUndefined();
      expect(details.refusal_kind).toBe("node-bin-not-executable");
      expect(details.node_bin).toBe(nodeSymlink);
    } finally {
      await cleanupTestPath(home);
    }
  });

  test("reports missing when the pinned node binary exists but is not executable", async () => {
    // Same bypass, different cause: the interpreter file is present (so an
    // existence-only check would pass it) but its exec bit is gone — a
    // botched install or an over-eager chmod. /bin/sh -c still cannot run it.
    const home = await createTestPluginDataRoot("hook-install-node-not-exec");
    try {
      const hookPath = path.join(home, "dist", "hooks", "approval-hook.js");
      await mkdir(path.dirname(hookPath), { recursive: true });
      await writeFile(hookPath, "// fake hook script for tests\n", "utf8");

      const fakeNode = path.join(home, "bin", "node");
      await mkdir(path.dirname(fakeNode), { recursive: true });
      await writeFile(fakeNode, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(fakeNode, 0o755);

      const env = {
        KIMI_CODE_HOME: home,
        KIMI_PLUGIN_CC_HOOK_SCRIPT: hookPath,
        KIMI_PLUGIN_CC_NODE_BIN: fakeNode,
      };
      await writeFile(
        path.join(home, "config.toml"),
        [
          "[[hooks]]",
          'event = "PreToolUse"',
          `command = ${JSON.stringify(buildHookShellCommand(hookPath, env))}`,
          "timeout = 15",
        ].join("\n"),
        "utf8",
      );

      expect((await verifyHookInstalled(env)).installed).toBe(true);

      // Readable, but no longer executable.
      await chmod(fakeNode, 0o644);

      const status = await verifyHookInstalled(env);
      expect(status.installed).toBe(false);
      expect(status.reason).toContain("not executable");
      expect(hookRefusalDetails(status).refusal_kind).toBe("node-bin-not-executable");
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
        const hookPath = path.join(home, "dist", "hooks", "approval-hook.js");
        const canonical = canonicalCommandFor(hookPath);
        const kimiBin = path.join(home, "fake-kimi-version.js");
        await mkdir(home, { recursive: true });
        await mkdir(path.dirname(hookPath), { recursive: true });
        await writeFile(hookPath, "// fake hook script for tests\n", "utf8");
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
      // The prose above is for humans; an LLM caller branches on this instead.
      expect(status.drift).toEqual({
        axis: "hook-script",
        installedCommand: staleCommand,
        expectedCommand: canonicalCommandFor(newHookPath),
      });
      expect(hookRefusalDetails(status)).toMatchObject({
        drift_axis: "hook-script",
        retryable_after_setup: true,
      });
    } finally {
      await cleanupTestPath(home);
    }
  });

  // §6 step 2 — machine-readable drift, so an agent can re-run setup and retry
  // instead of dead-ending. NEVER influences `installed`; it is derived only
  // after byte-exact equality has already failed.
  describe("structured drift signal", () => {
    test("classifies a marker-less stale table (the real 2026-07-25 incident shape)", async () => {
      // kimi-code strips ALL comments on every login/settings write, so markers
      // vanish; a plugin update then moves the version-stamped path. Both at
      // once is the COMMON case, and it lands in `absent`, not `found` — the
      // case an earlier draft of this feature missed entirely.
      const home = await createTestPluginDataRoot("hook-install-drift-bare");
      try {
        const oldHookPath =
          "/Users/x/.claude/plugins/cache/kimi-marketplace/kimi/1.8.7/dist/hooks/approval-hook.js";
        const newHookPath =
          "/Users/x/.claude/plugins/cache/kimi-marketplace/kimi/1.8.8/dist/hooks/approval-hook.js";
        await mkdir(home, { recursive: true });
        await writeFile(
          path.join(home, "config.toml"),
          [
            "[[hooks]]",
            'event = "PreToolUse"',
            `command = ${JSON.stringify(canonicalCommandFor(oldHookPath))}`,
            "timeout = 15",
          ].join("\n"),
          "utf8",
        );
        const status = await verifyHookInstalled({
          KIMI_CODE_HOME: home,
          KIMI_PLUGIN_CC_HOOK_SCRIPT: newHookPath,
        });
        expect(status.installed).toBe(false);
        expect(status.drift?.axis).toBe("hook-script");
        expect(hookRefusalDetails(status).retryable_after_setup).toBe(true);
      } finally {
        await cleanupTestPath(home);
      }
    });

    test("the v1.9.0 re-pin (same interpreter, moved script) IS retryable", async () => {
      // Every pre-1.9.0 install hits exactly this once: the node pin moves off
      // the version-stamped path onto the stable one AND the version-stamped
      // script path moves, so the axis is "both". It must still be retryable —
      // otherwise the release's own migration is the one case the self-repair
      // flow refuses to handle, and the human message ("your Node did not
      // move") would contradict the structured field.
      const home = await createTestPluginDataRoot("hook-install-drift-repin");
      try {
        const oldHookPath =
          "/Users/x/.claude/plugins/cache/kimi-marketplace/kimi/1.8.8/dist/hooks/approval-hook.js";
        const newHookPath =
          "/Users/x/.claude/plugins/cache/kimi-marketplace/kimi/1.9.0/dist/hooks/approval-hook.js";
        // Two real spellings of the SAME interpreter on this machine.
        const resolved = realpathSync(process.execPath);
        const staleCommand = buildHookShellCommand(oldHookPath, {
          KIMI_PLUGIN_CC_NODE_BIN: resolved,
        });
        await mkdir(home, { recursive: true });
        await writeFile(
          path.join(home, "config.toml"),
          [
            "[[hooks]]",
            'event = "PreToolUse"',
            `command = ${JSON.stringify(staleCommand)}`,
            "timeout = 15",
          ].join("\n"),
          "utf8",
        );
        const status = await verifyHookInstalled({
          KIMI_CODE_HOME: home,
          KIMI_PLUGIN_CC_HOOK_SCRIPT: newHookPath,
          KIMI_PLUGIN_CC_NODE_BIN: resolved,
        });
        expect(status.installed).toBe(false);
        // Same node token here, so only the script moved.
        expect(status.drift?.axis).toBe("hook-script");
        expect(hookRefusalDetails(status).retryable_after_setup).toBe(true);
      } finally {
        await cleanupTestPath(home);
      }
    });

    test("node-bin drift is reported but NOT marked retryable", async () => {
      // A moved interpreter may be GONE, and a hook that cannot spawn exits 127
      // — which kimi-code treats as ALLOW. Re-running setup would silently
      // re-pin over a real enforcement gap, so a caller must never auto-retry.
      const home = await createTestPluginDataRoot("hook-install-drift-node");
      try {
        const hookPath =
          "/Users/x/.claude/plugins/cache/kimi-marketplace/kimi/1.8.8/dist/hooks/approval-hook.js";
        const staleCommand = buildHookShellCommand(hookPath, {
          KIMI_PLUGIN_CC_NODE_BIN: "/opt/homebrew/Cellar/node/26.0.0/bin/node",
        });
        await mkdir(home, { recursive: true });
        await writeFile(
          path.join(home, "config.toml"),
          [
            "[[hooks]]",
            'event = "PreToolUse"',
            `command = ${JSON.stringify(staleCommand)}`,
            "timeout = 15",
          ].join("\n"),
          "utf8",
        );
        const status = await verifyHookInstalled({
          KIMI_CODE_HOME: home,
          KIMI_PLUGIN_CC_HOOK_SCRIPT: hookPath,
          KIMI_PLUGIN_CC_NODE_BIN: "/opt/homebrew/Cellar/node/26.5.0/bin/node",
        });
        expect(status.installed).toBe(false);
        expect(status.drift?.axis).toBe("node-bin");
        expect(hookRefusalDetails(status).retryable_after_setup).toBe(false);
      } finally {
        await cleanupTestPath(home);
      }
    });

    test("both axes drifting is classified as 'both' and is NOT retryable", async () => {
      // A brew node upgrade and a plugin update on the same morning.
      const home = await createTestPluginDataRoot("hook-install-drift-both");
      try {
        const oldHookPath =
          "/Users/x/.claude/plugins/cache/kimi-marketplace/kimi/1.8.7/dist/hooks/approval-hook.js";
        const newHookPath =
          "/Users/x/.claude/plugins/cache/kimi-marketplace/kimi/1.8.8/dist/hooks/approval-hook.js";
        const staleCommand = buildHookShellCommand(oldHookPath, {
          KIMI_PLUGIN_CC_NODE_BIN: "/opt/homebrew/Cellar/node/26.0.0/bin/node",
        });
        await mkdir(home, { recursive: true });
        await writeFile(
          path.join(home, "config.toml"),
          [
            "[[hooks]]",
            'event = "PreToolUse"',
            `command = ${JSON.stringify(staleCommand)}`,
            "timeout = 15",
          ].join("\n"),
          "utf8",
        );
        const status = await verifyHookInstalled({
          KIMI_CODE_HOME: home,
          KIMI_PLUGIN_CC_HOOK_SCRIPT: newHookPath,
          KIMI_PLUGIN_CC_NODE_BIN: "/opt/homebrew/Cellar/node/26.5.0/bin/node",
        });
        expect(status.installed).toBe(false);
        expect(status.drift?.axis).toBe("both");
        expect(hookRefusalDetails(status).retryable_after_setup).toBe(false);
      } finally {
        await cleanupTestPath(home);
      }
    });

    test("non-drift refusals carry NO drift (not re-pin-recoverable)", async () => {
      // Duplicate markers, orphan markers, unreadable config, invalid hook set:
      // all refuse, none are fixed by re-pinning, so none may advertise a retry.
      const home = await createTestPluginDataRoot("hook-install-drift-absent");
      try {
        await mkdir(home, { recursive: true });
        await writeFile(
          path.join(home, "config.toml"),
          `default_model = "kimi-for-coding"\n`,
          "utf8",
        );
        const status = await verifyHookInstalled({ KIMI_CODE_HOME: home });
        expect(status.installed).toBe(false);
        expect(status.drift).toBeUndefined();
        expect(hookRefusalDetails(status)).not.toHaveProperty("retryable_after_setup");
      } finally {
        await cleanupTestPath(home);
      }
    });

    test("an installed hook reports no drift", async () => {
      const home = await createTestPluginDataRoot("hook-install-drift-none");
      try {
        const hookPath = path.join(home, "dist", "hooks", "approval-hook.js");
        await mkdir(path.dirname(hookPath), { recursive: true });
        await writeFile(hookPath, "// hook\n", "utf8");
        await writeFile(
          path.join(home, "config.toml"),
          [
            "[[hooks]]",
            'event = "PreToolUse"',
            `command = ${JSON.stringify(canonicalCommandFor(hookPath))}`,
            "timeout = 15",
          ].join("\n"),
          "utf8",
        );
        const status = await verifyHookInstalled({
          KIMI_CODE_HOME: home,
          KIMI_PLUGIN_CC_HOOK_SCRIPT: hookPath,
        });
        expect(status.installed).toBe(true);
        expect(status.drift).toBeUndefined();
      } finally {
        await cleanupTestPath(home);
      }
    });
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
      const hookPath = path.join(home, "o'reilly", "dist", "hooks", "approval-hook.js");
      const canonical = canonicalCommandFor(hookPath);
      // tomlBasicString equivalent: escape \ to \\ and " to \"
      const tomlEscaped = canonical.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
      await mkdir(home, { recursive: true });
      await mkdir(path.dirname(hookPath), { recursive: true });
      await writeFile(hookPath, "// fake hook script for tests\n", "utf8");
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

describe("G6: job-time tolerance for marker damage around an enforcing hook", () => {
  const BEGIN = "# === BEGIN kimi-plugin-cc-managed (v1.0.0) ===";
  const END = "# === END kimi-plugin-cc-managed ===";
  const table = (command: string, extra: string[] = []) =>
    ["[[hooks]]", 'event = "PreToolUse"', `command = ${JSON.stringify(command)}`, "timeout = 15", ...extra];

  async function withConfig(
    prefix: string,
    build: (command: string) => string[],
    run: (status: Awaited<ReturnType<typeof verifyHookInstalled>>, raw: string, command: string, hookPath: string) => void,
  ): Promise<void> {
    const home = await createTestPluginDataRoot(prefix);
    try {
      const hookPath = path.join(home, "dist", "hooks", "approval-hook.js");
      await mkdir(path.dirname(hookPath), { recursive: true });
      await writeFile(hookPath, "// hook\n", "utf8");
      const command = canonicalCommandFor(hookPath);
      const raw = build(command).join("\n");
      await writeFile(path.join(home, "config.toml"), raw, "utf8");
      run(await verifyHookInstalled({ KIMI_CODE_HOME: home, KIMI_PLUGIN_CC_HOOK_SCRIPT: hookPath }), raw, command, hookPath);
    } finally {
      await cleanupTestPath(home);
    }
  }

  test("duplicate managed blocks with a clean exact entry are installed with a setup warning", async () => {
    await withConfig("hook-g6-duplicate", (command) => [BEGIN, ...table(command), END, BEGIN, ...table(command), END], (status, raw, command, hookPath) => {
      expect(status.installed).toBe(true);
      expect(status.warnings).toHaveLength(1);
      expect(status.warnings![0]).toContain("installed and enforcing");
      expect(status.warnings![0]).toContain("duplicate managed blocks");
      expect(status.warnings![0]).toContain("/kimi:setup");
      // setup and setup --check evaluate markers directly and keep failing.
      expect(evaluateInstalled(raw, command, { hostId: resolveHostId({}, hookPath) }).installed).toBe(false);
    });
  });

  test("an own orphan marker beside a clean exact entry is installed with a setup warning", async () => {
    await withConfig("hook-g6-orphan", (command) => [BEGIN, ...table(command)], (status, raw, command, hookPath) => {
      expect(status.installed).toBe(true);
      expect(status.warnings?.[0]).toContain("BEGIN-without-END");
      expect(evaluateInstalled(raw, command, { hostId: resolveHostId({}, hookPath) }).installed).toBe(false);
    });
  });

  test("marker damage still refuses when the entry is conditional, unexpected or stale", async () => {
    for (const [prefix, build] of [
      ["hook-g6-matcher", (command: string) => [BEGIN, ...table(command, ['matcher = "Write"']), END, BEGIN, ...table(command, ['matcher = "Write"']), END]],
      ["hook-g6-extra-key", (command: string) => [BEGIN, ...table(command, ["extra = 1"])]],
      ["hook-g6-stale", (command: string) => [BEGIN, ...table(`${command} --stale`)]],
      ["hook-g6-post-event", (command: string) => [BEGIN, "[[hooks]]", 'event = "PostToolUse"', `command = ${JSON.stringify(command)}`]],
    ] as const) {
      await withConfig(prefix, build, (status) => {
        expect([prefix, status.installed]).toEqual([prefix, false]);
        expect(status.warnings).toBeUndefined();
      });
    }
  });

  test("a clean installed hook carries no warnings", async () => {
    await withConfig("hook-g6-clean", (command) => [BEGIN, ...table(command), END], (status) => {
      expect(status.installed).toBe(true);
      expect("warnings" in status).toBe(false);
    });
  });
});
