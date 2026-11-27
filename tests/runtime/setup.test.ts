import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
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
import { kimiVersionsWith } from "../../runtime/kimi-releases.js";
import {
  KIMI_CONFIG_LOCK_METADATA_MAX_BYTES,
  kimiConfigLockPath,
  validateKimiHookSet,
  validateKimiHookSetForEnvironment,
  withKimiConfigLock,
} from "../../runtime/hooks/config-safety.js";
import { markerCommentLines } from "../../runtime/hooks/managed-block.js";
import { parse as parseToml } from "../../runtime/vendor/smol-toml/parse.js";
import type { CommandContext } from "../../runtime/types.js";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const bundledHookSourcePath = path.join(repoRoot, "dist", "hooks", "approval-hook.js");

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "kimi-plugin-cc-setup-"));
});

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function makeCase(
  name: string,
): Promise<{ env: NodeJS.ProcessEnv; configPath: string; pluginData: string; publishedHookPath: string }> {
  const kimiCodeHome = path.join(scratch, name, "kimi-code-home");
  const pluginData = path.join(scratch, name, "plugin-data");
  await mkdir(kimiCodeHome, { recursive: true });
  await mkdir(pluginData, { recursive: true });
  return {
    env: {
      ...process.env,
      KIMI_CODE_HOME: kimiCodeHome,
      KIMI_PLUGIN_CC_DATA: pluginData,
    },
    configPath: path.join(kimiCodeHome, "config.toml"),
    pluginData,
    publishedHookPath: path.join(pluginData, "kimi-plugin-cc", "hook", "approval-hook.js"),
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
  test("marker scanning stays bounded on long valid TOML lines", () => {
    const input = `values = [\n${" ".repeat(64_000)}${"[],".repeat(64_000)}\n]\n`;
    const start = performance.now();
    expect(markerCommentLines(input).size).toBe(0);
    expect(performance.now() - start).toBeLessThan(1500);
  });
  test("install publishes bundled hook to <pluginRoot>/hook/approval-hook.js, writes canonical block, and probe passes", async () => {
    const { env, configPath, publishedHookPath } = await makeCase("install-fresh");
    const result = await runSetup([], makeContext(env));

    expect(result.action).toBe("install");
    expect(result.blockWritten).toBe(true);
    expect(result.probe).toBe("ok");
    expect(result.hookScriptPath).toBe(publishedHookPath);

    // Bundled hook script and ESM package.json were atomically published under pluginRoot/hook/.
    expect(await readFile(publishedHookPath, "utf8")).toBe(await readFile(bundledHookSourcePath, "utf8"));
    expect(await readFile(path.join(path.dirname(publishedHookPath), "package.json"), "utf8")).toBe(
      '{"type":"module"}\n',
    );
    if (process.platform !== "win32") {
      expect((await stat(path.dirname(publishedHookPath))).mode & 0o777).toBe(0o700);
    }

    const contents = await readFile(configPath, "utf8");
    expect(contents).toContain("=== BEGIN kimi-plugin-cc-managed (v");
    expect(contents).toContain("=== END kimi-plugin-cc-managed ===");
    expect(contents).toContain('event = "PreToolUse"');
    expect(contents).toContain(publishedHookPath);
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
    const { env, configPath, publishedHookPath } = await makeCase("install-refresh");
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
    expect(contents).toContain(publishedHookPath);
    expect(contents).not.toContain("/stale/path/approval-hook.js");
  });

  test("install removes an orphaned legacy BEGIN without deleting surrounding content", async () => {
    const { env, configPath } = await makeCase("install-orphan-begin");
    await writeFile(configPath, "# === BEGIN kimi-plugin-cc-managed (v0.9.0) ===\nuser_setting = true\n", "utf8");
    const result = await runSetup([], makeContext(env));
    expect(result.warnings.join("\n")).toContain("orphaned managed marker");
    expect(await readFile(configPath, "utf8")).toContain("user_setting = true");
    expect((await runSetup(["--check"], makeContext(env))).probe).toBe("ok");
  });

  test("install repairs an orphaned legacy END", async () => {
    const { env, configPath } = await makeCase("install-orphan-end");
    await writeFile(configPath, "# === END kimi-plugin-cc-managed ===\n", "utf8");
    const result = await runSetup([], makeContext(env));
    expect(result.probe).toBe("ok");
    expect(result.warnings.join("\n")).toContain("orphaned managed marker");
  });

  test("install repairs a partially rewritten hooks array by pruning stale plugin tables and preserving user settings", async () => {
    const { env, configPath, publishedHookPath } = await makeCase("partial-hooks-rewrite");
    const legacyClaude = "/home/u/.claude/plugins/cache/kimi-marketplace/kimi/2.2.1/dist/hooks/approval-hook.js";
    const legacyCodex = "/home/u/.codex/plugins/cache/kimi-marketplace/kimi/2.4.5/dist/hooks/approval-hook.js";
    const userHook = "/opt/acme/my-own-hook.js";
    const seeded = [
      "[[hooks]]", 'event = "PreToolUse"', `command = "'/usr/bin/node' '${userHook}'"`, "timeout = 20", "",
      "[[hooks]]", 'event = "PreToolUse"', `command = "'${process.execPath}' '${legacyClaude}'"`, "timeout = 15", "",
      "[[hooks]]", 'event = "PreToolUse"', `command = "'${process.execPath}' '${legacyCodex}'"`, "timeout = 15",
      "# === END kimi-plugin-cc-managed:codex ===", "", "[user_settings]", "keep = true", "",
    ].join("\n");
    await writeFile(configPath, seeded, "utf8");
    const result = await runSetup([], makeContext(env));
    const after = await readFile(configPath, "utf8");
    expect(result.probe).toBe("ok");
    expect(after).toContain(`command = "'/usr/bin/node' '${userHook}'"`);
    expect(after).toContain(publishedHookPath);
    expect(after).not.toContain(legacyClaude);
    expect(after).not.toContain(legacyCodex);
    expect(after).toContain("[user_settings]\nkeep = true");
    expect((await runSetup(["--check"], makeContext(env))).probe).toBe("ok");
  });

  test("mismatched legacy host markers are repaired together without consuming content", async () => {
    const { env, configPath } = await makeCase("mismatched-host-markers");
    const seeded = '# === BEGIN kimi-plugin-cc-managed:claude-code (v2.5.1) ===\nuser_setting = true\n# === END kimi-plugin-cc-managed:codex ===\n';
    await writeFile(configPath, seeded, "utf8");
    const result = await runSetup([], makeContext(env));
    const after = await readFile(configPath, "utf8");
    expect(result.probe).toBe("ok");
    expect(after).toContain("user_setting = true");
    expect(after).not.toContain("BEGIN kimi-plugin-cc-managed:claude-code");
    expect(after).not.toContain("END kimi-plugin-cc-managed:codex");
    expect((await runSetup(["--check"], makeContext(env))).probe).toBe("ok");
  });

  test("install repairs a partially rewritten two-host hooks array into one canonical block", async () => {
    const { env, configPath, publishedHookPath } = await makeCase("mismatched-hooks-two-host");
    const claude = "/home/u/.claude/plugins/cache/kimi-marketplace/kimi/2.2.1/dist/hooks/approval-hook.js";
    const codex = "/home/u/.codex/plugins/cache/kimi-marketplace/kimi/2.4.5/dist/hooks/approval-hook.js";
    const table = (hook: string) => `[[hooks]]\nevent = "PreToolUse"\ncommand = "'${process.execPath}' '${hook}'"\ntimeout = 15\n`;
    const seeded = `# === BEGIN kimi-plugin-cc-managed:claude-code (v2.5.1) ===\n${table(claude)}\n${table(codex)}# === END kimi-plugin-cc-managed:codex ===\n`;
    await writeFile(configPath, seeded, "utf8");
    const context = makeContext(env);
    expect((await runSetup([], context)).probe).toBe("ok");
    const after = await readFile(configPath, "utf8");
    expect(after).toContain(publishedHookPath);
    expect(after).not.toContain(claude);
    expect(after).not.toContain(codex);
    expect(after.match(/\[\[hooks\]\]/g)).toHaveLength(1);
    expect((await runSetup(["--check"], context)).probe).toBe("ok");
  });

  test("orphan repair never rebinds quoted trailing fields onto a preceding user hook", async () => {
    const { env, configPath } = await makeCase("orphan-foreign-matcher");
    const userHook = "/opt/acme/user-hook.js";
    const codex = "/home/u/.codex/plugins/cache/kimi-marketplace/kimi/2.4.5/dist/hooks/approval-hook.js";
    const seeded = `# === BEGIN kimi-plugin-cc-managed:claude-code (v2.5.1) ===\n[[hooks]]\nevent = "PreToolUse"\ncommand = "'/usr/bin/node' '${userHook}'"\ntimeout = 15\n\n[[hooks]]\nevent = "PreToolUse"\ncommand = "'${process.execPath}' '${codex}'"\ntimeout = 15\n# === END kimi-plugin-cc-managed:codex ===\n\n"matcher" = "*"\n`;
    await writeFile(configPath, seeded, "utf8");
    const context = makeContext(env);
    expect((await runSetup([], context)).probe).toBe("ok");
    const hooks = parseToml(await readFile(configPath, "utf8")).hooks as Array<Record<string, unknown>>;
    expect(hooks.find((hook) => String(hook.command).includes(userHook))?.matcher).toBeUndefined();
    expect(hooks.find((hook) => String(hook.command).includes(codex))?.matcher).toBe("*");
  });

  test.each(['"""', "'''"])("marker text inside TOML %s values survives install and uninstall", async (quote) => {
    const { env, configPath } = await makeCase(`string-marker-${quote === '"""' ? 'basic' : 'literal'}`);
    const value = `custom = ${quote}\nkeep\n# === END kimi-plugin-cc-managed:codex ===\nmore\n${quote}\n`;
    await writeFile(configPath, value, "utf8");
    const context = makeContext(env);
    expect((await runSetup([], context)).probe).toBe("ok");
    expect(await readFile(configPath, "utf8")).toContain(value);
    await runSetup(["--uninstall"], context);
    expect(await readFile(configPath, "utf8")).toContain(value);
  });

  test("a hook-shaped TOML string is never pruned as a live hook table", async () => {
    const { env, configPath } = await makeCase("string-hook-table");
    const hook = "/home/u/.codex/plugins/cache/kimi-marketplace/kimi/2.4.5/dist/hooks/approval-hook.js";
    const content = `custom = '''\n[[hooks]]\nevent = "PreToolUse"\ncommand = "'${process.execPath}' '${hook}'"\ntimeout = 15\n'''\n`;
    await writeFile(configPath, content, "utf8");
    const context = makeContext(env);
    expect((await runSetup([], context)).probe).toBe("ok");
    expect(await readFile(configPath, "utf8")).toContain(content);
  });

  test.each(["install", "uninstall"])("%s preserves blank lines and mixed line endings inside TOML values", async (action) => {
    const { env, configPath } = await makeCase(`preserve-value-${action}`);
    const value = 'custom = """start\r\n\n\n\nend"""\n';
    const hook = "/home/u/.codex/plugins/cache/kimi-marketplace/kimi/2.4.5/dist/hooks/approval-hook.js";
    const seeded = `${value}[[hooks]]\nevent = "PreToolUse"\ncommand = "'${process.execPath}' '${hook}'"\ntimeout = 15\n# === END kimi-plugin-cc-managed:codex ===\n`;
    await writeFile(configPath, seeded, "utf8");
    const context = makeContext(env);
    await runSetup(action === "install" ? [] : ["--uninstall"], context);
    expect(await readFile(configPath, "utf8")).toContain(value);
  });

  test("orphan repair does not write when the hooks schema is invalid", async () => {
    const { env, configPath } = await makeCase("orphan-invalid-hook");
    const seeded = '[[hooks]]\nevent = "PreToolUse"\ncommand = "some-hook"\nunknown_field = true\n# === END kimi-plugin-cc-managed:codex ===\n';
    await writeFile(configPath, seeded, "utf8");
    await expect(runSetup([], makeContext(env))).rejects.toMatchObject({ code: "SETUP_INVALID_HOOKS_CONFIG" });
    expect(await readFile(configPath, "utf8")).toBe(seeded);
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

  test("rejects unknown, removed, and conflicting setup flags", async () => {
    const { env } = await makeCase("invalid-args");
    for (const argv of [
      ["--bogus"],
      ["--enable-review-gate"],
      ["--disable-review-gate"],
      ["--all"],
      ["--check", "--uninstall"],
    ]) {
      await expect(runSetup(argv, makeContext(env))).rejects.toMatchObject({
        code: "INVALID_ARGS",
        stage: "setup.parse",
      });
    }
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

  test("config temp file is created via O_EXCL + mode 0o600 at open() time (zero-window fix)", async () => {
    // Regression test for the writeFile()-then-chmod() gap: the temp file
    // must never exist at a wider mode than 0o600, even momentarily. That
    // can only be proven by asserting the *creation* call itself passes
    // O_CREAT|O_EXCL|O_NOFOLLOW and mode 0o600 to open() — mirroring
    // createPrivateLockFile in hooks/config-safety.ts — rather than by
    // inspecting the (unobservably fast) window between two syscalls.
    //
    // spyOn(fsPromises, "open") does not reliably intercept this call (the
    // module graph binds the real function before the spy patches the
    // exported property), so this uses mock.module to replace the module
    // in the resolver itself, and explicitly restores the real module
    // afterward so later tests in this file are unaffected.
    if (process.platform === "win32") return;
    const { env, configPath } = await makeCase("install-open-flags");

    const real = await import("node:fs/promises");
    const realOpen = real.open;
    const calls: unknown[][] = [];
    mock.module("node:fs/promises", () => ({
      ...real,
      open: (...args: unknown[]) => {
        calls.push(args);
        return (realOpen as (...a: unknown[]) => unknown)(...args);
      },
    }));
    try {
      await runSetup([], makeContext(env));
    } finally {
      mock.module("node:fs/promises", () => real);
    }

    const expectedFlags =
      fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0);
    // The lock file (config.toml.kimi-plugin-cc.lock*) shares the same
    // prefix as the config temp file, so also require the ".tmp" suffix
    // to isolate the call we care about.
    const configTmpCall = calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].startsWith(`${configPath}.kimi-plugin-cc.`) &&
        call[0].endsWith(".tmp"),
    );
    expect(configTmpCall).toBeDefined();
    expect(configTmpCall?.[1]).toBe(expectedFlags);
    expect(configTmpCall?.[2]).toBe(0o600);

    // The final config file mode is unaffected by the switch.
    const stats = await stat(configPath);
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

  test("versions below the 2.8.0 floor and uncertified newer 2.x releases emit rolling-window warnings", async () => {
    if (process.platform === "win32") return;
    for (const [version, expectedLine] of [
      ["0.99.0", "OLDER than the supported floor (2.8.0)"],
      ["2.7.3", "OLDER than the supported floor (2.8.0)"],
      ["2.9.0", "Read-only operations (ask, review, challenge) run on it with a warning"],
    ] as const) {
      const { env, configPath } = await makeCase(`rolling-window-warn-${version.replaceAll(".", "-")}`);
      const kimiBin = path.join(path.dirname(configPath), `kimi-${version}`);
      await writeFile(kimiBin, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, "utf8");
      await chmod(kimiBin, 0o700);
      await writeFile(
        configPath,
        '[[hooks]]\nevent = "PreToolUse"\ncommand = "foreign-hook"\n',
        "utf8",
      );

      const result = await runSetup([], makeContext({
        ...env,
        KIMI_PLUGIN_CC_KIMI_BIN: kimiBin,
      }));
      expect(result.probe).toBe("ok");
      const warnings = result.warnings.join("\n");
      expect(warnings).toContain(`kimi-code version ${version} is outside the rolling compatibility window`);
      expect(warnings).toContain(expectedLine);
      expect((await readFile(configPath, "utf8")).match(/^\[\[hooks\]\]$/gm)).toHaveLength(2);
    }
  });

  test.each(kimiVersionsWith("bounded-swarm"))("%s setup reports bounded swarm and the single-worker path", async (version) => {
    if (process.platform === "win32") return;
    const { env, configPath } = await makeCase(`bounded-swarm-version-notice-${version}`);
    const kimiBin = path.join(path.dirname(configPath), `kimi-${version}`);
    await writeFile(kimiBin, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, "utf8");
    await chmod(kimiBin, 0o700);

    const result = await runSetup([], makeContext({
      ...env,
      KIMI_PLUGIN_CC_KIMI_BIN: kimiBin,
    }));
    expect(result.probe).toBe("ok");
    const warnings = result.warnings.join("\n");
    expect(warnings).toContain(`kimi-code ${version} is certified for all operations`);
    expect(warnings).toContain("bounded waves with concurrency 2 or more");
    expect(warnings).toContain("one direct worker at concurrency 1");
    expect(warnings).not.toContain("refuse before model spawn");
    expect(warnings).not.toContain("outside the rolling compatibility window");
  });

  test.each(["PermissionRequest", "PermissionResult", "Interrupt"] as const)(
    "exact certified >= 2.8.0 schema accepts %s but refuses pre-floor and uncertified versions",
    async (event) => {
      const contents = `[[hooks]]\nevent = "${event}"\ncommand = "foreign-hook"\n`;
      expect(validateKimiHookSet(contents, { major: 2, minor: 8, patch: 0, version: "2.8.0" }).valid).toBe(true);
      expect(validateKimiHookSet(contents, { major: 2, minor: 8, patch: 1, version: "2.8.1" }).valid).toBe(true);
      for (const version of [
        { major: 0, minor: 14, patch: 0, version: "0.14.0" },
        { major: 0, minor: 41, patch: 3, version: "0.41.3" },
        { major: 2, minor: 0, patch: 0, version: "2.0.0" },
        { major: 2, minor: 6, patch: 0, version: "2.6.0" },
        { major: 2, minor: 7, patch: 3, version: "2.7.3" },
        { major: 2, minor: 8, patch: 2, version: "2.8.2" },
        { major: 2, minor: 9, patch: 0, version: "2.9.0" },
        { major: 2, minor: 8, patch: 0, version: "2.8.0-rc.1" },
        { major: 2, minor: 8, patch: 0, version: "2.8.0+unreviewed" },
        { major: 2, minor: 8, patch: 1, version: "2.8.0" },
        { major: 2, minor: 8 },
        { major: 2, minor: 8, patch: 0 },
        { major: 1, minor: 0, patch: 0, version: "1.0.0" },
        { major: 3, minor: 0, patch: 0, version: "3.0.0" },
      ]) {
        expect(validateKimiHookSet(contents, version).valid).toBe(false);
      }
      expect(
        validateKimiHookSet(contents + "unexpected = true\n", {
          major: 2,
          minor: 8,
          patch: 0,
          version: "2.8.0",
        }).valid,
      ).toBe(false);

      if (process.platform === "win32") return;
      const { env, configPath } = await makeCase(`major-two-${event}-2-8-0`);
      const kimiBin = path.join(path.dirname(configPath), "kimi-2-8-0");
      await writeFile(kimiBin, "#!/bin/sh\nprintf '%s\\n' '2.8.0'\n", "utf8");
      await chmod(kimiBin, 0o700);
      await writeFile(configPath, contents, "utf8");
      const result = await runSetup([], makeContext({ ...env, KIMI_PLUGIN_CC_KIMI_BIN: kimiBin }));
      expect(result.probe).toBe("ok");
      expect(await readFile(configPath, "utf8")).toContain(contents);
    },
  );

  test("KIMI_PLUGIN_CC_SKIP_VERSION_PROBE does not bypass hook-schema version verification", async () => {
    if (process.platform === "win32") return;
    const { configPath } = await makeCase("skip-version-does-not-skip-schema");
    const kimiBin = path.join(path.dirname(configPath), "old-kimi");
    await writeFile(kimiBin, "#!/bin/sh\nprintf '%s\\n' '2.7.3'\n", "utf8");
    await chmod(kimiBin, 0o700);
    const contents = '[[hooks]]\nevent = "Interrupt"\ncommand = "foreign-hook"\n';
    const result = await validateKimiHookSetForEnvironment(contents, {
      ...process.env,
      KIMI_PLUGIN_CC_KIMI_BIN: kimiBin,
      KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: "1",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('event "Interrupt" requires a certified kimi-code >= 2.8.0 release');
    expect(result.reason).toContain("got 2.7.3");
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
    const validation = validateKimiHookSet(contents, { major: 2, minor: 8, patch: 0, version: "2.8.0" });
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

// v3.1.0 — Single canonical managed block across all hosts, with automatic
// consolidation of legacy host-scoped `:<host-id>` blocks and bare plugin tables.

describe("single canonical managed block and legacy consolidation", () => {
  const legacyBlock = (host: string, hookPath: string) => [
    `# === BEGIN kimi-plugin-cc-managed:${host} (v2.8.0) ===`,
    "[[hooks]]",
    'event = "PreToolUse"',
    `command = "'${process.execPath}' '${hookPath}'"`,
    "timeout = 15",
    `# === END kimi-plugin-cc-managed:${host} ===`,
  ].join("\n");

  test("simultaneous setup runs serialize via the lock and produce one canonical block", async () => {
    const { env, configPath } = await makeCase("concurrent-canonical");

    const [first, second] = await Promise.all([
      runSetup([], makeContext(env)),
      runSetup([], makeContext(env)),
    ]);
    expect(first.probe).toBe("ok");
    expect(second.probe).toBe("ok");

    const contents = await readFile(configPath, "utf8");
    expect(contents.match(/BEGIN kimi-plugin-cc-managed \(v/g)).toHaveLength(1);
    expect(contents.match(/END kimi-plugin-cc-managed ===/g)).toHaveLength(1);
    expect((await runSetup(["--check"], makeContext(env))).probe).toBe("ok");
  });

  test("install migrates a single legacy host-scoped block in place to the canonical un-suffixed block", async () => {
    const { env, configPath, publishedHookPath } = await makeCase("legacy-single-migrate");
    const claudeHook =
      "/Users/x/.claude/plugins/cache/kimi-marketplace/kimi/2.8.0/dist/hooks/approval-hook.js";
    await writeFile(configPath, `user_setting = true\n\n${legacyBlock("claude-code", claudeHook)}\n`, "utf8");

    const result = await runSetup([], makeContext(env));
    expect(result.probe).toBe("ok");
    const after = await readFile(configPath, "utf8");
    expect(after).toContain("BEGIN kimi-plugin-cc-managed (v");
    expect(after).toContain("END kimi-plugin-cc-managed ===");
    expect(after).not.toContain(":claude-code");
    expect(after).not.toContain(claudeHook);
    expect(after).toContain(publishedHookPath);
    expect(after).toContain("user_setting = true");
    expect(after.match(/BEGIN kimi-plugin-cc-managed/g)?.length).toBe(1);
    expect((await runSetup(["--check"], makeContext(env))).probe).toBe("ok");
  });

  test("install consolidates multiple legacy host-scoped blocks into one canonical block while preserving foreign tables", async () => {
    const { env, configPath, publishedHookPath } = await makeCase("legacy-multi-consolidate");
    const claudeHook =
      "/Users/x/.claude/plugins/cache/kimi-marketplace/kimi/2.8.0/dist/hooks/approval-hook.js";
    const codexHook =
      "/Users/x/.codex/plugins/cache/kimi-marketplace/kimi/2.8.0/dist/hooks/approval-hook.js";
    const foreign = '[models."magpie/x"]\nprovider = "magpie"\nmodel = "x"\n';
    await writeFile(
      configPath,
      `${legacyBlock("claude-code", claudeHook)}\n\n${foreign}\n${legacyBlock("codex", codexHook)}\n`,
      "utf8",
    );

    const result = await runSetup([], makeContext(env));
    expect(result.probe).toBe("ok");
    expect(result.warnings.join("\n")).toContain(
      "Consolidated 2 legacy host-scoped managed block(s) into one canonical block.",
    );
    const after = await readFile(configPath, "utf8");
    expect(after.match(/BEGIN kimi-plugin-cc-managed/g)).toHaveLength(1);
    expect(after).not.toContain(":claude-code");
    expect(after).not.toContain(":codex");
    expect(after).toContain(publishedHookPath);
    expect(after).toContain(foreign);
    expect(() => parseToml(after)).not.toThrow();
    expect((await runSetup(["--check"], makeContext(env))).probe).toBe("ok");
  });

  test("install prunes orphaned marker-less approval-hook [[hooks]] entries from legacy hosts", async () => {
    const { env, configPath, publishedHookPath } = await makeCase("prune-orphans");
    const claudeOrphan =
      "/home/u/.claude/plugins/cache/kimi-marketplace/kimi/1.5.0/dist/hooks/approval-hook.js";
    const antigravityOrphan =
      "/home/u/.gemini/config/plugins/kimi/dist/hooks/approval-hook.js";
    const seeded = [
      "[[hooks]]",
      'event = "PreToolUse"',
      `command = "'${process.execPath}' '${claudeOrphan}'"`,
      "timeout = 15",
      "",
      "[[hooks]]",
      'event = "PreToolUse"',
      `command = "'${process.execPath}' '${antigravityOrphan}'"`,
      "timeout = 15",
      "",
      "[settings]",
      "user_setting = true",
      "",
    ].join("\n");
    await writeFile(configPath, seeded, "utf8");

    const result = await runSetup([], makeContext(env));
    const after = await readFile(configPath, "utf8");
    expect(after).not.toContain(claudeOrphan);
    expect(after).not.toContain(antigravityOrphan);
    expect(after).toContain(publishedHookPath);
    expect(after).toContain("user_setting = true");
    expect(after).toContain("BEGIN kimi-plugin-cc-managed (v");
    expect(result.warnings.join("\n")).toContain("Pruned 2 stale marker-less kimi-plugin-cc hook block(s)");
  });

  test("prune stops at a table header with a trailing comment (never eats the next table)", async () => {
    const { env, configPath } = await makeCase("prune-boundary-comment");
    const orphanHook =
      "/home/u/.claude/plugins/cache/kimi-marketplace/kimi/1.5.0/dist/hooks/approval-hook.js";
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
    expect(after).not.toContain(orphanHook);
    expect(after).toContain("[[permission.rules]] # user security rule");
    expect(after).toContain('pattern = "Bash(rm *)"');
  });

  test("uninstall removes canonical and legacy blocks while preserving user hooks and settings", async () => {
    const { env, configPath } = await makeCase("uninstall-all-blocks");
    const claudeHook =
      "/Users/x/.claude/plugins/cache/kimi-marketplace/kimi/2.8.0/dist/hooks/approval-hook.js";
    const codexHook =
      "/Users/x/.codex/plugins/cache/kimi-marketplace/kimi/2.8.0/dist/hooks/approval-hook.js";
    const userHook = "/opt/acme/my-own-hook.js";
    const seeded = [
      "user_setting = true",
      "",
      "[[hooks]]",
      'event = "PreToolUse"',
      `command = "'/usr/bin/node' '${userHook}'"`,
      "timeout = 20",
      "",
      legacyBlock("claude-code", claudeHook),
      "",
      legacyBlock("codex", codexHook),
      "",
    ].join("\n");
    await writeFile(configPath, seeded, "utf8");

    const uninstall = await runSetup(["--uninstall"], makeContext(env));
    expect(uninstall.blockRemoved).toBe(true);
    const after = await readFile(configPath, "utf8");
    expect(after).not.toContain("kimi-plugin-cc-managed");
    expect(after).not.toContain(claudeHook);
    expect(after).not.toContain(codexHook);
    expect(after).toContain(userHook);
    expect(after).toContain("user_setting = true");
  });

  test("prune leaves an unmanaged hook that carries a matcher (not our grammar)", async () => {
    const { env, configPath } = await makeCase("prune-skips-matcher");
    const ourScript =
      "/home/u/.claude/plugins/cache/kimi-marketplace/kimi/1.5.0/dist/hooks/approval-hook.js";
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
    expect(after).toBe(seeded);
    expect(after).toContain("metadata = [");
    expect(after).toContain('  "a",');
    expect(after).toContain("user_setting = true");
  });

  test("uninstall removes a legacy block with a non-canonical command", async () => {
    const { env, configPath } = await makeCase("uninstall-legacy-noncanonical");
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

    const uninstall = await runSetup(["--uninstall"], makeContext(env));
    expect(uninstall.blockRemoved).toBe(true);
    const after = await readFile(configPath, "utf8");
    expect(after).not.toContain("kimi-plugin-cc-managed");
  });
});

describe("canonical orphan marker handling", () => {
  const blockFor = (host: string | null, cmd: string) =>
    `# === BEGIN kimi-plugin-cc-managed${host ? `:${host}` : ""} (v2.8.0) ===\n[[hooks]]\nevent = "PreToolUse"\ncommand = "${cmd}"\ntimeout = 15\n# === END kimi-plugin-cc-managed${host ? `:${host}` : ""} ===\n`;

  test("any orphan marker (canonical, legacy-suffixed, or interleaved) fails closed as orphan", async () => {
    const { parseManagedBlock } = await import("../../runtime/hooks/managed-block.js");
    const suffixed = `${blockFor("codex", "x")}# === END kimi-plugin-cc-managed:claude-code ===\n`;
    expect(parseManagedBlock(suffixed).state.kind).toBe("orphan");
    expect(parseManagedBlock(suffixed).orphans).toEqual([
      { line: 6, detail: "END-without-BEGIN", hostId: "claude-code" },
    ]);
    const canonical = `${blockFor(null, "x")}# === END kimi-plugin-cc-managed ===\n`;
    expect(parseManagedBlock(canonical).state.kind).toBe("orphan");
    const interleaved =
      "# === BEGIN kimi-plugin-cc-managed:claude-code (v2.8.0) ===\n# === BEGIN kimi-plugin-cc-managed:codex (v2.8.0) ===\n[[hooks]]\nevent = \"PreToolUse\"\ncommand = \"x\"\n# === END kimi-plugin-cc-managed:claude-code ===\n";
    expect(parseManagedBlock(interleaved).state.kind).toBe("orphan");
  });

  test("check fails closed on an orphan END with plain-setup advice and install repairs it", async () => {
    const { env, configPath } = await makeCase("orphan-end-repair");
    await runSetup([], makeContext(env));
    const healthy = await readFile(configPath, "utf8");
    const begin = healthy.indexOf("# === BEGIN kimi-plugin-cc-managed");
    const table = healthy.indexOf("[[hooks]]", begin);
    await writeFile(configPath, healthy.slice(0, begin) + healthy.slice(table), "utf8");

    const broken = await runSetup(["--check"], makeContext(env));
    expect(broken.probe).toBe("failed");
    expect(broken.probeError).toContain("END-without-BEGIN");
    expect(broken.nextStep).toContain("without --uninstall");
    expect(broken.nextStep).not.toContain("Run setup --uninstall, then");

    const repaired = await runSetup([], makeContext(env));
    expect(repaired.probe).toBe("ok");
    expect(repaired.warnings.join("\n")).toContain("orphaned managed marker");
    expect((await runSetup(["--check"], makeContext(env))).probe).toBe("ok");
  });

  test("absent fallback sees a matcher bound across a blank line", async () => {
    const { evaluateInstalled } = await import("../../runtime/hooks/managed-block.js");
    const tainted = `[[hooks]]\nevent = "PreToolUse"\ncommand = "expected"\n\nmatcher = "*"\n`;
    expect(evaluateInstalled(tainted, "expected").installed).toBe(false);
    const clean = `[[hooks]]\nevent = "PreToolUse"\ncommand = "expected"\ntimeout = 15\n`;
    expect(evaluateInstalled(clean, "expected")).toMatchObject({ installed: true, via: "bare-table" });
  });
});

describe("H2-1: setup checks and repairs the hook's upstream timeout", () => {
  const userPrefix = 'default_model = "kimi-code/kimi-for-coding"\n\n';

  async function installed(name: string): Promise<{ env: NodeJS.ProcessEnv; configPath: string; healthy: string; command: string }> {
    const { env, configPath } = await makeCase(name);
    await writeFile(configPath, userPrefix, "utf8");
    await runSetup([], makeContext(env));
    const healthy = await readFile(configPath, "utf8");
    expect(healthy.match(/^timeout = 15$/gm)).toHaveLength(1);
    const hooks = (parseToml(healthy) as { hooks: Array<{ command: string }> }).hooks;
    return { env, configPath, healthy, command: hooks[0]!.command };
  }

  test("--check fails on a too-short timeout without writing; install rewrites the block in place", async () => {
    const { env, configPath, healthy } = await installed("timeout-short-marked");
    const short = healthy.replace(/^timeout = 15$/m, "timeout = 1");
    await writeFile(configPath, short, "utf8");

    const check = await runSetup(["--check"], makeContext(env));
    expect(check.probe).toBe("failed");
    expect(check.probeError).toContain("timeout = 1");
    expect(check.nextStep).toContain("without --check");
    expect(check.nextStep).not.toContain("--uninstall");
    expect(await readFile(configPath, "utf8")).toBe(short);

    const repair = await runSetup([], makeContext(env));
    expect(repair.blockWritten).toBe(true);
    expect(repair.warnings.join("\n")).toContain("timeout = 1");
    expect(await readFile(configPath, "utf8")).toBe(healthy);
    expect((await runSetup(["--check"], makeContext(env))).probe).toBe("ok");
  });

  test("a marker-less table with a short timeout fails --check and install re-adorns it at the installed timeout", async () => {
    const { env, configPath, healthy } = await installed("timeout-short-bare");
    const bare = healthy
      .split("\n")
      .filter((line) => !line.startsWith("#"))
      .join("\n")
      .replace(/^timeout = 15$/m, "timeout = 1");
    await writeFile(configPath, bare, "utf8");

    const check = await runSetup(["--check"], makeContext(env));
    expect(check.probe).toBe("failed");
    expect(check.probeError).toContain("timeout = 1");
    expect(await readFile(configPath, "utf8")).toBe(bare);

    const repair = await runSetup([], makeContext(env));
    expect(repair.blockWritten).toBe(true);
    expect(repair.warnings.join("\n")).not.toContain("never interrupted");
    expect(repair.warnings.join("\n")).toContain("timeout = 1");
    const after = await readFile(configPath, "utf8");
    expect(after.startsWith(userPrefix)).toBe(true);
    expect(after).not.toMatch(/^timeout = 1$/m);
    expect((await runSetup(["--check"], makeContext(env))).probe).toBe("ok");
  });

  test("install refuses, unchanged, when a short same-command entry it cannot prune would run first", async () => {
    const { env, configPath, healthy, command } = await installed("timeout-short-shadow");
    const shadow = [
      "[[hooks]]",
      'event = "PreToolUse"',
      `command = ${JSON.stringify(command)}`,
      'matcher = "Bash"',
      "timeout = 1",
      "",
    ].join("\n");
    expect(healthy.startsWith(userPrefix)).toBe(true);
    const shadowed = userPrefix + shadow + healthy.slice(userPrefix.length);
    await writeFile(configPath, shadowed, "utf8");

    expect((await runSetup(["--check"], makeContext(env))).probe).toBe("failed");
    await expect(runSetup([], makeContext(env))).rejects.toMatchObject({ code: "SETUP_INVALID_HOOKS_CONFIG" });
    expect(await readFile(configPath, "utf8")).toBe(shadowed);
  });

  test("a short timeout after the END marker fails --check and install refuses it unchanged", async () => {
    const { env, configPath, healthy } = await installed("timeout-short-after-end");
    const trailing = healthy
      .replace(/^timeout = 15\n/m, "")
      .replace(/^(# === END [^\n]*\n)/m, "$1timeout = 1\n");
    expect(trailing).not.toBe(healthy);
    await writeFile(configPath, trailing, "utf8");

    const check = await runSetup(["--check"], makeContext(env));
    expect(check.probe).toBe("failed");
    expect(check.probeError).toContain("timeout = 1");
    await expect(runSetup([], makeContext(env))).rejects.toMatchObject({ code: "SETUP_INVALID_HOOKS_CONFIG" });
    expect(await readFile(configPath, "utf8")).toBe(trailing);
  });
});
