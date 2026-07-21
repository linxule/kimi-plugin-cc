// v1.8.2 adversarial suite — "marker-strip survival."
//
// Root cause under test (see .claude/v1.8.2-spec.md): kimi-code persists its
// config via a comment-dropping TOML stringifier (smol-toml has no comment
// support) on every login/settings write. This deletes our BEGIN/END markers
// while the `[[hooks]]` TABLE (data) survives and keeps enforcing. Pre-v1.8.2
// this made each host's `/kimi:setup` prune the OTHER host's live-but-unmarked
// hook (the "seesaw"). v1.8.2 adds (A) a content-based installed fallback
// (byte-exact command match on a bare table) and (B) host-scoped pruning.
//
// This suite exercises the REAL vendored `smol-toml` package (a devDependency,
// same 1.6.1 kimi-code vendors) to simulate the rewrite end to end, plus
// direct unit coverage of the new `evaluateInstalled`/`findUnmanagedApprovalHookBlocks`
// contracts.
//
// Host-id note: unlike the plain "setup host scoping" suite (which uses
// `KIMI_PLUGIN_CC_HOST_ID` overrides with a SHARED hook script path — fine
// there because ownership is read off the marker suffix), this suite gives
// each host a DISTINCT `KIMI_PLUGIN_CC_HOOK_SCRIPT` path containing a real
// `/.claude/` or `/.codex/` segment and does NOT set `KIMI_PLUGIN_CC_HOST_ID`.
// That's required for the bare-table (marker-stripped) scenarios: ownership
// during pruning is derived from `hostIdFromHookCommand`, which reads the
// COMMAND's script path — it never consults `KIMI_PLUGIN_CC_HOST_ID`. A
// mismatch between an overridden marker host id and a path-derived command
// host id would make the host-scoped prune silently fail to find its own
// bare table. Mirroring the real install topology
// (`~/.claude/plugins/cache/...` vs `~/.codex/plugins/cache/...`) keeps
// `resolveHostId` (marker side) and `hostIdFromHookCommand` (content side)
// self-consistent, exactly as production installs are.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse, stringify } from "smol-toml";

import { runSetup } from "../../runtime/commands/setup.js";
import { buildHookShellCommand } from "../../runtime/hooks/install-paths.js";
import {
  evaluateInstalled,
  findBareApprovalHookTables,
  findUnmanagedApprovalHookBlocks,
} from "../../runtime/hooks/managed-block.js";
import type { CommandContext } from "../../runtime/types.js";

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "kimi-plugin-cc-marker-strip-"));
});

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function makeCase(name: string): Promise<{ env: NodeJS.ProcessEnv; configPath: string }> {
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

/**
 * A hook script whose probe always denies (exit 2 + stderr reason) — mirrors
 * `dist/hooks/approval-hook.js`'s deny contract, which is all `setup`'s probe
 * requires to report `probe: "ok"`.
 */
const DENY_HOOK_SOURCE = `process.stderr.write('deny\\n'); process.exit(2);\n`;

/** Write a synthetic hook script under `<caseDir>/.<hostSegment>/.../approval-hook.js`. */
async function seedHostHookScript(caseDir: string, hostSegment: ".claude" | ".codex"): Promise<string> {
  const scriptPath = path.join(
    caseDir,
    hostSegment,
    "plugins",
    "cache",
    "kimi-marketplace",
    "kimi",
    "1.8.2",
    "dist",
    "hooks",
    "approval-hook.js",
  );
  await mkdir(path.dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, DENY_HOOK_SOURCE, "utf8");
  return scriptPath;
}

/** First line of `contents` containing `needle`, or throws if none does. */
function lineContaining(contents: string, needle: string): string {
  const line = contents.split("\n").find((l) => l.includes(needle));
  if (line === undefined) {
    throw new Error(`expected a line containing ${JSON.stringify(needle)}`);
  }
  return line;
}

describe("marker-strip survival: real smol-toml round-trip", () => {
  test("bare-table fallback keeps both hosts enforcing after a kimi-code config rewrite, and each host's setup re-adorns only its own table", async () => {
    const caseName = "round-trip";
    const { env, configPath } = await makeCase(caseName);
    const caseDir = path.join(scratch, caseName);
    const hookScriptClaude = await seedHostHookScript(caseDir, ".claude");
    const hookScriptCodex = await seedHostHookScript(caseDir, ".codex");

    const claudeEnv = { ...env, KIMI_PLUGIN_CC_HOOK_SCRIPT: hookScriptClaude };
    const codexEnv = { ...env, KIMI_PLUGIN_CC_HOOK_SCRIPT: hookScriptCodex };

    // Install both hosts' marked blocks.
    const claudeInstall = await runSetup([], makeContext(claudeEnv));
    expect(claudeInstall.probe).toBe("ok");
    const codexInstall = await runSetup([], makeContext(codexEnv));
    expect(codexInstall.probe).toBe("ok");

    const beforeRewrite = await readFile(configPath, "utf8");
    expect(beforeRewrite).toContain("BEGIN kimi-plugin-cc-managed:claude-code");
    expect(beforeRewrite).toContain("BEGIN kimi-plugin-cc-managed:codex");

    // --- Simulate kimi-code's config rewrite with the REAL vendored smol-toml. ---
    const rewritten = stringify(parse(beforeRewrite));
    await writeFile(configPath, rewritten, "utf8");

    // Sanity: markers gone, both [[hooks]] tables survived as data.
    expect(rewritten).not.toContain("kimi-plugin-cc-managed");
    expect(rewritten.match(/\[\[hooks\]\]/g)?.length).toBe(2);
    expect(rewritten).toContain(hookScriptClaude);
    expect(rewritten).toContain(hookScriptCodex);

    // --- Each host's --check still passes via the bare-table fallback. ---
    const claudeCheck = await runSetup(["--check"], makeContext(claudeEnv));
    // "exit-equivalent success": companion.ts only sets process.exitCode = 1
    // when action === "check" && probe === "failed" — probe "ok" is the
    // success signal.
    expect(claudeCheck.probe).toBe("ok");
    const claudeCheckWarnings = claudeCheck.warnings.join("\n");
    expect(claudeCheckWarnings).toMatch(/markers are missing/i);
    expect(claudeCheckWarnings).toMatch(/re-adorn/i);
    // The OTHER host's bare table is informational, not an own-stale warning.
    expect(claudeCheckWarnings).toMatch(/host "codex" has a marker-less/i);

    const codexCheck = await runSetup(["--check"], makeContext(codexEnv));
    expect(codexCheck.probe).toBe("ok");
    const codexCheckWarnings = codexCheck.warnings.join("\n");
    expect(codexCheckWarnings).toMatch(/markers are missing/i);
    expect(codexCheckWarnings).toMatch(/re-adorn/i);
    expect(codexCheckWarnings).toMatch(/host "claude-code" has a marker-less/i);

    // --- Installing host A re-adorns ONLY its own table. ---
    const codexExpectedCommand = buildHookShellCommand(hookScriptCodex, codexEnv);
    const codexLineBefore = lineContaining(rewritten, hookScriptCodex);
    expect(lineContaining(rewritten, hookScriptCodex)).toContain(codexExpectedCommand);

    const claudeReinstall = await runSetup([], makeContext(claudeEnv));
    expect(claudeReinstall.blockWritten).toBe(true);
    const claudeReinstallWarnings = claudeReinstall.warnings.join("\n");
    expect(claudeReinstallWarnings).toMatch(/re-adorn/i);
    expect(claudeReinstallWarnings).not.toMatch(/cruft/i);

    const afterClaudeReinstall = await readFile(configPath, "utf8");
    expect(afterClaudeReinstall).toContain("BEGIN kimi-plugin-cc-managed:claude-code");
    // Host B's bare table is untouched — byte-for-byte identical command line.
    expect(lineContaining(afterClaudeReinstall, hookScriptCodex)).toBe(codexLineBefore);
    // Host B still has no marker (not yet re-adorned).
    expect(afterClaudeReinstall).not.toContain("BEGIN kimi-plugin-cc-managed:codex");

    // --- Now host B re-adorns too; both end with marked blocks. ---
    const codexReinstall = await runSetup([], makeContext(codexEnv));
    expect(codexReinstall.blockWritten).toBe(true);
    expect(codexReinstall.warnings.join("\n")).toMatch(/re-adorn/i);

    const finalContents = await readFile(configPath, "utf8");
    expect(finalContents).toContain("BEGIN kimi-plugin-cc-managed:claude-code");
    expect(finalContents).toContain("BEGIN kimi-plugin-cc-managed:codex");

    expect((await runSetup(["--check"], makeContext(claudeEnv))).probe).toBe("ok");
    expect((await runSetup(["--check"], makeContext(codexEnv))).probe).toBe("ok");
  });

  test("a 0.28.1-style thinking-effort migration (strict parse + reserialize) leaves the markerless enforcing hook verifier-clean", async () => {
    // kimi-code 0.28.x ships a one-shot `thinking.effort = "max" -> "high"`
    // migration that strictly parses and reserializes config.toml via
    // configToTomlData/setHooks: validated hooks[] entries are preserved as
    // DATA but ALL comments — including our managed-block markers — are
    // dropped. This simulates that exact parse→mutate→stringify shape and
    // asserts the v1.8.2 markerless fallback keeps the host verifier-clean.
    const caseName = "thinking-effort-migration";
    const { env, configPath } = await makeCase(caseName);
    const caseDir = path.join(scratch, caseName);
    const hookScript = await seedHostHookScript(caseDir, ".claude");
    const hostEnv = { ...env, KIMI_PLUGIN_CC_HOOK_SCRIPT: hookScript };

    // Pre-seed the pre-migration upstream setting, then install our block.
    await writeFile(configPath, '[thinking]\neffort = "max"\n', "utf8");
    const install = await runSetup([], makeContext(hostEnv));
    expect(install.probe).toBe("ok");
    const beforeMigration = await readFile(configPath, "utf8");
    expect(beforeMigration).toContain("BEGIN kimi-plugin-cc-managed:claude-code");
    expect(beforeMigration).toContain('effort = "max"');

    // --- The 0.28.1-style migration: parse, flip the value, reserialize. ---
    const migrated = parse(beforeMigration);
    (migrated.thinking as Record<string, unknown>).effort = "high";
    const reserialized = stringify(migrated);
    await writeFile(configPath, reserialized, "utf8");

    // Sanity: value migrated, markers gone, hook table survived as data.
    expect(reserialized).toContain('effort = "high"');
    expect(reserialized).not.toContain("kimi-plugin-cc-managed");
    expect(reserialized).toContain(hookScript);
    expect(reserialized).toContain("[[hooks]]");

    // --- The host still verifies installed via the bare-table fallback. ---
    const check = await runSetup(["--check"], makeContext(hostEnv));
    expect(check.probe).toBe("ok");
    expect(check.warnings.join("\n")).toMatch(/markers are missing/i);
  });
});

describe("evaluateInstalled bare-table fallback strictness", () => {
  const hostId = "claude-code";
  const expectedCommand = buildHookShellCommand(
    path.join("/plugin-root", "dist", "hooks", "approval-hook.js"),
    process.env,
  );

  function bareTableToml(command: string, extraLines: string[] = []): string {
    return [
      "[[hooks]]",
      'event = "PreToolUse"',
      `command = "${command}"`,
      ...extraLines,
      "timeout = 15",
      "",
    ].join("\n");
  }

  test("bare table with a byte-exact command is installed via the fallback", () => {
    const contents = bareTableToml(expectedCommand);
    const result = evaluateInstalled(contents, expectedCommand, { hostId });
    expect(result.installed).toBe(true);
    expect(result.via).toBe("bare-table");
    expect(result.note).toBeDefined();
  });

  test("bare table with a DIFFERENT (e.g. old-version) command is not installed", () => {
    const oldCommand = buildHookShellCommand(
      path.join("/plugin-root", "OLD-1.0.0", "dist", "hooks", "approval-hook.js"),
      process.env,
    );
    expect(oldCommand).not.toBe(expectedCommand);
    const contents = bareTableToml(oldCommand);
    const result = evaluateInstalled(contents, expectedCommand, { hostId });
    expect(result.installed).toBe(false);
    expect(result.via).toBeUndefined();
  });

  test("bare table with the exact command but a `matcher` line is rejected (grammar reject)", () => {
    const contents = [
      "[[hooks]]",
      'matcher = ".*"',
      'event = "PreToolUse"',
      `command = "${expectedCommand}"`,
      "timeout = 15",
      "",
    ].join("\n");
    const result = evaluateInstalled(contents, expectedCommand, { hostId });
    expect(result.installed).toBe(false);
  });

  test("bare table with the exact command but an extra foreign key is rejected", () => {
    const contents = bareTableToml(expectedCommand, ['metadata = "x"']);
    const result = evaluateInstalled(contents, expectedCommand, { hostId });
    expect(result.installed).toBe(false);
  });

  test("a marked-but-INVALID block for this host + a bare exact table elsewhere: no fallback from an invalid state", () => {
    const invalidMarked = [
      `# === BEGIN kimi-plugin-cc-managed:${hostId} (v1.8.0) ===`,
      "[[hooks]]",
      'matcher = "Write"', // invalid: matcher present disables the hook
      'event = "PreToolUse"',
      `command = "${expectedCommand}"`,
      "timeout = 15",
      `# === END kimi-plugin-cc-managed:${hostId} ===`,
      "",
      bareTableToml(expectedCommand),
    ].join("\n");
    const result = evaluateInstalled(invalidMarked, expectedCommand, { hostId });
    expect(result.installed).toBe(false);
    expect(result.state.kind).toBe("found");
    if (result.state.kind === "found") {
      expect(result.state.valid).toBe(false);
    }
  });

  test("duplicate marked blocks for this host + a bare exact table elsewhere: no fallback from a duplicate state", () => {
    const markedBlock = (version: string) =>
      [
        `# === BEGIN kimi-plugin-cc-managed:${hostId} (v${version}) ===`,
        "[[hooks]]",
        'event = "PreToolUse"',
        `command = "${expectedCommand}"`,
        "timeout = 15",
        `# === END kimi-plugin-cc-managed:${hostId} ===`,
      ].join("\n");
    const contents = [markedBlock("1.0.0"), markedBlock("1.0.1"), bareTableToml(expectedCommand)].join(
      "\n\n",
    );
    const result = evaluateInstalled(contents, expectedCommand, { hostId });
    expect(result.installed).toBe(false);
    expect(result.state.kind).toBe("duplicate");
  });
});

describe("scoped uninstall on a stripped config never touches a hand-rolled hook", () => {
  test("host-scoped uninstall removes only that host's bare table; --all clears every plugin table but preserves a hand-rolled hook throughout", async () => {
    const caseName = "stripped-uninstall";
    const { env, configPath } = await makeCase(caseName);
    const caseDir = path.join(scratch, caseName);
    const hookScriptClaude = await seedHostHookScript(caseDir, ".claude");
    const hookScriptCodex = await seedHostHookScript(caseDir, ".codex");

    const claudeEnv = { ...env, KIMI_PLUGIN_CC_HOOK_SCRIPT: hookScriptClaude };
    const codexEnv = { ...env, KIMI_PLUGIN_CC_HOOK_SCRIPT: hookScriptCodex };

    const HAND_ROLLED_HOOK = "/opt/acme/my-own-hook.js";
    const handRolled = [
      "[[hooks]]",
      'event = "PreToolUse"',
      `command = "'/usr/bin/node' '${HAND_ROLLED_HOOK}'"`,
      "timeout = 20",
      "",
    ].join("\n");
    await writeFile(configPath, handRolled, "utf8");

    await runSetup([], makeContext(claudeEnv));
    await runSetup([], makeContext(codexEnv));

    const afterInstall = await readFile(configPath, "utf8");
    // Survives install (both hosts' installs run around it).
    expect(afterInstall).toContain(HAND_ROLLED_HOOK);
    expect(afterInstall).toContain("BEGIN kimi-plugin-cc-managed:claude-code");
    expect(afterInstall).toContain("BEGIN kimi-plugin-cc-managed:codex");

    // Simulate the kimi-code config rewrite that strips all comments/markers.
    const rewritten = stringify(parse(afterInstall));
    await writeFile(configPath, rewritten, "utf8");
    expect(rewritten).not.toContain("kimi-plugin-cc-managed");
    expect(rewritten).toContain(HAND_ROLLED_HOOK);
    expect(rewritten.match(/\[\[hooks\]\]/g)?.length).toBe(3);

    // Host-scoped uninstall (Claude) removes ONLY Claude's bare table.
    const claudeUninstall = await runSetup(["--uninstall"], makeContext(claudeEnv));
    expect(claudeUninstall.blockRemoved).toBe(true);
    const afterClaudeUninstall = await readFile(configPath, "utf8");
    expect(afterClaudeUninstall).not.toContain(hookScriptClaude);
    expect(afterClaudeUninstall).toContain(hookScriptCodex);
    // Survives the scoped uninstall.
    expect(afterClaudeUninstall).toContain(HAND_ROLLED_HOOK);

    // --all clears every remaining plugin table (Codex's bare table here) —
    // but never a hand-rolled hook whose script isn't approval-hook.js.
    const allUninstall = await runSetup(["--uninstall", "--all"], makeContext(codexEnv));
    expect(allUninstall.blockRemoved).toBe(true);
    const afterAll = await readFile(configPath, "utf8");
    expect(afterAll).not.toContain(hookScriptCodex);
    expect(afterAll).not.toContain("kimi-plugin-cc-managed");
    // Survives --all.
    expect(afterAll).toContain(HAND_ROLLED_HOOK);
  });
});

describe("findUnmanagedApprovalHookBlocks(contents, ownedBy)", () => {
  test("ownedBy scopes to a single host; omitted returns every plugin table but never a hand-rolled hook", () => {
    const claudeCmd = `'${process.execPath}' '/Users/x/.claude/plugins/cache/kimi-marketplace/kimi/1.8.2/dist/hooks/approval-hook.js'`;
    const codexCmd = `'${process.execPath}' '/Users/x/.codex/plugins/cache/kimi-marketplace/kimi/1.8.2/dist/hooks/approval-hook.js'`;
    const handRolledCmd = "'/usr/bin/node' '/opt/acme/my-own-hook.js'";

    const table = (command: string): string =>
      ["[[hooks]]", 'event = "PreToolUse"', `command = "${command}"`, "timeout = 15", ""].join("\n");

    const contents = [table(claudeCmd), table(codexCmd), table(handRolledCmd)].join("\n");

    const claudeOnly = findUnmanagedApprovalHookBlocks(contents, "claude-code");
    expect(claudeOnly).toHaveLength(1);
    expect(claudeOnly[0]!.command).toBe(claudeCmd);

    const codexOnly = findUnmanagedApprovalHookBlocks(contents, "codex");
    expect(codexOnly).toHaveLength(1);
    expect(codexOnly[0]!.command).toBe(codexCmd);

    // A host id that owns nothing here returns nothing.
    const thirdHostOnly = findUnmanagedApprovalHookBlocks(contents, "host-deadbeefcafebabe");
    expect(thirdHostOnly).toHaveLength(0);

    const everyPluginTable = findUnmanagedApprovalHookBlocks(contents);
    expect(everyPluginTable).toHaveLength(2);
    const commands = everyPluginTable.map((t) => t.command);
    expect(commands).toContain(claudeCmd);
    expect(commands).toContain(codexCmd);
    expect(commands).not.toContain(handRolledCmd);
  });
});

describe("blank-line-separated matcher (Opus review, HIGH — TOML table span)", () => {
  const NODE = process.execPath;
  const HOOK = "/Users/x/.claude/plugins/cache/kimi-marketplace/kimi/1.8.2/dist/hooks/approval-hook.js";
  const expected = `'${NODE}' '${HOOK}'`;
  const cmdLine = `command = "'${NODE}' '${HOOK}'"`;

  // A blank line does NOT end a TOML table — a `matcher` after it is still part
  // of the [[hooks]] table, so kimi-code loads it (matcher is a schema-valid
  // string) then throws at `new RegExp("*")` and DISABLES the hook. The bare
  // scanner must not report such a table as installed/prunable.
  test("matcher after a blank line disqualifies the table (must NOT count as installed)", () => {
    const cfg = `[[hooks]]\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n\nmatcher = "*"\n`;
    const r = evaluateInstalled(cfg, expected, { hostId: "claude-code" });
    expect(r.installed).toBe(false);
    expect(findBareApprovalHookTables(cfg)).toHaveLength(0);
  });

  test("matcher separated by multiple blanks is still caught", () => {
    const cfg = `[[hooks]]\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n\n\nmatcher = ".*"\n`;
    expect(evaluateInstalled(cfg, expected, { hostId: "claude-code" }).installed).toBe(false);
  });

  test("a matcher in a SEPARATE downstream table does not taint a clean bare table", () => {
    const cfg =
      `[[hooks]]\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n\n` +
      `[[hooks]]\nevent = "Stop"\nmatcher = "*"\ncommand = "'${NODE}' '/other.js'"\n`;
    const r = evaluateInstalled(cfg, expected, { hostId: "claude-code" });
    expect(r.installed).toBe(true);
    expect(r.via).toBe("bare-table");
  });

  test("adjacent (no blank) matcher is still caught, unchanged", () => {
    const cfg = `[[hooks]]\nevent = "PreToolUse"\nmatcher = "*"\n${cmdLine}\ntimeout = 15\n`;
    expect(evaluateInstalled(cfg, expected, { hostId: "claude-code" }).installed).toBe(false);
  });
});

describe("parser-based installed check (Codex/Opus/kimi convergence — TOML, not lexing)", () => {
  const NODE = process.execPath;
  const HOOK = "/Users/x/.claude/plugins/cache/kimi-marketplace/kimi/1.8.2/dist/hooks/approval-hook.js";
  const expected = `'${NODE}' '${HOOK}'`;
  const cmdLine = `command = "'${NODE}' '${HOOK}'"`;
  const inst = (cfg: string) => evaluateInstalled(cfg, expected, { hostId: "claude-code" }).installed;

  // A quoted key `"matcher"` is identical to `matcher` in TOML but never matches
  // the `/^matcher\s*=/` line regex — only the real parser catches it (Codex P1).
  test('quoted-key `"matcher"` after a blank line does NOT count as installed', () => {
    expect(inst(`[[hooks]]\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n\n"matcher" = "*"\n`)).toBe(false);
  });

  // A multiline array value whose lines start with `[` fools a line scanner's
  // table-boundary check, hiding a trailing matcher — the parser is immune.
  test("matcher hidden past a multiline array value does NOT count as installed", () => {
    expect(inst(`[[hooks]]\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n\nfoo = [\n[1, 2]\n]\nmatcher = "*"\n`)).toBe(false);
  });

  // A non-throwing narrowing matcher (valid regex) scopes enforcement to a
  // subset of tools — still must not count as our clean all-tools hook.
  test("a narrowing matcher (valid regex) does NOT count as installed", () => {
    expect(inst(`[[hooks]]\nevent = "PreToolUse"\nmatcher = "Read"\n${cmdLine}\ntimeout = 15\n`)).toBe(false);
  });

  // A foreign key after a blank line belongs to the hook table in TOML (would
  // trip kimi-code's strict schema) — must not count.
  test("a foreign key after a blank line does NOT count as installed", () => {
    expect(inst(`[[hooks]]\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n\nuser_ok = true\n`)).toBe(false);
  });

  // Host isolation: our exact command sitting INSIDE another host's marked block
  // is that host's hook, not evidence THIS host is installed.
  test("exact command nested in another host's marked block does NOT count (host isolation)", () => {
    const cfg =
      `# === BEGIN kimi-plugin-cc-managed:codex (v1.8.2) ===\n[[hooks]]\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n# === END kimi-plugin-cc-managed:codex ===\n`;
    expect(inst(cfg)).toBe(false);
  });

  // A clean bare table still counts even alongside a separate marked block for
  // another host carrying a different command.
  test("a clean bare table counts even beside another host's marked block", () => {
    const cfg =
      `[[hooks]]\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n\n` +
      `# === BEGIN kimi-plugin-cc-managed:codex (v1.8.2) ===\n[[hooks]]\nevent = "PreToolUse"\ncommand = "'${NODE}' '/other/approval-hook.js'"\ntimeout = 15\n# === END kimi-plugin-cc-managed:codex ===\n`;
    const r = evaluateInstalled(cfg, expected, { hostId: "claude-code" });
    expect(r.installed).toBe(true);
    expect(r.via).toBe("bare-table");
  });

  // The parser correctly reads TOML forms the line grammar rejected (kimi F1):
  // a trailing-comment table header now recognizes the enforcing hook.
  test("a trailing-comment table header still counts as installed (parser handles it)", () => {
    expect(inst(`[[hooks]] # user note\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n`)).toBe(true);
  });
});

// The quoted-`"matcher"` immunity above is tested only on the BARE-TABLE
// (absent-state) fallback. The PRIMARY marked-block path — a matcher hidden
// INSIDE a `# === BEGIN … ===` / `# === END … ===` block — validated the body
// with a line scanner (`/^matcher\s*=/`) that a quoted/literal matcher key
// slips past, blessing a hook-DISABLED block as installed:true (fail-open
// auto-approve). `validateBlockBody` now also parses the body with smol-toml.
// (kimi whole-repo audit 2026-07-17.)
describe("marked-block matcher rejection (parser-based body check)", () => {
  const NODE = process.execPath;
  const HOOK = "/Users/x/.claude/plugins/cache/kimi-marketplace/kimi/1.8.5/dist/hooks/approval-hook.js";
  const expected = `'${NODE}' '${HOOK}'`;
  const cmdLine = `command = "'${NODE}' '${HOOK}'"`;
  const hostId = "claude-code";
  const marked = (bodyExtra: string) =>
    `# === BEGIN kimi-plugin-cc-managed:claude-code (v1.8.5) ===\n` +
    `[[hooks]]\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n${bodyExtra}` +
    `# === END kimi-plugin-cc-managed:claude-code ===\n`;
  const inst = (cfg: string) => evaluateInstalled(cfg, expected, { hostId });

  test("a CLEAN marked block still counts as installed (no false positive)", () => {
    const r = inst(marked(""));
    expect(r.installed).toBe(true);
    expect(r.via).toBe("managed-block");
  });

  test('quoted `"matcher"` inside the marked block does NOT count as installed', () => {
    const r = inst(marked('"matcher" = "*"\n'));
    expect(r.installed).toBe(false);
    expect(r.reason).toContain("matcher");
  });

  test('quoted `"matcher"` after a blank line inside the marked block does NOT count', () => {
    expect(inst(marked('\n"matcher" = "*"\n')).installed).toBe(false);
  });

  test("literal-string `'matcher'` key inside the marked block does NOT count", () => {
    expect(inst(marked("'matcher' = \".*\"\n")).installed).toBe(false);
  });

  test("bare `matcher` inside the marked block is still caught (regression)", () => {
    expect(inst(marked('matcher = "*"\n')).installed).toBe(false);
  });

  // Fable review of the fix 2026-07-17: `validateBlockBody` only inspects lines
  // BETWEEN the markers, but a `matcher`/stray key AFTER the END comment is still
  // part of the same `[[hooks]]` TOML table (comments don't terminate a table),
  // so kimi-code loads it and disables the hook while the marked body looks
  // clean. The whole-file `foundHookEntryIsClean` parse closes this.
  test("`matcher` AFTER the END marker does NOT count as installed", () => {
    const cfg =
      `# === BEGIN kimi-plugin-cc-managed:claude-code (v1.8.6) ===\n` +
      `[[hooks]]\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n` +
      `# === END kimi-plugin-cc-managed:claude-code ===\n` +
      `matcher = "*"\n`;
    const r = inst(cfg);
    expect(r.installed).toBe(false);
  });

  test("a stray key AFTER the END marker does NOT count as installed", () => {
    const cfg =
      `# === BEGIN kimi-plugin-cc-managed:claude-code (v1.8.6) ===\n` +
      `[[hooks]]\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n` +
      `# === END kimi-plugin-cc-managed:claude-code ===\n` +
      `user_ok = true\n`;
    expect(inst(cfg).installed).toBe(false);
  });

  test("a clean block followed by a SEPARATE table after END still counts", () => {
    // A new `[table]`/`[[hooks]]` header after END terminates our table, so a
    // matcher there belongs to the other table, not ours — must stay installed.
    const cfg =
      `# === BEGIN kimi-plugin-cc-managed:claude-code (v1.8.6) ===\n` +
      `[[hooks]]\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n` +
      `# === END kimi-plugin-cc-managed:claude-code ===\n` +
      `[[hooks]]\nevent = "Stop"\nmatcher = "*"\ncommand = "'${NODE}' '/other.js'"\n`;
    const r = inst(cfg);
    expect(r.installed).toBe(true);
    expect(r.via).toBe("managed-block");
  });
});
