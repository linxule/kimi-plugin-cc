import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolvePluginPaths } from "../../runtime/paths.js";
import { resolvePluginDataRoot } from "../../runtime/plugin-data.js";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kimi-data-resolution-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("canonical plugin data root", () => {
  test("KIMI_PLUGIN_CC_DATA override wins over XDG, HOME, legacy vars, and test fail-closed flag", () => {
    const chosen = path.join(root, "chosen");
    const unnormalized = path.join(root, "sub", "..", "chosen");
    expect(
      resolvePluginDataRoot({
        KIMI_PLUGIN_CC_DATA: unnormalized,
        KIMI_PLUGIN_CC_TEST_NO_DEFAULT_DATA: "1",
        XDG_DATA_HOME: path.join(root, "xdg"),
        LOCALAPPDATA: path.join(root, "localappdata"),
        HOME: path.join(root, "home"),
        CLAUDE_PLUGIN_DATA: path.join(root, "claude-legacy"),
        PLUGIN_DATA: path.join(root, "codex-legacy"),
      }),
    ).toBe(path.normalize(chosen));
  });

  test("invalid explicit KIMI_PLUGIN_CC_DATA fails closed instead of falling back", () => {
    for (const value of ["", "relative/path", "./data"]) {
      expect(() =>
        resolvePluginDataRoot({
          KIMI_PLUGIN_CC_DATA: value,
          XDG_DATA_HOME: path.join(root, "xdg"),
          HOME: path.join(root, "home"),
        }),
      ).toThrow(/absolute directory/);
      try {
        resolvePluginDataRoot({ KIMI_PLUGIN_CC_DATA: value });
      } catch (err) {
        expect(err).toMatchObject({ code: "INVALID_PLUGIN_DATA", stage: "paths" });
      }
    }
  });

  test("KIMI_PLUGIN_CC_TEST_NO_DEFAULT_DATA=1 fails closed with MISSING_PLUGIN_DATA", () => {
    for (const env of [
      { KIMI_PLUGIN_CC_TEST_NO_DEFAULT_DATA: "1" },
      {
        KIMI_PLUGIN_CC_TEST_NO_DEFAULT_DATA: "1",
        XDG_DATA_HOME: path.join(root, "xdg"),
        HOME: path.join(root, "home"),
        CLAUDE_PLUGIN_DATA: path.join(root, "claude"),
        PLUGIN_DATA: path.join(root, "codex"),
      },
    ]) {
      expect(() => resolvePluginDataRoot(env)).toThrow("Set KIMI_PLUGIN_CC_DATA");
      try {
        resolvePluginDataRoot(env);
      } catch (err) {
        expect(err).toMatchObject({ code: "MISSING_PLUGIN_DATA", stage: "paths" });
      }
    }
  });

  test("ignores legacy CLAUDE_PLUGIN_DATA, PLUGIN_DATA, PLUGIN_ROOT, and CODEX_HOME", () => {
    const xdg = path.join(root, "xdg-canonical");
    const home = path.join(root, "home-canonical");
    const env: NodeJS.ProcessEnv = {
      CLAUDE_PLUGIN_DATA: path.join(root, "foreign-claude"),
      PLUGIN_DATA: path.join(root, "foreign-codex"),
      CLAUDE_PLUGIN_ROOT: "/fake/claude-root",
      PLUGIN_ROOT: "/fake/codex-root",
      CODEX_HOME: path.join(root, "codex-home"),
      KIMI_PLUGIN_CC_SHELL_LAUNCH: "1",
      HOME: home,
    };
    if (process.platform === "win32") {
      expect(resolvePluginDataRoot({ ...env, LOCALAPPDATA: xdg })).toBe(path.normalize(xdg));
      expect(resolvePluginDataRoot(env)).toBe(path.join(home, "AppData", "Local"));
    } else {
      expect(resolvePluginDataRoot({ ...env, XDG_DATA_HOME: xdg })).toBe(path.normalize(xdg));
      expect(resolvePluginDataRoot(env)).toBe(path.join(home, ".local", "share"));
    }
  });

  test.skipIf(process.platform === "win32")("POSIX default uses XDG_DATA_HOME, then HOME/.local/share", () => {
    const xdg = path.join(root, "xdg-share");
    const home = path.join(root, "user-home");
    expect(resolvePluginDataRoot({ XDG_DATA_HOME: xdg, HOME: home })).toBe(path.normalize(xdg));
    expect(resolvePluginDataRoot({ XDG_DATA_HOME: "   ", HOME: home })).toBe(
      path.join(home, ".local", "share"),
    );
    expect(resolvePluginDataRoot({ HOME: home })).toBe(path.join(home, ".local", "share"));
    expect(resolvePluginDataRoot({ USERPROFILE: home })).toBe(path.join(home, ".local", "share"));

    // Per XDG Base Directory spec, relative XDG_DATA_HOME is ignored in favor of ~/.local/share.
    expect(resolvePluginDataRoot({ XDG_DATA_HOME: "relative/xdg", HOME: home })).toBe(
      path.join(home, ".local", "share"),
    );
    expect(() => resolvePluginDataRoot({ HOME: "relative/home" })).toThrow(/absolute directory/);
  });

  test("resolvePluginPaths derives canonical shared paths including hook/approval-hook.js", () => {
    const data = path.join(root, "paths-root");
    const paths = resolvePluginPaths({ KIMI_PLUGIN_CC_DATA: data });
    const pluginRoot = path.join(data, "kimi-plugin-cc");
    expect(paths).toEqual({
      dataRoot: data,
      claudePluginData: data,
      pluginRoot,
      stateDbPath: path.join(pluginRoot, "state.db"),
      logsDir: path.join(pluginRoot, "logs"),
      artifactsDir: path.join(pluginRoot, "artifacts"),
      hookDir: path.join(pluginRoot, "hook"),
      hookScriptPath: path.join(pluginRoot, "hook", "approval-hook.js"),
      worktreesDir: path.join(pluginRoot, "worktrees"),
      configPath: path.join(pluginRoot, "config.json"),
    });
  });
});
