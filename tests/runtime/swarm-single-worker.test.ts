import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { runSwarm } from "../../runtime/commands/swarm.js";
import { removeWorktree, resolveRepoIdentity } from "../../runtime/git.js";
import { JobStore, type JobRecord } from "../../runtime/job-store.js";
import { NATIVE_V2_CERTIFIED, type KimiOperationKind } from "../../runtime/kimi-engine.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import { probeProcessIdentity } from "../../runtime/process-tree.js";
import type { CommandContext } from "../../runtime/types.js";
import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";

const nodeCommand = Bun.which("node") ?? "node";
const prose = "Single worker completed the requested task.";
const edit = "export const singleWorker = true;\n";

interface Invocation {
  pid: number;
  kind: string;
  argv: string[];
  cwd: string;
  env: Record<string, string | null>;
  path?: string;
  body?: { agent_config?: { swarm_mode?: boolean } };
}

interface Fixture {
  root: string;
  repo: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  write: boolean;
  initialStatus: string;
  initialWorktrees: string;
}

const workerStub = `
import { appendFile, writeFile } from 'node:fs/promises';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.6.2'); process.exit(0); }
const env = Object.fromEntries([
  'KIMI_PLUGIN_CC_OPERATION', 'KIMI_PLUGIN_CC_CMD', 'KIMI_PLUGIN_CC_WORKSPACE_ROOT',
  'KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY', 'KIMI_CODE_SWARM_TIMEOUT_MS'
].map(key => [key, process.env[key] ?? null]));
if (!args.includes('-p') || args.includes('-r')) {
  await appendFile(process.env.SINGLE_WORKER_TEST_LOG, JSON.stringify({pid:process.pid,kind:'unexpected',argv:args,cwd:process.cwd(),env})+'\\n');
  process.exit(91);
}
console.log(JSON.stringify({role:'meta', type:'system.version', version:'2.6.2'}));
if (process.env.SINGLE_WORKER_TEST_WRITE === '1') await writeFile('single-worker.ts', ${JSON.stringify(edit)});
await appendFile(process.env.SINGLE_WORKER_TEST_LOG, JSON.stringify({pid:process.pid,kind:'print',argv:args,cwd:process.cwd(),env})+'\\n');
await new Promise(resolve => setTimeout(resolve, Number(process.env.SINGLE_WORKER_TEST_HOLD_MS ?? 0)));
console.log(JSON.stringify({role:'assistant',content:${JSON.stringify(prose)}}));
console.log(JSON.stringify({role:'meta',type:'session.resume_hint',session_id:'single_worker_session',command:'kimi -r single_worker_session',content:'To resume this session: kimi -r single_worker_session'}));
`;

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

async function withFixture(write: boolean, run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await createTestPluginDataRoot("swarm-single-state");
  const repo = await createGitRepoFixture("swarm-single-repo");
  const home = path.join(root, "home");
  const stub = path.join(root, "worker.mjs");
  const logPath = path.join(root, "invocations.jsonl");
  await mkdir(home);
  await writeFile(stub, workerStub);
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    PATH: process.env.PATH,
    KIMI_PLUGIN_CC_DATA: path.join(root, "data"),
    KIMI_CODE_HOME: home,
    KIMI_PLUGIN_CC_KIMI_BIN: nodeCommand,
    KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify([stub]),
    KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
    KIMI_PLUGIN_CC_DISABLE_WEB_ANNOUNCE: "1",
    SINGLE_WORKER_TEST_LOG: logPath,
    SINGLE_WORKER_TEST_WRITE: write ? "1" : "0",
  };
  // Candidate-only until the production capability row is added after the
  // real-binary gate. Restore the operation map so this fixture grants no
  // capability to other tests.
  const matrix = NATIVE_V2_CERTIFIED as Map<KimiOperationKind, readonly string[]>;
  const operation = write ? "swarm-write" : "swarm";
  const previous = matrix.get(operation)!;
  matrix.set(operation, [...new Set([...previous, "2.6.2"])]);
  try {
    await run({ root, repo, env, logPath, write,
      initialStatus: git(repo, ["status", "--porcelain", "--untracked-files=all"]),
      initialWorktrees: git(repo, ["worktree", "list", "--porcelain"]),
    });
  } finally {
    matrix.set(operation, previous);
    await cleanupTestPath(root);
    await cleanupTestPath(repo);
  }
}

function context(fixture: Fixture): CommandContext {
  return { cwd: fixture.repo, env: fixture.env, stdout: process.stdout, stderr: process.stderr };
}

async function invocations(fixture: Fixture): Promise<Invocation[]> {
  const value = await readFile(fixture.logPath, "utf8").catch(() => "");
  return value.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForPrint(fixture: Fixture): Promise<Invocation> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const entry = (await invocations(fixture)).find((candidate) => candidate.kind === "print");
    if (entry) return entry;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("single-worker print did not start");
}

async function latestJob(fixture: Fixture): Promise<JobRecord> {
  const repoId = (await resolveRepoIdentity(fixture.repo)).repoId;
  const store = new JobStore(resolvePluginPaths(fixture.env));
  try {
    const job = store.findLatestJob({ repoId, commandType: fixture.write ? "rescue" : "review" });
    expect(job).not.toBeNull();
    const recovery = store.getSwarmRecovery(job!.job_id)?.record;
    expect(recovery).toBeDefined();
    expect(recovery!.session).toBeNull();
    expect(recovery!.sessionDirty).toBe(false);
    expect(recovery!.launches).toHaveLength(1);
    expect(recovery!.launches[0]!.kind).toBe("print");
    expect(recovery!.complete).toBe(job!.status !== "failed");
    return job!;
  } finally {
    store.close();
  }
}

async function assertDirectWorker(fixture: Fixture, operation: "swarm" | "swarm-write"): Promise<Invocation> {
  const entries = await invocations(fixture);
  expect(entries).toHaveLength(1);
  const invocation = entries[0]!;
  expect(invocation.kind).toBe("print");
  expect(invocation.argv).not.toContain("-r");
  expect(invocation.argv).not.toContain("web");
  expect(invocation.argv).toContain("--environment");
  expect(invocation.argv[invocation.argv.indexOf("--environment") + 1]).toBe("local");
  expect(invocation.env).toMatchObject({
    KIMI_PLUGIN_CC_OPERATION: operation,
    KIMI_PLUGIN_CC_CMD: operation,
    KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: "1",
    KIMI_CODE_SWARM_TIMEOUT_MS: "2147483647",
  });
  const prompt = invocation.argv[invocation.argv.indexOf("-p") + 1]!;
  expect(prompt).not.toContain("Launch the parallel fan-out");
  expect(prompt).not.toContain("Coordinate a parallel CODE-EDITING task");
  const processProbe = await probeProcessIdentity(invocation.pid);
  expect(processProbe.complete).toBe(true);
  expect(processProbe.identity).toBeUndefined();
  return invocation;
}

async function assertPatchAndUserTree(fixture: Fixture, job: JobRecord, invocation: Invocation, retained = false): Promise<void> {
  const paths = resolvePluginPaths(fixture.env);
  const patch = await readFile(path.join(paths.artifactsDir, `swarm-write-${job.job_id}.patch`), "utf8");
  expect(patch).toContain("+++ b/single-worker.ts");
  expect(patch).toContain("+export const singleWorker = true;");
  expect(invocation.cwd).not.toBe(await realpath(fixture.repo));
  expect(invocation.env.KIMI_PLUGIN_CC_WORKSPACE_ROOT).toBe(invocation.cwd);
  expect(existsSync(invocation.cwd)).toBe(retained);
  expect(existsSync(path.join(fixture.repo, "single-worker.ts"))).toBe(false);
  expect(git(fixture.repo, ["status", "--porcelain", "--untracked-files=all"])).toBe(fixture.initialStatus);
  if (retained) {
    expect(git(fixture.repo, ["worktree", "list", "--porcelain"])).toContain(invocation.cwd);
    await removeWorktree(fixture.repo, invocation.cwd);
  }
  expect(git(fixture.repo, ["worktree", "list", "--porcelain"])).toBe(fixture.initialWorktrees);
}

describe("exact 2.6.2 single-worker swarm orchestration", () => {
  test("read concurrency one starts fresh and preserves swarm provenance", async () => {
    await withFixture(false, async (fixture) => {
      const output = await runSwarm(["--max-concurrency", "1", "inspect one target"], context(fixture));
      expect(output).toContain(prose);
      const invocation = await assertDirectWorker(fixture, "swarm");
      expect(invocation.cwd).toBe(await realpath(fixture.repo));
      const job = await latestJob(fixture);
      expect(job).toMatchObject({ status: "completed", operation_kind: "swarm", intended_engine: "native-v2",
        observed_engine: "native-v2", kimi_version: "2.6.2", system_version: "2.6.2",
        kimi_session_id: "single_worker_session", kimi_session_id_source: "announced" });
    });
  }, 15_000);

  test("write default uses one direct worker and captures a confined patch", async () => {
    await withFixture(true, async (fixture) => {
      const output = await runSwarm(["--write", "edit one target"], context(fixture));
      expect(output).toContain(prose);
      const invocation = await assertDirectWorker(fixture, "swarm-write");
      const job = await latestJob(fixture);
      expect(job).toMatchObject({ status: "completed", operation_kind: "swarm-write", command_type: "rescue",
        cwd: fixture.repo, kimi_session_id_source: "announced" });
      await assertPatchAndUserTree(fixture, job, invocation);
    });
  }, 15_000);

  test("write cancellation settles the direct worker and captures its partial patch", async () => {
    await withFixture(true, async (fixture) => {
      fixture.env.SINGLE_WORKER_TEST_HOLD_MS = "5000";
      const baseline = process.listeners("SIGTERM");
      const pending = runSwarm(["--write", "cancel the worker"], context(fixture));
      await waitForPrint(fixture);
      const handlers = process.listeners("SIGTERM").filter((listener) => !baseline.includes(listener));
      expect(handlers).toHaveLength(1);
      handlers[0]!("SIGTERM");
      await pending;
      const invocation = await assertDirectWorker(fixture, "swarm-write");
      const job = await latestJob(fixture);
      expect(job.status).toBe("cancelled");
      expect(job.error?.code).toBe("SWARM_CANCELLED");
      expect(job.error?.details?.cleanup_error).toBeUndefined();
      await assertPatchAndUserTree(fixture, job, invocation);
    });
  }, 15_000);

  test("write budget expiry settles the direct worker without an activation cleanup", async () => {
    await withFixture(true, async (fixture) => {
      fixture.env.SINGLE_WORKER_TEST_HOLD_MS = "5000";
      await expect(runSwarm(["--write", "--budget", "1s", "time out the worker"], context(fixture)))
        .rejects.toMatchObject({ code: "RESCUE_KIMI_RESPONSE_TIMEOUT" });
      const invocation = await assertDirectWorker(fixture, "swarm-write");
      const job = await latestJob(fixture);
      expect(job.status).toBe("failed");
      expect(job.error?.code).toBe("RESCUE_KIMI_RESPONSE_TIMEOUT");
      expect(job.error?.details?.cleanup_error).toBeUndefined();
      await assertPatchAndUserTree(fixture, job, invocation, true);
    });
  }, 15_000);

  test("concurrency two still activates and resumes a native swarm session", async () => {
    await withFixture(false, async (fixture) => {
      fixture.env.KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS = JSON.stringify([path.join(process.cwd(), "tests/helpers/mock-kimi-web.mjs")]);
      fixture.env.MOCK_KIMI_WEB_VERSION = "2.6.2";
      fixture.env.MOCK_KIMI_WEB_LOG = fixture.logPath;
      fixture.env.MOCK_KIMI_WEB_PRINT_PROSE = prose;
      const output = await runSwarm(["--max-concurrency", "2", "inspect several targets"], context(fixture));
      expect(output).toContain(prose);
      const entries = await invocations(fixture);
      const print = entries.filter((entry) => entry.kind === "print");
      expect(print).toHaveLength(1);
      expect(print[0]!.argv).toContain("-r");
      expect(print[0]!.env.KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY).toBe("2");
      expect(entries.filter((entry) => entry.kind === "spawn")).toHaveLength(2);
      expect(await readFile(path.join(fixture.env.KIMI_CODE_HOME!, "sessions", "wd_mock", "session_mock", "tool-policy", "state.json"), "utf8"))
        .toBe('{"disabledTools":["TaskStop"]}\n');
      const repoId = (await resolveRepoIdentity(fixture.repo)).repoId;
      const store = new JobStore(resolvePluginPaths(fixture.env));
      try {
        const job = store.findLatestJob({ repoId, commandType: "review" })!;
        expect(job.status).toBe("completed");
        expect(job.kimi_session_id_source).toBe("preactivated");
        expect(store.getSwarmRecovery(job.job_id)?.record.complete).toBe(true);
      } finally { store.close(); }
    });
  }, 20_000);

  test("concurrency two refuses an unexpected native policy before print and deactivates the session", async () => {
    await withFixture(false, async (fixture) => {
      fixture.env.KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS = JSON.stringify([path.join(process.cwd(), "tests/helpers/mock-kimi-web.mjs")]);
      fixture.env.MOCK_KIMI_WEB_VERSION = "2.6.2";
      fixture.env.MOCK_KIMI_WEB_LOG = fixture.logPath;
      fixture.env.MOCK_KIMI_WEB_PRINT_PROSE = prose;
      const policyPath = path.join(fixture.env.KIMI_CODE_HOME!, "sessions", "wd_mock", "session_mock", "tool-policy", "state.json");
      const originalPolicy = '{"disabledTools":["Read"],"unexpected":"preserve"}\n';
      await mkdir(path.dirname(policyPath), { recursive: true });
      await writeFile(policyPath, originalPolicy, { mode: 0o600 });
      const before = await lstat(policyPath);

      const output = await runSwarm(["--max-concurrency", "2", "refuse unexpected policy"], context(fixture));
      expect(output).not.toContain(prose);
      expect(await readFile(policyPath, "utf8")).toBe(originalPolicy);
      const after = await lstat(policyPath);
      expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
      const entries = await invocations(fixture);
      expect(entries.filter((entry) => entry.kind === "print")).toEqual([]);
      expect(entries.filter((entry) => entry.kind === "request" && entry.path?.endsWith("/profile") && entry.body?.agent_config?.swarm_mode === true))
        .toHaveLength(1);
      expect(entries.filter((entry) => entry.kind === "request" && entry.path?.endsWith("/profile") && entry.body?.agent_config?.swarm_mode === false))
        .toHaveLength(1);
      const spawns = entries.filter((entry) => entry.kind === "spawn");
      expect(spawns).toHaveLength(2);
      for (const spawn of spawns) {
        const probe = await probeProcessIdentity(spawn.pid);
        expect(probe.complete).toBe(true);
        expect(probe.identity).toBeUndefined();
      }
      const repoId = (await resolveRepoIdentity(fixture.repo)).repoId;
      const store = new JobStore(resolvePluginPaths(fixture.env));
      try {
        const job = store.findLatestJob({ repoId, commandType: "review" })!;
        expect(job.status).toBe("failed");
        expect(job.error).toMatchObject({ code: "SWARM_ACTIVATION_FAILED", stage: "swarm-activation.tool-policy" });
        const recovery = store.getSwarmRecovery(job.job_id)!.record;
        expect(recovery.sessionDirty).toBe(false);
        expect(recovery.complete).toBe(true);
        expect(recovery.launches.map((launch) => launch.kind)).toEqual(["web", "web"]);
      } finally { store.close(); }
      expect(git(fixture.repo, ["status", "--porcelain", "--untracked-files=all"])).toBe(fixture.initialStatus);
    });
  }, 20_000);
});
