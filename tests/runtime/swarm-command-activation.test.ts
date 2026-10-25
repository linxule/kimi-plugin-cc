import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { runSwarm } from "../../runtime/commands/swarm.js";
import { RuntimeError } from "../../runtime/errors.js";
import { removeWorktree, resolveRepoIdentity } from "../../runtime/git.js";
import { JobStore, type JobRecord } from "../../runtime/job-store.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import type { CommandContext } from "../../runtime/types.js";
import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";

const mockWebPath = path.join(process.cwd(), "tests/helpers/mock-kimi-web.mjs");
const nodeCommand = Bun.which("node") ?? "node";
const proseSentinel = "Swarm command prose sentinel.";

interface Fixture {
  readonly stateRoot: string;
  readonly pluginData: string;
  readonly repo: string;
  readonly home: string;
  readonly logPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly write: boolean;
}

interface LogEntry {
  readonly pid: number;
  readonly kind: string;
  readonly argv?: string[];
  readonly cwd?: string;
  readonly path?: string;
  readonly body?: any;
}

async function createFixture(scenario: string, write: boolean): Promise<Fixture> {
  const stateRoot = await createTestPluginDataRoot("swarm-command-state");
  const pluginData = await createTestPluginDataRoot("swarm-command-data");
  const repo = await createGitRepoFixture("swarm-command-repo");
  const home = path.join(stateRoot, "kimi-home");
  const logPath = path.join(stateRoot, "mock-web.jsonl");
  await mkdir(home, { recursive: true });
  return {
    stateRoot,
    pluginData,
    repo,
    home,
    logPath,
    write,
    env: {
      HOME: stateRoot,
      PATH: process.env.PATH,
      CLAUDE_PLUGIN_DATA: pluginData,
      KIMI_CODE_HOME: home,
      KIMI_PLUGIN_CC_KIMI_BIN: nodeCommand,
      KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify([mockWebPath]),
      KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
      MOCK_KIMI_WEB_SCENARIO: scenario,
      MOCK_KIMI_WEB_LOG: logPath,
      MOCK_KIMI_WEB_PRINT_PROSE: proseSentinel,
    },
  };
}

async function destroyFixture(fixture: Fixture): Promise<void> {
  for (const entry of await readLog(fixture)) {
    if (entry.kind !== "spawn" && entry.kind !== "descendant" && entry.kind !== "print") continue;
    try {
      process.kill(-entry.pid, "SIGKILL");
    } catch {
      try {
        process.kill(entry.pid, "SIGKILL");
      } catch {
      }
    }
  }
  const repoId = (await resolveRepoIdentity(fixture.repo)).repoId;
  const worktreeRoot = path.join(resolvePluginPaths(fixture.env).worktreesDir, repoId);
  for (const entry of await readdir(worktreeRoot).catch(() => [])) {
    await removeWorktree(fixture.repo, path.join(worktreeRoot, entry)).catch(() => undefined);
  }
  await cleanupTestPath(fixture.stateRoot);
  await cleanupTestPath(fixture.pluginData);
  await cleanupTestPath(fixture.repo);
}

async function withFixture(
  scenario: string,
  write: boolean,
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const fixture = await createFixture(scenario, write);
  try {
    await run(fixture);
  } finally {
    await destroyFixture(fixture);
  }
}

function context(fixture: Fixture): CommandContext {
  return { cwd: fixture.repo, env: fixture.env, stdout: process.stdout, stderr: process.stderr };
}

async function readLog(fixture: Fixture): Promise<LogEntry[]> {
  try {
    const text = await readFile(fixture.logPath, "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function waitForLog(
  fixture: Fixture,
  predicate: (entry: LogEntry) => boolean,
): Promise<LogEntry> {
  const deadline = Date.now() + 4_000;
  while (true) {
    const entry = (await readLog(fixture)).find(predicate);
    if (entry !== undefined) return entry;
    if (Date.now() >= deadline) throw new Error("timed out waiting for command lifecycle log");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function latestJob(fixture: Fixture): Promise<JobRecord> {
  const repoId = (await resolveRepoIdentity(fixture.repo)).repoId;
  const store = new JobStore(resolvePluginPaths(fixture.env));
  try {
    const job = store.findLatestJob({
      repoId,
      commandType: fixture.write ? "rescue" : "review",
    });
    expect(job).not.toBeNull();
    return job!;
  } finally {
    store.close();
  }
}

function profileRequests(entries: readonly LogEntry[], active: boolean): LogEntry[] {
  return entries.filter((entry) =>
    entry.kind === "request" && entry.path?.endsWith("/profile") &&
    entry.body?.agent_config?.swarm_mode === active);
}

function printEntries(entries: readonly LogEntry[]): LogEntry[] {
  return entries.filter((entry) => entry.kind === "print");
}

async function runSwarmFault(
  activationError: RuntimeError,
  options: { write?: boolean; budgetMs?: number; deactivate?: () => Promise<void> } = {},
): Promise<{ result: any; retained: boolean; deactivations: number }> {
  const source = await readFile(path.join(process.cwd(), "runtime/commands/swarm.ts"), "utf8");
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
    source.slice(source.indexOf("async function executeSwarmJob(")),
  );
  const controller = new AbortController();
  const job = { job_id: "job", cwd: "/virtual", status: "running", kimi_session_id: null };
  let retained = false;
  let deactivations = 0;
  const bindings = {
    RuntimeError,
    ResponseTimeoutError: class extends RuntimeError {
      constructor(budgetMs: number, stage: string) {
        super("RESPONSE_TIMEOUT", `${stage} timed out`, stage, { details: { budget_ms: budgetMs } });
      }
    },
    resolvePluginPaths: () => ({}),
    ensurePluginPaths: async () => undefined,
    JobStore: class {
      getJob() { return { ...job }; }
      updateRunningJob() {}
      close() {}
    },
    createCliCancellationHandlers: () => ({
      signal: controller.signal,
      cancelling: false,
      dispose() {},
    }),
    executionPlanFromPersisted: () => ({ command: "fake", prefixArgs: [], kimiVersion: "2.3.2" }),
    requiresSwarmPreactivation: () => true,
    preactivateSwarmSession: async () => { throw activationError; },
    deactivateSwarmSession: async () => {
      deactivations += 1;
      await options.deactivate?.();
    },
    capturePatchArtifact: async () => ({ path: "/virtual/patch", bytes: 0, empty: true }),
    classifyManagedCommandFailure: (error: unknown) => error,
    markJobFailed: async (_store: unknown, _paths: unknown, _job: unknown, error: unknown) => ({ ...job, error }),
  };
  const execute = new Function(...Object.keys(bindings), `${code}; return executeSwarmJob;`)(
    ...Object.values(bindings),
  ) as (...args: any[]) => Promise<any>;
  const result = await execute(
    "job",
    "prompt",
    "objective",
    options.budgetMs ?? 10_000,
    1,
    { env: { KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1" }, stderr: { write() {} } },
    options.write
      ? {
          workspaceRoot: "/virtual/worktree",
          spawnCwd: "/virtual/worktree",
          onPatchCaptureFailure() { retained = true; },
        }
      : undefined,
  );
  return { result, retained, deactivations };
}

describe("runSwarm 2.3.2 preactivation orchestration", () => {
  test("persists preactivated identity, resumes it, and keeps activation in turn-running", async () => {
    await withFixture("success", false, async (fixture) => {
      fixture.env.MOCK_KIMI_WEB_PRINT_DELAY_MS = "200";
      const pending = runSwarm(["inspect", "activation"], context(fixture));
      const print = await waitForLog(fixture, (entry) => entry.kind === "print");
      const running = await latestJob(fixture);
      expect(running.kimi_version).toBe("2.3.2");
      expect(running.kimi_session_id).toBe("session_mock");
      expect(running.kimi_session_id_source).toBe("preactivated");
      expect(running.phase).toBe("turn-running");
      expect(running.phase).not.toBe("attached");
      expect(running.phase).not.toBe("attaching");
      const resumeIndex = print.argv!.indexOf("-r");
      expect(resumeIndex).toBeGreaterThanOrEqual(0);
      expect(print.argv![resumeIndex + 1]).toBe("session_mock");

      await expect(pending).resolves.toContain(proseSentinel);
      const completed = await latestJob(fixture);
      expect(completed.status).toBe("completed");
      expect(completed.phase).toBe("done");
      expect(completed.system_version).toBe("2.3.2");
      expect(completed.observed_engine).toBe("native-v2");
      expect(completed.kimi_session_id).toBe("session_mock");
      expect(completed.kimi_session_id_source).toBe("preactivated");
      const log = await readLog(fixture);
      expect(printEntries(log)).toHaveLength(1);
      expect(profileRequests(log, false)).toHaveLength(1);
    });
  }, 20_000);

  test("rejects a different resumed session only after deactivating the preactivated one", async () => {
    await withFixture("session-mismatch", false, async (fixture) => {
      await runSwarm(["inspect", "session", "mismatch"], context(fixture));
      const job = await latestJob(fixture);
      expect(job.status).toBe("failed");
      expect(job.error).toMatchObject({
        code: "SWARM_SESSION_MISMATCH",
        stage: "swarm.session-provenance",
        details: { expected_session_id: "session_mock", actual_session_id: "session_other" },
      });
      expect(job.kimi_session_id).toBe("session_mock");
      expect(job.kimi_session_id_source).toBe("preactivated");
      expect(job.system_version).toBe("2.3.2");
      const log = await readLog(fixture);
      expect(profileRequests(log, false)).toHaveLength(1);
      expect(printEntries(log)).toHaveLength(1);
    });
  }, 20_000);

  test("success cleanup failure preserves provenance, prose, hook evidence, and the write worktree", async () => {
    await withFixture("deactivate-rest-failure", true, async (fixture) => {
      let caught: unknown;
      try {
        await runSwarm(["--write", "preserve", "cleanup", "evidence"], context(fixture));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RuntimeError);
      expect((caught as RuntimeError).code).toBe("SWARM_SESSION_CLEANUP_FAILED");
      const job = await latestJob(fixture);
      expect(job.status).toBe("failed");
      expect(job.system_version).toBe("2.3.2");
      expect(job.observed_engine).toBe("native-v2");
      expect(job.kimi_session_id).toBe("session_mock");
      expect(job.kimi_session_id_source).toBe("preactivated");
      expect(job.hook_escapes).not.toBeNull();
      expect(JSON.parse(job.hook_escapes!)).toEqual([
        expect.objectContaining({
          tool_call_id: "print-plan-1",
          tool_name: "EnterPlanMode",
          kind: "mismatch",
        }),
      ]);
      expect(job.error?.details?.cleanup_error).toMatchObject({
        code: "SWARM_SESSION_CLEANUP_FAILED",
        cancelled: false,
      });
      expect(job.error?.details?.worktreePath).toEqual(expect.any(String));
      expect(existsSync(job.error!.details!.worktreePath as string)).toBe(true);
      expect(job.error?.details?.rawOutput).toContain(proseSentinel);
      expect(profileRequests(await readLog(fixture), false)).toHaveLength(1);
    });
  }, 20_000);

  test("bounds success deactivation by the remaining budget and preserves cleanup evidence", async () => {
    await withFixture("success", true, async (fixture) => {
      fixture.env.MOCK_KIMI_WEB_DEACTIVATE_STATUS_DELAY_MS = "5000";
      let caught: unknown;
      try {
        await runSwarm(["--write", "--budget", "1s", "bounded", "cleanup"], context(fixture));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RuntimeError);
      expect((caught as RuntimeError).code).toBe("RESCUE_KIMI_RESPONSE_TIMEOUT");
      expect((caught as RuntimeError).stage).toBe("swarm.cleanup");
      const job = await latestJob(fixture);
      expect(job.status).toBe("failed");
      const worktreePath = job.error?.details?.worktreePath;
      expect(worktreePath).toEqual(expect.any(String));
      expect(job.error).toMatchObject({
        code: "RESCUE_KIMI_RESPONSE_TIMEOUT",
        stage: "swarm.cleanup",
        details: {
          budget_ms: 1_000,
          cleanup_error: { code: "SWARM_SESSION_CLEANUP_FAILED", unverified: true },
          rawOutput: proseSentinel,
        },
      });
      expect(existsSync(worktreePath as string)).toBe(true);
      const log = await readLog(fixture);
      expect(log.filter((entry) => entry.kind === "spawn")).toHaveLength(2);
      expect(profileRequests(log, false)).toHaveLength(1);
    });
  }, 20_000);

  test("charges preactivation against the existing budget and verifies cleanup after timeout", async () => {
    await withFixture("success", false, async (fixture) => {
      fixture.env.MOCK_KIMI_WEB_STATUS_DELAY_MS = "5000";
      fixture.env.MOCK_KIMI_WEB_DEACTIVATE_STATUS_DELAY_MS = "0";
      const started = Date.now();
      await runSwarm(["--budget", "1s", "activation", "budget"], context(fixture));
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(8_000);
      const job = await latestJob(fixture);
      expect(job.status).toBe("failed");
      expect(job.budget_ms).toBe(1_000);
      expect(job.kimi_session_id).toBe("session_mock");
      expect(job.kimi_session_id_source).toBe("preactivated");
      expect(job.error).toMatchObject({
        code: "REVIEW_KIMI_RESPONSE_TIMEOUT",
        stage: "swarm.activation",
        details: { budget_ms: 1_000 },
      });
      expect(job.error?.details?.cleanup_error).toBeUndefined();
      const journal = await readFile(
        path.join(fixture.home, "sessions", "wd_mock", "session_mock", "agents", "main", "wire.jsonl"),
        "utf8",
      );
      expect(journal.trim().split("\n").map((line) => JSON.parse(line)).at(-1))
        .toMatchObject({ type: "swarm_mode.exit" });
      const log = await readLog(fixture);
      expect(printEntries(log)).toEqual([]);
      expect(log.filter((entry) => entry.kind === "spawn")).toHaveLength(2);
      expect(profileRequests(log, false)).toHaveLength(1);
    });
  }, 20_000);

  test("retains the write worktree when activation-timeout cleanup is unverified", async () => {
    await withFixture("deactivate-rest-failure", true, async (fixture) => {
      fixture.env.MOCK_KIMI_WEB_STATUS_DELAY_MS = "5000";
      fixture.env.MOCK_KIMI_WEB_DEACTIVATE_STATUS_DELAY_MS = "0";
      await expect(runSwarm(["--write", "--budget", "1s", "retain", "activation"], context(fixture)))
        .rejects.toMatchObject({ code: "RESCUE_KIMI_RESPONSE_TIMEOUT", stage: "swarm.activation" });
      const job = await latestJob(fixture);
      const worktreePath = job.error?.details?.worktreePath;
      expect(worktreePath).toEqual(expect.any(String));
      expect(job.error?.details?.cleanup_error).toMatchObject({
        code: "SWARM_SESSION_CLEANUP_FAILED",
        cancelled: false,
        unverified: true,
      });
      expect(existsSync(worktreePath as string)).toBe(true);
      expect(profileRequests(await readLog(fixture), false)).toHaveLength(1);
    });
  }, 20_000);

  test("retains identity and the write worktree when rejected activation cleanup fails", async () => {
    await withFixture("composite-failure", true, async (fixture) => {
      await expect(runSwarm(["--write", "activation", "cleanup", "failure"], context(fixture)))
        .rejects.toMatchObject({ code: "SWARM_ACTIVATION_FAILED", stage: "swarm-activation.status" });
      const job = await latestJob(fixture);
      expect(job.kimi_session_id).toBe("session_mock");
      expect(job.kimi_session_id_source).toBe("preactivated");
      const worktreePath = job.error?.details?.worktreePath;
      expect(worktreePath).toEqual(expect.any(String));
      expect(existsSync(worktreePath as string)).toBe(true);
      expect(job.error?.details?.cleanup_error).toMatchObject({
        code: "SWARM_SESSION_CLEANUP_FAILED",
        cancelled: false,
        unverified: true,
      });
      const log = await readLog(fixture);
      expect(log.filter((entry) => entry.kind === "spawn")).toHaveLength(2);
      expect(profileRequests(log, false)).toHaveLength(1);
      expect(printEntries(log)).toEqual([]);
    });
  }, 20_000);

  test("retains the write worktree when activation is cancelled after mutation", async () => {
    await withFixture("success", true, async (fixture) => {
      fixture.env.MOCK_KIMI_WEB_STATUS_DELAY_MS = "5000";
      const baseline = process.listeners("SIGTERM");
      const pending = runSwarm(["--write", "cancel", "mutated", "activation"], context(fixture));
      await waitForLog(fixture, (entry) =>
        entry.kind === "request" && entry.path?.endsWith("/profile") === true &&
        entry.body?.agent_config?.swarm_mode === true);
      const added = process.listeners("SIGTERM").filter((listener) => !baseline.includes(listener));
      expect(added).toHaveLength(1);
      added[0]!("SIGTERM");
      await expect(pending).rejects.toMatchObject({ code: "SWARM_CANCELLED" });
      const job = await latestJob(fixture);
      expect(job.status).toBe("cancelled");
      expect(job.kimi_session_id).toBe("session_mock");
      expect(job.kimi_session_id_source).toBe("preactivated");
      const worktreePath = job.error?.details?.worktreePath;
      expect(worktreePath).toEqual(expect.any(String));
      expect(existsSync(worktreePath as string)).toBe(true);
      expect(job.error?.details?.cleanup_error).toMatchObject({ cancelled: true, unverified: true });
      const log = await readLog(fixture);
      expect(log.filter((entry) => entry.kind === "spawn")).toHaveLength(1);
      expect(profileRequests(log, false)).toEqual([]);
      expect(printEntries(log)).toEqual([]);
    });
  }, 20_000);

  test("does not invent cleanup evidence when activation has no session identity", async () => {
    await withFixture("success", true, async (fixture) => {
      fixture.env.MOCK_KIMI_WEB_CREATE_SESSION_DELAY_MS = "5000";
      await runSwarm(["--write", "--budget", "1s", "no", "identity"], context(fixture));
      const job = await latestJob(fixture);
      expect(job.error).toMatchObject({ code: "RESCUE_KIMI_RESPONSE_TIMEOUT", stage: "swarm.activation" });
      expect(job.error?.details?.cleanup_error).toBeUndefined();
      expect(job.error?.details?.worktreePath).toBeUndefined();
      const repoId = (await resolveRepoIdentity(fixture.repo)).repoId;
      const worktreeRoot = path.join(resolvePluginPaths(fixture.env).worktreesDir, repoId);
      expect(await readdir(worktreeRoot)).toEqual([]);
      const log = await readLog(fixture);
      expect(log.filter((entry) => entry.kind === "spawn")).toHaveLength(1);
      expect(profileRequests(log, false)).toEqual([]);
    });
  }, 20_000);

  test("cancels activation-timeout recovery without waiting for its REST delay", async () => {
    await withFixture("success", false, async (fixture) => {
      fixture.env.MOCK_KIMI_WEB_STATUS_DELAY_MS = "5000";
      fixture.env.MOCK_KIMI_WEB_DEACTIVATE_STATUS_DELAY_MS = "5000";
      const baseline = process.listeners("SIGTERM");
      const started = Date.now();
      const pending = runSwarm(["--budget", "1s", "cancel", "recovery"], context(fixture));
      await waitForLog(fixture, (entry) =>
        entry.kind === "request" && entry.path?.endsWith("/profile") === true &&
        entry.body?.agent_config?.swarm_mode === false);
      const added = process.listeners("SIGTERM").filter((listener) => !baseline.includes(listener));
      expect(added).toHaveLength(1);
      added[0]!("SIGTERM");
      await pending;
      expect(Date.now() - started).toBeLessThan(4_000);
      const job = await latestJob(fixture);
      expect(job.status).toBe("cancelled");
      expect(job.error).toMatchObject({
        code: "SWARM_CANCELLED",
        details: { cleanup_error: { cancelled: true, unverified: true } },
      });
      expect(printEntries(await readLog(fixture))).toEqual([]);
    });
  }, 20_000);

  test("runs exactly one bounded cleanup after activation rejection", async () => {
    await withFixture("status-plan-mismatch", false, async (fixture) => {
      fixture.env.MOCK_KIMI_WEB_DEACTIVATE_STATUS_DELAY_MS = "5000";
      await runSwarm(["--budget", "5s", "single", "activation", "rollback"], context(fixture));
      const job = await latestJob(fixture);
      expect(job.error).toMatchObject({
        code: "SWARM_ACTIVATION_FAILED",
        stage: "swarm-activation.status",
        details: {
          cleanup_error: { code: "SWARM_SESSION_CLEANUP_FAILED", cancelled: false, unverified: true },
        },
      });
      const log = await readLog(fixture);
      expect(log.filter((entry) => entry.kind === "spawn")).toHaveLength(2);
      expect(profileRequests(log, false)).toHaveLength(1);
      expect(printEntries(log)).toEqual([]);
    });
  }, 20_000);

  test("deactivates after a print budget timeout", async () => {
    await withFixture("success", false, async (fixture) => {
      fixture.env.MOCK_KIMI_WEB_PRINT_DELAY_MS = "4000";
      fixture.env.MOCK_KIMI_WEB_DEACTIVATE_STATUS_DELAY_MS = "0";
      await runSwarm(["--budget", "1s", "print", "timeout", "cleanup"], context(fixture));
      const job = await latestJob(fixture);
      expect(job.error).toMatchObject({ code: "REVIEW_KIMI_RESPONSE_TIMEOUT", stage: "swarm.prompt" });
      expect(job.error?.details?.cleanup_error).toBeUndefined();
      const journal = await readFile(
        path.join(fixture.home, "sessions", "wd_mock", "session_mock", "agents", "main", "wire.jsonl"),
        "utf8",
      );
      expect(journal.trim().split("\n").map((line) => JSON.parse(line)).at(-1))
        .toMatchObject({ type: "swarm_mode.exit" });
      const log = await readLog(fixture);
      expect(log.filter((entry) => entry.kind === "spawn")).toHaveLength(2);
      expect(profileRequests(log, false)).toHaveLength(1);
      expect(printEntries(log)).toHaveLength(1);
    });
  }, 20_000);

  test("preserves a nonzero print failure when cleanup also fails", async () => {
    await withFixture("success", false, async (fixture) => {
      fixture.env.MOCK_KIMI_WEB_PRINT_EXIT_CODE = "7";
      fixture.env.MOCK_KIMI_WEB_PRINT_STDERR = "print-failure-sentinel";
      fixture.env.MOCK_KIMI_WEB_DEACTIVATE_STATUS_DELAY_MS = "5000";
      await runSwarm(["--budget", "1s", "print", "failure", "cleanup"], context(fixture));
      const job = await latestJob(fixture);
      expect(job.error).toMatchObject({
        code: "REVIEW_KIMI_STARTUP_FAILED",
        stage: "swarm.runtime",
        details: {
          cause_code: "CLI_NONZERO_EXIT",
          exit_code: 7,
          cleanup_error: { code: "SWARM_SESSION_CLEANUP_FAILED", cancelled: false, unverified: true },
          rawOutput: proseSentinel,
        },
      });
      expect(job.error?.details?.cause_message).toContain("print-failure-sentinel");
      const log = await readLog(fixture);
      expect(log.filter((entry) => entry.kind === "spawn")).toHaveLength(2);
      expect(profileRequests(log, false)).toHaveLength(1);
      expect(printEntries(log)).toHaveLength(1);
    });
  }, 20_000);

  test("retains an established print failure when cancellation interrupts cleanup", async () => {
    await withFixture("success", false, async (fixture) => {
      fixture.env.MOCK_KIMI_WEB_PRINT_EXIT_CODE = "7";
      fixture.env.MOCK_KIMI_WEB_PRINT_STDERR = "cancelled-print-failure-sentinel";
      fixture.env.MOCK_KIMI_WEB_DEACTIVATE_STATUS_DELAY_MS = "5000";
      const baseline = process.listeners("SIGTERM");
      const pending = runSwarm(["print", "failure", "cancel", "cleanup"], context(fixture));
      await waitForLog(fixture, (entry) =>
        entry.kind === "request" && entry.path?.endsWith("/profile") === true &&
        entry.body?.agent_config?.swarm_mode === false);
      const added = process.listeners("SIGTERM").filter((listener) => !baseline.includes(listener));
      expect(added).toHaveLength(1);
      added[0]!("SIGTERM");
      await pending;
      const job = await latestJob(fixture);
      expect(job.status).toBe("cancelled");
      expect(job.error).toMatchObject({
        code: "SWARM_CANCELLED",
        details: {
          cause_code: "CLI_NONZERO_EXIT",
          exit_code: 7,
          cleanup_error: { cancelled: true, unverified: true },
        },
      });
      expect(job.error?.details?.cause_message).toContain("cancelled-print-failure-sentinel");
      const log = await readLog(fixture);
      expect(log.filter((entry) => entry.kind === "spawn")).toHaveLength(2);
      expect(profileRequests(log, false)).toHaveLength(1);
      expect(printEntries(log)).toHaveLength(1);
    });
  }, 20_000);

  test("cancels during print without starting a fresh cleanup server", async () => {
    await withFixture("success", false, async (fixture) => {
      fixture.env.MOCK_KIMI_WEB_PRINT_DELAY_MS = "4000";
      const baseline = process.listeners("SIGTERM");
      const pending = runSwarm(["cancel", "during", "print"], context(fixture));
      await waitForLog(fixture, (entry) => entry.kind === "print");
      const added = process.listeners("SIGTERM").filter((listener) => !baseline.includes(listener));
      expect(added).toHaveLength(1);
      added[0]!("SIGTERM");
      await pending;
      const job = await latestJob(fixture);
      expect(job.status).toBe("cancelled");
      expect(job.error).toMatchObject({
        code: "SWARM_CANCELLED",
        details: { cleanup_error: { cancelled: true, unverified: true } },
      });
      const log = await readLog(fixture);
      expect(log.filter((entry) => entry.kind === "spawn")).toHaveLength(1);
      expect(profileRequests(log, false)).toEqual([]);
      expect(printEntries(log)).toHaveLength(1);
    });
  }, 20_000);

  test("routes process-only cleanup uncertainty to worktree retention without a session id", async () => {
    const { result, retained, deactivations } = await runSwarmFault(
      new RuntimeError(
        "SWARM_SESSION_CLEANUP_FAILED",
        "The Kimi web process tree did not become quiescent after startup failed.",
        "swarm-activation.ready-cleanup",
        { details: { process_cleanup_unverified: true } },
      ),
      { write: true },
    );
    expect(retained).toBe(true);
    expect(deactivations).toBe(0);
    expect(result.error).toMatchObject({
      code: "SWARM_SESSION_CLEANUP_FAILED",
      stage: "swarm-activation.ready-cleanup",
      details: {
        process_cleanup_unverified: true,
        worktreePath: "/virtual/worktree",
        cleanup_error: { cancelled: false, unverified: true },
      },
    });
    expect(result.error.details.session_id).toBeUndefined();
  });

  test("keeps activation failure primary when recovery crosses the budget deadline", async () => {
    const { result, deactivations } = await runSwarmFault(
      new RuntimeError("SWARM_ACTIVATION_FAILED", "status rejection", "swarm-activation.status", {
        details: { session_id: "session_mock", workspace_id: "wd_mock" },
      }),
      {
        budgetMs: 1_000,
        deactivate: () => new Promise<void>((resolve) => setTimeout(resolve, 1_100)),
      },
    );
    expect(deactivations).toBe(1);
    expect(result.error).toMatchObject({ code: "SWARM_ACTIVATION_FAILED", stage: "swarm-activation.status" });
    expect(result.error.details.cleanup_error).toBeUndefined();
  });

  test("cancels during activation without printing or starting fresh cleanup", async () => {
    await withFixture("success", false, async (fixture) => {
      fixture.env.MOCK_KIMI_WEB_STATUS_DELAY_MS = "5000";
      const baseline = process.listeners("SIGTERM");
      const started = Date.now();
      const pending = runSwarm(["cancel", "during", "activation"], context(fixture));
      await waitForLog(fixture, (entry) =>
        entry.kind === "request" && entry.path?.endsWith("/profile") === true &&
        entry.body?.agent_config?.swarm_mode === true);
      const added = process.listeners("SIGTERM").filter((listener) => !baseline.includes(listener));
      expect(added).toHaveLength(1);
      added[0]!("SIGTERM");
      await pending;
      expect(Date.now() - started).toBeLessThan(4_000);
      const job = await latestJob(fixture);
      expect(job.status).toBe("cancelled");
      expect(job.error?.code).toBe("SWARM_CANCELLED");
      const log = await readLog(fixture);
      expect(printEntries(log)).toEqual([]);
      expect(log.filter((entry) => entry.kind === "spawn")).toHaveLength(1);
      expect(profileRequests(log, false)).toEqual([]);
    });
  }, 20_000);
});
