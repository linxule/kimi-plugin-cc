import { describe, expect, test } from "bun:test";

import {
  buildHookShellCommand,
  describeHookCommandDrift,
  parseHookShellCommand,
} from "../../runtime/hooks/install-paths.js";

// H4 — hook-command drift parsing + classification.

describe("parseHookShellCommand", () => {
  test("round-trips a simple two-token command", () => {
    const cmd = buildHookShellCommand("/usr/local/dist/hooks/approval-hook.js", {
      KIMI_PLUGIN_CC_NODE_BIN: "/opt/node/bin/node",
    });
    expect(parseHookShellCommand(cmd)).toEqual({
      nodeBin: "/opt/node/bin/node",
      hookScript: "/usr/local/dist/hooks/approval-hook.js",
    });
  });

  test("round-trips paths containing spaces (space lives inside the quotes)", () => {
    const node = "/Apps/My Node/bin/node";
    const hook = "/Apps/My Plugin/dist/hooks/approval-hook.js";
    const cmd = buildHookShellCommand(hook, { KIMI_PLUGIN_CC_NODE_BIN: node });
    expect(parseHookShellCommand(cmd)).toEqual({ nodeBin: node, hookScript: hook });
  });

  test("round-trips paths containing apostrophes ('\\'' encoding)", () => {
    const node = "/Users/o'brien/bin/node";
    const hook = "/Users/o'brien/dist/hooks/approval-hook.js";
    const cmd = buildHookShellCommand(hook, { KIMI_PLUGIN_CC_NODE_BIN: node });
    expect(parseHookShellCommand(cmd)).toEqual({ nodeBin: node, hookScript: hook });
  });

  test("returns null for a bare (unquoted) command", () => {
    expect(parseHookShellCommand("node /path/to/approval-hook.js")).toBeNull();
  });

  test("returns null for a substring-disguise command", () => {
    expect(parseHookShellCommand("true # /path/to/approval-hook.js")).toBeNull();
  });

  test("returns null for the wrong token count", () => {
    expect(parseHookShellCommand("'only-one-token'")).toBeNull();
    expect(parseHookShellCommand("'a' 'b' 'c'")).toBeNull();
  });

  test("returns null for an unterminated quote", () => {
    expect(parseHookShellCommand("'/node' '/unterminated")).toBeNull();
  });
});

describe("describeHookCommandDrift", () => {
  const expected = buildHookShellCommand("/new/dist/hooks/approval-hook.js", {
    KIMI_PLUGIN_CC_NODE_BIN: "/opt/node-26.3/bin/node",
  });

  test("Node binary drift when the old interpreter is gone (the live H4 case)", () => {
    const installed = buildHookShellCommand("/new/dist/hooks/approval-hook.js", {
      KIMI_PLUGIN_CC_NODE_BIN: "/opt/node-26.0/bin/node",
    });
    const reason = describeHookCommandDrift(installed, expected, () => false);
    expect(reason).toContain("Node binary drift");
    expect(reason).toContain("/opt/node-26.0/bin/node");
    expect(reason).toContain("no longer exists");
    expect(reason).toContain("version-manager");
    expect(reason).toContain("Run /kimi:setup");
  });

  test("Node binary changed when both interpreters still exist (version-manager switch)", () => {
    const installed = buildHookShellCommand("/new/dist/hooks/approval-hook.js", {
      KIMI_PLUGIN_CC_NODE_BIN: "/opt/node-26.0/bin/node",
    });
    const reason = describeHookCommandDrift(installed, expected, () => true);
    expect(reason).toContain("Node binary changed");
    expect(reason).not.toContain("no longer exists");
    expect(reason).toContain("Run /kimi:setup");
  });

  test("Hook script path drift when only the plugin path moved (same node)", () => {
    const installed = buildHookShellCommand("/old/dist/hooks/approval-hook.js", {
      KIMI_PLUGIN_CC_NODE_BIN: "/opt/node-26.3/bin/node",
    });
    const reason = describeHookCommandDrift(installed, expected, () => true);
    expect(reason).toContain("Hook script path drift");
    expect(reason).toContain("/old/dist/hooks/approval-hook.js");
    expect(reason).not.toContain("Node binary");
    expect(reason).toContain("Run /kimi:setup");
  });

  test("reports BOTH drifts when node and hook path changed", () => {
    const installed = buildHookShellCommand("/old/dist/hooks/approval-hook.js", {
      KIMI_PLUGIN_CC_NODE_BIN: "/opt/node-26.0/bin/node",
    });
    const reason = describeHookCommandDrift(installed, expected, () => false);
    expect(reason).toContain("Node binary drift");
    expect(reason).toContain("Hook script path drift");
  });

  test("returns undefined for an unparseable installed command (caller uses generic reason)", () => {
    expect(
      describeHookCommandDrift("true # /path/approval-hook.js", expected, () => false),
    ).toBeUndefined();
  });

  test("returns undefined when the commands are identical", () => {
    expect(describeHookCommandDrift(expected, expected, () => false)).toBeUndefined();
  });
});
