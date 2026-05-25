import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { renderSetupResult, runSetup } from "../../runtime/commands/setup.js";
import type { CommandContext } from "../../runtime/types.js";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const hookScriptPath = path.join(repoRoot, "dist", "hooks", "approval-hook.js");

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "kimi-plugin-cc-setup-"));
});

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function makeCase(name: string): Promise<{ env: NodeJS.ProcessEnv; configPath: string; pluginData: string }> {
  const kimiCodeHome = path.join(scratch, name, "kimi-code-home");
  const pluginData = path.join(scratch, name, "plugin-data");
  await mkdir(kimiCodeHome, { recursive: true });
  await mkdir(pluginData, { recursive: true });
  return {
    env: {
      ...process.env,
      KIMI_CODE_HOME: kimiCodeHome,
      CLAUDE_PLUGIN_DATA: pluginData,
    },
    configPath: path.join(kimiCodeHome, "config.toml"),
    pluginData,
  };
}

function makeContext(env: NodeJS.ProcessEnv): CommandContext {
  return {
    cwd: process.cwd(),
    env,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

describe("setup managed-block installer", () => {
  test("install writes the block on a fresh config and probe passes", async () => {
    const { env, configPath } = await makeCase("install-fresh");
    const result = await runSetup([], makeContext(env));

    expect(result.action).toBe("install");
    expect(result.blockWritten).toBe(true);
    expect(result.probe).toBe("ok");
    expect(result.hookScriptPath).toBe(hookScriptPath);

    const contents = await readFile(configPath, "utf8");
    expect(contents).toContain("=== BEGIN kimi-plugin-cc-managed");
    expect(contents).toContain("=== END kimi-plugin-cc-managed");
    expect(contents).toContain('event = "PreToolUse"');
    expect(contents).toContain("approval-hook.js");
    // Empty matcher is critical — `new RegExp("*")` in kimi-code would
    // throw and silently disable the hook. We must NOT write a matcher
    // line under any circumstance.
    expect(contents).not.toMatch(/^matcher\s*=/m);
  });

  test("install is idempotent — running twice does not duplicate the block", async () => {
    const { env, configPath } = await makeCase("install-idempotent");
    await runSetup([], makeContext(env));
    const first = await readFile(configPath, "utf8");

    const second = await runSetup([], makeContext(env));
    const secondContents = await readFile(configPath, "utf8");

    expect(secondContents).toBe(first);
    // Block-already-up-to-date message; blockWritten is false on the second run.
    expect(second.blockWritten).toBe(false);
    expect(second.probe).toBe("ok");
  });

  test("install preserves surrounding user content", async () => {
    const { env, configPath } = await makeCase("install-preserve");
    const userPrefix = [
      'default_model = "kimi-code/kimi-for-coding"',
      "",
      "[[permission.rules]]",
      'decision = "allow"',
      'pattern = "Bash(ls)"',
      "",
    ].join("\n");
    await writeFile(configPath, userPrefix, "utf8");

    await runSetup([], makeContext(env));
    const contents = await readFile(configPath, "utf8");

    expect(contents.startsWith('default_model = "kimi-code/kimi-for-coding"')).toBe(true);
    expect(contents).toContain('pattern = "Bash(ls)"');
    expect(contents).toContain("=== BEGIN kimi-plugin-cc-managed");
  });

  test("install refreshes a stale block in place when the hook path changed", async () => {
    const { env, configPath } = await makeCase("install-refresh");
    const stale = [
      "# === BEGIN kimi-plugin-cc-managed (v0.9.0) ===",
      "[[hooks]]",
      'event = "PreToolUse"',
      'command = "node /stale/path/approval-hook.js"',
      "timeout = 15",
      "# === END kimi-plugin-cc-managed ===",
      "",
    ].join("\n");
    await writeFile(configPath, stale, "utf8");

    const result = await runSetup([], makeContext(env));
    expect(result.blockWritten).toBe(true);
    const contents = await readFile(configPath, "utf8");
    expect(contents).toContain(hookScriptPath);
    expect(contents).not.toContain("/stale/path/approval-hook.js");
  });

  test("install refuses on orphaned BEGIN without END", async () => {
    const { env, configPath } = await makeCase("install-orphan-begin");
    await writeFile(configPath, "# === BEGIN kimi-plugin-cc-managed (v0.9.0) ===\n", "utf8");
    await expect(runSetup([], makeContext(env))).rejects.toMatchObject({
      code: "SETUP_ORPHAN_MARKERS",
    });
  });

  test("install refuses on orphaned END without BEGIN", async () => {
    const { env, configPath } = await makeCase("install-orphan-end");
    await writeFile(configPath, "# === END kimi-plugin-cc-managed ===\n", "utf8");
    await expect(runSetup([], makeContext(env))).rejects.toMatchObject({
      code: "SETUP_ORPHAN_MARKERS",
    });
  });

  test("uninstall removes only the managed block, preserving user content", async () => {
    const { env, configPath } = await makeCase("uninstall-clean");
    const before = "user_setting = true\n";
    await writeFile(configPath, before, "utf8");
    await runSetup([], makeContext(env));
    const after = await runSetup(["--uninstall"], makeContext(env));

    expect(after.action).toBe("uninstall");
    expect(after.blockRemoved).toBe(true);
    const contents = await readFile(configPath, "utf8");
    expect(contents).toContain("user_setting = true");
    expect(contents).not.toContain("kimi-plugin-cc-managed");
  });

  test("uninstall sweeps orphan markers so install can re-run", async () => {
    const { env, configPath } = await makeCase("uninstall-orphan-sweep");
    await writeFile(
      configPath,
      "# === BEGIN kimi-plugin-cc-managed (v0.9.0) ===\nstuff\n",
      "utf8",
    );

    const uninstall = await runSetup(["--uninstall"], makeContext(env));
    expect(uninstall.blockRemoved).toBe(true);
    const sweptContents = await readFile(configPath, "utf8");
    expect(sweptContents).not.toContain("kimi-plugin-cc-managed");

    // Now a fresh install should succeed.
    const install = await runSetup([], makeContext(env));
    expect(install.blockWritten).toBe(true);
    expect(install.probe).toBe("ok");
  });

  test("uninstall on missing config is a clean no-op", async () => {
    const { env } = await makeCase("uninstall-missing-config");
    const result = await runSetup(["--uninstall"], makeContext(env));
    expect(result.action).toBe("uninstall");
    expect(result.blockRemoved).toBe(false);
    expect(result.probe).toBe("skipped");
  });

  test("--check on a missing block reports failed probe without writing", async () => {
    const { env, configPath } = await makeCase("check-missing");
    await writeFile(configPath, "user_setting = true\n", "utf8");

    const result = await runSetup(["--check"], makeContext(env));
    expect(result.action).toBe("check");
    expect(result.blockWritten).toBe(false);
    expect(result.probe).toBe("failed");

    const after = await readFile(configPath, "utf8");
    expect(after).toBe("user_setting = true\n");
  });

  test("--check after install reports ok probe and leaves config untouched", async () => {
    const { env, configPath } = await makeCase("check-installed");
    await runSetup([], makeContext(env));
    const installed = await readFile(configPath, "utf8");
    const check = await runSetup(["--check"], makeContext(env));
    expect(check.probe).toBe("ok");
    const after = await readFile(configPath, "utf8");
    expect(after).toBe(installed);
  });

  test("--check on a stale hook path reports failure that points back to install", async () => {
    const { env, configPath } = await makeCase("check-stale-path");
    const stale = [
      "# === BEGIN kimi-plugin-cc-managed (v0.9.0) ===",
      "[[hooks]]",
      'event = "PreToolUse"',
      'command = "node /old/dist/hooks/approval-hook.js"',
      "timeout = 15",
      "# === END kimi-plugin-cc-managed ===",
      "",
    ].join("\n");
    await writeFile(configPath, stale, "utf8");

    const result = await runSetup(["--check"], makeContext(env));
    expect(result.probe).toBe("failed");
    // setup --check rejects a block that doesn't point at the current
    // dist path so users notice path drift after a reinstall.
    expect(result.probeError ?? "").toContain("different hook script");
    expect(result.nextStep).toContain("repair");
  });

  test("install warns about pre-existing broad deny permission rules", async () => {
    const { env, configPath } = await makeCase("install-permission-warn");
    const broadDeny = [
      "[[permission.rules]]",
      'decision = "deny"',
      'pattern = "*"',
      "",
    ].join("\n");
    await writeFile(configPath, broadDeny, "utf8");
    const result = await runSetup([], makeContext(env));
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.join("\n")).toContain('deny pattern "*"');
  });

  test("rejects unknown flags and conflicting review-gate flags", async () => {
    const { env } = await makeCase("invalid-args");
    await expect(runSetup(["--bogus"], makeContext(env))).rejects.toMatchObject({
      code: "INVALID_ARGS",
      stage: "setup.parse",
    });
    await expect(
      runSetup(["--enable-review-gate", "--disable-review-gate"], makeContext(env)),
    ).rejects.toMatchObject({
      code: "INVALID_ARGS",
      stage: "setup.parse",
    });
  });

  test("renderSetupResult renders details and next step", async () => {
    const { env } = await makeCase("render");
    const result = await runSetup([], makeContext(env));
    const rendered = renderSetupResult(result);
    expect(rendered).toContain("Action:      install");
    expect(rendered).toContain("Probe:          ok");
    expect(rendered).toContain("Next step:");
  });

  test("install refuses when two managed blocks exist (concurrent setup races)", async () => {
    const { env, configPath } = await makeCase("install-duplicate-blocks");
    const dual = [
      "# === BEGIN kimi-plugin-cc-managed (v0.9.0) ===",
      "[[hooks]]",
      'event = "PreToolUse"',
      'command = "node /old/dist/hooks/approval-hook.js"',
      "timeout = 15",
      "# === END kimi-plugin-cc-managed ===",
      "",
      "# === BEGIN kimi-plugin-cc-managed (v0.9.1) ===",
      "[[hooks]]",
      'event = "PreToolUse"',
      'command = "node /other/dist/hooks/approval-hook.js"',
      "timeout = 15",
      "# === END kimi-plugin-cc-managed ===",
      "",
    ].join("\n");
    await writeFile(configPath, dual, "utf8");
    await expect(runSetup([], makeContext(env))).rejects.toMatchObject({
      code: "SETUP_DUPLICATE_BLOCKS",
    });
  });

  test("uninstall preserves user content following an orphan BEGIN marker", async () => {
    const { env, configPath } = await makeCase("uninstall-preserves-after-orphan");
    const tainted = [
      "# === BEGIN kimi-plugin-cc-managed (v0.9.0) ===",
      "# orphan with no END",
      "",
      "user_setting = true",
      'another_user_setting = "preserve me"',
      "",
    ].join("\n");
    await writeFile(configPath, tainted, "utf8");

    const result = await runSetup(["--uninstall"], makeContext(env));
    const after = await readFile(configPath, "utf8");
    // Critical: user_setting must NOT be deleted by the orphan sweep.
    expect(after).toContain("user_setting = true");
    expect(after).toContain('another_user_setting = "preserve me"');
    // Marker line itself is removed.
    expect(after).not.toContain("BEGIN kimi-plugin-cc-managed");
    // Warning surfaced so the user knows we touched orphan lines.
    expect(result.warnings.join("\n")).toContain("orphan marker");
  });

  test("install accepts paths containing a single quote (TOML basic-string handles it)", async () => {
    // PR 4 reviewers flagged that the old shell-single-quote approach
    // produced unparseable TOML when paths contained `'`. The fix
    // switched to TOML basic-string escaping for the entire command
    // field — single quotes are legitimate inside a basic string.
    // Verify that a path with an apostrophe is accepted AND that the
    // resulting TOML is parseable (basic-string round-trip).
    const { env, configPath } = await makeCase("install-apostrophe-path");
    const apostrophePath = path.join(scratch, "install-apostrophe-path", "o'reilly", "hook.js");
    await mkdir(path.dirname(apostrophePath), { recursive: true });
    await writeFile(apostrophePath, "process.stderr.write('deny'); process.exit(2);\n", "utf8");
    const result = await runSetup(
      [],
      makeContext({ ...env, KIMI_PLUGIN_CC_HOOK_SCRIPT: apostrophePath }),
    );
    expect(result.probe).toBe("ok");
    const contents = await readFile(configPath, "utf8");
    expect(contents).toContain("o'reilly");
  });

  test("install refuses a hook script path containing characters that break TOML basic strings", async () => {
    // Quotes, backslashes, newlines and other control characters DO
    // require rejection — they cannot be safely embedded inside the
    // TOML basic string used for the command field. The path
    // construction here is purely a TOML-safety check; we don't need
    // the file to exist.
    const { env } = await makeCase("install-unsafe-chars-path");
    const hostilePath = "/tmp/hook\"path/approval.js";
    await expect(
      runSetup([], makeContext({ ...env, KIMI_PLUGIN_CC_HOOK_SCRIPT: hostilePath })),
    ).rejects.toMatchObject({ code: "SETUP_HOOK_PATH_UNSAFE" });
  });

  test("install rejects a managed block that contains a matcher line", async () => {
    // Direct shared-parser exercise: the verifier and the installer
    // must both reject matcher lines because `new RegExp("*")` throws
    // and silently disables the hook in kimi-code.
    const { env, configPath } = await makeCase("install-matcher-rejection");
    const sabotaged = [
      "# === BEGIN kimi-plugin-cc-managed (v0.9.0) ===",
      "[[hooks]]",
      'matcher = "*"',
      'event = "PreToolUse"',
      'command = "node /old/dist/hooks/approval-hook.js"',
      "timeout = 15",
      "# === END kimi-plugin-cc-managed ===",
      "",
    ].join("\n");
    await writeFile(configPath, sabotaged, "utf8");
    // Install replaces the block in place — it does NOT inherit the
    // sabotaged matcher. After install, the block must be a fresh
    // grammar-clean replacement.
    const result = await runSetup([], makeContext(env));
    expect(result.probe).toBe("ok");
    const after = await readFile(configPath, "utf8");
    expect(after).not.toMatch(/^\s*matcher\s*=/m);
  });

  test("install writes process.execPath into the managed block (not bare 'node')", async () => {
    const { env, configPath } = await makeCase("install-execpath");
    await runSetup([], makeContext(env));
    const contents = await readFile(configPath, "utf8");
    // The Node binary is written absolute so kimi-code's /bin/sh hook
    // runner doesn't need `node` on its PATH. process.execPath is the
    // running Node binary (or its symlink target).
    expect(contents).toContain(process.execPath);
  });

  test("install preserves CRLF line endings", async () => {
    const { env, configPath } = await makeCase("install-crlf");
    const crlf = `user_setting = true\r\nanother = 42\r\n`;
    await writeFile(configPath, crlf, "utf8");
    await runSetup([], makeContext(env));
    const after = await readFile(configPath, "utf8");
    // CRLF on the user's lines is preserved.
    expect(after).toContain("user_setting = true\r\n");
    expect(after).toContain("another = 42\r\n");
    // The managed block we appended is also CRLF.
    expect(after).toMatch(/=== BEGIN kimi-plugin-cc-managed[^\n]*\r\n/);
  });

  test("KIMI_PLUGIN_CC_HOOK_SCRIPT override is honored end-to-end", async () => {
    const { env, configPath } = await makeCase("hook-script-override");
    const overridePath = path.join(scratch, "hook-script-override", "fake-hook.js");
    await mkdir(path.dirname(overridePath), { recursive: true });
    // Hook that always denies. Mimics dist/hooks/approval-hook.js's deny
    // contract: exit 2 + stderr reason.
    await writeFile(
      overridePath,
      `process.stderr.write('override-deny\\n'); process.exit(2);\n`,
      "utf8",
    );

    const overrideEnv = { ...env, KIMI_PLUGIN_CC_HOOK_SCRIPT: overridePath };
    const result = await runSetup([], makeContext(overrideEnv));
    expect(result.probe).toBe("ok");
    const contents = await readFile(configPath, "utf8");
    expect(contents).toContain(overridePath);
  });
});
