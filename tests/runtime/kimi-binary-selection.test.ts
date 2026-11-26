import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  inspectPluginOwnedKimi,
  resolveKimiCliCommand,
  selectKimiBinary,
} from "../../runtime/kimi-command.js";
import { validateKimiHookSetForEnvironment } from "../../runtime/hooks/config-safety.js";
import { prepareKimiExecutionPlan } from "../../runtime/kimi-engine.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function makeDataRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "kimi-binary-selection-"));
  roots.push(root);
  return root;
}

/** Explicit env: never inherit the operator's KIMI_PLUGIN_CC_KIMI_BIN export. */
function envFor(dataRoot: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    KIMI_PLUGIN_CC_DATA: dataRoot,
    KIMI_CODE_HOME: path.join(dataRoot, "kimi-home"),
    ...extra,
  };
}

async function writePin(dataRoot: string, version: string, printed = version): Promise<string> {
  const binDir = path.join(dataRoot, "kimi-plugin-cc", "kimi-bin");
  const binary = path.join(binDir, version, "node_modules", ".bin", "kimi");
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, `#!/bin/sh\necho ${printed}\n`, "utf8");
  await chmod(binary, 0o755);
  await symlink(path.join(version, "node_modules", ".bin", "kimi"), path.join(binDir, "current"));
  return binary;
}

describe.skipIf(process.platform === "win32")("plugin-owned kimi binary selection", () => {
  test("PATH kimi when no data root resolves (unchanged default)", () => {
    const unavailableEnv: NodeJS.ProcessEnv = { KIMI_PLUGIN_CC_TEST_NO_DEFAULT_DATA: "1" };
    expect(resolveKimiCliCommand(unavailableEnv)).toEqual({ command: "kimi", prefixArgs: [] });
    expect(selectKimiBinary(unavailableEnv).pluginOwned.status).toBe("unavailable");
  });

  test("a link at the data root's top level is not the plugin-owned install", async () => {
    const dataRoot = await makeDataRoot();
    const binary = path.join(dataRoot, "kimi-bin", "2.8.0", "node_modules", ".bin", "kimi");
    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(binary, "#!/bin/sh\necho 2.8.0\n", "utf8");
    await chmod(binary, 0o755);
    await symlink(path.join("2.8.0", "node_modules", ".bin", "kimi"), path.join(dataRoot, "kimi-bin", "current"));
    expect(selectKimiBinary(envFor(dataRoot))).toMatchObject({ command: "kimi", source: "path" });
    expect(inspectPluginOwnedKimi(envFor(dataRoot)).binDir).toBe(path.join(dataRoot, "kimi-plugin-cc", "kimi-bin"));
  });

  test("PATH kimi when nothing is installed", async () => {
    const dataRoot = await makeDataRoot();
    const selection = selectKimiBinary(envFor(dataRoot));
    expect(selection).toMatchObject({ command: "kimi", source: "path" });
    expect(selection.pluginOwned.status).toBe("absent");
  });

  test("uses the realpath of a valid plugin-owned install", async () => {
    const dataRoot = await makeDataRoot();
    const binary = await writePin(dataRoot, "2.8.0");
    const selection = selectKimiBinary(envFor(dataRoot));
    expect(selection.source).toBe("plugin-owned");
    expect(selection.command).toBe(await realpath(binary));
    expect(selection.pluginOwned).toMatchObject({ status: "active", version: "2.8.0" });
    expect(resolveKimiCliCommand(envFor(dataRoot))).toEqual({ command: await realpath(binary), prefixArgs: [] });
  });

  test("KIMI_PLUGIN_CC_KIMI_BIN wins over a valid plugin-owned install", async () => {
    const dataRoot = await makeDataRoot();
    await writePin(dataRoot, "2.8.0");
    const env = envFor(dataRoot, { KIMI_PLUGIN_CC_KIMI_BIN: "/opt/custom/kimi" });
    expect(resolveKimiCliCommand(env).command).toBe("/opt/custom/kimi");
    expect(selectKimiBinary(env)).toMatchObject({ command: "/opt/custom/kimi", source: "override" });
    expect(selectKimiBinary(env).pluginOwned.status).toBe("active");
  });

  test("reserved prefix flags still refuse with a plugin-owned install", async () => {
    const dataRoot = await makeDataRoot();
    await writePin(dataRoot, "2.8.0");
    expect(() =>
      resolveKimiCliCommand(envFor(dataRoot, { KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["--resume", "s"]) })),
    ).toThrow(/reserved kimi flag/);
  });

  test("current escaping kimi-plugin-cc/kimi-bin falls back to PATH", async () => {
    const dataRoot = await makeDataRoot();
    const outside = path.join(dataRoot, "elsewhere", "kimi");
    await mkdir(path.dirname(outside), { recursive: true });
    await writeFile(outside, "#!/bin/sh\necho 2.8.0\n", "utf8");
    await chmod(outside, 0o755);
    await mkdir(path.join(dataRoot, "kimi-plugin-cc", "kimi-bin"), { recursive: true });
    await symlink(outside, path.join(dataRoot, "kimi-plugin-cc", "kimi-bin", "current"));
    const selection = selectKimiBinary(envFor(dataRoot));
    expect(selection).toMatchObject({ command: "kimi", source: "path" });
    expect(selection.pluginOwned.status).toBe("rejected");
    expect(selection.pluginOwned.reason).toContain("outside");
  });

  test("an escape through a version-named symlink directory is rejected", async () => {
    const dataRoot = await makeDataRoot();
    const outside = path.join(dataRoot, "elsewhere");
    await mkdir(path.join(outside, "bin"), { recursive: true });
    await writeFile(path.join(outside, "bin", "kimi"), "#!/bin/sh\necho 2.8.0\n", "utf8");
    await chmod(path.join(outside, "bin", "kimi"), 0o755);
    await mkdir(path.join(dataRoot, "kimi-plugin-cc", "kimi-bin"), { recursive: true });
    await symlink(outside, path.join(dataRoot, "kimi-plugin-cc", "kimi-bin", "2.8.0"));
    await symlink(path.join("2.8.0", "bin", "kimi"), path.join(dataRoot, "kimi-plugin-cc", "kimi-bin", "current"));
    expect(inspectPluginOwnedKimi(envFor(dataRoot)).status).toBe("rejected");
    expect(resolveKimiCliCommand(envFor(dataRoot)).command).toBe("kimi");
  });

  test("a target outside an exact-version directory is rejected", async () => {
    const dataRoot = await makeDataRoot();
    const binary = path.join(dataRoot, "kimi-plugin-cc", "kimi-bin", "latest", "kimi");
    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(binary, "#!/bin/sh\necho 2.8.0\n", "utf8");
    await chmod(binary, 0o755);
    await symlink(path.join("latest", "kimi"), path.join(dataRoot, "kimi-plugin-cc", "kimi-bin", "current"));
    expect(inspectPluginOwnedKimi(envFor(dataRoot)).status).toBe("rejected");
  });

  test("a non-executable target falls back to PATH", async () => {
    const dataRoot = await makeDataRoot();
    const binary = await writePin(dataRoot, "2.8.0");
    await chmod(binary, 0o644);
    const selection = selectKimiBinary(envFor(dataRoot));
    expect(selection).toMatchObject({ command: "kimi", source: "path" });
    expect(selection.pluginOwned).toMatchObject({ status: "rejected" });
    expect(selection.pluginOwned.reason).toContain("not executable");
  });

  test("a dangling current falls back to PATH", async () => {
    const dataRoot = await makeDataRoot();
    await mkdir(path.join(dataRoot, "kimi-plugin-cc", "kimi-bin"), { recursive: true });
    await symlink(path.join("2.8.0", "node_modules", ".bin", "kimi"), path.join(dataRoot, "kimi-plugin-cc", "kimi-bin", "current"));
    expect(selectKimiBinary(envFor(dataRoot))).toMatchObject({ command: "kimi", source: "path" });
    expect(inspectPluginOwnedKimi(envFor(dataRoot)).status).toBe("rejected");
  });
});

describe.skipIf(process.platform === "win32")("execution plan over the plugin-owned binary", () => {
  const planEnv = (dataRoot: string) =>
    envFor(dataRoot, {
      KIMI_CODE_EXPERIMENTAL_FLAG: "",
      KIMI_CODE_EXPERIMENTAL_TOWER: "",
      KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK: "",
      KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
    });

  test("a job plan records the plugin-owned realpath and its probed exact version", async () => {
    const dataRoot = await makeDataRoot();
    const binary = await writePin(dataRoot, "2.8.0");
    const plan = await prepareKimiExecutionPlan({
      operationKind: "ask",
      cwd: dataRoot,
      env: planEnv(dataRoot),
      intendedEngine: "native-v2",
    });
    expect(plan.command).toBe(await realpath(binary));
    expect(plan.kimiVersion).toBe("2.8.0");
    expect(plan.certification).toBe("certified");
  });

  test("a tampered pin reporting an uncertified version fails closed in the engine probe", async () => {
    const dataRoot = await makeDataRoot();
    await writePin(dataRoot, "2.8.0", "9.9.9");
    await expect(
      prepareKimiExecutionPlan({ operationKind: "rescue", cwd: dataRoot, env: planEnv(dataRoot) }),
    ).rejects.toThrow(/9\.9\.9/);
  });
});

describe.skipIf(process.platform === "win32")("hook-schema version check over the plugin-owned binary", () => {
  const contents = '[[hooks]]\nevent = "Interrupt"\ncommand = "foreign-hook"\n';

  test("probes the plugin-owned binary jobs will run, not PATH", async () => {
    const dataRoot = await makeDataRoot();
    await writePin(dataRoot, "2.8.0", "0.2.0");
    const result = await validateKimiHookSetForEnvironment(contents, envFor(dataRoot));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("requires a certified kimi-code >= 2.8.0 release (got 0.2.0)");
  });

  test("accepts the event when the plugin-owned binary is certified >= 2.8.0", async () => {
    const dataRoot = await makeDataRoot();
    await writePin(dataRoot, "2.8.0");
    expect((await validateKimiHookSetForEnvironment(contents, envFor(dataRoot))).valid).toBe(true);
  });

  test("the override still wins for the hook-schema probe", async () => {
    const dataRoot = await makeDataRoot();
    await writePin(dataRoot, "2.8.0");
    const old = path.join(dataRoot, "old-kimi");
    await writeFile(old, "#!/bin/sh\necho 0.2.0\n", "utf8");
    await chmod(old, 0o755);
    const result = await validateKimiHookSetForEnvironment(contents, envFor(dataRoot, { KIMI_PLUGIN_CC_KIMI_BIN: old }));
    expect(result.valid).toBe(false);
  });
});
