import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildHookShellCommand,
  classifyHookCommandDrift,
  describeHookCommandDrift,
  hostIdFromHookScript,
  isOurApprovalHookCommand,
  parseHookShellCommand,
  resolveNodeBinary,
  shellSingleQuote,
  preferStableNodePath,
  resolveHostId,
  slugifyHostId,
  tryBuildExpectedHookCommand,
} from "../../runtime/hooks/install-paths.js";

/**
 * Spawn `tests/helpers/print-node-pin.mjs` with the given node binary and read
 * back how that REAL child resolves its own node-pin token. Rejects on a
 * non-zero exit or unparseable stdout so a broken probe fails the test loudly
 * instead of silently asserting nothing.
 */
async function runNodePinProbe(
  nodeBinary: string,
): Promise<{ argv0: string; execPath: string; canonical: string }> {
  const helper = path.join(process.cwd(), "tests/helpers/print-node-pin.mjs");
  return await new Promise((resolve, reject) => {
    const child = spawn(nodeBinary, [helper], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`node-pin probe exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`node-pin probe emitted unparseable stdout ${JSON.stringify(stdout)}: ${String(err)}`));
      }
    });
  });
}

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

  test("same interpreter, different spelling → the v1.9.0 re-pin, NOT a version-manager switch", () => {
    // Every pre-1.9.0 install hits this exactly once on upgrade: the pin moved
    // off the symlink-resolved Cellar path onto the stable one. Both paths name
    // the same binary, so telling the user their Node "moved" would be wrong.
    const installed = buildHookShellCommand("/new/dist/hooks/approval-hook.js", {
      KIMI_PLUGIN_CC_NODE_BIN: "/opt/homebrew/Cellar/node/26.5.0/bin/node",
    });
    const stable = buildHookShellCommand("/new/dist/hooks/approval-hook.js", {
      KIMI_PLUGIN_CC_NODE_BIN: "/opt/homebrew/bin/node",
    });
    const reason = describeHookCommandDrift(
      installed,
      stable,
      () => true,
      () => true, // both paths resolve to the same file
    );
    expect(reason).toContain("Node path spelling changed");
    expect(reason).toContain("SAME interpreter");
    expect(reason).toContain("your Node did not move");
    expect(reason).not.toContain("version-manager switch");
    expect(reason).toContain("Run /kimi:setup");
  });

  test("a genuinely different interpreter is still reported as a real change", () => {
    const installed = buildHookShellCommand("/new/dist/hooks/approval-hook.js", {
      KIMI_PLUGIN_CC_NODE_BIN: "/opt/node-26.0/bin/node",
    });
    const reason = describeHookCommandDrift(
      installed,
      expected,
      () => true,
      () => false, // distinct files
    );
    expect(reason).toContain("Node binary changed");
    expect(reason).toContain("version-manager switch");
    expect(reason).not.toContain("SAME interpreter");
  });

  test("a gone interpreter still wins over the same-file wording", () => {
    // Order matters: "no longer exists" is the unambiguous danger signal and
    // must not be softened into a benign re-pin message.
    const installed = buildHookShellCommand("/new/dist/hooks/approval-hook.js", {
      KIMI_PLUGIN_CC_NODE_BIN: "/opt/node-26.0/bin/node",
    });
    const reason = describeHookCommandDrift(
      installed,
      expected,
      () => false,
      () => true,
    );
    expect(reason).toContain("Node binary drift");
    expect(reason).toContain("no longer exists");
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

  test("dev checkouts fall back to a stable 64-bit host-<hash>", () => {
    const a = hostIdFromHookScript("/repo/kimi-plugin-cc/dist/hooks/approval-hook.js");
    const b = hostIdFromHookScript("/repo/kimi-plugin-cc/dist/hooks/approval-hook.js");
    expect(a).toBe(b);
    // 16 hex chars (64 bits) — an 8-char prefix collided in review.
    expect(a).toMatch(/^host-[0-9a-f]{16}$/);
    // Distinct roots derive distinct ids.
    expect(hostIdFromHookScript("/other/root/dist/hooks/approval-hook.js")).not.toBe(a);
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

  test("true for the standalone DSH package hook path", () => {
    expect(
      isOurApprovalHookCommand(
        "'/usr/bin/node' '/home/u/.dsh/profiles/web/node_modules/dsh-kimi-plugin-cc/dist/hooks/approval-hook.js'",
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

// Stable node-path selection. `process.execPath` resolves symlinks, so under
// Homebrew it carries the node version and churns on every `brew upgrade`,
// invalidating the byte-exact managed block for every host at once.
describe("preferStableNodePath", () => {
  const CELLAR = "/opt/homebrew/Cellar/node/26.5.0/bin/node";
  const STABLE = "/opt/homebrew/bin/node";
  // Both names resolve to the same inode; anything else is its own identity.
  const realpath = (p: string): string => (p === STABLE ? CELLAR : p);

  test("prefers the stable symlink when it resolves to the same binary", () => {
    expect(preferStableNodePath(CELLAR, STABLE, realpath)).toBe(STABLE);
  });

  test("the chosen path still resolves to the running interpreter", () => {
    // The load-bearing invariant: substitution never changes WHICH binary runs.
    const chosen = preferStableNodePath(CELLAR, STABLE, realpath);
    expect(realpath(chosen)).toBe(realpath(CELLAR));
  });

  test("falls back when argv0 is a bare relative name (direct `node file.js`)", () => {
    expect(preferStableNodePath(CELLAR, "node", realpath)).toBe(CELLAR);
  });

  test("falls back when argv0 is undefined or empty", () => {
    expect(preferStableNodePath(CELLAR, undefined, realpath)).toBe(CELLAR);
    expect(preferStableNodePath(CELLAR, "", realpath)).toBe(CELLAR);
  });

  test("falls back when argv0 is a DIFFERENT binary (never widens selection)", () => {
    // An absolute argv0 that resolves elsewhere must be rejected outright —
    // otherwise the hook could be pinned to an interpreter we never probed.
    expect(preferStableNodePath(CELLAR, "/usr/local/bin/node", realpath)).toBe(CELLAR);
  });

  test("falls back when realpath throws (deleted or unreadable argv0)", () => {
    const throwing = (): string => {
      throw new Error("ENOENT");
    };
    expect(preferStableNodePath(CELLAR, STABLE, throwing)).toBe(CELLAR);
  });

  test("returns execPath unchanged when argv0 already equals it (nvm/asdf shape)", () => {
    const nvm = "/home/u/.nvm/versions/node/v22.5.0/bin/node";
    expect(preferStableNodePath(nvm, nvm, (p) => p)).toBe(nvm);
  });

  // REGRESSION (Kimi pre-release review, v1.9.0). The hook verifier rebuilds the
  // canonical command from ITS OWN process.argv0, so a background worker must be
  // spawned with the same spelling of node that setup pinned. `spawn(process.execPath)`
  // gives the child argv0 === the fully symlink-resolved (version-stamped) path,
  // while setup — running via companion.sh, which execs `$(command -v node)` —
  // pins the stable symlink. The two never converge, so every background
  // rescue/ask would refuse forever and `/kimi:setup` could not fix it.
  test("a worker spawned with resolveNodeBinary agrees with what setup pins", () => {
    const setupSide = resolveNodeBinary({});
    // A child spawned with `setupSide` reports it verbatim as its own argv0
    // (spawn does not resolve symlinks in argv0), so the worker recomputes the
    // identical canonical token.
    const workerSide = preferStableNodePath(process.execPath, setupSide);
    expect(workerSide).toBe(setupSide);
    expect(buildHookShellCommand("/x/dist/hooks/approval-hook.js", {})).toBe(
      `${shellSingleQuote(workerSide)} '/x/dist/hooks/approval-hook.js'`,
    );
  });

  test("spawning with the raw execPath would NOT agree (the bug this guards)", () => {
    // Documents the actual defect: on Homebrew, execPath is the Cellar path and
    // resolveNodeBinary picks the stable symlink, so they differ. On a layout
    // where they coincide (nvm/asdf), this is vacuously equal — assert only the
    // property that matters, that the fix uses the SAME source as the verifier.
    const stable = resolveNodeBinary({});
    const workerWithExecPath = preferStableNodePath(process.execPath, process.execPath);
    expect(workerWithExecPath).toBe(process.execPath);
    if (stable !== process.execPath) {
      expect(workerWithExecPath).not.toBe(stable);
    }
  });

  // The two tests above are in-process: they FEED `setupSide` in as the child's
  // argv0 rather than observing a real one, so they assume the very OS premise
  // the v1.9.0 fix rests on — that spawn() reports argv[0] verbatim and does not
  // resolve symlinks. Flagged in the v1.9.0 post-release review as a proxy.
  // This test proves it against a real child process and the COMPILED dist/
  // artifact a background worker actually loads.
  test("a REAL child spawned through a node symlink pins that symlink, not the realpath", async () => {
    const linkDir = await mkdtemp(path.join(tmpdir(), "kimi-node-pin-"));
    try {
      const stableLink = path.join(linkDir, "node-stable");
      const realNode = realpathSync(process.execPath);
      await symlink(realNode, stableLink);

      const probe = await runNodePinProbe(stableLink);

      // The premise, measured rather than assumed.
      expect(probe.argv0).toBe(stableLink);

      // And the consequence that matters: the child's canonical command names
      // the symlink it was invoked through — the same spelling companion.sh
      // pins at setup time — NOT the version-stamped realpath.
      expect(probe.canonical).toBe(
        `${shellSingleQuote(stableLink)} '/x/dist/hooks/approval-hook.js'`,
      );

      // Guard the regression directly: had background-spawn kept
      // `spawn(process.execPath)`, the child's argv0 would have been the
      // realpath and the command would have disagreed with the pin. Skip the
      // assertion on layouts where the two coincide (nvm/asdf), where there is
      // no divergence to detect.
      if (realNode !== stableLink) {
        expect(probe.canonical).not.toContain(realNode);
      }
    } finally {
      await rm(linkDir, { recursive: true, force: true });
    }
  }, 20_000);

  // `tryBuildExpectedHookCommand` had NO test coverage before v1.9.1 despite
  // being the single source of both the byte-exact comparand and (now) the
  // interpreter path the verifier probes. These pin the invariant the X_OK
  // check rests on.
  test("tryBuildExpectedHookCommand's nodeBin is the exact token inside its own command", () => {
    for (const env of [
      {},
      { KIMI_PLUGIN_CC_NODE_BIN: "/opt/homebrew/bin/node" },
      // A path needing shell quoting — proves nodeBin is the DECODED token, not
      // the quoted form, and that quoting round-trips.
      { KIMI_PLUGIN_CC_NODE_BIN: "/weird path/it's/node" },
    ]) {
      const built = tryBuildExpectedHookCommand({
        ...env,
        KIMI_PLUGIN_CC_HOOK_SCRIPT: "/x/dist/hooks/approval-hook.js",
      });
      expect("error" in built).toBe(false);
      if ("error" in built) continue;

      // The load-bearing identity: probing `nodeBin` must be probing the very
      // binary named in `command`. Deriving nodeBin by re-calling
      // resolveNodeBinary would break this whenever the filesystem changed
      // between the two calls (preferStableNodePath does realpath I/O), letting
      // the verifier bless a command whose real interpreter it never checked.
      const parsed = parseHookShellCommand(built.command);
      expect(parsed).not.toBeNull();
      expect(parsed!.nodeBin).toBe(built.nodeBin);
      expect(parsed!.hookScript).toBe(built.hookScriptPath);
      expect(built.command).toBe(
        `${shellSingleQuote(built.nodeBin)} ${shellSingleQuote(built.hookScriptPath)}`,
      );
    }
  });

  test("tryBuildExpectedHookCommand surfaces a structured error for a relative node override", () => {
    const built = tryBuildExpectedHookCommand({
      KIMI_PLUGIN_CC_NODE_BIN: "node",
      KIMI_PLUGIN_CC_HOOK_SCRIPT: "/x/dist/hooks/approval-hook.js",
    });
    expect("error" in built).toBe(true);
    if ("error" in built) {
      expect(built.error.code).toBe("SETUP_NODE_BIN_NOT_ABSOLUTE");
    }
  });

  test("same-file node spelling change is flagged as an unchanged interpreter", () => {
    const a = buildHookShellCommand("/same/hook.js", {
      KIMI_PLUGIN_CC_NODE_BIN: "/opt/homebrew/Cellar/node/26.5.0/bin/node",
    });
    const b = buildHookShellCommand("/same/hook.js", {
      KIMI_PLUGIN_CC_NODE_BIN: "/opt/homebrew/bin/node",
    });
    expect(classifyHookCommandDrift(a, b, () => true)).toMatchObject({
      axis: "node-bin",
      nodeInterpreterUnchanged: true,
    });
    expect(classifyHookCommandDrift(a, b, () => false)).toMatchObject({
      axis: "node-bin",
      nodeInterpreterUnchanged: false,
    });
  });

  test("a pure hook-script move carries no interpreter verdict", () => {
    const a = buildHookShellCommand("/old/hook.js", { KIMI_PLUGIN_CC_NODE_BIN: "/n/node" });
    const b = buildHookShellCommand("/new/hook.js", { KIMI_PLUGIN_CC_NODE_BIN: "/n/node" });
    const drift = classifyHookCommandDrift(a, b, () => true);
    expect(drift?.axis).toBe("hook-script");
    expect(drift).not.toHaveProperty("nodeInterpreterUnchanged");
  });

  test("the real process satisfies the invariant with live realpath", () => {
    const chosen = preferStableNodePath(process.execPath);
    expect(path.isAbsolute(chosen)).toBe(true);
    expect(realpathSync(chosen)).toBe(realpathSync(process.execPath));
  });
});
