import { describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";

/**
 * END-TO-END hook enforcement across the background process boundary.
 *
 * WHY THIS FILE EXISTS
 *
 * v1.9.0 shipped a fix for a CRITICAL self-inflicted regression: `startBackgroundJob`
 * spawned its worker with `process.execPath` (the fully symlink-resolved,
 * version-stamped `…/Cellar/node/<ver>/bin/node`) while `/kimi:setup` pins the
 * stable symlink (`/opt/homebrew/bin/node`). The spawned worker re-verifies the
 * PreToolUse hook by rebuilding the canonical command from ITS OWN `process.argv0`,
 * so it computed a different expected command than the config held → byte-exact
 * mismatch → every background rescue/ask refused FOREVER, and `/kimi:setup` could
 * not converge the two sides.
 *
 * That regression was caught by a pre-release model review, not by CI. The
 * post-release review identified the structural reason: every background test in
 * this suite sets `KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1`, and the one worker-refusal
 * test drives `executeAskJob` IN-PROCESS. Nothing ever ran a real detached worker
 * with enforcement on, so nothing could observe the two processes disagreeing.
 *
 * WHY IT CANNOT LIVE IN ask-background.test.ts
 *
 * The bug only manifests on the NO-OVERRIDE path: with `KIMI_PLUGIN_CC_NODE_BIN`
 * set, both the spawner and the verifier honor it verbatim and agree by
 * construction — the buggy code (`env.KIMI_PLUGIN_CC_NODE_BIN || process.execPath`)
 * did too. Reproducing it therefore requires the PARENT to be a real node process
 * invoked through a symlink, which is impossible inside `bun test` (there,
 * `process.execPath` is bun). So this test shells out: it runs the companion CLI
 * itself as a node subprocess, with no node-bin override, and lets the real
 * spawn→verify handshake happen.
 */

const REPO_ROOT = process.cwd();
const COMPANION_ENTRY = path.join(REPO_ROOT, "runtime", "companion.ts");
const NODE_PIN_HELPER = path.join(REPO_ROOT, "tests", "helpers", "print-node-pin.mjs");
const MOCK_CLI = path.join(REPO_ROOT, "tests", "helpers", "mock-kimi-cli.ts");
const HOOK_SCRIPT = path.join(REPO_ROOT, "dist", "hooks", "approval-hook.js");

function realNodeBinary(): string {
  return execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim();
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Build the fixture: a kimi-code home whose config pins the canonical command
 * exactly as a node process invoked through `nodeSymlink` would compute it.
 *
 * The pin is produced by ASKING such a process (via the print-node-pin helper)
 * rather than by computing it here, because this test process is bun and would
 * compute a different token. That also makes the fixture self-consistent by
 * construction: the pin is whatever the real interpreter says it is.
 */
async function buildFixture(label: string): Promise<{
  pluginDataRoot: string;
  repoFixture: string;
  env: NodeJS.ProcessEnv;
  nodeSymlink: string;
}> {
  const pluginDataRoot = await createTestPluginDataRoot(label);
  const repoFixture = await createGitRepoFixture(`${label}-repo`);
  const kimiHome = path.join(pluginDataRoot, "kimi-home");
  await mkdir(kimiHome, { recursive: true });

  // Stand-in for /opt/homebrew/bin/node: a stable name pointing at the
  // version-stamped real binary. This is the layout the whole fix is about.
  const nodeSymlink = path.join(kimiHome, "node-stable");
  await symlink(realNodeBinary(), nodeSymlink);

  const probeRun = await run(nodeSymlink, [NODE_PIN_HELPER, HOOK_SCRIPT], {
    cwd: REPO_ROOT,
    env: process.env,
  });
  // Fail loudly rather than JSON.parse-ing "" into a confusing downstream error.
  // The helper imports from dist/, so the usual cause is a stale or absent build
  // when this file is run standalone instead of through `bun run check`.
  if (probeRun.code !== 0) {
    throw new Error(
      `node-pin probe exited ${probeRun.code} (is dist/ built? run \`bun run build\`): ${probeRun.stderr.trim()}`,
    );
  }
  const probe = JSON.parse(probeRun.stdout) as { argv0: string; canonical: string };

  // Guard the fixture itself: if argv0 were resolved we would be pinning the
  // realpath and the test would prove nothing.
  expect(probe.argv0).toBe(nodeSymlink);

  await writeFile(
    path.join(kimiHome, "config.toml"),
    ["[[hooks]]", 'event = "PreToolUse"', `command = ${JSON.stringify(probe.canonical)}`, "timeout = 15"].join("\n"),
    "utf8",
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KIMI_PLUGIN_CC_DATA: pluginDataRoot,
    KIMI_CODE_HOME: kimiHome,
    KIMI_PLUGIN_CC_HOOK_SCRIPT: HOOK_SCRIPT,
    // Mock Kimi so no network/binary is needed.
    KIMI_PLUGIN_CC_KIMI_BIN: "bun",
    KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", MOCK_CLI]),
    KIMI_PLUGIN_CC_MOCK_SCENARIO: "ask-success",
    KIMI_PLUGIN_CC_MOCK_DELAY_MS: "0",
  };
  // The two variables that would defeat the test: an override makes spawner and
  // verifier agree by construction, and the skip flag disables enforcement.
  delete env.KIMI_PLUGIN_CC_NODE_BIN;
  delete env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK;

  return { pluginDataRoot, repoFixture, env, nodeSymlink };
}

describe("background hook enforcement (real spawn, no node-bin override)", () => {
  test("a background ask completes: the detached worker's own hook check agrees with the pin", async () => {
    const { pluginDataRoot, repoFixture, env, nodeSymlink } = await buildFixture("bg-hook-enforced");

    try {
      const result = await run(
        nodeSymlink,
        ["--import", "tsx", COMPANION_ENTRY, "ask", "--background", "--wait", "Explain the job store"],
        { cwd: repoFixture, env },
      );

      // BOTH assertions must read STDOUT, and that is load-bearing — do not
      // "improve" either one into a stderr or exit-code check:
      //   - the worker is spawned detached with stdio:"ignore"
      //     (background-spawn.ts), so its stderr goes NOWHERE; a
      //     `stderr` assertion here can never fail and proves nothing.
      //   - `runAsk` RETURNS the failure artifact rather than throwing, so the
      //     parent still exits 0 on a worker refusal; an exit-code assertion is
      //     equally inert.
      // The refusal reaches us only as artifact text on the parent's stdout.
      //
      // This is the regression assertion. Under the v1.9.0 bug the parent pins
      // (and verifies) `nodeSymlink` but spawns the worker with the resolved
      // Cellar path, so the WORKER rebuilds a different canonical command and
      // refuses with ASK_HOOK_NOT_INSTALLED (drift_axis "node-bin"), and the job
      // lands failed. Verified by reverting the fix and watching this fail.
      expect(result.stdout).not.toContain("ASK_HOOK_NOT_INSTALLED");
      expect(result.stdout).toContain("Ask answer from mock Kimi.");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoFixture);
    }
  }, 60_000);

  test("enforcement is genuinely ON: corrupting the pin makes the same invocation refuse", async () => {
    // Control for the test above. If the success case passed because enforcement
    // was silently disabled (skip flag leaking through, a fail-open verifier),
    // this would pass too — and it must not.
    //
    // SCOPE, precisely: this refusal happens in the PARENT. `runAsk` calls
    // requireAskHookInstalled BEFORE job creation and before startBackgroundJob
    // (commands/ask.ts), so a corrupted pin never reaches a worker and no child
    // is spawned. It therefore does NOT cover the worker's own re-verify — that
    // invariant is held by the in-process test in ask-background.test.ts
    // ("worker re-verifies the hook and persists the exact refusal"). Deleting
    // executeAskJob's hook check would leave BOTH tests in this file green.
    // What this does prove: the verifier is not fail-open and the skip flag is
    // not leaking into these runs.
    const { pluginDataRoot, repoFixture, env, nodeSymlink } = await buildFixture("bg-hook-enforced-control");

    try {
      const kimiHome = env.KIMI_CODE_HOME as string;
      await writeFile(
        path.join(kimiHome, "config.toml"),
        [
          "[[hooks]]",
          'event = "PreToolUse"',
          `command = ${JSON.stringify(`'${nodeSymlink}' '${path.join(REPO_ROOT, "dist", "hooks", "not-our-hook.js")}'`)}`,
          "timeout = 15",
        ].join("\n"),
        "utf8",
      );

      const result = await run(
        nodeSymlink,
        ["--import", "tsx", COMPANION_ENTRY, "ask", "--background", "--wait", "Explain the job store"],
        { cwd: repoFixture, env },
      );

      expect(result.code).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("ASK_HOOK_NOT_INSTALLED");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoFixture);
    }
  }, 60_000);
});

for (const kind of ["ask", "rescue"]) {
  test(`detached ${kind} replays thinking effort and persists hook escapes with real pin verification`, async () => {
    const { pluginDataRoot, repoFixture, env, nodeSymlink } = await buildFixture("bg-effort-escape");
    const invocation = path.join(pluginDataRoot, "invocation.json");
    env.KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH = invocation;
    const command = kind === "ask" ? ["ask"] : ["task", "rescue"];
    try {
      const result = await run(nodeSymlink, [path.join(REPO_ROOT, "dist/companion.js"), ...command, "--thinking", "off", "--background", "--wait", "inspect"], { cwd: repoFixture, env });
      expect(result.stdout).toContain("Ask answer from mock Kimi.");
      const logged = JSON.parse(await (await import("node:fs/promises")).readFile(invocation, "utf8"));
      expect(logged.env.KIMI_MODEL_THINKING_EFFORT).toBe("off");
      // Rescue's pure plan denial is covered separately; Write delegates to its filesystem evaluator.
      if (kind === "ask") {
        env.KIMI_PLUGIN_CC_MOCK_SCENARIO = "hook-escape-executed";
        const escaped = await run(nodeSymlink, [path.join(REPO_ROOT, "dist/companion.js"), ...command, "--fresh", "--background", "--wait", "inspect"], { cwd: repoFixture, env });
        // Detection only: the detached worker completes, keeps delivering, and persists the finding.
        expect(escaped.stdout).toContain("UNTRUSTED AFTER ESCAPE");
        const status = JSON.parse((await run(nodeSymlink, [path.join(REPO_ROOT, "dist/companion.js"), "status"], { cwd: repoFixture, env })).stdout);
        expect(status.status).toBe("completed");
        expect(status.hook_escapes[0]).toMatchObject({ kind: "mismatch", tool_name: "Write" });
      }
    } finally { await cleanupTestPath(pluginDataRoot); await cleanupTestPath(repoFixture); }
  }, 60000);
}
