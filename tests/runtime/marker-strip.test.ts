// Marker-strip survival tests.
//
// kimi-code persists its config via a comment-dropping TOML stringifier
// (smol-toml has no comment support) on login/settings writes. This deletes
// our BEGIN/END markers while the `[[hooks]]` table (data) survives and keeps
// enforcing. In 3.1.0, all hosts share one canonical managed block and one
// published hook at `<pluginRoot>/hook/approval-hook.js`.
//
// This suite exercises the REAL vendored `smol-toml` package to simulate a
// comment-stripping rewrite end to end, plus direct unit coverage of
// `evaluateInstalled` and `findUnmanagedApprovalHookBlocks`.

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

async function makeCase(name: string): Promise<{ env: NodeJS.ProcessEnv; configPath: string; publishedHook: string }> {
  const kimiCodeHome = path.join(scratch, name, "kimi-code-home");
  const pluginData = path.join(scratch, name, "plugin-data");
  await mkdir(kimiCodeHome, { recursive: true });
  await mkdir(pluginData, { recursive: true });
  return {
    env: {
      ...process.env,
      KIMI_CODE_HOME: kimiCodeHome,
      KIMI_PLUGIN_CC_DATA: pluginData,
      KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: "1",
    },
    configPath: path.join(kimiCodeHome, "config.toml"),
    publishedHook: path.join(pluginData, "kimi-plugin-cc", "hook", "approval-hook.js"),
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

const DENY_HOOK_SOURCE = `process.stderr.write('deny\\n'); process.exit(2);\n`;

async function seedCustomHook(caseDir: string, rel: string): Promise<string> {
  const scriptPath = path.join(caseDir, rel);
  await mkdir(path.dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, DENY_HOOK_SOURCE, "utf8");
  return scriptPath;
}

describe("marker-strip survival: real smol-toml round-trip", () => {
  test("bare-table fallback keeps the canonical hook enforcing after a kimi-code config rewrite, and setup re-adorns it", async () => {
    const { env, configPath, publishedHook } = await makeCase("round-trip");

    // Install the canonical marked block.
    const install = await runSetup([], makeContext(env));
    expect(install.probe).toBe("ok");

    const beforeRewrite = await readFile(configPath, "utf8");
    expect(beforeRewrite).toContain("BEGIN kimi-plugin-cc-managed (v");
    expect(beforeRewrite).toContain("END kimi-plugin-cc-managed ===");

    // --- Simulate kimi-code's config rewrite with the REAL vendored smol-toml. ---
    const rewritten = stringify(parse(beforeRewrite));
    await writeFile(configPath, rewritten, "utf8");

    // Sanity: markers gone, [[hooks]] table survived as data.
    expect(rewritten).not.toContain("kimi-plugin-cc-managed");
    expect(rewritten.match(/\[\[hooks\]\]/g)?.length).toBe(1);
    expect(rewritten).toContain(publishedHook);

    // --- setup --check still passes via the bare-table fallback. ---
    const check = await runSetup(["--check"], makeContext(env));
    expect(check.probe).toBe("ok");
    const checkWarnings = check.warnings.join("\n");
    expect(checkWarnings).toMatch(/markers are missing/i);
    expect(checkWarnings).toMatch(/re-adorn/i);

    // --- Re-running setup re-adorns the single canonical block without duplication. ---
    const reinstall = await runSetup([], makeContext(env));
    expect(reinstall.blockWritten).toBe(true);
    const reinstallWarnings = reinstall.warnings.join("\n");
    expect(reinstallWarnings).toMatch(/re-adorn/i);
    expect(reinstallWarnings).not.toMatch(/cruft/i);

    const finalContents = await readFile(configPath, "utf8");
    expect(finalContents).toContain("BEGIN kimi-plugin-cc-managed (v");
    expect(finalContents.match(/\[\[hooks\]\]/g)?.length).toBe(1);

    const finalCheck = await runSetup(["--check"], makeContext(env));
    expect(finalCheck.probe).toBe("ok");
    expect(finalCheck.warnings.join("\n")).not.toMatch(/markers are missing/i);
  });

  test("setup prunes legacy bare plugin tables from multiple older hosts while preserving hand-rolled hooks", async () => {
    const { env, configPath, publishedHook } = await makeCase("legacy-bare-consolidation");
    const legacyClaude = "/Users/x/.claude/plugins/cache/kimi-marketplace/kimi/2.8.0/dist/hooks/approval-hook.js";
    const legacyCodex = "/Users/x/.codex/plugins/cache/kimi-marketplace/kimi/2.8.0/dist/hooks/approval-hook.js";
    const handRolled = "/opt/acme/my-own-hook.js";
    const seeded = [
      "[[hooks]]", 'event = "PreToolUse"', `command = "'/usr/bin/node' '${handRolled}'"`, "timeout = 20", "",
      "[[hooks]]", 'event = "PreToolUse"', `command = "'${process.execPath}' '${legacyClaude}'"`, "timeout = 15", "",
      "[[hooks]]", 'event = "PreToolUse"', `command = "'${process.execPath}' '${legacyCodex}'"`, "timeout = 15", "",
    ].join("\n");
    await writeFile(configPath, seeded, "utf8");

    const checkBefore = await runSetup(["--check"], makeContext(env));
    expect(checkBefore.probe).toBe("failed");
    expect(checkBefore.warnings.join("\n")).toContain("Found 2 stale marker-less kimi-plugin-cc hook block(s)");

    const install = await runSetup([], makeContext(env));
    expect(install.probe).toBe("ok");
    expect(install.warnings.join("\n")).toContain("Pruned 2 stale marker-less kimi-plugin-cc hook block(s)");
    const after = await readFile(configPath, "utf8");
    expect(after).toContain(handRolled);
    expect(after).toContain(publishedHook);
    expect(after).not.toContain(legacyClaude);
    expect(after).not.toContain(legacyCodex);
    expect(after.match(/\[\[hooks\]\]/g)?.length).toBe(2);
  });

  test("a thinking-effort migration (strict parse + reserialize) leaves the markerless enforcing hook verifier-clean", async () => {
    const { env, configPath, publishedHook } = await makeCase("thinking-effort-migration");

    await writeFile(configPath, '[thinking]\neffort = "max"\n', "utf8");
    const install = await runSetup([], makeContext(env));
    expect(install.probe).toBe("ok");
    const beforeMigration = await readFile(configPath, "utf8");
    expect(beforeMigration).toContain("BEGIN kimi-plugin-cc-managed (v");
    expect(beforeMigration).toContain('effort = "max"');

    const migrated = parse(beforeMigration);
    (migrated.thinking as Record<string, unknown>).effort = "high";
    const reserialized = stringify(migrated);
    await writeFile(configPath, reserialized, "utf8");

    expect(reserialized).toContain('effort = "high"');
    expect(reserialized).not.toContain("kimi-plugin-cc-managed");
    expect(reserialized).toContain(publishedHook);
    expect(reserialized).toContain("[[hooks]]");

    const check = await runSetup(["--check"], makeContext(env));
    expect(check.probe).toBe("ok");
    expect(check.warnings.join("\n")).toMatch(/markers are missing/i);
  });
});

describe("evaluateInstalled bare-table fallback strictness", () => {
  const expectedCommand = buildHookShellCommand(
    path.join("/plugin-root", "kimi-plugin-cc", "hook", "approval-hook.js"),
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
    const result = evaluateInstalled(contents, expectedCommand);
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
    const result = evaluateInstalled(contents, expectedCommand);
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
    const result = evaluateInstalled(contents, expectedCommand);
    expect(result.installed).toBe(false);
  });

  test("bare table with the exact command but an extra foreign key is rejected", () => {
    const contents = bareTableToml(expectedCommand, ['metadata = "x"']);
    const result = evaluateInstalled(contents, expectedCommand);
    expect(result.installed).toBe(false);
  });

  test("a marked-but-INVALID block + a bare exact table elsewhere: no fallback from an invalid state", () => {
    const invalidMarked = [
      "# === BEGIN kimi-plugin-cc-managed (v3.1.0) ===",
      "[[hooks]]",
      'matcher = "Write"',
      'event = "PreToolUse"',
      `command = "${expectedCommand}"`,
      "timeout = 15",
      "# === END kimi-plugin-cc-managed ===",
      "",
      bareTableToml(expectedCommand),
    ].join("\n");
    const result = evaluateInstalled(invalidMarked, expectedCommand);
    expect(result.installed).toBe(false);
    expect(result.state.kind).toBe("found");
    if (result.state.kind === "found") {
      expect(result.state.valid).toBe(false);
    }
  });

  test("duplicate marked blocks + a bare exact table elsewhere: no fallback from a duplicate state", () => {
    const markedBlock = (version: string) =>
      [
        `# === BEGIN kimi-plugin-cc-managed (v${version}) ===`,
        "[[hooks]]",
        'event = "PreToolUse"',
        `command = "${expectedCommand}"`,
        "timeout = 15",
        "# === END kimi-plugin-cc-managed ===",
      ].join("\n");
    const contents = [markedBlock("3.0.0"), markedBlock("3.1.0"), bareTableToml(expectedCommand)].join(
      "\n\n",
    );
    const result = evaluateInstalled(contents, expectedCommand);
    expect(result.installed).toBe(false);
    expect(result.state.kind).toBe("duplicate");
  });
});

describe("uninstall on a stripped config never touches a hand-rolled hook", () => {
  test("uninstall removes canonical and legacy plugin bare tables while preserving a hand-rolled hook", async () => {
    const caseName = "stripped-uninstall";
    const { env, configPath, publishedHook } = await makeCase(caseName);
    const caseDir = path.join(scratch, caseName);
    const customHook = await seedCustomHook(caseDir, "custom/approval-hook.js");
    const legacyCodex = "/Users/x/.codex/plugins/cache/kimi-marketplace/kimi/2.8.0/dist/hooks/approval-hook.js";
    const HAND_ROLLED_HOOK = "/opt/acme/my-own-hook.js";
    const handRolled = [
      "[[hooks]]",
      'event = "PreToolUse"',
      `command = "'/usr/bin/node' '${HAND_ROLLED_HOOK}'"`,
      "timeout = 20",
      "",
      "[[hooks]]",
      'event = "PreToolUse"',
      `command = "'${process.execPath}' '${legacyCodex}'"`,
      "timeout = 15",
      "",
    ].join("\n");
    await writeFile(configPath, handRolled, "utf8");

    await runSetup([], makeContext(env));
    const afterInstall = await readFile(configPath, "utf8");
    expect(afterInstall).toContain(HAND_ROLLED_HOOK);
    expect(afterInstall).toContain(publishedHook);
    expect(afterInstall).not.toContain(legacyCodex);

    // Simulate a comment-stripping config rewrite, plus another bare legacy plugin table.
    const rewritten =
      stringify(parse(afterInstall)) +
      `\n[[hooks]]\nevent = "PreToolUse"\ncommand = "'${process.execPath}' '${legacyCodex}'"\ntimeout = 15\n`;
    await writeFile(configPath, rewritten, "utf8");
    expect(rewritten).not.toContain("kimi-plugin-cc-managed");

    // Plain uninstall removes ALL plugin bare tables but preserves the hand-rolled hook.
    const uninstall = await runSetup(["--uninstall"], makeContext(env));
    expect(uninstall.blockRemoved).toBe(true);
    const afterUninstall = await readFile(configPath, "utf8");
    expect(afterUninstall).not.toContain(publishedHook);
    expect(afterUninstall).not.toContain(legacyCodex);
    expect(afterUninstall).toContain(HAND_ROLLED_HOOK);

    // Custom KIMI_PLUGIN_CC_HOOK_SCRIPT outside known trees is also removed on uninstall via alsoMatchCommand.
    const customEnv = { ...env, KIMI_PLUGIN_CC_HOOK_SCRIPT: customHook };
    await runSetup([], makeContext(customEnv));
    await writeFile(configPath, stringify(parse(await readFile(configPath, "utf8"))), "utf8");
    const customUninstall = await runSetup(["--uninstall"], makeContext(customEnv));
    expect(customUninstall.blockRemoved).toBe(true);
    const afterCustom = await readFile(configPath, "utf8");
    expect(afterCustom).not.toContain(customHook);
    expect(afterCustom).toContain(HAND_ROLLED_HOOK);
  });
});

describe("findUnmanagedApprovalHookBlocks(contents, alsoMatchCommand)", () => {
  test("matches every plugin approval-hook table, optional exact override, and never a hand-rolled hook", () => {
    const canonicalCmd = `'${process.execPath}' '/home/u/.local/share/kimi-plugin-cc/hook/approval-hook.js'`;
    const claudeCmd = `'${process.execPath}' '/Users/x/.claude/plugins/cache/kimi-marketplace/kimi/2.8.0/dist/hooks/approval-hook.js'`;
    const codexCmd = `'${process.execPath}' '/Users/x/.codex/plugins/cache/kimi-marketplace/kimi/2.8.0/dist/hooks/approval-hook.js'`;
    const customOverrideCmd = `'${process.execPath}' '/tmp/custom-override/approval-hook.js'`;
    const handRolledCmd = "'/usr/bin/node' '/opt/acme/my-own-hook.js'";

    const table = (command: string): string =>
      ["[[hooks]]", 'event = "PreToolUse"', `command = "${command}"`, "timeout = 15", ""].join("\n");

    const contents = [
      table(canonicalCmd),
      table(claudeCmd),
      table(codexCmd),
      table(customOverrideCmd),
      table(handRolledCmd),
    ].join("\n");

    const defaultMatches = findUnmanagedApprovalHookBlocks(contents);
    expect(defaultMatches.map((t) => t.command)).toEqual([canonicalCmd, claudeCmd, codexCmd]);

    const withOverride = findUnmanagedApprovalHookBlocks(contents, customOverrideCmd);
    expect(withOverride.map((t) => t.command)).toEqual([
      canonicalCmd,
      claudeCmd,
      codexCmd,
      customOverrideCmd,
    ]);
    expect(withOverride.map((t) => t.command)).not.toContain(handRolledCmd);
  });
});

describe("blank-line-separated matcher (Opus review, HIGH — TOML table span)", () => {
  const NODE = process.execPath;
  const HOOK = "/Users/x/.local/share/kimi-plugin-cc/hook/approval-hook.js";
  const expected = `'${NODE}' '${HOOK}'`;
  const cmdLine = `command = "'${NODE}' '${HOOK}'"`;

  test("matcher after a blank line disqualifies the table (must NOT count as installed)", () => {
    const cfg = `[[hooks]]\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n\nmatcher = "*"\n`;
    const r = evaluateInstalled(cfg, expected);
    expect(r.installed).toBe(false);
    expect(findBareApprovalHookTables(cfg)).toHaveLength(0);
  });

  test("matcher separated by multiple blanks is still caught", () => {
    const cfg = `[[hooks]]\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n\n\nmatcher = ".*"\n`;
    expect(evaluateInstalled(cfg, expected).installed).toBe(false);
  });

  test("a matcher in a SEPARATE downstream table does not taint a clean bare table", () => {
    const cfg =
      `[[hooks]]\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n\n` +
      `[[hooks]]\nevent = "Stop"\nmatcher = "*"\ncommand = "'${NODE}' '/other.js'"\n`;
    const r = evaluateInstalled(cfg, expected);
    expect(r.installed).toBe(true);
    expect(r.via).toBe("bare-table");
  });

  test("adjacent (no blank) matcher is still caught, unchanged", () => {
    const cfg = `[[hooks]]\nevent = "PreToolUse"\nmatcher = "*"\n${cmdLine}\ntimeout = 15\n`;
    expect(evaluateInstalled(cfg, expected).installed).toBe(false);
  });
});

describe("parser-based installed check (TOML, not lexing)", () => {
  const NODE = process.execPath;
  const HOOK = "/Users/x/.local/share/kimi-plugin-cc/hook/approval-hook.js";
  const expected = `'${NODE}' '${HOOK}'`;
  const cmdLine = `command = "'${NODE}' '${HOOK}'"`;
  const inst = (cfg: string) => evaluateInstalled(cfg, expected).installed;

  test('quoted-key `"matcher"` after a blank line does NOT count as installed', () => {
    expect(inst(`[[hooks]]\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n\n"matcher" = "*"\n`)).toBe(false);
  });

  test("matcher hidden past a multiline array value does NOT count as installed", () => {
    expect(inst(`[[hooks]]\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n\nfoo = [\n[1, 2]\n]\nmatcher = "*"\n`)).toBe(false);
  });

  test("a narrowing matcher (valid regex) does NOT count as installed", () => {
    expect(inst(`[[hooks]]\nevent = "PreToolUse"\nmatcher = "Read"\n${cmdLine}\ntimeout = 15\n`)).toBe(false);
  });

  test("a foreign key after a blank line does NOT count as installed", () => {
    expect(inst(`[[hooks]]\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n\nuser_ok = true\n`)).toBe(false);
  });

  test("a single legacy suffixed block carrying the exact command counts as installed via managed-block", () => {
    const cfg =
      `# === BEGIN kimi-plugin-cc-managed:codex (v2.8.0) ===\n[[hooks]]\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n# === END kimi-plugin-cc-managed:codex ===\n`;
    const r = evaluateInstalled(cfg, expected);
    expect(r.installed).toBe(true);
    expect(r.via).toBe("managed-block");
  });

  test("a stale legacy suffixed block fails closed even beside a bare exact table", () => {
    const cfg =
      `[[hooks]]\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n\n` +
      `# === BEGIN kimi-plugin-cc-managed:codex (v2.8.0) ===\n[[hooks]]\nevent = "PreToolUse"\ncommand = "'${NODE}' '/other/approval-hook.js'"\ntimeout = 15\n# === END kimi-plugin-cc-managed:codex ===\n`;
    const r = evaluateInstalled(cfg, expected);
    expect(r.installed).toBe(false);
    expect(r.state.kind).toBe("found");
  });

  test("a trailing-comment table header still counts as installed (parser handles it)", () => {
    expect(inst(`[[hooks]] # user note\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n`)).toBe(true);
  });
});

describe("marked-block matcher rejection (parser-based body check)", () => {
  const NODE = process.execPath;
  const HOOK = "/Users/x/.local/share/kimi-plugin-cc/hook/approval-hook.js";
  const expected = `'${NODE}' '${HOOK}'`;
  const cmdLine = `command = "'${NODE}' '${HOOK}'"`;
  const marked = (bodyExtra: string) =>
    `# === BEGIN kimi-plugin-cc-managed (v3.1.0) ===\n` +
    `[[hooks]]\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n${bodyExtra}` +
    `# === END kimi-plugin-cc-managed ===\n`;
  const inst = (cfg: string) => evaluateInstalled(cfg, expected);

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

  test("`matcher` AFTER the END marker does NOT count as installed", () => {
    const cfg =
      `# === BEGIN kimi-plugin-cc-managed (v3.1.0) ===\n` +
      `[[hooks]]\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n` +
      `# === END kimi-plugin-cc-managed ===\n` +
      `matcher = "*"\n`;
    const r = inst(cfg);
    expect(r.installed).toBe(false);
  });

  test("a stray key AFTER the END marker does NOT count as installed", () => {
    const cfg =
      `# === BEGIN kimi-plugin-cc-managed (v3.1.0) ===\n` +
      `[[hooks]]\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n` +
      `# === END kimi-plugin-cc-managed ===\n` +
      `user_ok = true\n`;
    expect(inst(cfg).installed).toBe(false);
  });

  test("a clean block followed by a SEPARATE table after END still counts", () => {
    const cfg =
      `# === BEGIN kimi-plugin-cc-managed (v3.1.0) ===\n` +
      `[[hooks]]\nevent = "PreToolUse"\n${cmdLine}\ntimeout = 15\n` +
      `# === END kimi-plugin-cc-managed ===\n` +
      `[[hooks]]\nevent = "Stop"\nmatcher = "*"\ncommand = "'${NODE}' '/other.js'"\n`;
    const r = inst(cfg);
    expect(r.installed).toBe(true);
    expect(r.via).toBe("managed-block");
  });
});
