import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Smoke tests for the installed-plugin entry script (scripts/companion.sh). These exercise
// the production launch path — shell wrapper → `node dist/companion.js` — under a sanitized
// PATH so regressions like hardcoding bare `node` or skipping the dist build are caught in CI
// before they ship. The script must honor KIMI_PLUGIN_CC_NODE_BIN for locked-down PATH.

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const companionScript = path.join(repoRoot, "scripts", "companion.sh");
const SANITIZED_PATH = "/usr/bin:/bin";
const nodeExecPath = resolveNodeExecPath();

let cleanCopyRoot: string;
let fakeNode20Path: string;

beforeAll(async () => {
  cleanCopyRoot = await mkdtemp(path.join(tmpdir(), "kimi-plugin-cc-installed-"));
  await cp(repoRoot, cleanCopyRoot, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(repoRoot, source);
      if (!relative) {
        return true;
      }
      const parts = relative.split(path.sep);
      return (
        !parts.some((part) => part.startsWith("node_modules")) &&
        !parts.includes(".git") &&
        !parts.some((part) => part.startsWith(".claude")) &&
        !parts.includes(".tmp")
      );
    },
  });

  fakeNode20Path = path.join(cleanCopyRoot, "fake-node-20.sh");
  await writeFile(
    fakeNode20Path,
    [
      "#!/usr/bin/env bash",
      "if [ \"$1\" = \"--version\" ]; then",
      "  echo \"v20.11.0\"",
      "  exit 0",
      "fi",
      "echo \"unexpected invocation: $*\" >&2",
      "exit 99",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(fakeNode20Path, 0o755);
}, 60_000);

afterAll(async () => {
  if (cleanCopyRoot) {
    await rm(cleanCopyRoot, { recursive: true, force: true });
  }
}, 60_000);

describe("installed-plugin script wrappers", () => {
  test("companion.sh launches dist/companion.js under sanitized PATH via KIMI_PLUGIN_CC_NODE_BIN", () => {
    const result = spawnSync(companionScript, ["setup-bogus-subcommand"], {
      env: {
        PATH: SANITIZED_PATH,
        KIMI_PLUGIN_CC_NODE_BIN: nodeExecPath,
        KIMI_PLUGIN_CC_DATA: path.join(cleanCopyRoot, ".tmp", "installed-smoke-data"),
      },
      encoding: "utf8",
    });

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(combined).toContain("setup-bogus-subcommand");
    expect(combined).not.toContain("node: not found");
    expect(combined).not.toContain("unable to locate 'node'");
  });

  test("companion.sh fails with actionable error when node cannot be resolved", () => {
    const result = spawnSync(companionScript, ["setup"], {
      env: {
        PATH: SANITIZED_PATH,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(127);
    expect(result.stderr).toContain("unable to locate 'node'");
    expect(result.stderr).toContain("KIMI_PLUGIN_CC_NODE_BIN");
  });

  test("clean installed copy runs setup without repo-root node_modules and publishes the bundled hook", () => {
    const kimiCodeHome = path.join(cleanCopyRoot, ".tmp", "kimi-code-home");
    const dataRoot = path.join(cleanCopyRoot, ".tmp", "installed-smoke-data");
    const result = spawnSync(path.join(cleanCopyRoot, "scripts", "companion.sh"), ["setup"], {
      env: {
        PATH: SANITIZED_PATH,
        KIMI_PLUGIN_CC_NODE_BIN: nodeExecPath,
        KIMI_CODE_HOME: kimiCodeHome,
        KIMI_PLUGIN_CC_DATA: dataRoot,
      },
      encoding: "utf8",
    });

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(0);
    expect(combined).toContain("Installed kimi-plugin-cc PreToolUse hook");
    expect(combined).toContain("Probe:          ok");
    expect(combined).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(existsSync(path.join(dataRoot, "kimi-plugin-cc", "hook", "approval-hook.js"))).toBe(true);
  });

  test("clean installed copy resolves relative KIMI_CODE_HOME against the captured workspace cwd", async () => {
    const workspaceRoot = path.join(cleanCopyRoot, ".tmp", "workspace-relative-home");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(path.join(workspaceRoot, ".keep"), "", "utf8");

    const result = spawnSync(path.join(cleanCopyRoot, "scripts", "companion.sh"), ["setup"], {
      cwd: workspaceRoot,
      env: {
        PATH: SANITIZED_PATH,
        KIMI_PLUGIN_CC_NODE_BIN: nodeExecPath,
        KIMI_CODE_HOME: "relative-kimi-home",
        KIMI_PLUGIN_CC_DATA: path.join(cleanCopyRoot, ".tmp", "installed-smoke-data-relative-home"),
      },
      encoding: "utf8",
    });

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(0);
    expect(combined).toContain("Installed kimi-plugin-cc PreToolUse hook");
    expect(combined).toContain(path.join(workspaceRoot, "relative-kimi-home", "config.toml"));
  });

  test.skipIf(process.platform === "win32")(
    "clean installed copy uses XDG_DATA_HOME when KIMI_PLUGIN_CC_DATA is omitted",
    () => {
      const kimiCodeHome = path.join(cleanCopyRoot, ".tmp", "kimi-code-home-xdg");
      const xdgDataHome = path.join(cleanCopyRoot, ".tmp", "xdg-data-home");
      const result = spawnSync(path.join(cleanCopyRoot, "scripts", "companion.sh"), ["setup"], {
        env: {
          PATH: SANITIZED_PATH,
          XDG_DATA_HOME: xdgDataHome,
          KIMI_PLUGIN_CC_NODE_BIN: nodeExecPath,
          KIMI_CODE_HOME: kimiCodeHome,
        },
        encoding: "utf8",
      });

      const combined = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(0);
      expect(combined).toContain("Installed kimi-plugin-cc PreToolUse hook");
      expect(combined).toContain("Probe:          ok");
      expect(combined).not.toContain("MISSING_PLUGIN_DATA");
      expect(combined).not.toContain("ERR_MODULE_NOT_FOUND");
      expect(existsSync(path.join(xdgDataHome, "kimi-plugin-cc", "hook", "approval-hook.js"))).toBe(
        true,
      );
    },
  );

  test.skipIf(process.platform === "win32")(
    "clean installed copy falls back to HOME/.local/share when XDG_DATA_HOME and KIMI_PLUGIN_CC_DATA are omitted",
    () => {
      const kimiCodeHome = path.join(cleanCopyRoot, ".tmp", "kimi-code-home-home-default");
      const fakeHome = path.join(cleanCopyRoot, ".tmp", "fake-home");
      const result = spawnSync(path.join(cleanCopyRoot, "scripts", "companion.sh"), ["setup"], {
        env: {
          PATH: SANITIZED_PATH,
          HOME: fakeHome,
          KIMI_PLUGIN_CC_NODE_BIN: nodeExecPath,
          KIMI_CODE_HOME: kimiCodeHome,
        },
        encoding: "utf8",
      });

      const combined = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(0);
      expect(combined).toContain("Installed kimi-plugin-cc PreToolUse hook");
      expect(combined).toContain("Probe:          ok");
      expect(combined).not.toContain("MISSING_PLUGIN_DATA");
      expect(
        existsSync(path.join(fakeHome, ".local", "share", "kimi-plugin-cc", "hook", "approval-hook.js")),
      ).toBe(true);
    },
  );

  test("companion.sh rejects Node versions below 22.5 before launching the runtime", () => {
    const result = spawnSync(path.join(cleanCopyRoot, "scripts", "companion.sh"), ["setup"], {
      env: {
        PATH: SANITIZED_PATH,
        KIMI_PLUGIN_CC_NODE_BIN: fakeNode20Path,
        KIMI_PLUGIN_CC_DATA: path.join(cleanCopyRoot, ".tmp", "installed-smoke-data"),
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(127);
    expect(result.stderr).toContain("requires Node >= 22.5.0");
    expect(result.stderr).toContain("KIMI_PLUGIN_CC_NODE_BIN");
  });
});

function resolveNodeExecPath(): string {
  const result = spawnSync("node", ["-p", "process.execPath"], {
    env: process.env,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`Unable to resolve the Node executable path: ${result.stderr}`);
  }

  return result.stdout.trim();
}
