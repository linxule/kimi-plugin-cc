import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runSetup } from "../../runtime/commands/setup.js";
import type { CommandContext } from "../../runtime/types.js";

// Pins how install (orphan-marker repair) and uninstall (block stripping) pair
// BEGIN/END markers: nested BEGINs, mismatched hosts, legacy markers, CRLF.

const begin = (host?: string) => `# === BEGIN kimi-plugin-cc-managed${host ? `:${host}` : ""} (v0.9.0) ===`;
const end = (host?: string) => `# === END kimi-plugin-cc-managed${host ? `:${host}` : ""} ===`;
const claudeHook = "/home/u/.claude/plugins/cache/kimi-marketplace/kimi/2.2.1/dist/hooks/approval-hook.js";
const codexHook = "/home/u/.codex/plugins/cache/kimi-marketplace/kimi/2.4.5/dist/hooks/approval-hook.js";
const command = (hook: string) => `command = "'/usr/bin/node' '${hook}'"`;

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "kimi-plugin-cc-marker-pairing-"));
});

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function makeCase(name: string) {
  const home = path.join(scratch, name, "kimi-code-home");
  const data = path.join(scratch, name, "plugin-data");
  await mkdir(home, { recursive: true });
  await mkdir(data, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KIMI_CODE_HOME: home,
    CLAUDE_PLUGIN_DATA: data,
    KIMI_PLUGIN_CC_HOST_ID: "codex",
    KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: "1",
  };
  const context: CommandContext = { cwd: process.cwd(), env, stdout: process.stdout, stderr: process.stderr };
  return { context, configPath: path.join(home, "config.toml") };
}

// Marker pairing (line: marker):
//   1 E(codex) orphan        2 B(claude-code) orphan, next is a BEGIN
//   3-8 codex block          9-14 legacy block whose command derives to claude-code
//   15 B(legacy) orphan      16 E(other) orphan, host differs from line 15
//   17-21 legacy block; the matcher stops the validator at the first command,
//         but uninstall attributes the block by its LAST command, which is not
//         canonical, so a scoped uninstall keeps it.
const uninstallSeed = [
  "keep_top = 1",
  end("codex"),
  begin("claude-code"),
  begin("codex"),
  "[[hooks]]",
  'event = "PreToolUse"',
  command(codexHook),
  "timeout = 15",
  end("codex"),
  begin(),
  "[[hooks]]",
  'event = "PreToolUse"',
  command(claudeHook),
  "timeout = 15",
  end(),
  begin(),
  end("other"),
  begin(),
  command(codexHook),
  'matcher = "x"',
  'command = "not-canonical"',
  end(),
  "tail_key = 2",
];

function keep(lines: string[], removed: number[], eol: string): string {
  return lines.filter((_, index) => !removed.includes(index)).map((line) => `${line}${eol}`).join("");
}

describe("setup marker pairing", () => {
  test.each(["\n", "\r\n"])("scoped uninstall pairs markers and attributes legacy blocks (eol %j)", async (eol) => {
    const { context, configPath } = await makeCase(`scoped-${eol.length}`);
    await writeFile(configPath, uninstallSeed.map((line) => `${line}${eol}`).join(""), "utf8");
    const result = await runSetup(["--uninstall"], context);
    expect(await readFile(configPath, "utf8")).toBe(keep(uninstallSeed, [1, 3, 4, 5, 6, 7, 8, 15], eol));
    expect(result.summary).toBe(`Removed 1 managed block(s) from ${configPath}.`);
    expect(result.warnings).toEqual([
      "Detected 2 orphan marker line(s) at line 2, line 16. Removed the marker line(s) but preserved surrounding user content — verify the config visually.",
      "Left 2 other host block(s) in place: claude-code, codex. Use `/kimi:setup --uninstall --all` to remove every host's block.",
    ]);
  });

  test.each(["\n", "\r\n"])("--all uninstall removes every block and orphan marker (eol %j)", async (eol) => {
    const { context, configPath } = await makeCase(`all-${eol.length}`);
    await writeFile(configPath, uninstallSeed.map((line) => `${line}${eol}`).join(""), "utf8");
    const result = await runSetup(["--uninstall", "--all"], context);
    expect(await readFile(configPath, "utf8")).toBe(`keep_top = 1${eol}tail_key = 2${eol}`);
    expect(result.summary).toBe(`Removed 3 managed block(s) from ${configPath}.`);
    expect(result.warnings).toEqual([
      "Detected 4 orphan marker line(s) at line 2, line 3, line 16, line 17. Removed the marker line(s) but preserved surrounding user content — verify the config visually.",
    ]);
  });

  test("uninstall without a trailing newline keeps the last line intact", async () => {
    const { context, configPath } = await makeCase("no-trailing-newline");
    await writeFile(configPath, `${begin("codex")}\nuser = true\n${end("other")}`, "utf8");
    const result = await runSetup(["--uninstall"], context);
    expect(await readFile(configPath, "utf8")).toBe(`user = true\n${end("other")}`);
    expect(result.warnings[0]).toStartWith("Detected 1 orphan marker line(s) at line 1.");
  });

  test.each(["\n", "\r\n"])("install repairs nested, mismatched and legacy orphans (eol %j)", async (eol) => {
    const { context, configPath } = await makeCase(`install-${eol.length}`);
    // 1 E(other) orphan; 2 B(other) + 3 E(codex) mismatched, both orphan;
    // 4 B(legacy) and 5 B(claude-code) orphan, each followed by a BEGIN;
    // 6-11 claude-code block.
    const seed = [
      "user_setting = true",
      end("other"),
      begin("other"),
      end("codex"),
      begin(),
      begin("claude-code"),
      begin("claude-code"),
      "[[hooks]]",
      'event = "PreToolUse"',
      `command = "'${process.execPath}' '${claudeHook}'"`,
      "timeout = 15",
      end("claude-code"),
    ];
    await writeFile(configPath, seed.map((line) => `${line}${eol}`).join(""), "utf8");
    const result = await runSetup([], context);
    expect(result.probe).toBe("ok");
    expect(result.warnings).toContain("Removed 5 orphaned managed marker comment(s); surrounding config was preserved.");
    const repaired = keep(seed, [1, 2, 3, 4, 5], eol);
    expect(await readFile(configPath, "utf8")).toStartWith(`${repaired}${eol}# === BEGIN kimi-plugin-cc-managed:codex (v`);
  });
});
