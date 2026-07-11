import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { renderSetupResult, runSetup } from "../../runtime/commands/setup.js";
import {
  KIMI_CONFIG_LOCK_METADATA_MAX_BYTES,
  kimiConfigLockPath,
  validateKimiHookSet,
  validateKimiHookSetForEnvironment,
  withKimiConfigLock,
} from "../../runtime/hooks/config-safety.js";
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
      "# === BEGIN kimi-plugin-cc-managed (v0.9.0) ===\nuser_setting = true\n",
      "utf8",
    );

    const uninstall = await runSetup(["--uninstall"], makeContext(env));
    expect(uninstall.blockRemoved).toBe(true);
    const sweptContents = await readFile(configPath, "utf8");
    expect(sweptContents).not.toContain("kimi-plugin-cc-managed");
    expect(sweptContents).toContain("user_setting = true");

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
    // setup --check rejects a block whose `command = "..."` doesn't
    // equal the canonical shell command this companion would write,
    // so users notice path drift after a reinstall. Audit reports 27/28
    // tightened this from substring to equality.
    expect(result.probeError ?? "").toContain("does not match the canonical command");
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

  test("H8: surfaces installed+enabled kimi-code plugins as a non-blocking notice", async () => {
    const { env } = await makeCase("kimi-plugins-notice");
    const kimiCodeHome = env.KIMI_CODE_HOME!;
    await mkdir(path.join(kimiCodeHome, "plugins"), { recursive: true });
    await writeFile(
      path.join(kimiCodeHome, "plugins", "installed.json"),
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "acme-search", root: "/p/acme", source: {}, enabled: true, installedAt: "x" },
          { id: "disabled-one", root: "/p/dis", source: {}, enabled: false, installedAt: "x" },
        ],
      }),
      "utf8",
    );
    const result = await runSetup([], makeContext(env));
    const joined = result.warnings.join("\n");
    // Enabled plugin is named; the read-only turn-waste expectation is set.
    expect(joined).toContain("kimi-code plugin(s) installed and enabled");
    expect(joined).toContain("acme-search");
    expect(joined).toContain("waste model turns");
    // The explicitly-disabled plugin is NOT surfaced.
    expect(joined).not.toContain("disabled-one");
    // It is a non-blocking notice — setup still installs successfully.
    expect(result.blockWritten).toBe(true);
  });

  test("H8: no plugin notice when kimi-code has no installed.json", async () => {
    const { env } = await makeCase("kimi-plugins-absent");
    const result = await runSetup([], makeContext(env));
    expect(result.warnings.join("\n")).not.toContain("kimi-code plugin(s) installed");
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

  test("install accepts paths containing a single quote (shell-quote + TOML-escape round-trip)", async () => {
    // PR 5 reviewer fix (Codex C2): the managed block now shell-quotes
    // both arguments so kimi-code's `/bin/sh -c "<command>"` parses the
    // path back correctly. For a path containing `'`, shellSingleQuote
    // splits the literal at the apostrophe (`'o'\''reilly'` is four
    // shell tokens that concatenate into `o'reilly`), and TOML escapes
    // the embedded backslash. The file does NOT contain the literal
    // substring "o'reilly" — but the round-trip works, which is what
    // the probe asserts (probe.ok === true means /bin/sh successfully
    // parsed and ran the command).
    const { env, configPath } = await makeCase("install-apostrophe-path");
    const apostrophePath = path.join(scratch, "install-apostrophe-path", "o'reilly", "hook.js");
    await mkdir(path.dirname(apostrophePath), { recursive: true });
    await writeFile(apostrophePath, "process.stderr.write('deny'); process.exit(2);\n", "utf8");
    const result = await runSetup(
      [],
      makeContext({ ...env, KIMI_PLUGIN_CC_HOOK_SCRIPT: apostrophePath }),
    );
    // The probe runs `/bin/sh -c "<command>"` with the exact string
    // written into the managed block. probe.ok === true means /bin/sh
    // successfully parsed the shell-quoted-then-TOML-escaped command
    // back to a runnable invocation that reached the apostrophe path.
    expect(result.probe).toBe("ok");
    // Sanity: the path tail (without the apostrophe) survives in the
    // file. The full path doesn't appear as a contiguous substring
    // because shellSingleQuote splits at the apostrophe; the test for
    // round-trip correctness is the probe assertion above.
    const contents = await readFile(configPath, "utf8");
    expect(contents).toContain("reilly/hook.js");
  });

  test("install rejects KIMI_PLUGIN_CC_NODE_BIN that is not absolute", async () => {
    // PR 5 reviewer fix (Codex H1): the env override is honored
    // verbatim, so a `KIMI_PLUGIN_CC_NODE_BIN=node` invocation would
    // write bare `node` into the managed block and silently break the
    // absolute-path invariant kimi-code's /bin/sh -c spawn relies on.
    // Setup must reject the override up front.
    const { env } = await makeCase("install-bad-node-bin");
    await expect(
      runSetup([], makeContext({ ...env, KIMI_PLUGIN_CC_NODE_BIN: "node" })),
    ).rejects.toMatchObject({ code: "SETUP_NODE_BIN_NOT_ABSOLUTE" });
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

  test("install writes the config with mode 0o600 (audit M1 — preserves API-key secrecy)", async () => {
    if (process.platform === "win32") return;
    const { env, configPath } = await makeCase("install-mode-600");
    await runSetup([], makeContext(env));
    const { stat } = await import("node:fs/promises");
    const stats = await stat(configPath);
    // Lower 9 bits are the permission triplet; mask off the file-type bits.
    // Expect 0o600 — owner read/write only, no group or other access.
    expect(stats.mode & 0o777).toBe(0o600);
  });

  test("config lock is adjacent, private, bounded, and released", async () => {
    const { configPath } = await makeCase("lock-private-bounded");
    const lockPath = kimiConfigLockPath(configPath);
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withKimiConfigLock(configPath, async () => {
      const lockStats = await stat(lockPath);
      if (process.platform !== "win32") expect(lockStats.mode & 0o777).toBe(0o600);
      entered();
      await releasePromise;
    });
    await enteredPromise;

    await expect(
      withKimiConfigLock(configPath, async () => undefined, {
        waitMs: 75,
        staleMs: 10,
        retryMs: 10,
      }),
    ).rejects.toMatchObject({ code: "SETUP_CONFIG_LOCK_TIMEOUT" });

    release();
    await holder;
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("config lock creates a missing KIMI_CODE_HOME with mode 0o700", async () => {
    if (process.platform === "win32") return;
    const kimiHome = path.join(scratch, "lock-private-parent", "new-kimi-home");
    const configPath = path.join(kimiHome, "config.toml");

    await withKimiConfigLock(configPath, async () => {
      expect((await stat(kimiHome)).mode & 0o777).toBe(0o700);
      expect((await stat(kimiConfigLockPath(configPath))).mode & 0o777).toBe(0o600);
    });
    expect((await stat(kimiHome)).mode & 0o777).toBe(0o700);
  });

  test("config lock publishes complete metadata and rechecks inode/token before entry", async () => {
    const { configPath } = await makeCase("lock-atomic-publication");
    const lockPath = kimiConfigLockPath(configPath);
    const displacedPath = `${lockPath}.displaced`;
    const replacement = {
      pid: process.pid,
      token: "f".repeat(32),
      createdAt: new Date().toISOString(),
    };
    let operationEntered = false;

    await expect(
      withKimiConfigLock(
        configPath,
        async () => {
          operationEntered = true;
        },
        {
          testHooks: {
            afterPublish: async (publishedPath) => {
              const raw = await readFile(publishedPath, "utf8");
              const owner = JSON.parse(raw) as { pid: number; token: string; createdAt: string };
              expect(owner.pid).toBe(process.pid);
              expect(owner.token).toMatch(/^[a-f0-9]{32}$/);
              expect(owner.createdAt.length).toBeGreaterThan(0);

              await rename(publishedPath, displacedPath);
              await writeFile(publishedPath, `${JSON.stringify(replacement)}\n`, {
                flag: "wx",
                mode: 0o600,
              });
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "SETUP_CONFIG_LOCK_OWNERSHIP_LOST" });

    expect(operationEntered).toBe(false);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(replacement);
    await unlink(lockPath);
    await unlink(displacedPath);
  });

  test("stale recovery never removes a replacement lock after an ABA", async () => {
    const { configPath } = await makeCase("lock-stale-aba");
    const lockPath = kimiConfigLockPath(configPath);
    const displacedPath = `${lockPath}.old`;
    await writeFile(lockPath, "crashed owner\n", { mode: 0o600 });
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);
    const replacement = {
      pid: process.pid,
      token: "a".repeat(32),
      createdAt: new Date().toISOString(),
    };
    let replaced = false;

    await expect(
      withKimiConfigLock(configPath, async () => undefined, {
        waitMs: 80,
        staleMs: 1,
        retryMs: 10,
        testHooks: {
          beforeStaleRecovery: async (observedPath) => {
            if (replaced) return;
            replaced = true;
            await rename(observedPath, displacedPath);
            await writeFile(observedPath, `${JSON.stringify(replacement)}\n`, {
              flag: "wx",
              mode: 0o600,
            });
          },
        },
      }),
    ).rejects.toMatchObject({ code: "SETUP_CONFIG_LOCK_TIMEOUT" });

    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(replacement);
    expect(await readFile(displacedPath, "utf8")).toBe("crashed owner\n");
    await unlink(lockPath);
    await unlink(displacedPath);
  });

  test("config lock refuses a symlink without following its device target", async () => {
    if (process.platform === "win32") return;
    const { configPath } = await makeCase("lock-symlink");
    const lockPath = kimiConfigLockPath(configPath);
    await symlink("/dev/null", lockPath);

    await expect(
      withKimiConfigLock(configPath, async () => undefined, { waitMs: 50 }),
    ).rejects.toMatchObject({ code: "SETUP_CONFIG_LOCK_UNSAFE" });
    expect((await stat("/dev/null")).isCharacterDevice()).toBe(true);
    await unlink(lockPath);
  });

  test("config lock refuses a FIFO without blocking", async () => {
    if (process.platform === "win32") return;
    const { configPath } = await makeCase("lock-fifo");
    const lockPath = kimiConfigLockPath(configPath);
    const made = spawnSync("mkfifo", [lockPath], { encoding: "utf8" });
    expect(made.status, made.stderr || made.error?.message).toBe(0);

    const outcome = await Promise.race([
      withKimiConfigLock(configPath, async () => "entered", { waitMs: 50 })
        .then(() => "entered")
        .catch((error: unknown) => (error as { code?: string }).code),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 500)),
    ]);
    expect(outcome).toBe("SETUP_CONFIG_LOCK_UNSAFE");
    await unlink(lockPath);
  });

  test("config lock caps oversized metadata and still recovers an old regular file", async () => {
    const { configPath } = await makeCase("lock-capped-metadata");
    const lockPath = kimiConfigLockPath(configPath);
    await writeFile(lockPath, "x".repeat(KIMI_CONFIG_LOCK_METADATA_MAX_BYTES + 1), {
      mode: 0o600,
    });
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);

    const result = await withKimiConfigLock(configPath, async () => "recovered", {
      staleMs: 1,
      waitMs: 200,
    });
    expect(result).toBe("recovered");
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("stale recovery also reclaims a dead recovery lease after a second crash", async () => {
    const { configPath } = await makeCase("lock-stale-recovery-lease");
    const lockPath = kimiConfigLockPath(configPath);
    await writeFile(lockPath, "first crashed owner\n", { mode: 0o600 });
    const lockStats = await stat(lockPath, { bigint: true });
    const identity = `${lockStats.dev.toString()}:${lockStats.ino.toString()}`;
    const identityHash = createHash("sha256").update(identity).digest("hex").slice(0, 16);
    const recoveryPath = `${lockPath}.recover.${identityHash}`;
    await writeFile(
      recoveryPath,
      `${JSON.stringify({
        pid: 2_147_483_647,
        token: "b".repeat(32),
        createdAt: new Date(Date.now() - 20_000).toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);
    await utimes(recoveryPath, old, old);

    const result = await withKimiConfigLock(configPath, async () => "recovered twice", {
      staleMs: 1,
      waitMs: 500,
      retryMs: 5,
    });
    expect(result).toBe("recovered twice");
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(recoveryPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await readdir(path.dirname(configPath))).filter((name) => name.includes(".recover.")),
    ).toEqual([]);
  });

  test("install recovers an old malformed lock left by a crashed setup", async () => {
    const { env, configPath } = await makeCase("lock-stale-recovery");
    const lockPath = kimiConfigLockPath(configPath);
    await writeFile(lockPath, "incomplete crashed-owner metadata\n", { mode: 0o600 });
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);

    const result = await runSetup([], makeContext(env));
    expect(result.probe).toBe("ok");
    expect((await readFile(configPath, "utf8"))).toContain("kimi-plugin-cc-managed");
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("install refuses an invalid foreign hook without changing config", async () => {
    const { env, configPath } = await makeCase("invalid-foreign-install");
    const invalidForeign = [
      "[[hooks]]",
      'event = "PreToolUse"',
      'command = "foreign-hook"',
      'cwd = "/tmp"',
      "",
    ].join("\n");
    await writeFile(configPath, invalidForeign, "utf8");

    await expect(runSetup([], makeContext(env))).rejects.toMatchObject({
      code: "SETUP_INVALID_HOOKS_CONFIG",
      stage: "setup.install",
      message: expect.stringContaining('unknown field "cwd"'),
    });
    expect(await readFile(configPath, "utf8")).toBe(invalidForeign);
  });

  test("install converts hooks=[] and preserves every surrounding byte", async () => {
    const { env, configPath } = await makeCase("inline-hooks-empty");
    const prefix = "# exact prefix\ndefault_model = \"kimi-code/kimi-for-coding\"\n";
    const suffix = "\n[ui]\ntheme = \"light\"\n";
    await writeFile(configPath, `${prefix}hooks = [] # normalized by setup\n${suffix}`, "utf8");

    const result = await runSetup([], makeContext(env));
    const after = await readFile(configPath, "utf8");
    expect(result.probe).toBe("ok");
    expect(after.startsWith(prefix)).toBe(true);
    expect(after).toContain(suffix);
    expect(after).not.toMatch(/^hooks\s*=/m);
    expect(after.match(/^\[\[hooks\]\]$/gm)).toHaveLength(1);
    expect(result.warnings.join("\n")).toContain("formatting and comments inside that hooks assignment were normalized");
  });

  test("install converts a validated multiline inline hook to canonical [[hooks]] tables", async () => {
    const { env, configPath } = await makeCase("inline-hooks-nonempty");
    const prefix = "# untouched before\ndefault_model = \"kimi-code/kimi-for-coding\"\n";
    const inline = [
      "hooks = [",
      "  # this assignment-local comment is intentionally normalized",
      '  { event = "Stop", command = "foreign-hook", timeout = 9 },',
      "]",
      "",
    ].join("\n");
    const suffix = "[ui]\nshow_usage = true\n# untouched after\n";
    await writeFile(configPath, `${prefix}${inline}${suffix}`, "utf8");

    const result = await runSetup([], makeContext(env));
    const after = await readFile(configPath, "utf8");
    expect(result.probe).toBe("ok");
    expect(after.startsWith(prefix)).toBe(true);
    expect(after).toContain(`${suffix}\n# === BEGIN kimi-plugin-cc-managed`);
    expect(after).not.toMatch(/^hooks\s*=/m);
    expect(after.match(/^\[\[hooks\]\]$/gm)).toHaveLength(2);
    expect(after).toContain('event = "Stop"\ncommand = "foreign-hook"\ntimeout = 9');
    expect(result.warnings.join("\n")).toContain("inline hooks array (1 entry)");
  });

  test("future 0.x minors validate additive events by minimum and warn separately", async () => {
    if (process.platform === "win32") return;
    const { env, configPath } = await makeCase("future-minor-event");
    const kimiBin = path.join(path.dirname(configPath), "future-kimi");
    await writeFile(kimiBin, "#!/bin/sh\nprintf '%s\\n' '0.99.0'\n", "utf8");
    await chmod(kimiBin, 0o700);
    await writeFile(
      configPath,
      '[[hooks]]\nevent = "Interrupt"\ncommand = "foreign-hook"\n',
      "utf8",
    );

    const result = await runSetup([], makeContext({
      ...env,
      KIMI_PLUGIN_CC_KIMI_BIN: kimiBin,
    }));
    expect(result.probe).toBe("ok");
    expect(result.warnings.join("\n")).toContain("kimi-code version 0.99.0 is outside the range");
    expect((await readFile(configPath, "utf8")).match(/^\[\[hooks\]\]$/gm)).toHaveLength(2);
  });

  test("KIMI_PLUGIN_CC_SKIP_VERSION_PROBE does not bypass hook-schema version verification", async () => {
    if (process.platform === "win32") return;
    const { configPath } = await makeCase("skip-version-does-not-skip-schema");
    const kimiBin = path.join(path.dirname(configPath), "old-kimi");
    await writeFile(kimiBin, "#!/bin/sh\nprintf '%s\\n' '0.2.0'\n", "utf8");
    await chmod(kimiBin, 0o700);
    const contents = '[[hooks]]\nevent = "Interrupt"\ncommand = "foreign-hook"\n';
    const result = await validateKimiHookSetForEnvironment(contents, {
      ...process.env,
      KIMI_PLUGIN_CC_KIMI_BIN: kimiBin,
      KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: "1",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('event "Interrupt" requires kimi-code >= 0.14');
    expect(result.reason).toContain("installed version is 0.2");
  });

  test("install refuses nested hooks table shapes without changing config", async () => {
    const { env, configPath } = await makeCase("invalid-nested-hooks-install");
    const invalidNested = "[hooks.foo]\ncommand = \"foreign-hook\"\n";
    await writeFile(configPath, invalidNested, "utf8");

    await expect(runSetup([], makeContext(env))).rejects.toMatchObject({
      code: "SETUP_INVALID_HOOKS_CONFIG",
      message: expect.stringContaining("no configured PreToolUse hook"),
    });
    expect(await readFile(configPath, "utf8")).toBe(invalidNested);
  });

  test.each([
    ["malformed table header", '[[hooks] ]\nevent = "PreToolUse"\ncommand = "foreign-hook"\n'],
    ["repeated timeout underscore", '[[hooks]]\nevent = "PreToolUse"\ncommand = "foreign-hook"\ntimeout = 1__0\n'],
    ["leading-zero timeout", '[[hooks]]\nevent = "PreToolUse"\ncommand = "foreign-hook"\ntimeout = 01\n'],
    ["malformed unrelated array", 'bad = [1,,2]\n[[hooks]]\nevent = "PreToolUse"\ncommand = "foreign-hook"\n'],
    ["duplicate unrelated key", 'bad = 1\nbad = 2\n[[hooks]]\nevent = "PreToolUse"\ncommand = "foreign-hook"\n'],
  ])("rejects TOML-invalid config syntax: %s", (_name, contents) => {
    const validation = validateKimiHookSet(contents, { major: 0, minor: 23 });
    expect(validation.valid).toBe(false);
    expect(validation.reason).toContain("no configured PreToolUse hook");
  });

  test("--check fails when a foreign hook invalidates the whole hooks array", async () => {
    const { env, configPath } = await makeCase("invalid-foreign-check");
    await runSetup([], makeContext(env));
    const installed = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      `${installed}\n[[hooks]]\nevent = "PreToolUse"\ncommand = "foreign-hook"\ntimeout = 0\n`,
      "utf8",
    );

    const result = await runSetup(["--check"], makeContext(env));
    expect(result.probe).toBe("failed");
    expect(result.probeError).toContain("drops the entire hooks array");
    expect(result.probeError).toContain("timeout");
    expect(result.nextStep).toContain("invalid [[hooks]] entry");
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

// v1.7.0 — Claude Code and Codex share one ~/.kimi-code/config.toml and each
// own a host-scoped managed block, so setup in one host never clobbers the other.

function extractBlock(contents: string, host: string): string {
  const lines = contents.split("\n");
  const begin = lines.findIndex((l) =>
    new RegExp(`BEGIN kimi-plugin-cc-managed:${host}\\b`).test(l),
  );
  const end = lines.findIndex(
    (l, i) => i > begin && new RegExp(`END kimi-plugin-cc-managed:${host}\\b`).test(l),
  );
  return lines.slice(begin, end + 1).join("\n");
}

describe("setup host scoping (Claude Code ↔ Codex coexistence)", () => {
  test("simultaneous dual-host setup serializes without lost updates", async () => {
    const { env, configPath } = await makeCase("dual-host-concurrent");
    const claudeEnv = { ...env, KIMI_PLUGIN_CC_HOST_ID: "claude-code" };
    const codexEnv = { ...env, KIMI_PLUGIN_CC_HOST_ID: "codex" };

    const [claude, codex] = await Promise.all([
      runSetup([], makeContext(claudeEnv)),
      runSetup([], makeContext(codexEnv)),
    ]);
    expect(claude.probe).toBe("ok");
    expect(codex.probe).toBe("ok");

    const contents = await readFile(configPath, "utf8");
    expect(contents.match(/BEGIN kimi-plugin-cc-managed:claude-code/g)).toHaveLength(1);
    expect(contents.match(/BEGIN kimi-plugin-cc-managed:codex/g)).toHaveLength(1);
    expect((await runSetup(["--check"], makeContext(claudeEnv))).probe).toBe("ok");
    expect((await runSetup(["--check"], makeContext(codexEnv))).probe).toBe("ok");
  });

  test("two hosts coexist — setup in one host never clobbers the other's block", async () => {
    const { env, configPath } = await makeCase("dual-host-coexist");
    const claudeEnv = { ...env, KIMI_PLUGIN_CC_HOST_ID: "claude-code" };
    const codexEnv = { ...env, KIMI_PLUGIN_CC_HOST_ID: "codex" };

    await runSetup([], makeContext(claudeEnv));
    const afterClaude = await readFile(configPath, "utf8");
    expect(afterClaude).toContain("BEGIN kimi-plugin-cc-managed:claude-code");
    const claudeBlock = extractBlock(afterClaude, "claude-code");

    const codexResult = await runSetup([], makeContext(codexEnv));
    expect(codexResult.blockWritten).toBe(true);
    const afterCodex = await readFile(configPath, "utf8");
    expect(afterCodex).toContain("BEGIN kimi-plugin-cc-managed:claude-code");
    expect(afterCodex).toContain("BEGIN kimi-plugin-cc-managed:codex");
    // Claude's block is byte-identical after the Codex install.
    expect(extractBlock(afterCodex, "claude-code")).toBe(claudeBlock);

    // Each host's --check passes for its OWN block.
    expect((await runSetup(["--check"], makeContext(claudeEnv))).probe).toBe("ok");
    expect((await runSetup(["--check"], makeContext(codexEnv))).probe).toBe("ok");

    // Re-running Claude setup is idempotent and does not touch Codex's block.
    const codexBlock = extractBlock(afterCodex, "codex");
    await runSetup([], makeContext(claudeEnv));
    expect(extractBlock(await readFile(configPath, "utf8"), "codex")).toBe(codexBlock);
  });

  test("install migrates a legacy un-suffixed block to a host-scoped marker in place", async () => {
    const { env, configPath } = await makeCase("legacy-migrate");
    const legacy = [
      "# === BEGIN kimi-plugin-cc-managed (v0.9.0) ===",
      "[[hooks]]",
      'event = "PreToolUse"',
      'command = "node /stale/approval-hook.js"',
      "timeout = 15",
      "# === END kimi-plugin-cc-managed ===",
      "",
    ].join("\n");
    await writeFile(configPath, legacy, "utf8");

    await runSetup([], makeContext({ ...env, KIMI_PLUGIN_CC_HOST_ID: "claude-code" }));
    const after = await readFile(configPath, "utf8");
    expect(after).toContain("BEGIN kimi-plugin-cc-managed:claude-code");
    // Converted in place — exactly one block, not duplicated.
    expect(after.match(/BEGIN kimi-plugin-cc-managed/g)?.length).toBe(1);
    expect(after).not.toContain("/stale/approval-hook.js");
  });

  test("install prunes orphaned marker-less approval-hook [[hooks]] entries", async () => {
    const { env, configPath } = await makeCase("prune-orphans");
    const orphanHook =
      "/home/u/.claude/plugins/cache/kimi-marketplace/kimi/1.5.0/dist/hooks/approval-hook.js";
    const seeded = [
      "[[hooks]]",
      'event = "PreToolUse"',
      `command = "'${process.execPath}' '${orphanHook}'"`,
      "timeout = 15",
      "",
      "user_setting = true",
      "",
    ].join("\n");
    await writeFile(configPath, seeded, "utf8");

    const result = await runSetup([], makeContext(env));
    const after = await readFile(configPath, "utf8");
    // Orphan removed, user content preserved, our fresh block installed.
    expect(after).not.toContain(orphanHook);
    expect(after).toContain("user_setting = true");
    expect(after).toContain("BEGIN kimi-plugin-cc-managed");
    expect(result.warnings.join("\n")).toContain("Pruned");
  });

  test("prune stops at a table header with a trailing comment (never eats the next table)", async () => {
    const { env, configPath } = await makeCase("prune-boundary-comment");
    const orphanHook =
      "/home/u/.claude/plugins/cache/kimi-marketplace/kimi/1.5.0/dist/hooks/approval-hook.js";
    // No blank line between the orphan hook and the user's permission rule, and
    // the table header carries an inline comment (Codex review scenario).
    const seeded = [
      "[[hooks]]",
      'event = "PreToolUse"',
      `command = "'${process.execPath}' '${orphanHook}'"`,
      "timeout = 15",
      "[[permission.rules]] # user security rule",
      'decision = "deny"',
      'pattern = "Bash(rm *)"',
      "",
    ].join("\n");
    await writeFile(configPath, seeded, "utf8");

    await runSetup([], makeContext(env));
    const after = await readFile(configPath, "utf8");
    // Orphan hook removed…
    expect(after).not.toContain(orphanHook);
    // …but the user's permission rule (and its inline-comment header) survive.
    expect(after).toContain("[[permission.rules]] # user security rule");
    expect(after).toContain('pattern = "Bash(rm *)"');
  });

  test("uninstall is host-scoped by default; --all removes every host", async () => {
    const { env, configPath } = await makeCase("uninstall-hosts");
    const claudeEnv = { ...env, KIMI_PLUGIN_CC_HOST_ID: "claude-code" };
    const codexEnv = { ...env, KIMI_PLUGIN_CC_HOST_ID: "codex" };
    await runSetup([], makeContext(claudeEnv));
    await runSetup([], makeContext(codexEnv));

    // Default uninstall as Claude removes ONLY Claude's block.
    const scoped = await runSetup(["--uninstall"], makeContext(claudeEnv));
    expect(scoped.blockRemoved).toBe(true);
    let after = await readFile(configPath, "utf8");
    expect(after).not.toContain("BEGIN kimi-plugin-cc-managed:claude-code");
    expect(after).toContain("BEGIN kimi-plugin-cc-managed:codex");

    // Reinstall Claude, then --all clears everything.
    await runSetup([], makeContext(claudeEnv));
    const all = await runSetup(["--uninstall", "--all"], makeContext(codexEnv));
    expect(all.blockRemoved).toBe(true);
    after = await readFile(configPath, "utf8");
    expect(after).not.toContain("kimi-plugin-cc-managed");
  });

  test("install does NOT adopt or clobber another host's legacy block", async () => {
    const { env, configPath } = await makeCase("no-clobber-foreign-legacy");
    // A pre-1.7.0 legacy (un-suffixed) block whose command path is Codex's.
    const codexHook =
      "/Users/x/.codex/plugins/cache/kimi-marketplace/kimi/1.6.5/dist/hooks/approval-hook.js";
    const legacy = [
      "# === BEGIN kimi-plugin-cc-managed (v1.6.5) ===",
      "[[hooks]]",
      'event = "PreToolUse"',
      `command = "'${process.execPath}' '${codexHook}'"`,
      "timeout = 15",
      "# === END kimi-plugin-cc-managed ===",
      "",
    ].join("\n");
    await writeFile(configPath, legacy, "utf8");

    // Claude installs: it must APPEND its own block and leave Codex's intact —
    // NOT convert the Codex-owned legacy block to a Claude block (the migration
    // clobber the whole change exists to prevent).
    await runSetup([], makeContext({ ...env, KIMI_PLUGIN_CC_HOST_ID: "claude-code" }));
    const after = await readFile(configPath, "utf8");
    expect(after).toContain(codexHook);
    expect(after).toContain("BEGIN kimi-plugin-cc-managed:claude-code");
  });

  test("default uninstall leaves another host's legacy block intact", async () => {
    const { env, configPath } = await makeCase("uninstall-keeps-foreign-legacy");
    const codexHook =
      "/Users/x/.codex/plugins/cache/kimi-marketplace/kimi/1.6.5/dist/hooks/approval-hook.js";
    const legacy = [
      "# === BEGIN kimi-plugin-cc-managed (v1.6.5) ===",
      "[[hooks]]",
      'event = "PreToolUse"',
      `command = "'${process.execPath}' '${codexHook}'"`,
      "timeout = 15",
      "# === END kimi-plugin-cc-managed ===",
      "",
    ].join("\n");
    await writeFile(configPath, legacy, "utf8");
    await runSetup([], makeContext({ ...env, KIMI_PLUGIN_CC_HOST_ID: "claude-code" }));

    // Claude's default uninstall removes only Claude's block — Codex's legacy
    // block (host-neutral marker, but Codex-owned command path) survives.
    await runSetup(["--uninstall"], makeContext({ ...env, KIMI_PLUGIN_CC_HOST_ID: "claude-code" }));
    const after = await readFile(configPath, "utf8");
    expect(after).toContain(codexHook);
    expect(after).not.toContain("BEGIN kimi-plugin-cc-managed:claude-code");
  });

  test("prune leaves an unmanaged hook that carries a matcher (not our grammar)", async () => {
    const { env, configPath } = await makeCase("prune-skips-matcher");
    const ourScript =
      "/home/u/.claude/plugins/cache/kimi-marketplace/kimi/1.5.0/dist/hooks/approval-hook.js";
    // Reuses approval-hook.js but with a matcher — a deliberate user hook, not
    // an orphan of ours. Must survive the prune.
    const seeded = [
      "[[hooks]]",
      'matcher = "Write"',
      'event = "PreToolUse"',
      `command = "'${process.execPath}' '${ourScript}'"`,
      "timeout = 15",
      "",
    ].join("\n");
    await writeFile(configPath, seeded, "utf8");
    const result = await runSetup([], makeContext(env));
    const after = await readFile(configPath, "utf8");
    expect(after).toContain(ourScript);
    expect(result.warnings.join("\n")).not.toContain("Pruned");
  });

  test("install preserves but refuses an invalid unmanaged hook with a multi-line array", async () => {
    const { env, configPath } = await makeCase("prune-multiline-array");
    const ourScript =
      "/home/u/.claude/plugins/cache/kimi-marketplace/kimi/1.5.0/dist/hooks/approval-hook.js";
    // A marker-less table that reuses approval-hook.js but also has a multi-line
    // array key — NOT our grammar. Must be left fully intact (no partial cut).
    const seeded = [
      "[[hooks]]",
      'event = "PreToolUse"',
      `command = "'${process.execPath}' '${ourScript}'"`,
      "metadata = [",
      '  "a",',
      '  "b",',
      "]",
      "timeout = 15",
      "",
      "user_setting = true",
      "",
    ].join("\n");
    await writeFile(configPath, seeded, "utf8");
    await expect(runSetup([], makeContext(env))).rejects.toMatchObject({
      code: "SETUP_INVALID_HOOKS_CONFIG",
      message: expect.stringContaining('unknown field "metadata"'),
    });
    const after = await readFile(configPath, "utf8");
    // The whole table survives byte-for-byte; setup neither partially prunes
    // it nor appends a block that kimi-code would silently discard with it.
    expect(after).toBe(seeded);
    expect(after).toContain("metadata = [");
    expect(after).toContain('  "a",');
    expect(after).toContain("user_setting = true");
  });

  test("scoped uninstall keeps a legacy block it cannot attribute; --all removes it", async () => {
    const { env, configPath } = await makeCase("uninstall-ambiguous-legacy");
    // Legacy block with a NON-canonical (bare-node) command — un-attributable.
    const legacy = [
      "# === BEGIN kimi-plugin-cc-managed (v1.6.5) ===",
      "[[hooks]]",
      'event = "PreToolUse"',
      'command = "node /somewhere/dist/hooks/approval-hook.js"',
      "timeout = 15",
      "# === END kimi-plugin-cc-managed ===",
      "",
    ].join("\n");
    await writeFile(configPath, legacy, "utf8");

    // Scoped uninstall (some other host) must NOT remove the ambiguous block.
    await runSetup(["--uninstall"], makeContext({ ...env, KIMI_PLUGIN_CC_HOST_ID: "codex" }));
    let after = await readFile(configPath, "utf8");
    expect(after).toContain("BEGIN kimi-plugin-cc-managed");

    // --all clears it.
    await runSetup(["--uninstall", "--all"], makeContext({ ...env, KIMI_PLUGIN_CC_HOST_ID: "codex" }));
    after = await readFile(configPath, "utf8");
    expect(after).not.toContain("kimi-plugin-cc-managed");
  });

  test("--all is rejected without --uninstall", async () => {
    const { env } = await makeCase("all-requires-uninstall");
    await expect(runSetup(["--all"], makeContext(env))).rejects.toMatchObject({
      code: "INVALID_ARGS",
      stage: "setup.parse",
    });
  });
});
