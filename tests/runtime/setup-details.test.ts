import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { renderSetupResult, runSetup } from "../../runtime/commands/setup.js";
import { buildHookShellCommand, resolveNodeBinary } from "../../runtime/hooks/install-paths.js";
import { ORPHAN_MARKER_REMEDY } from "../../runtime/hooks/managed-block.js";
import type { CommandContext } from "../../runtime/types.js";
import { KIMI_PLUGIN_CC_VERSION } from "../../runtime/version.js";

// Pins the full rendered output of every check/uninstall/install outcome,
// including which results carry the "Host id:" detail line.

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const repoHookScript = path.join(repoRoot, "dist", "hooks", "approval-hook.js");
const HOST = "test-host";
const PROBE_DENY_EXCERPT =
  'kimi-plugin-cc safety hook: review is read-only. Tool "Bash" is denied — use Rea…';

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "kimi-plugin-cc-setup-details-"));
});

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function makeCase(name: string, extra: NodeJS.ProcessEnv = {}) {
  const home = path.join(scratch, name, "kimi-code-home");
  const data = path.join(scratch, name, "plugin-data");
  await mkdir(home, { recursive: true });
  await mkdir(data, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KIMI_CODE_HOME: home,
    CLAUDE_PLUGIN_DATA: data,
    KIMI_PLUGIN_CC_HOST_ID: HOST,
    KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: "1",
    ...extra,
  };
  const context: CommandContext = { cwd: process.cwd(), env, stdout: process.stdout, stderr: process.stderr };
  return { env, context, configPath: path.join(home, "config.toml") };
}

function render(args: {
  summary: string;
  action: string;
  written: boolean;
  removed: boolean;
  probe: string;
  probeDetail: string;
  hostId?: string;
  configPath: string;
  hookScript: string;
  nextStep: string;
}): string {
  return [
    args.summary,
    "",
    `Action:      ${args.action}`,
    `Block written:  ${args.written ? "yes" : "no"}`,
    `Block removed:  ${args.removed ? "yes" : "no"}`,
    `Probe:          ${args.probe}`,
    "Review gate:    disabled",
    "",
    "Details:",
    `- Companion runtime: Node ${process.version}`,
    `- Plugin version:   ${KIMI_PLUGIN_CC_VERSION}`,
    ...(args.hostId ? [`- Host id:          ${args.hostId}`] : []),
    `- Config file:      ${args.configPath}`,
    `- Hook script:      ${args.hookScript}`,
    "- Review gate:      disabled",
    `- Probe:            ${args.probeDetail}`,
    "",
    `Next step: ${args.nextStep}`,
    "Models: run setup --models to list configured aliases and provider setup guidance without making a model call.",
  ].join("\n");
}

function failed(reason: string) {
  return { probe: `failed (${reason})`, probeDetail: `failed — ${reason}` };
}

describe("setup rendered details", () => {
  test("check with an invalid hooks array", async () => {
    const { context, configPath } = await makeCase("check-invalid");
    await writeFile(configPath, '[[hooks]]\nevent = "PreToolUse"\ncommand = "x"\nunknown_field = true\n', "utf8");
    const reason =
      'hooks[0] at line 1 is invalid: unknown field "unknown_field" (allowed: event, matcher, command, timeout). kimi-code drops the entire hooks array when any entry fails its strict schema, so no configured PreToolUse hook will run.';
    expect(renderSetupResult(await runSetup(["--check"], context))).toBe(render({
      summary: "kimi-code hook configuration is invalid; the configured hooks array will not load.",
      action: "check",
      written: false,
      removed: false,
      ...failed(reason),
      hostId: HOST,
      configPath,
      hookScript: repoHookScript,
      nextStep: "Repair or remove the invalid [[hooks]] entry named above, then run /kimi:setup --check again. No model call is required.",
    }));
  });

  test("check with no managed block", async () => {
    const { context, configPath } = await makeCase("check-absent");
    await writeFile(configPath, "user_setting = true\n", "utf8");
    expect(renderSetupResult(await runSetup(["--check"], context))).toBe(render({
      summary: `kimi-plugin-cc managed block is NOT installed in ${configPath}.`,
      action: "check",
      written: false,
      removed: false,
      ...failed("managed block is not present"),
      configPath,
      hookScript: repoHookScript,
      nextStep: "Run /kimi:setup (without --check) to install the managed block.",
    }));
  });

  test("check with an orphan marker", async () => {
    const { context, configPath } = await makeCase("check-orphan");
    await writeFile(configPath, `# === END kimi-plugin-cc-managed:${HOST} ===\n`, "utf8");
    const reason = `END-without-BEGIN marker. ${ORPHAN_MARKER_REMEDY}`;
    expect(renderSetupResult(await runSetup(["--check"], context))).toBe(render({
      summary: `kimi-plugin-cc managed block is present but invalid: ${reason}.`,
      action: "check",
      written: false,
      removed: false,
      ...failed(reason),
      configPath,
      hookScript: repoHookScript,
      nextStep: ORPHAN_MARKER_REMEDY,
    }));
  });

  test("check with a stale command", async () => {
    const { env, context, configPath } = await makeCase("check-stale");
    await writeFile(
      configPath,
      `# === BEGIN kimi-plugin-cc-managed:${HOST} (v0.9.0) ===\n[[hooks]]\nevent = "PreToolUse"\ncommand = "node /old/approval-hook.js"\ntimeout = 15\n# === END kimi-plugin-cc-managed:${HOST} ===\n`,
      "utf8",
    );
    const reason = `installed block's command does not match the canonical command this companion would write. Run /kimi:setup to refresh. expected ${buildHookShellCommand(repoHookScript, env)}; got node /old/approval-hook.js.`;
    expect(renderSetupResult(await runSetup(["--check"], context))).toBe(render({
      summary: `kimi-plugin-cc managed block is present but invalid: ${reason}.`,
      action: "check",
      written: false,
      removed: false,
      ...failed(reason),
      configPath,
      hookScript: repoHookScript,
      nextStep: "Run /kimi:setup --uninstall, then /kimi:setup to repair.",
    }));
  });

  test("install with a failing probe, then check with the hook script gone", async () => {
    const script = path.join(scratch, "dummy-hook", "approval-hook.js");
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, "", "utf8");
    const { env, context, configPath } = await makeCase("unreadable", { KIMI_PLUGIN_CC_HOOK_SCRIPT: script });
    const nodeBin = resolveNodeBinary(env);
    expect(renderSetupResult(await runSetup([], context))).toBe(render({
      summary: `Wrote managed block to ${configPath} but the hook script probe failed.`,
      action: "install",
      written: true,
      removed: false,
      ...failed(`direct probe via ${nodeBin}: expected exit 2 with deny reason, got exit 0. stdout= stderr=`),
      hostId: HOST,
      configPath,
      hookScript: script,
      nextStep: "Re-run /kimi:setup after installing kimi-code and Node. If the probe keeps failing, run /kimi:setup --uninstall and inspect ~/.kimi-code/config.toml manually.",
    }));

    await rm(script);
    const reason = `Hook script ${script} is missing or unreadable. Reinstall the plugin so dist/hooks/approval-hook.js is present.`;
    expect(renderSetupResult(await runSetup(["--check"], context))).toBe(render({
      summary: `Managed block references ${script} but that path is unreadable.`,
      action: "check",
      written: false,
      removed: false,
      ...failed(reason),
      configPath,
      hookScript: script,
      nextStep: "Reinstall the plugin so dist/hooks/approval-hook.js is present, or run /kimi:setup to refresh the managed block.",
    }));
  });

  test("install, check, uninstall and a second uninstall", async () => {
    const { env, context, configPath } = await makeCase("lifecycle");
    await writeFile(configPath, "user_setting = true\n", "utf8");
    const okDetail = `ok — direct probe via ${resolveNodeBinary(env)}: deny reason captured (${PROBE_DENY_EXCERPT}); shell probe also ok`;
    const common = { configPath, hookScript: repoHookScript };

    expect(renderSetupResult(await runSetup([], context))).toBe(render({
      summary: `Installed kimi-plugin-cc PreToolUse hook in ${configPath}.`,
      action: "install",
      written: true,
      removed: false,
      probe: "ok",
      probeDetail: okDetail,
      hostId: HOST,
      ...common,
      nextStep: "Run /kimi:review, /kimi:challenge, /kimi:ask, or /kimi:rescue. Codex users can invoke the matching $kimi-* skills.",
    }));

    expect(renderSetupResult(await runSetup(["--check"], context))).toBe(render({
      summary: "kimi-plugin-cc PreToolUse hook is installed and probe passed.",
      action: "check",
      written: false,
      removed: false,
      probe: "ok",
      probeDetail: okDetail,
      hostId: HOST,
      ...common,
      nextStep: "No action needed.",
    }));

    expect(renderSetupResult(await runSetup(["--uninstall"], context))).toBe(render({
      summary: `Removed 1 managed block(s) from ${configPath}.`,
      action: "uninstall",
      written: false,
      removed: true,
      probe: "skipped",
      probeDetail: "ok — removed 1 block(s)",
      ...common,
      nextStep: "Run /kimi:setup again to reinstall the hook, or leave the plugin uninstalled.",
    }));

    expect(renderSetupResult(await runSetup(["--uninstall"], context))).toBe(render({
      summary: `No kimi-plugin-cc managed block to remove from ${configPath}.`,
      action: "uninstall",
      written: false,
      removed: false,
      probe: "skipped",
      probeDetail: "ok — no-op (no markers)",
      ...common,
      nextStep: "Run /kimi:setup to install the hook.",
    }));
  });

  test("uninstall with no config", async () => {
    const { context, configPath } = await makeCase("uninstall-empty");
    expect(renderSetupResult(await runSetup(["--uninstall"], context))).toBe(render({
      summary: `Nothing to remove — ${configPath} does not exist or is empty.`,
      action: "uninstall",
      written: false,
      removed: false,
      probe: "skipped",
      probeDetail: "ok — no-op (config absent)",
      configPath,
      hookScript: repoHookScript,
      nextStep: "Run /kimi:setup to install the managed block again.",
    }));
  });
});
