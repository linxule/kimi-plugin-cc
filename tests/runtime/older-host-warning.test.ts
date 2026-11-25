import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runSetup } from "../../runtime/commands/setup.js";
import { buildHookShellCommand } from "../../runtime/hooks/install-paths.js";
import {
  hookPluginVersion,
  olderHostHookWarnings,
  pluginVersionIsOlder,
  verifyHookInstalled,
} from "../../runtime/hooks/install.js";
import type { CommandContext } from "../../runtime/types.js";
import { KIMI_PLUGIN_CC_VERSION } from "../../runtime/version.js";

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "kimi-plugin-cc-older-host-"));
});

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

const DENY_HOOK_SOURCE = `process.stderr.write('deny\\n'); process.exit(2);\n`;

type Layout = "claude" | "codex" | "none" | "foreign";

/** A hook script under an install tree shaped like the given host's cache. */
async function installTree(caseDir: string, segment: ".claude" | ".codex", layout: Layout, version: string): Promise<string> {
  const root = path.join(caseDir, segment, "plugins", "cache", "kimi-marketplace", "kimi", version);
  const script = path.join(root, "dist", "hooks", "approval-hook.js");
  await mkdir(path.dirname(script), { recursive: true });
  await writeFile(script, DENY_HOOK_SOURCE, "utf8");
  await writeFile(path.join(root, "dist", "package.json"), `{"type":"module"}`, "utf8");
  if (layout === "claude") {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "kimi-plugin-cc", version }), "utf8");
  } else if (layout === "codex") {
    await mkdir(path.join(root, ".codex-plugin"), { recursive: true });
    await writeFile(path.join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "kimi", version }), "utf8");
  } else if (layout === "foreign") {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "someone-else", version }), "utf8");
  }
  return script;
}

function context(env: NodeJS.ProcessEnv): CommandContext {
  return { cwd: process.cwd(), env, stdout: process.stdout, stderr: process.stderr };
}

async function makeCase(name: string): Promise<{ dir: string; env: NodeJS.ProcessEnv }> {
  const dir = path.join(scratch, name);
  await mkdir(path.join(dir, "home"), { recursive: true });
  return {
    dir,
    env: {
      ...process.env,
      KIMI_CODE_HOME: path.join(dir, "home"),
      CLAUDE_PLUGIN_DATA: path.join(dir, "data"),
      KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: "1",
    },
  };
}

function expectedWarning(host: string, version: string | undefined): string {
  return `The ${host} host's kimi-plugin-cc hook (${version === undefined ? "an unknown version" : `version ${version}`}) ` +
    "also checks this job with its older rules; it can deny what this version allows. " +
    `Update the plugin in ${host} and run its setup.`;
}

describe("pluginVersionIsOlder", () => {
  test.each([["3.1.9", true], ["2.7.3", true], ["3.2.0-rc.1", true], ["3.3.0-rc.1", true], ["garbage", true],
    ["3.2.0", false], ["3.2.1", false], ["4.0.0", false], ["3.2.0+build.1", false]])(
    "%s against 3.2.0 → %p",
    (version, older) => {
      expect(pluginVersionIsOlder(version, "3.2.0")).toBe(older);
    },
  );

  test("compares against this plugin's version by default", () => {
    expect(pluginVersionIsOlder(KIMI_PLUGIN_CC_VERSION)).toBe(false);
    expect(pluginVersionIsOlder("2.7.3")).toBe(true);
  });
});

describe("hookPluginVersion", () => {
  test("reads a Claude install's package.json past dist's nameless marker", async () => {
    const script = await installTree(path.join(scratch, "v-claude"), ".claude", "claude", "2.6.2");
    expect(await hookPluginVersion(buildHookShellCommand(script, { KIMI_PLUGIN_CC_NODE_BIN: "/usr/bin/node" }))).toBe("2.6.2");
  });

  test("falls back to a Codex install's .codex-plugin/plugin.json", async () => {
    const script = await installTree(path.join(scratch, "v-codex"), ".codex", "codex", "3.1.0");
    expect(await hookPluginVersion(buildHookShellCommand(script, { KIMI_PLUGIN_CC_NODE_BIN: "/usr/bin/node" }))).toBe("3.1.0");
  });

  test("a foreign package name or no manifest is unknown", async () => {
    const foreign = await installTree(path.join(scratch, "v-foreign"), ".codex", "foreign", "3.1.0");
    expect(await hookPluginVersion(buildHookShellCommand(foreign, { KIMI_PLUGIN_CC_NODE_BIN: "/usr/bin/node" }))).toBeUndefined();
    const none = await installTree(path.join(scratch, "v-none"), ".codex", "none", "3.1.0");
    expect(await hookPluginVersion(buildHookShellCommand(none, { KIMI_PLUGIN_CC_NODE_BIN: "/usr/bin/node" }))).toBeUndefined();
    expect(await hookPluginVersion("node approval-hook.js")).toBeUndefined();
  });
});

describe("older host hook warning", () => {
  async function twoHosts(name: string, codexLayout: Layout, codexVersion: string) {
    const { dir, env } = await makeCase(name);
    const claudeScript = await installTree(dir, ".claude", "claude", KIMI_PLUGIN_CC_VERSION);
    const codexScript = await installTree(dir, ".codex", codexLayout, codexVersion);
    const claudeEnv = { ...env, KIMI_PLUGIN_CC_HOOK_SCRIPT: claudeScript };
    const codexEnv = { ...env, KIMI_PLUGIN_CC_HOOK_SCRIPT: codexScript };
    expect((await runSetup([], context(codexEnv))).probe).toBe("ok");
    const install = await runSetup([], context(claudeEnv));
    expect(install.probe).toBe("ok");
    return { claudeEnv, codexEnv, install, configPath: path.join(dir, "home", "config.toml") };
  }

  test("an older other host warns at job time and in setup install and check", async () => {
    const { claudeEnv, install } = await twoHosts("older", "codex", "2.7.3");
    const warning = expectedWarning("codex", "2.7.3");
    const status = await verifyHookInstalled(claudeEnv);
    expect(status.installed).toBe(true);
    expect(status.warnings).toEqual([warning]);
    expect(install.warnings).toContain(warning);
    const otherHostsNote = install.warnings.findIndex((w) => w.startsWith("Other host(s) also manage a block"));
    expect(install.warnings[otherHostsNote + 1]).toBe(warning);
    const check = await runSetup(["--check"], context(claudeEnv));
    expect(check.warnings).toContain(warning);
  });

  test("a same or newer other host does not warn", async () => {
    for (const version of [KIMI_PLUGIN_CC_VERSION, "99.0.0"]) {
      const { claudeEnv } = await twoHosts(`newer-${version}`, "codex", version);
      const status = await verifyHookInstalled(claudeEnv);
      expect(status).toEqual({ installed: true, configPath: status.configPath });
    }
  });

  test("an unreadable version warns as unknown", async () => {
    const { claudeEnv } = await twoHosts("unknown", "none", "3.2.1");
    expect((await verifyHookInstalled(claudeEnv)).warnings).toEqual([expectedWarning("codex", undefined)]);
  });

  test("its own host never warns, even from an older version", async () => {
    const { codexEnv } = await twoHosts("own", "codex", "2.7.3");
    // codex is 2.7.3 but it is the verifying host; the other (claude) host is current.
    const status = await verifyHookInstalled(codexEnv);
    expect(status).toEqual({ installed: true, configPath: status.configPath });
  });

  test("a marker-less other-host table left by a config rewrite still warns", async () => {
    const { claudeEnv, configPath } = await twoHosts("bare", "codex", "2.7.3");
    const contents = await readFile(configPath, "utf8");
    const stripped = contents.split("\n").filter((line) => !line.includes("kimi-plugin-cc-managed:codex")).join("\n");
    const claudeCommand = buildHookShellCommand(claudeEnv.KIMI_PLUGIN_CC_HOOK_SCRIPT!, claudeEnv);
    expect(await olderHostHookWarnings(stripped, "claude-code", claudeCommand)).toEqual([expectedWarning("codex", "2.7.3")]);
  });
});
