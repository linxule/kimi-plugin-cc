// A swarm child can exit before the launcher reads its process identity, and
// the read can time out on a live child. Either way the print root is never
// recorded. Settlement then rests on evidence that needs no identity: the
// launcher's own exit report, its closed pipes, a complete pass that tracks
// nothing, and an empty process group. It must neither stall and fail a clean
// run, nor settle while a helper survives in that group or still holds a pipe.
import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { runCliPrompt } from "../../runtime/cli-client.js";
import type { JobStore } from "../../runtime/job-store.js";
import type { KimiExecutionPlan } from "../../runtime/kimi-engine.js";
import { probeProcessIdentity, type ProcessIdentity } from "../../runtime/process-tree.js";
import { recordPrintSnapshot, recordRecoveryEvent, type SwarmRecoveryRecord } from "../../runtime/swarm-recovery.js";
import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";

const exec = promisify(execFile);
const companion = path.resolve("dist/companion.js");
const instantKimi = path.resolve("tests/helpers/instant-kimi.sh");
// A launch that cannot settle spends 1,500 ms plus 500 ms in teardown before it fails.
const STALL_MS = 1_500;
const HELPER_SECONDS = 4;
const posix = process.platform !== "win32";

type RootMode = "gone-before-probe" | "probe-timed-out" | "identified";
interface Pass { identities: number; complete: boolean; exited: boolean; closed: boolean; accepted: boolean; error?: string }

async function waitUntilReaped(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("the stand-in child did not exit");
}

/** Runs the launcher against the stand-in with the shipped recovery recording, as the swarm command wires it. */
async function launch(options: { root: string; mode: RootMode; env?: NodeJS.ProcessEnv; signal?: AbortSignal }) {
  const record: SwarmRecoveryRecord = {
    schema: 1, jobId: "rootless", ownerPid: process.pid, owner: null, kimiHome: "/virtual/kimi-home",
    cwd: "/virtual/repo", workspaceRoot: null, launches: [], session: null, sessionDirty: false,
    complete: false, patchPath: null,
  };
  const store = { saveSwarmRecovery() {} } as unknown as JobStore;
  recordRecoveryEvent(store, record, { kind: "print-spawn" });
  const plan: KimiExecutionPlan = {
    schemaVersion: 1, operationKind: "swarm", intendedEngine: "native-v2", command: instantKimi, prefixArgs: [],
    kimiVersion: "2.8.0", certification: "certified", resumedFromJobId: null, safetyProfile: "native-v2-no-plan/1",
  };
  const passes: Pass[] = [];
  let rootPid: number | undefined;
  const started = Date.now();
  let result: Awaited<ReturnType<typeof runCliPrompt>> | undefined;
  let error: { code?: string; message?: string; details?: Record<string, unknown> } | undefined;
  try {
    result = await runCliPrompt({
      cwd: options.root,
      env: {
        PATH: process.env.PATH, KIMI_CODE_HOME: path.join(options.root, "home"),
        INSTANT_KIMI_HELPER_SECONDS: String(HELPER_SECONDS), INSTANT_KIMI_HELPER_PID: path.join(options.root, "helper.pid"),
        ...options.env,
      },
      command: instantKimi, prefixArgs: [], executionPlan: plan, prompt: "Exercise rootless settlement.",
      commandLabel: "swarm", swarmMaxConcurrency: 1, signal: options.signal,
      onSpawn: async (pid) => {
        rootPid = pid;
        let identities: ProcessIdentity[] = [];
        let complete = true;
        if (options.mode === "gone-before-probe") {
          await waitUntilReaped(pid);
        } else if (options.mode === "probe-timed-out") {
          complete = false;
        } else {
          const probe = await probeProcessIdentity(pid);
          if (!probe.identity) throw new Error("the stand-in exited before its identity could be read");
          identities = [probe.identity];
        }
        // What the swarm command records from its spawn-time probe.
        recordRecoveryEvent(store, record, { kind: "print-processes", identities, complete });
      },
      onProcessIdentities: async (identities, complete, root) => {
        const pass: Pass = { identities: identities.length, complete, exited: root.exited, closed: root.closed, accepted: false };
        passes.push(pass);
        try {
          await recordPrintSnapshot(store, record, { identities, complete, rootExited: root.exited, rootClosed: root.closed }, rootPid);
          pass.accepted = true;
        } catch (caught) {
          pass.error = (caught as { code?: string }).code ?? String(caught);
          throw caught;
        }
      },
    });
  } catch (caught) {
    error = caught as typeof error;
  }
  const elapsedMs = Date.now() - started;
  const helperPid = Number((await readFile(path.join(options.root, "helper.pid"), "utf8").catch(() => "")).trim());
  let helperAlive = false;
  if (Number.isInteger(helperPid) && helperPid > 0) {
    try {
      process.kill(helperPid, 0);
      helperAlive = true;
    } catch {
      // Already gone.
    }
  }
  // The helper is never signalled by PID: it ends by itself after HELPER_SECONDS.
  const helperGroupId = helperAlive
    ? Number((await exec("ps", ["-o", "pgid=", "-p", String(helperPid)]).catch(() => ({ stdout: "" }))).stdout.trim())
    : undefined;
  return { result, error, elapsedMs, passes, printLaunch: record.launches[0]!, helperAlive, helperGroupId, rootPid };
}

describe.skipIf(!posix)("launcher settlement without a recorded print root", () => {
  test("a child that is gone before its identity is read settles on its exit", async () => {
    const root = await createTestPluginDataRoot("rootless-gone");
    try {
      const { result, error, elapsedMs, passes, printLaunch } = await launch({ root, mode: "gone-before-probe" });
      expect(error).toBeUndefined();
      expect(result?.exitCode).toBe(0);
      expect(JSON.stringify(result?.records)).toContain("Instant answer from the stand-in.");
      expect(elapsedMs).toBeLessThan(STALL_MS);
      const accepted = passes.filter((pass) => pass.accepted);
      expect(accepted.length).toBeGreaterThan(0);
      // No pass that began before the exit, or before the pipes closed, was accepted.
      expect(passes.filter((pass) => pass.accepted && !(pass.exited && pass.closed))).toEqual([]);
      expect(passes.filter((pass) => !pass.accepted).every((pass) => pass.error === "SWARM_RECOVERY_REQUIRED")).toBe(true);
      expect(printLaunch).toMatchObject({ pending: false, uncertain: false, identities: [], rootUnidentified: true });
    } finally {
      await cleanupTestPath(root);
    }
  }, 15_000);

  test("a spawn probe that never returned an identity for a live child settles when that child exits", async () => {
    const root = await createTestPluginDataRoot("rootless-timeout");
    try {
      const { result, error, elapsedMs, passes, printLaunch } = await launch({
        root, mode: "probe-timed-out", env: { INSTANT_KIMI_DELAY: "0.4" },
      });
      expect(error).toBeUndefined();
      expect(result?.exitCode).toBe(0);
      const whileAlive = passes.filter((pass) => !pass.exited);
      expect(whileAlive.length).toBeGreaterThan(0);
      expect(whileAlive.filter((pass) => pass.accepted)).toEqual([]);
      expect(whileAlive.every((pass) => pass.error === "SWARM_RECOVERY_REQUIRED")).toBe(true);
      expect(passes.filter((pass) => pass.accepted).length).toBeGreaterThan(0);
      expect(passes.filter((pass) => pass.accepted && !(pass.exited && pass.closed))).toEqual([]);
      // 400 ms of life plus settlement, with no 2-second teardown stall on top.
      expect(elapsedMs).toBeLessThan(400 + STALL_MS);
      expect(printLaunch).toMatchObject({ pending: false, uncertain: false, identities: [], rootUnidentified: true });
    } finally {
      await cleanupTestPath(root);
    }
  }, 15_000);

  test("cancelling a live child whose identity was never read settles as a cancellation", async () => {
    const root = await createTestPluginDataRoot("rootless-cancel");
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 250).unref();
      const { result, error, elapsedMs, passes, printLaunch } = await launch({
        root, mode: "probe-timed-out", env: { INSTANT_KIMI_DELAY: "20" }, signal: controller.signal,
      });
      expect(error).toBeUndefined();
      expect(result?.aborted).toBe(true);
      expect(elapsedMs).toBeLessThan(250 + STALL_MS);
      expect(passes.filter((pass) => pass.accepted && !(pass.exited && pass.closed))).toEqual([]);
      expect(printLaunch).toMatchObject({ pending: false, identities: [], rootUnidentified: true });
    } finally {
      await cleanupTestPath(root);
    }
  }, 15_000);

  test("a helper left in the child's process group refuses settlement", async () => {
    const root = await createTestPluginDataRoot("rootless-ingroup");
    try {
      const run = await launch({ root, mode: "gone-before-probe", env: { INSTANT_KIMI_HELPER: "ingroup" } });
      expect(run.helperAlive).toBe(true);
      expect(run.helperGroupId).toBe(run.rootPid!);
      expect(run.result).toBeUndefined();
      expect(run.error).toMatchObject({ code: "CLI_PROCESS_SETTLEMENT_FAILED" });
      expect(run.error?.details).toMatchObject({ process_cleanup_unverified: true, process_exit_code: 0 });
      expect(run.passes.filter((pass) => pass.accepted)).toEqual([]);
      expect(run.printLaunch).toMatchObject({ pending: true, identities: [] });
      expect(run.printLaunch.rootUnidentified).toBeUndefined();
    } finally {
      await cleanupTestPath(root);
    }
  }, 15_000);

  test("a helper that left the group but holds the child's pipes fails settlement instead of waiting for it", async () => {
    const root = await createTestPluginDataRoot("rootless-detached");
    try {
      // Precondition: the tracker never saw the helper. If a pass happens to
      // catch it in the instant before it is orphaned, teardown stops it as a
      // tracked descendant, which is a different path; try again.
      let run = await launch({ root, mode: "gone-before-probe", env: { INSTANT_KIMI_HELPER: "detached" } });
      for (let attempt = 1; attempt < 5 && !run.helperAlive; attempt += 1) {
        run = await launch({ root, mode: "gone-before-probe", env: { INSTANT_KIMI_HELPER: "detached" } });
      }
      expect(run.helperAlive).toBe(true);
      expect(run.passes.filter((pass) => pass.identities > 0 && pass.exited)).toEqual([]);
      // Only the pipes can refuse this one: the helper is outside the child's group.
      expect(run.helperGroupId).toBeGreaterThan(1);
      expect(run.helperGroupId).not.toBe(run.rootPid!);
      expect(run.result).toBeUndefined();
      expect(run.error).toMatchObject({ code: "CLI_PROCESS_SETTLEMENT_FAILED" });
      // The helper holds the pipes for 4 seconds; the launcher must not wait for it.
      expect(run.elapsedMs).toBeLessThan(HELPER_SECONDS * 1_000 - 500);
      expect(run.passes.filter((pass) => pass.accepted)).toEqual([]);
      expect(run.passes.some((pass) => pass.exited && !pass.closed)).toBe(true);
      expect(run.printLaunch).toMatchObject({ pending: true, identities: [] });
    } finally {
      await cleanupTestPath(root);
    }
  }, 15_000);
});

// These run the compiled companion against a child that exits within
// milliseconds. Whether the spawn-time identity read wins that race is not
// forced here, so they hold on either path; the launcher tests above force it.
// They assert outcomes, not wall time: a stalled settlement ends as a failed job.
describe.skipIf(!posix)("compiled swarm against a child that exits at once", () => {
  async function run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
    const data = await createTestPluginDataRoot("rootless-swarm");
    const env: NodeJS.ProcessEnv = {
      ...process.env, KIMI_PLUGIN_CC_DATA: data, KIMI_CODE_HOME: path.join(data, "home"),
      KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1", KIMI_PLUGIN_CC_KIMI_BIN: instantKimi, ...options.env,
    };
    delete env.KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS;
    delete env.KIMI_MODEL_THINKING_EFFORT;
    const cwd = options.cwd ?? process.cwd();
    const launched = await exec("node", [companion, "task", "swarm", ...args, "--max-concurrency", "1", "inspect"], { env, cwd });
    const status = JSON.parse((await exec("node", [companion, "status"], { env, cwd })).stdout);
    const result = JSON.parse((await exec("node", [companion, "result", status.job_id, "--json"], { env, cwd })).stdout);
    return { data, launched, status, result };
  }
  const printLaunch = (status: { swarm_recovery?: { launches?: Array<Record<string, unknown>> } }) =>
    status.swarm_recovery?.launches?.find((entry) => entry.kind === "print");

  test("a clean instant exit completes", async () => {
    for (let round = 0; round < 3; round += 1) {
      const { data, launched, status, result } = await run([]);
      try {
        expect(status.status).toBe("completed");
        expect(result.error ?? null).toBeNull();
        expect(launched.stdout).toContain("Instant answer from the stand-in.");
        expect(printLaunch(status)).toMatchObject({ quiescent: true, pending: false, uncertain: false });
        expect(status.swarm_recovery.complete).toBe(true);
      } finally {
        await cleanupTestPath(data);
      }
    }
  }, 30_000);

  test("an instant startup failure reports the child's own failure, not a settlement failure", async () => {
    const { data, launched, status, result } = await run([], { env: { INSTANT_KIMI_EXIT_CODE: "64" } });
    try {
      expect(status.status).toBe("failed");
      expect(result.error.code).toBe("REVIEW_KIMI_STARTUP_FAILED");
      expect(JSON.stringify(result.error)).not.toContain("CLI_PROCESS_SETTLEMENT_FAILED");
      expect(JSON.stringify(result.error)).toContain("instant-kimi: forced startup failure");
      expect(launched.stderr).not.toContain("recovery record retained");
      expect(printLaunch(status)).toMatchObject({ quiescent: true, pending: false });
      expect(status.swarm_recovery.complete).toBe(true);
    } finally {
      await cleanupTestPath(data);
    }
  }, 30_000);

  test("a patch-only write swarm captures the child's edit after a clean instant exit", async () => {
    const repo = await createGitRepoFixture("rootless-write-repo");
    try {
      const { data, status, result } = await run(["--write"], { cwd: repo, env: { INSTANT_KIMI_WRITE: "rootless-edit.txt" } });
      try {
        expect(status.status).toBe("completed");
        expect(result.error ?? null).toBeNull();
        expect(printLaunch(status)).toMatchObject({ quiescent: true, pending: false, uncertain: false });
        expect(status.swarm_recovery.complete).toBe(true);
        const patch = await readFile(status.swarm_recovery.patchPath, "utf8");
        expect(patch).toContain("rootless-edit.txt");
        expect(patch).toContain("+written by the stand-in");
      } finally {
        await cleanupTestPath(data);
      }
    } finally {
      await cleanupTestPath(repo);
    }
  }, 30_000);
});
