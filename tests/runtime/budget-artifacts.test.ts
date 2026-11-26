import { runAsk } from "../../runtime/commands/ask.js";
import { runRescue } from "../../runtime/commands/rescue.js";
import { describe, expect, test, spyOn } from "bun:test";
import { execFile, spawn } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";
import { JobStore } from "../../runtime/job-store.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import { assertPersistedResumeLineage, executionPlanFromPersisted } from "../../runtime/kimi-engine.js";

const exec = promisify(execFile);
const companion = path.resolve("dist/companion.js");
const mockCli = path.resolve("tests/helpers/mock-kimi-cli.ts");

async function invoke(args: string[], env: NodeJS.ProcessEnv) {
  try {
    const result = await exec("node", [companion, ...args], { env, timeout: 15_000 });
    return { ...result, code: 0 };
  } catch (error) {
    const result = error as Error & { stdout: string; stderr: string; code: number };
    if (typeof result.code !== "number") throw error;
    return result;
  }
}

function mockEnv(root: string, repo: string, scenario: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KIMI_PLUGIN_CC_DATA: root,
    KIMI_CODE_HOME: path.join(root, "kimi-home"),
    KIMI_PLUGIN_CC_WORKSPACE_CWD: repo,
    KIMI_PLUGIN_CC_KIMI_BIN: "bun",
    KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCli]),
    KIMI_PLUGIN_CC_MOCK_SCENARIO: scenario,
    KIMI_PLUGIN_CC_MOCK_POST_OUTPUT_DELAY_MS: "5000",
    KIMI_PLUGIN_CC_MOCK_SESSION_ID: "session_26242650-d95f-4805-80d9-c947d309b2c6",
    KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1", // transport integration, not a hook-enforcement test
    KIMI_PLUGIN_CC_NODE_BIN: "node",
  };
}

describe("compiled timeout artifacts", () => {
  for (const [kind, command, scenario, text] of [
    ["ask", ["ask"], "ask-success", "Ask answer from mock Kimi."],
    ["rescue", ["task", "rescue"], "rescue-success", ""],
    ["review", ["review"], "review-success", "One correctness issue found."],
    ["challenge", ["task", "challenge"], "review-success", "One correctness issue found."],
  ] as const) {
    for (const background of kind === "ask" || kind === "rescue" ? [false, true] : [false]) {
      test(`${kind} background=${background}: persisted budget, prose, session and failed envelope`, async () => {
        const root = await createTestPluginDataRoot("budget-artifact");
        const repo = await createGitRepoFixture("budget-artifact-repo");
        const env = mockEnv(root, repo, scenario);
        try {
          const result = await invoke([...command, "--budget", "1s", ...(background ? ["--background", "--wait"] : []), "Inspect this change"], env);
          if (!background && kind !== "rescue") expect(result.code).toBe(1);
          else expect(result.code).toBe(0);
          const status = JSON.parse((await invoke(["status", "--type", kind], env)).stdout);
          expect(status.status).toBe("failed");
          expect(status.budget_ms).toBe(1000);
          expect(status.budget_source).toBe("explicit");
          expect(status.kimi_session_id_source).toBe("recovered_session_dir");
          expect(status.kimi_session_id).toBe("session_26242650-d95f-4805-80d9-c947d309b2c6");
          expect(status.error.code).toBe(`${kind.toUpperCase()}_KIMI_RESPONSE_TIMEOUT`);
          expect(status.error.message).not.toContain("race");
          expect(status.error.message.includes("--background")).toBe(!background && (kind === "ask" || kind === "rescue"));
          expect(status.error.details).toMatchObject({ budget_ms: 1000, aborted: true });
          expect(status.error.details.record_count).toBeGreaterThan(0);
          expect(status.error.details.partial_output_chars).toBeGreaterThan(0);
          expect(JSON.stringify(status.error.details)).not.toContain("records");
          const envelope = JSON.parse((await invoke(["result", status.job_id, "--json"], env)).stdout);
          expect(envelope.status).toBe("failed");
          expect(envelope.budget_ms).toBe(1000);
          expect(envelope.budget_source).toBe("explicit");
          expect(envelope.kimi_session_id_source).toBe("recovered_session_dir");
          expect(envelope.kimi_session_id).toBe("session_26242650-d95f-4805-80d9-c947d309b2c6");
          expect(envelope.artifact_path).toBe(status.final_output_path);
          expect(envelope.body).toContain("## Partial output (budget exhausted after 1s — NOT a final answer)");
          expect(envelope.body).toContain(text);
          expect(envelope.body).toContain("- Kimi session: session_26242650-d95f-4805-80d9-c947d309b2c6");
          expect(envelope.summary).toContain("partial output captured");
          expect((await invoke(["result", status.job_id], env)).stdout.trimEnd()).toBe(envelope.body.trimEnd());
          expect(await readFile(status.final_output_path, "utf8")).toBe(envelope.body);
          if (kind === "ask") {
            const resumed = await invoke(["ask", "-r", "Continue"], { ...env, KIMI_PLUGIN_CC_MOCK_POST_OUTPUT_DELAY_MS: "0" });
            expect(resumed.code).toBe(0);
            const resumedStatus = JSON.parse((await invoke(["status", "--type", "ask"], env)).stdout);
            expect(resumedStatus.status).toBe("completed");
            expect(resumedStatus.budget_ms).toBe(1000);
            expect(resumedStatus.resumed_from_job_id).toBe(status.job_id);
          }
        } finally {
          await cleanupTestPath(root);
          await cleanupTestPath(repo);
        }
      }, 20_000);
    }
  }

  test("tool-only timeout gets an explicit no-prose section", async () => {
    const root = await createTestPluginDataRoot("budget-empty");
    const repo = await createGitRepoFixture("budget-empty-repo");
    try {
      const env = mockEnv(root, repo, "rescue-empty");
      await invoke(["task", "rescue", "--budget", "1s", "Inspect"], env);
      const result = JSON.parse((await invoke(["result", "--json"], env)).stdout);
      expect(result.status).toBe("failed");
      expect(result.error.code).toBe("RESCUE_KIMI_RESPONSE_TIMEOUT");
      expect(result.body).toContain("No assistant prose was emitted before the budget.");
      expect(result.body).not.toContain("tool calls only");
    } finally {
      await cleanupTestPath(root);
      await cleanupTestPath(repo);
    }
  }, 20_000);

  test("cancellation after emitted prose never captures timeout partial output", async () => {
    const root = await createTestPluginDataRoot("budget-cancel");
    const repo = await createGitRepoFixture("budget-cancel-repo");
    const env = mockEnv(root, repo, "ask-success");
    const child = spawn("node", [companion, "ask", "--budget", "30s", "Inspect"], { env, stdio: "ignore" });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      let sawProse = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const status = await invoke(["status", "--type", "ask"], env);
        if (status.code !== 0) continue;
        const job = JSON.parse(status.stdout);
        const log = await readFile(job.stream_log_path, "utf8");
        if (log.includes("Ask answer from mock Kimi.")) { sawProse = true; break; }
      }
      expect(sawProse).toBe(true);
      child.kill("SIGTERM");
      await closed;
      const envelope = JSON.parse((await invoke(["result", "--json"], env)).stdout);
      expect(envelope.status).toBe("cancelled");
      expect(envelope.body).not.toContain("## Partial output");
      expect(envelope.body).not.toContain("Ask answer from mock Kimi.");
    } finally {
      child.kill("SIGTERM");
      await closed;
      await cleanupTestPath(root);
      await cleanupTestPath(repo);
    }
  }, 20_000);
});

for (const [kind, command, run, scenario] of [
  ["ask", ["ask"], runAsk, "ask-success"],
  ["rescue", ["task", "rescue"], runRescue, "rescue-success"],
] as const) {
  test(`${kind} inherits a timed-out parent's 45m budget for -r and --resume; explicit budget wins`, async () => {
    const root = await createTestPluginDataRoot("budget-inherit");
    const repo = await createGitRepoFixture("budget-inherit-repo");
    const env = mockEnv(root, repo, scenario);
    const realSetTimeout = globalThis.setTimeout;
    // Advance only the 45m budget deadline; use the real subprocess and timeout path.
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: any[]) => void, ms?: number, ...args: any[]) =>
      realSetTimeout(callback, ms === 2_700_000 ? 500 : ms, ...args)) as typeof setTimeout);
    try {
      try { await run(["--budget", "45m", "Inspect"], { cwd: repo, env, stdout: process.stdout, stderr: process.stderr }); }
      catch (error) { expect(error).toMatchObject({ code: "ASK_KIMI_RESPONSE_TIMEOUT" }); }
      timers.mockRestore();
      const parent = JSON.parse((await invoke(["status", "--type", kind], env)).stdout);
      expect(parent).toMatchObject({ status: "failed", budget_ms: 2_700_000 });
      expect(parent.budget_source).toBe("explicit");
      expect(parent.error.code).toBe(`${kind.toUpperCase()}_KIMI_RESPONSE_TIMEOUT`);
      expect(parent.error.details.budget_ms).toBe(2_700_000);
      const quickEnv = { ...env, KIMI_PLUGIN_CC_MOCK_POST_OUTPUT_DELAY_MS: "0" };
      for (const flags of [["-r"], ["--resume", parent.job_id], ["--resume", parent.kimi_session_id]]) {
        const continuation = await invoke([...command, ...flags, "--background", "--wait"], quickEnv);
        expect(continuation.code).toBe(0);
        const job = JSON.parse((await invoke(["status", "--type", kind], env)).stdout);
        expect(job.status).toBe("completed");
        expect(job.budget_ms).toBe(2_700_000);
        expect(job.budget_source).toBe("inherited");
        expect(continuation.stderr).toContain(`[${kind}] budget 45m inherited from job ${job.resumed_from_job_id}; pass --budget to override`);
        expect(JSON.parse((await invoke(["result", job.job_id, "--json"], env)).stdout).budget_source).toBe("inherited");
        expect(job.resumed_from_job_id).not.toBeNull();
      }
      expect((await invoke([...command, "-r", "--budget", "1h"], quickEnv)).code).toBe(0);
      expect(JSON.parse((await invoke(["status", "--type", kind], env)).stdout).budget_ms).toBe(3_600_000);
      expect(JSON.parse((await invoke(["result", "--json"], env)).stdout).budget_source).toBe("explicit");
      expect((await invoke([...command, "--fresh", "New task"], quickEnv)).code).toBe(0);
      expect(JSON.parse((await invoke(["status", "--type", kind], env)).stdout).budget_ms).toBeNull();
      expect(JSON.parse((await invoke(["status", "--type", kind], env)).stdout).budget_source).toBe("default");
      expect(JSON.parse((await invoke(["result", "--json"], env)).stdout).budget_source).toBe("default");
    } finally {
      timers.mockRestore();
      await cleanupTestPath(root);
      await cleanupTestPath(repo);
    }
  }, 20_000);
}

for (const [kind, flags, defaultBudget] of [["pursue", [], 2_700_000], ["swarm", ["--max-concurrency", "1"], 1_800_000], ["swarm-write", ["--write"], 1_800_000]] as const) {
  test(`compiled ${kind} stores its effective safety budget, including defaults`, async () => {
    const root = await createTestPluginDataRoot("safety-budget");
    const repo = await createGitRepoFixture("safety-budget-repo");
    const env = { ...mockEnv(root, repo, "ask-success"), KIMI_PLUGIN_CC_MOCK_POST_OUTPUT_DELAY_MS: "0" };
    try {
      for (const budget of [[], ["--budget", "1h"]]) {
        const result = await invoke(["task", kind === "swarm-write" ? "swarm" : kind, ...flags, ...budget, "Inspect"], env);
        expect(result.code).toBe(0);
        const envelope = JSON.parse((await invoke(["result", "--json"], env)).stdout);
        expect(envelope.operation_kind).toBe(kind);
        expect(envelope.status).toBe("completed");
        expect(envelope.budget_ms).toBe(budget.length ? 3_600_000 : defaultBudget);
      }
    } finally {
      await cleanupTestPath(root);
      await cleanupTestPath(repo);
    }
  }, 20_000);
}

test("compiled native-v2 ask: a same-window session whose journal opens with a different prompt is never adopted", async () => {
  const root = await createTestPluginDataRoot("v2-budget-digest");
  const repo = await createGitRepoFixture("v2-budget-digest-repo");
  const env: NodeJS.ProcessEnv = { ...mockEnv(root, repo, "ask-success"), KIMI_PLUGIN_CC_MOCK_VERSION: "2.8.0",
    KIMI_PLUGIN_CC_MOCK_SESSION_ID: "session_26242650-d95f-4805-80d9-c947d309b2c7",
    KIMI_PLUGIN_CC_MOCK_JOURNAL_PROMPT_OVERRIDE: "a prompt this job never sent" };
  try {
    await invoke(["ask", "--budget", "1s", "Inspect"], env);
    const result = JSON.parse((await invoke(["result", "--json"], env)).stdout);
    expect(result).toMatchObject({ status: "failed", observed_engine: "native-v2", kimi_session_id: null, kimi_session_id_source: null });
    expect(result.error.details.session_recovery).toBe("digest_mismatch:1");
    expect(result.error.details.kimi_session_id).toBeUndefined();
  } finally {
    await cleanupTestPath(root);
    await cleanupTestPath(repo);
  }
}, 20_000);

for (const [kind, command, scenario] of [
  ["ask", ["ask"], "ask-success"],
  ["rescue", ["task", "rescue"], "rescue-success"],
  ["review", ["review"], "review-success"],
  ["challenge", ["task", "challenge"], "review-success"],
] as const) {
  test(`compiled native-v2 ${kind}: recover timeout session; resume retains safety checks`, async () => {
    const root = await createTestPluginDataRoot("v2-budget-recovery");
    const repo = await createGitRepoFixture("v2-budget-repo");
    const sessionId = "session_26242650-d95f-4805-80d9-c947d309b2c6";
    const env: NodeJS.ProcessEnv = { ...mockEnv(root, repo, scenario), KIMI_PLUGIN_CC_MOCK_VERSION: "2.8.0",
      KIMI_PLUGIN_CC_MOCK_SESSION_ID: sessionId };
    try {
      // Rescue exercises the detached-worker route; the other commands run foreground.
      await invoke([...command, "--budget", "1s", ...(kind === "rescue" ? ["--background", "--wait"] : []), "Inspect"], env);
      const result = JSON.parse((await invoke(["result", "--json"], env)).stdout);
      expect(result).toMatchObject({ status: "failed", observed_engine: "native-v2",
        kimi_session_id: sessionId, kimi_session_id_source: "recovered_session_dir" });
      expect(result.error.details).toMatchObject({ kimi_session_id: sessionId, kimi_session_id_source: "recovered_session_dir" });
      expect(result.error.details.session_recovery).toBeUndefined();
      if (kind !== "ask" && kind !== "rescue") return;
      const quickEnv = { ...env, KIMI_PLUGIN_CC_MOCK_POST_OUTPUT_DELAY_MS: "0" };
      const resume = await invoke([...command, "--resume", result.job_id], quickEnv);
      expect(resume).toMatchObject({ code: 0 });
      const continued = JSON.parse((await invoke(["result", "--json"], env)).stdout);
      expect(continued).toMatchObject({ status: "completed", kimi_session_id: sessionId,
        kimi_session_id_source: "announced", resumed_from_job_id: result.job_id, budget_source: "inherited" });
      const store = new JobStore(resolvePluginPaths(env));
      try {
        const continuation = store.getJob(continued.job_id)!;
        const plan = executionPlanFromPersisted(continuation);
        await expect(assertPersistedResumeLineage(store, plan, sessionId, kind)).resolves.toBeUndefined();
        await expect(assertPersistedResumeLineage(store, { ...plan, resumedFromJobId: null }, sessionId, kind))
          .rejects.toMatchObject({ code: "KIMI_SESSION_LINEAGE_UNKNOWN" });
      } finally { store.close(); }
      const journal = path.join(env.KIMI_CODE_HOME!, "sessions/wd_mock", sessionId, "agents/main/wire.jsonl");
      await appendFile(journal, '{"type":"plan_mode.enter"}\n');
      const tainted = await invoke([...command, "--resume", result.job_id], quickEnv);
      expect(tainted.code).not.toBe(0);
      expect(tainted.stderr).toContain("KIMI_SESSION_PLAN_TAINTED");
    } finally {
      await cleanupTestPath(root);
      await cleanupTestPath(repo);
    }
  }, 20_000);
}

test("compiled native-v2 timeout reports why session recovery found none", async () => {
  const root = await createTestPluginDataRoot("v2-budget-no-session");
  const repo = await createGitRepoFixture("v2-budget-no-session-repo");
  const env = { ...mockEnv(root, repo, "ask-success"), KIMI_PLUGIN_CC_MOCK_VERSION: "2.8.0",
    KIMI_PLUGIN_CC_MOCK_NO_SESSION_STORE: "1" };
  try {
    await invoke(["ask", "--budget", "1s", "Inspect"], env);
    const result = JSON.parse((await invoke(["result", "--json"], env)).stdout);
    expect(result).toMatchObject({ status: "failed", kimi_session_id: null, kimi_session_id_source: null });
    expect(result.error.details.session_recovery).toBe("none");
  } finally {
    await cleanupTestPath(root);
    await cleanupTestPath(repo);
  }
}, 20_000);
