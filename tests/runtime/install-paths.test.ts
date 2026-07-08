import { describe, expect, test } from "bun:test";

import {
  buildHookShellCommand,
  describeHookCommandDrift,
  hostIdFromHookScript,
  isOurApprovalHookCommand,
  parseHookShellCommand,
  resolveHostId,
  slugifyHostId,
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

// v1.7.0 host scoping — Claude Code and Codex share one config.toml.

describe("resolveHostId / hostIdFromHookScript", () => {
  test("derives claude-code from a ~/.claude install path", () => {
    expect(
      hostIdFromHookScript(
        "/Users/x/.claude/plugins/cache/kimi-marketplace/kimi/1.6.5/dist/hooks/approval-hook.js",
      ),
    ).toBe("claude-code");
  });

  test("derives codex from a ~/.codex install path", () => {
    expect(
      hostIdFromHookScript(
        "/Users/x/.codex/plugins/cache/kimi-marketplace/kimi/1.6.5/dist/hooks/approval-hook.js",
      ),
    ).toBe("codex");
  });

  test("host id is version-independent (upgrade refreshes the same block)", () => {
    const v1 = hostIdFromHookScript(
      "/Users/x/.claude/plugins/cache/kimi-marketplace/kimi/1.6.5/dist/hooks/approval-hook.js",
    );
    const v2 = hostIdFromHookScript(
      "/Users/x/.claude/plugins/cache/kimi-marketplace/kimi/9.9.9/dist/hooks/approval-hook.js",
    );
    expect(v1).toBe(v2);
    expect(v1).toBe("claude-code");
  });

  test("dev checkouts fall back to a stable host-<hash>", () => {
    const a = hostIdFromHookScript("/repo/kimi-plugin-cc/dist/hooks/approval-hook.js");
    const b = hostIdFromHookScript("/repo/kimi-plugin-cc/dist/hooks/approval-hook.js");
    expect(a).toBe(b);
    expect(a).toMatch(/^host-[0-9a-f]{8}$/);
  });

  test("KIMI_PLUGIN_CC_HOST_ID override wins and is slugified", () => {
    expect(
      resolveHostId({
        KIMI_PLUGIN_CC_HOST_ID: "My Host!",
        KIMI_PLUGIN_CC_HOOK_SCRIPT: "/a/dist/hooks/approval-hook.js",
      }),
    ).toBe("my-host");
  });

  test("resolveHostId derives from the passed hook script path", () => {
    expect(
      resolveHostId(
        {},
        "/Users/x/.codex/plugins/cache/kimi-marketplace/kimi/2.0.0/dist/hooks/approval-hook.js",
      ),
    ).toBe("codex");
  });

  test("slugifyHostId collapses junk and never returns empty", () => {
    expect(slugifyHostId("  Claude Code  ")).toBe("claude-code");
    expect(slugifyHostId("!!!")).toBe("host");
  });
});

describe("isOurApprovalHookCommand", () => {
  test("true for a canonical approval-hook command under a kimi-marketplace tree", () => {
    expect(
      isOurApprovalHookCommand(
        "'/usr/bin/node' '/home/u/.claude/plugins/cache/kimi-marketplace/kimi/1.5.0/dist/hooks/approval-hook.js'",
      ),
    ).toBe(true);
  });

  test("false for a non-canonical (bare node) command — never prunes a hand-rolled hook", () => {
    expect(isOurApprovalHookCommand("node /home/u/dist/hooks/approval-hook.js")).toBe(false);
  });

  test("false for a canonical command that is not our approval-hook", () => {
    expect(isOurApprovalHookCommand("'/usr/bin/node' '/home/u/other/hook.js'")).toBe(false);
  });

  test("false for a look-alike substring path (segment match required, not substring)", () => {
    // A user's own hook that merely CONTAINS the substring must not be pruned.
    expect(
      isOurApprovalHookCommand(
        "'/usr/bin/node' '/opt/acme/kimi-plugin-cc-wrapper/approval-hook.js'",
      ),
    ).toBe(false);
  });
});
