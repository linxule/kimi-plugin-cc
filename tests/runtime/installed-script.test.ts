import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Smoke tests for the installed-plugin entry scripts (scripts/*.sh). These exercise the
// production launch path — shell wrapper → `node dist/...` — under a sanitized PATH so that
// regressions like hardcoding bare `node` or skipping the dist build are caught in CI
// before they ship. The scripts must honor KIMI_PLUGIN_CC_NODE_BIN for locked-down PATH.

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const companionScript = path.join(repoRoot, "scripts", "companion.sh");
const reviewGateScript = path.join(repoRoot, "scripts", "review-gate-hook.sh");
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
      return !parts.includes("node_modules") && !parts.includes(".git");
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
});

afterAll(async () => {
  if (cleanCopyRoot) {
    await rm(cleanCopyRoot, { recursive: true, force: true });
  }
});

describe("installed-plugin script wrappers", () => {
  test("companion.sh launches dist/companion.js under sanitized PATH via KIMI_PLUGIN_CC_NODE_BIN", () => {
    const result = spawnSync(companionScript, ["setup-bogus-subcommand"], {
      env: {
        PATH: SANITIZED_PATH,
        KIMI_PLUGIN_CC_NODE_BIN: nodeExecPath,
        CLAUDE_PLUGIN_ROOT: repoRoot,
        CLAUDE_PLUGIN_DATA: path.join(repoRoot, ".tmp", "installed-smoke-data"),
      },
      encoding: "utf8",
    });

    // Should have launched dist/companion.js successfully — the runtime will error on the
    // unknown subcommand, which proves both node-resolution and dist-entrypoint are wired.
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(combined).toContain("setup-bogus-subcommand");
    expect(combined).not.toContain("node: not found");
    expect(combined).not.toContain("unable to locate 'node'");
  });

  test("companion.sh fails with actionable error when node cannot be resolved", () => {
    // SANITIZED_PATH contains bash (so the shebang resolves) but not node (node lives under
    // /opt/homebrew/bin or /usr/local/bin on dev hosts). Leaving KIMI_PLUGIN_CC_NODE_BIN
    // unset forces the fallback path and exercises the actionable-error branch.
    const result = spawnSync(companionScript, ["setup"], {
      env: {
        PATH: SANITIZED_PATH,
        CLAUDE_PLUGIN_ROOT: repoRoot,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(127);
    expect(result.stderr).toContain("unable to locate 'node'");
    expect(result.stderr).toContain("KIMI_PLUGIN_CC_NODE_BIN");
  });

  test("review-gate-hook.sh launches dist/hooks/review-gate-stop.js under sanitized PATH", () => {
    const result = spawnSync(reviewGateScript, [], {
      input: JSON.stringify({
        session_id: "test",
        transcript_path: "/nonexistent/transcript.jsonl",
        cwd: repoRoot,
        stop_hook_active: false,
        hook_event_name: "Stop",
      }),
      env: {
        PATH: SANITIZED_PATH,
        KIMI_PLUGIN_CC_NODE_BIN: nodeExecPath,
        CLAUDE_PLUGIN_ROOT: repoRoot,
        CLAUDE_PLUGIN_DATA: path.join(repoRoot, ".tmp", "installed-smoke-data"),
      },
      encoding: "utf8",
    });

    // The hook fail-opens on missing transcript or disabled review gate, so exit 0 is the
    // expected success signal. What we care about is that node was located and the script
    // dispatched at all — no shell-level "node: not found" error.
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).not.toContain("node: not found");
    expect(combined).not.toContain("unable to locate 'node'");
  });

  test("clean installed copy runs setup without repo-root node_modules", () => {
    // v1.0 setup writes a managed block to ~/.kimi-code/config.toml and
    // probes the installed hook script directly. We isolate the test from
    // the developer's real kimi-code config via KIMI_CODE_HOME → a temp
    // dir under the clean copy. The probe never spawns kimi-code itself,
    // so the kimi mock is no longer needed here.
    const kimiCodeHome = path.join(cleanCopyRoot, ".tmp", "kimi-code-home");
    const result = spawnSync(path.join(cleanCopyRoot, "scripts", "companion.sh"), ["setup"], {
      env: {
        PATH: SANITIZED_PATH,
        KIMI_PLUGIN_CC_NODE_BIN: nodeExecPath,
        KIMI_CODE_HOME: kimiCodeHome,
        CLAUDE_PLUGIN_ROOT: cleanCopyRoot,
        CLAUDE_PLUGIN_DATA: path.join(cleanCopyRoot, ".tmp", "installed-smoke-data"),
      },
      encoding: "utf8",
    });

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(0);
    expect(combined).toContain("Installed kimi-plugin-cc PreToolUse hook");
    expect(combined).toContain("Probe:          ok");
    expect(combined).not.toContain("ERR_MODULE_NOT_FOUND");
  });

  test("companion.sh rejects Node versions below 22.5 before launching the runtime", () => {
    const result = spawnSync(path.join(cleanCopyRoot, "scripts", "companion.sh"), ["setup"], {
      env: {
        PATH: SANITIZED_PATH,
        KIMI_PLUGIN_CC_NODE_BIN: fakeNode20Path,
        CLAUDE_PLUGIN_ROOT: cleanCopyRoot,
        CLAUDE_PLUGIN_DATA: path.join(cleanCopyRoot, ".tmp", "installed-smoke-data"),
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
