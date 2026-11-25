import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildHookShellCommand } from "../../runtime/hooks/install-paths.js";
import { prepareKimiExecutionPlan } from "../../runtime/kimi-engine.js";

// A cwd-selecting version shim (mise/asdf style) reports a different release
// per directory. The plan must validate the hook set against the release its
// own exact probe saw, and must not spawn a second version probe to do so.

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function makeCase(planRelease: string, otherRelease: string, hooks: string) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "plan-hook-release-")));
  roots.push(root);
  const project = path.join(root, "project");
  const kimiHome = path.join(root, "kimi-home");
  const shimLog = path.join(root, "shim.log");
  const shim = path.join(root, "kimi-shim");
  const hookScript = path.join(root, "dist", "hooks", "approval-hook.js");
  await mkdir(project, { recursive: true });
  await mkdir(kimiHome, { recursive: true });
  await mkdir(path.dirname(hookScript), { recursive: true });
  await writeFile(hookScript, "// hook\n", "utf8");
  // This checkout's managed block, so the job-time check sees an installed hook
  // and only the hook-set validation under test can refuse.
  const hookEnv = { KIMI_PLUGIN_CC_HOOK_SCRIPT: hookScript, KIMI_PLUGIN_CC_NODE_BIN: process.execPath };
  const managed = [
    "# === BEGIN kimi-plugin-cc-managed (v1.0.0) ===", "[[hooks]]", 'event = "PreToolUse"',
    `command = ${JSON.stringify(buildHookShellCommand(hookScript, hookEnv))}`, "timeout = 15",
    "# === END kimi-plugin-cc-managed ===", "",
  ].join("\n");
  await writeFile(path.join(kimiHome, "config.toml"), `${managed}${hooks}`, "utf8");
  await writeFile(
    shim,
    [
      "#!/bin/sh",
      `here="$(pwd -P)"`,
      `echo "$here" >> '${shimLog}'`,
      `if [ "$here" = '${project}' ]; then echo ${planRelease}; else echo ${otherRelease}; fi`,
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(shim, 0o755);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    KIMI_PLUGIN_CC_DATA: path.join(root, "plugin-data"),
    KIMI_CODE_HOME: kimiHome,
    KIMI_PLUGIN_CC_KIMI_BIN: shim,
    ...hookEnv,
  };
  const calls = async () => (existsSync(shimLog) ? (await readFile(shimLog, "utf8")).split("\n").filter(Boolean) : []);
  return { project, env, calls };
}

const INTERRUPT_HOOK = '[[hooks]]\nevent = "Interrupt"\ncommand = "foreign-hook"\n';

describe.skipIf(process.platform === "win32")("plan-time hook-schema check uses the plan's exact probe", () => {
  test("refuses when the release the job runs cannot load the hook set", async () => {
    const c = await makeCase("0.13.0", "2.7.3", INTERRUPT_HOOK);
    await expect(
      prepareKimiExecutionPlan({ operationKind: "review", cwd: c.project, env: c.env }),
    ).rejects.toMatchObject({
      code: "KIMI_HOOK_SET_INVALID",
      stage: "kimi-engine.plan",
      details: { kimi_version: "0.13.0", retryable_after_setup: false },
    });
    expect(await c.calls()).toEqual([c.project]);
  });

  test("accepts the hook set when the job's release supports it, with one probe", async () => {
    const c = await makeCase("0.14.0", "0.13.0", INTERRUPT_HOOK);
    const plan = await prepareKimiExecutionPlan({ operationKind: "review", cwd: c.project, env: c.env });
    expect(plan.kimiVersion).toBe("0.14.0");
    expect(await c.calls()).toEqual([c.project]);
  });

  test("a hook set without version-sensitive events never adds a probe", async () => {
    const c = await makeCase("0.13.0", "0.13.0", '[[hooks]]\nevent = "PreToolUse"\ncommand = "foreign-hook"\n');
    await prepareKimiExecutionPlan({ operationKind: "review", cwd: c.project, env: c.env });
    expect(await c.calls()).toEqual([c.project]);
  });
});
