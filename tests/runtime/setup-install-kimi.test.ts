import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { highestCertifiedKimiVersion, renderSetupResult, runSetup } from "../../runtime/commands/setup.js";
import { selectKimiBinary } from "../../runtime/kimi-command.js";
import { prepareKimiExecutionPlan } from "../../runtime/kimi-engine.js";
import type { CommandContext } from "../../runtime/types.js";

// No test here reaches the registry: a fake `npm` first on PATH stands in for
// the installer and logs every invocation.

const HIGHEST = highestCertifiedKimiVersion();
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const FAKE_NPM = `#!/bin/sh
echo "$*" >> "$FAKE_NPM_LOG"
prefix=""
spec=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    -*) shift ;;
    *) spec="$1"; shift ;;
  esac
done
version="\${spec##*@}"
pkg="$prefix/node_modules/@moonshot-ai/kimi-code"
mkdir -p "$pkg/dist" "$prefix/node_modules/.bin"
if [ "$FAKE_NPM_MODE" = "fail" ]; then
  echo "npm error boom" >&2
  exit 1
fi
printed="$version"
if [ "$FAKE_NPM_MODE" = "mismatch" ]; then printed="0.0.1"; fi
printf '#!/bin/sh\\necho %s\\n' "$printed" > "$pkg/dist/main.mjs"
chmod 755 "$pkg/dist/main.mjs"
ln -s ../@moonshot-ai/kimi-code/dist/main.mjs "$prefix/node_modules/.bin/kimi"
`;

interface Case {
  root: string;
  dataRoot: string;
  binDir: string;
  npmLog: string;
  env: NodeJS.ProcessEnv;
  context: CommandContext;
}

async function makeCase(extra: NodeJS.ProcessEnv = {}): Promise<Case> {
  const root = await mkdtemp(path.join(tmpdir(), "kimi-install-kimi-"));
  roots.push(root);
  const fakeBin = path.join(root, "fake-bin");
  const dataRoot = path.join(root, "plugin-data");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  await writeFile(path.join(fakeBin, "npm"), FAKE_NPM, "utf8");
  await chmod(path.join(fakeBin, "npm"), 0o755);
  const npmLog = path.join(root, "npm.log");
  // Explicit env: no inherited KIMI_PLUGIN_CC_KIMI_BIN, real npm or real kimi.
  const env: NodeJS.ProcessEnv = {
    PATH: `${fakeBin}:/usr/bin:/bin`,
    HOME: root,
    KIMI_PLUGIN_CC_DATA: dataRoot,
    KIMI_CODE_HOME: path.join(root, "kimi-home"),
    FAKE_NPM_LOG: npmLog,
    ...extra,
  };
  return {
    root,
    dataRoot,
    binDir: path.join(dataRoot, "kimi-bin"),
    npmLog,
    env,
    context: { cwd: root, env, stdout: process.stdout, stderr: process.stderr },
  };
}

async function npmCalls(c: Case): Promise<string[]> {
  if (!existsSync(c.npmLog)) return [];
  return (await readFile(c.npmLog, "utf8")).split("\n").filter(Boolean);
}

async function leftovers(c: Case): Promise<string[]> {
  if (!existsSync(c.binDir)) return [];
  return (await readdir(c.binDir)).filter((name) => name.startsWith("."));
}

async function seedPin(c: Case, version: string): Promise<void> {
  const binary = path.join(c.binDir, version, "node_modules", ".bin", "kimi");
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, `#!/bin/sh\necho ${version}\n`, "utf8");
  await chmod(binary, 0o755);
  await symlink(path.join(version, "node_modules", ".bin", "kimi"), path.join(c.binDir, "current"));
}

describe.skipIf(process.platform === "win32")("setup --install-kimi", () => {
  test("picks the numerically highest certified version", () => {
    expect(highestCertifiedKimiVersion(["2.9.0", "2.10.0", "2.7.3"])).toBe("2.10.0");
    expect(HIGHEST).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("installs the highest certified version, verifies it, and points current at it", async () => {
    const c = await makeCase();
    const result = await runSetup(["--install-kimi"], c.context);
    expect(result.probe).toBe("skipped");
    expect(result.kimiInstall).toMatchObject({ ok: true, version: HIGHEST, downloaded: true, selectedSource: "plugin-owned" });

    const calls = await npmCalls(c);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`@moonshot-ai/kimi-code@${HIGHEST}`);
    for (const flag of ["install", "--ignore-scripts", "--no-global", "--prefix"]) expect(calls[0]).toContain(flag);

    expect(await readlink(path.join(c.binDir, "current"))).toBe(path.join(HIGHEST, "node_modules", ".bin", "kimi"));
    const binary = await realpath(path.join(c.binDir, HIGHEST, "node_modules", ".bin", "kimi"));
    expect(result.kimiInstall!.binary).toBe(binary);
    expect(selectKimiBinary(c.env)).toMatchObject({ command: binary, source: "plugin-owned" });
    expect(await leftovers(c)).toEqual([]);

    const text = renderSetupResult(result);
    expect(text).toContain(`Installed kimi-code ${HIGHEST} for kimi-plugin-cc.`);
    expect(text).toContain(`Binary:           ${binary}`);
    expect(text).toContain("Jobs will now use this binary.");
  });

  test("a re-run reuses the verified install without calling npm", async () => {
    const c = await makeCase();
    await runSetup(["--install-kimi"], c.context);
    const again = await runSetup(["--install-kimi"], c.context);
    expect(again.kimiInstall).toMatchObject({ ok: true, downloaded: false });
    expect(await npmCalls(c)).toHaveLength(1);
    expect(renderSetupResult(again)).toContain("nothing was downloaded");
  });

  test("a version mismatch after install leaves current untouched and removes the download", async () => {
    const c = await makeCase({ FAKE_NPM_MODE: "mismatch" });
    await seedPin(c, "2.6.2");
    const result = await runSetup(["--install-kimi"], c.context);
    expect(result.probe).toBe("failed");
    expect(result.kimiInstall?.error?.code).toBe("KIMI_INSTALL_VERIFY_FAILED");
    expect(await readlink(path.join(c.binDir, "current"))).toBe(path.join("2.6.2", "node_modules", ".bin", "kimi"));
    expect(existsSync(path.join(c.binDir, HIGHEST))).toBe(false);
    expect(await leftovers(c)).toEqual([]);
    expect(renderSetupResult(result)).toContain("KIMI_INSTALL_VERIFY_FAILED");
  });

  test("an installer failure leaves current untouched and reports npm's stderr", async () => {
    const c = await makeCase({ FAKE_NPM_MODE: "fail" });
    await seedPin(c, "2.6.2");
    const result = await runSetup(["--install-kimi"], c.context);
    expect(result.probe).toBe("failed");
    expect(result.kimiInstall?.error).toMatchObject({ code: "KIMI_INSTALL_FAILED" });
    expect(result.kimiInstall?.error?.details.npm_stderr_tail).toContain("npm error boom");
    expect(await readlink(path.join(c.binDir, "current"))).toBe(path.join("2.6.2", "node_modules", ".bin", "kimi"));
    expect(existsSync(path.join(c.binDir, HIGHEST))).toBe(false);
    expect(await leftovers(c)).toEqual([]);
  });

  test("an unverifiable existing version directory is replaced, and older versions are kept", async () => {
    const c = await makeCase();
    await seedPin(c, "2.6.2");
    await mkdir(path.join(c.binDir, HIGHEST, "node_modules"), { recursive: true });
    const result = await runSetup(["--install-kimi"], c.context);
    expect(result.kimiInstall).toMatchObject({ ok: true, downloaded: true });
    expect(await readlink(path.join(c.binDir, "current"))).toBe(path.join(HIGHEST, "node_modules", ".bin", "kimi"));
    expect(existsSync(path.join(c.binDir, "2.6.2", "node_modules", ".bin", "kimi"))).toBe(true);
    expect(await leftovers(c)).toEqual([]);
  });

  test("with KIMI_PLUGIN_CC_KIMI_BIN set, install says jobs keep using the override", async () => {
    const c = await makeCase({ KIMI_PLUGIN_CC_KIMI_BIN: "/opt/custom/kimi" });
    const result = await runSetup(["--install-kimi", "--json"], c.context);
    const payload = JSON.parse(renderSetupResult(result));
    expect(payload).toMatchObject({
      action: "install-kimi",
      ok: true,
      version: HIGHEST,
      selected_binary: "/opt/custom/kimi",
      selected_source: "override",
      error: null,
    });
    expect(payload.next_step).toContain("Unset KIMI_PLUGIN_CC_KIMI_BIN");
  });

  test("--install-kimi refuses other setup flags, and --json needs it", async () => {
    const c = await makeCase();
    for (const argv of [["--install-kimi", "--check"], ["--install-kimi", "--uninstall"], ["--enable-review-gate", "--install-kimi"], ["--json"]]) {
      await expect(runSetup(argv, c.context)).rejects.toMatchObject({ code: "INVALID_ARGS", stage: "setup.parse" });
    }
    expect(await npmCalls(c)).toEqual([]);
  });

  test("plain setup and setup --check never invoke the installer", async () => {
    const c = await makeCase({ KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: "1" });
    await mkdir(c.env.KIMI_CODE_HOME!, { recursive: true });
    expect((await runSetup([], c.context)).action).toBe("install");
    expect((await runSetup(["--check"], c.context)).action).toBe("check");
    expect(await npmCalls(c)).toEqual([]);
    expect(existsSync(c.binDir)).toBe(false);
  });

  test("a job with no kimi anywhere refuses without installing", async () => {
    const c = await makeCase({ KIMI_CODE_EXPERIMENTAL_FLAG: "" });
    await expect(
      prepareKimiExecutionPlan({ operationKind: "ask", cwd: c.root, env: c.env }),
    ).rejects.toMatchObject({ code: "KIMI_EXECUTION_PLAN_UNRESOLVED" });
    expect(await npmCalls(c)).toEqual([]);
    expect(existsSync(c.binDir)).toBe(false);
  });

  test("setup --check reports the selected binary and a stale plugin-owned install", async () => {
    const c = await makeCase({ KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: "1" });
    await mkdir(c.env.KIMI_CODE_HOME!, { recursive: true });
    await seedPin(c, "2.6.2");
    const stale = renderSetupResult(await runSetup(["--check"], c.context));
    const staleBinary = await realpath(path.join(c.binDir, "2.6.2", "node_modules", ".bin", "kimi"));
    expect(stale).toContain(`- Kimi binary:      ${staleBinary} (plugin-owned kimi-code 2.6.2 from setup --install-kimi)`);
    expect(stale).toContain(`the plugin-owned kimi-code 2.6.2 is behind the highest certified version ${HIGHEST}`);

    await runSetup(["--install-kimi"], c.context);
    const fresh = renderSetupResult(await runSetup(["--check"], c.context));
    expect(fresh).not.toContain("is behind the highest certified version");
    expect(fresh).toContain(`(plugin-owned kimi-code ${HIGHEST} from setup --install-kimi)`);

    const overridden = renderSetupResult(
      await runSetup(["--check"], { ...c.context, env: { ...c.env, KIMI_PLUGIN_CC_KIMI_BIN: "/opt/custom/kimi" } }),
    );
    expect(overridden).toContain("- Kimi binary:      /opt/custom/kimi (KIMI_PLUGIN_CC_KIMI_BIN override)");
  });

  test("setup --check reports a rejected plugin-owned install and the PATH fallback", async () => {
    const c = await makeCase({ KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: "1" });
    await mkdir(c.env.KIMI_CODE_HOME!, { recursive: true });
    await mkdir(c.binDir, { recursive: true });
    await symlink("/bin/sh", path.join(c.binDir, "current"));
    const text = renderSetupResult(await runSetup(["--check"], c.context));
    expect(text).toContain("- Kimi binary:      kimi on PATH (plugin-owned install rejected:");
    expect(text).toContain("The plugin-owned kimi-code install is not used:");
  });

  test("the companion prints an install failure on stdout and exits 1", async () => {
    const c = await makeCase({ FAKE_NPM_MODE: "fail" });
    const node = Bun.which("node");
    expect(node).not.toBeNull();
    const result = await new Promise<{ exitCode: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(node!, ["--import", "tsx", path.join(process.cwd(), "runtime", "companion.ts"), "setup", "--install-kimi"], {
        cwd: process.cwd(),
        env: c.env,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.once("error", reject);
      child.once("close", (exitCode) => resolve({ exitCode, stdout }));
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(`Failed to install kimi-code ${HIGHEST} for kimi-plugin-cc`);
    expect(result.stdout).toContain("KIMI_INSTALL_FAILED");
  });
});
