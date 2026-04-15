import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

// Smoke tests for the installed-plugin entry scripts (scripts/*.sh). These exercise the
// production launch path — shell wrapper → `node dist/...` — under a sanitized PATH so that
// regressions like hardcoding bare `node` or skipping the dist build are caught in CI
// before they ship. The scripts must honor KIMI_PLUGIN_CC_NODE_BIN for locked-down PATH.

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const companionScript = path.join(repoRoot, "scripts", "companion.sh");
const reviewGateScript = path.join(repoRoot, "scripts", "review-gate-hook.sh");
const SANITIZED_PATH = "/usr/bin:/bin";

describe("installed-plugin script wrappers", () => {
  test("companion.sh launches dist/companion.js under sanitized PATH via KIMI_PLUGIN_CC_NODE_BIN", () => {
    const result = spawnSync(companionScript, ["setup-bogus-subcommand"], {
      env: {
        PATH: SANITIZED_PATH,
        KIMI_PLUGIN_CC_NODE_BIN: process.execPath,
        CLAUDE_PLUGIN_ROOT: repoRoot,
        KIMI_PLUGIN_CC_DATA_DIR: path.join(repoRoot, ".tmp", "installed-smoke-data"),
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
        KIMI_PLUGIN_CC_NODE_BIN: process.execPath,
        CLAUDE_PLUGIN_ROOT: repoRoot,
        KIMI_PLUGIN_CC_DATA_DIR: path.join(repoRoot, ".tmp", "installed-smoke-data"),
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
});
