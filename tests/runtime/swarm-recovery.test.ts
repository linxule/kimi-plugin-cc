import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { JobStore } from "../../runtime/job-store.js";
import { ensurePluginPaths, resolvePluginPaths } from "../../runtime/paths.js";
import { probeProcessIdentity } from "../../runtime/process-tree.js";
import { recoverLaunch, validateRecoveryGroupMembers, type RecoveryLaunch } from "../../runtime/swarm-recovery.js";
import { removeWorktree, resolveRepoIdentity } from "../../runtime/git.js";
import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";

const node = Bun.which("node")!;
const companion = path.resolve("dist/companion.js");
const mock = path.resolve("tests/helpers/mock-kimi-web.mjs");
function launch(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(node, [companion, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}
async function waitUntil<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for crash precondition");
}

describe("durable swarm recovery", () => {
  test.each([false, true])("compiled hard-kill recovery preserves work and terminal outcomes (already terminal=%s)", async (alreadyTerminal) => {
    const root = await createTestPluginDataRoot("swarm-crash");
    const repo = await createGitRepoFixture("swarm-crash-repo");
    const home = path.join(root, "home");
    const log = path.join(root, "web.jsonl");
    const env = { ...process.env, KIMI_PLUGIN_CC_DATA: root, KIMI_CODE_HOME: home,
      KIMI_PLUGIN_CC_KIMI_BIN: node, KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify([mock]),
      KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1", MOCK_KIMI_WEB_LOG: log,
      MOCK_KIMI_WEB_TOKEN: "never-persist-this-token", MOCK_KIMI_WEB_STATUS_DELAY_MS: "10000" };
    await mkdir(home, { recursive: true });
    const paths = resolvePluginPaths(env);
    await ensurePluginPaths(paths);
    const store = new JobStore(paths);
    const running = launch(["task", "swarm", "--write", "--budget", "20s", "crash recovery fixture"], repo, env);
    let worktree: string | undefined;
    let orphanPid: number | undefined;
    try {
      const repoId = (await resolveRepoIdentity(repo)).repoId;
      const { job, recovery } = await waitUntil(async () => {
        const job = store.findLatestJob({ repoId });
        const recovery = job && store.getSwarmRecovery(job.job_id)?.record;
        const entries = (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
        if (!job || !recovery?.sessionDirty || !entries.some((entry) => entry.path?.endsWith("/status"))) return;
        return { job, recovery };
      });
      expect(job.kimi_session_id).toBeNull(); // The crash window predates old post-activation persistence.
      expect(recovery.session?.sessionId).toBe("session_mock");
      expect(recovery.launches[0]?.pending).toBe(false);
      worktree = recovery.workspaceRoot!;
      orphanPid = recovery.launches[0]!.identities[0]!.pid;
      await writeFile(path.join(worktree, "recovered.txt"), "keep this untracked work\n");

      const beforePreview = await readFile(log, "utf8");
      const preview = await launch(["recover-swarm", job.job_id], repo, env).done;
      expect(preview.code).toBe(0);
      expect(JSON.parse(preview.stdout).mode).toBe("preview");
      expect(await readFile(log, "utf8")).toBe(beforePreview);
      const liveRefusal = await launch(["recover-swarm", job.job_id, "--apply"], repo, env).done;
      expect(liveRefusal.code).toBe(1);
      expect(liveRefusal.stderr).toContain("still alive");

      running.child.kill("SIGKILL");
      await running.done;
      expect((await probeProcessIdentity(orphanPid)).identity).toBeDefined();
      const recoverEnv = { ...env, MOCK_KIMI_WEB_STATUS_DELAY_MS: "0" };
      const claim = JSON.stringify((await probeProcessIdentity(process.pid)).identity);
      expect(store.claimSwarmRecovery(job.job_id, null, claim)).toBe(true);
      expect(store.claimSwarmRecovery(job.job_id, null, "loser")).toBe(false);
      const busy = await launch(["recover-swarm", job.job_id, "--apply"], repo, recoverEnv).done;
      expect(busy.stderr).toContain("Another recovery owner");
      expect(store.claimSwarmRecovery(job.job_id, claim, JSON.stringify(recovery.owner))).toBe(true);
      // A dead original owner also exercises stale recovery-claim takeover.
      if (alreadyTerminal) store.markCancelled(job.job_id, { summary: "original outcome", error: null });
      const terminalBefore = JSON.stringify(store.getJob(job.job_id));
      const recovered = await launch(["recover-swarm", job.job_id, "--apply"], repo, recoverEnv).done;
      expect(recovered.code, recovered.stderr).toBe(0);
      const output = JSON.parse(recovered.stdout);
      expect(output.recovery_complete).toBe(true);
      expect(await readFile(output.patch_path, "utf8")).toContain("+keep this untracked work");
      expect(existsSync(worktree)).toBe(true);
      expect(store.getJob(job.job_id)?.status).toBe(alreadyTerminal ? "cancelled" : "failed");
      if (alreadyTerminal) expect(JSON.stringify(store.getJob(job.job_id))).toBe(terminalBefore);
      const afterCleanup = (await probeProcessIdentity(orphanPid)).identity;
      expect(afterCleanup === undefined || /^[ZX]/i.test(afterCleanup.state)).toBe(true);
      const persisted = store.getSwarmRecovery(job.job_id)!;
      expect(JSON.stringify(persisted)).not.toContain("never-persist-this-token");
      expect(persisted.owner).toBeNull();
      const journal = await readFile(path.join(home, "sessions/wd_mock/session_mock/agents/main/wire.jsonl"), "utf8");
      expect(journal).toContain('"type":"swarm_mode.exit"');
      const settled = JSON.stringify(store.getJob(job.job_id));
      const logAfter = await readFile(log, "utf8");
      expect((await launch(["recover-swarm", job.job_id, "--apply"], repo, recoverEnv).done).code).toBe(0);
      expect(await readFile(log, "utf8")).toBe(logAfter);
      expect(JSON.stringify(store.getJob(job.job_id))).toBe(settled);
      expect((await launch(["recover-swarm", job.job_id, "--apply"], root, recoverEnv).done).code).toBe(1);
    } finally {
      running.child.kill("SIGKILL");
      await running.done;
      if (orphanPid) { try { process.kill(-orphanPid, "SIGKILL"); } catch {} }
      store.close();
      if (worktree) await removeWorktree(repo, worktree);
      await cleanupTestPath(repo);
      await cleanupTestPath(root);
    }
  }, 30_000);

  test("compiled cancel still reaches the owner after the print process has exited", async () => {
    const root = await createTestPluginDataRoot("swarm-web-cancel");
    const repo = await createGitRepoFixture("swarm-web-cancel-repo");
    const home = path.join(root, "home");
    const log = path.join(root, "web.jsonl");
    const env = { ...process.env, KIMI_PLUGIN_CC_DATA: root, KIMI_CODE_HOME: home,
      KIMI_PLUGIN_CC_KIMI_BIN: node, KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify([mock]),
      KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1", MOCK_KIMI_WEB_LOG: log, MOCK_KIMI_WEB_DEACTIVATE_STATUS_DELAY_MS: "5000" };
    await mkdir(home, { recursive: true });
    const paths = resolvePluginPaths(env);
    await ensurePluginPaths(paths);
    const store = new JobStore(paths);
    const running = launch(["task", "swarm", "--budget", "20s", "cancel during web cleanup"], repo, env);
    try {
      const repoId = (await resolveRepoIdentity(repo)).repoId;
      const job = await waitUntil(async () => {
        const entries = (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
        if (!entries.some((entry) => entry.body?.agent_config?.swarm_mode === false)) return;
        return store.findLatestJob({ repoId }) ?? undefined;
      });
      expect((await probeProcessIdentity(job.kimi_pid!)).identity).toBeUndefined();
      const cancelled = await launch(["cancel", job.job_id], repo, env).done;
      expect(cancelled.code, cancelled.stderr).toBe(0);
      expect(JSON.parse(cancelled.stdout).status).toBe("cancelled");
      await running.done;
      const entries = (await readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(entries.filter((entry) => entry.kind === "spawn")).toHaveLength(2);
    } finally {
      running.child.kill("SIGKILL"); await running.done;
      const saved = store.findLatestJob({ repoId: (await resolveRepoIdentity(repo)).repoId });
      if (saved) for (const entry of store.getSwarmRecovery(saved.job_id)?.record.launches ?? []) {
        for (const id of entry.identities) {
          const current = await probeProcessIdentity(id.pid);
          if (current.identity?.startToken === id.startToken && current.identity.processGroupId === id.processGroupId) {
            try { process.kill(id.pid, "SIGKILL"); } catch {}
          }
        }
      }
      store.close(); await cleanupTestPath(repo); await cleanupTestPath(root);
    }
  }, 20_000);

  test("group recovery proves both Linux proc/ps identity representations", async () => {
    const proc = { pid: 42, processGroupId: 42, startToken: "proc:123", state: "S" };
    const ps = { ...proc, startToken: "ps:Mon Oct 26 10:00:00 2026" };
    let proofs = 0;
    const validate = async (ids: readonly typeof proc[]) => {
      proofs += 1;
      return { identities: [...ids], complete: true };
    };
    expect(await validateRecoveryGroupMembers([proc], [ps], validate)).toEqual([proc]);
    expect(proofs).toBe(3);
    await expect(validateRecoveryGroupMembers([proc], [ps], async (ids) => ({
      identities: ids[0]?.startToken === proc.startToken ? [] : [...ids], complete: true,
    }))).rejects.toMatchObject({ code: "SWARM_RECOVERY_REQUIRED" });
    await expect(validateRecoveryGroupMembers([proc], [ps], async () => ({
      identities: [], complete: false,
    }))).rejects.toMatchObject({ code: "SWARM_RECOVERY_REQUIRED" });
  });

  test("unknown spawn intent refuses instead of claiming cleanup", async () => {
    const launch: RecoveryLaunch = { kind: "web", pending: true, identities: [], quiescent: false, uncertain: false };
    await expect(recoverLaunch(launch, () => {})).rejects.toMatchObject({ code: "SWARM_RECOVERY_REQUIRED" });
    expect(launch.quiescent).toBe(false);
  });

  test("a replaced identity is not signalled even when its PID and group match", async () => {
    const child = spawn(node, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      const identity = await waitUntil(async () => (await probeProcessIdentity(child.pid!)).identity);
      const launch: RecoveryLaunch = { kind: "web", pending: false, identities: [{ ...identity, startToken: "different-incarnation" }], quiescent: false, uncertain: false };
      await expect(recoverLaunch(launch, () => {})).rejects.toMatchObject({ code: "SWARM_RECOVERY_REQUIRED" });
      expect((await probeProcessIdentity(child.pid!)).identity?.startToken).toBe(identity.startToken);
    } finally { child.kill("SIGKILL"); await exited; }
  });
});
