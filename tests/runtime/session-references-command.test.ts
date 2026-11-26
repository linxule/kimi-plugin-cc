import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { runAsk } from "../../runtime/commands/ask.js";
import { runRepairSessions } from "../../runtime/commands/repair-sessions.js";
import { runRescue } from "../../runtime/commands/rescue.js";
import { runReview } from "../../runtime/commands/review.js";
import { runSwarm } from "../../runtime/commands/swarm.js";
import { resolveRepoIdentity } from "../../runtime/git.js";
import { digestPrompt } from "../../runtime/jobs.js";
import { JobStore, type JobRecord } from "../../runtime/job-store.js";
import { ensurePluginPaths, resolvePluginPaths } from "../../runtime/paths.js";
import type { CommandContext } from "../../runtime/types.js";
import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";

const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli.ts");
const REF_WORKSPACE = "wd_other_0123456789ab";
const REF_SESSION = "session_11111111-1111-4111-8111-111111111111";
const NEW_SESSION = "session_22222222-2222-4222-8222-222222222222";
const CONTINUATION = "Continue the previous ask conversation and answer any outstanding question.";

interface Fixture {
  root: string;
  repo: string;
  home: string;
  invocationPath: string;
  env: NodeJS.ProcessEnv;
}

async function withFixture(scenario: string, run: (fixture: Fixture) => Promise<void>, extraEnv: NodeJS.ProcessEnv = {}): Promise<void> {
  const root = await createTestPluginDataRoot("session-references-command");
  const repo = await createGitRepoFixture("session-references-command-repo");
  const home = path.join(root, "kimi-home");
  const invocationPath = path.join(root, "invocation.jsonl");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KIMI_PLUGIN_CC_DATA: root,
    KIMI_CODE_HOME: home,
    KIMI_PLUGIN_CC_KIMI_BIN: "bun",
    KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
    KIMI_PLUGIN_CC_MOCK_SCENARIO: scenario,
    KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH: invocationPath,
    KIMI_PLUGIN_CC_MOCK_VERSION: "2.8.0",
    KIMI_PLUGIN_CC_MOCK_RECOVERABLE_V2: "1",
    KIMI_PLUGIN_CC_MOCK_SESSION_ID: NEW_SESSION,
    KIMI_PLUGIN_CC_NODE_BIN: "node",
    KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
    ...extraEnv,
  };
  try {
    await seedReferencedSession(home);
    await indexNewSession(home);
    await run({ root, repo, home, invocationPath, env });
  } finally {
    await cleanupTestPath(root);
    await cleanupTestPath(repo);
  }
}

async function seedReferencedSession(home: string): Promise<void> {
  const dir = path.join(home, "sessions", REF_WORKSPACE, REF_SESSION);
  await mkdir(path.join(dir, "agents", "main"), { recursive: true });
  await writeFile(path.join(dir, "agents", "main", "wire.jsonl"), "{\"type\":\"metadata\"}\n");
  await writeFile(path.join(dir, "state.json"), JSON.stringify({ id: REF_SESSION, version: 2, title: "Earlier \"auth\" work" }));
}

/** The mock creates the new session under wd_mock; title sync finds it through the index. */
async function indexNewSession(home: string): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "session_index.jsonl"),
    `${JSON.stringify({ sessionId: NEW_SESSION, sessionDir: path.join(home, "sessions", "wd_mock", NEW_SESSION), workDir: "/w" })}\n`);
}

function context(fixture: Fixture, cwd = fixture.repo): CommandContext {
  return { cwd, env: fixture.env, stdout: process.stdout, stderr: process.stderr };
}

async function lastInvocation(fixture: Fixture): Promise<{ argv: string[]; env: Record<string, string | null> }> {
  const lines = (await readFile(fixture.invocationPath, "utf8")).trim().split("\n");
  return JSON.parse(lines.at(-1)!);
}

function spawnedPrompt(argv: string[]): string {
  return argv[argv.indexOf("-p") + 1]!;
}

function expectedBlock(home: string): string {
  return [
    "",
    "",
    "<referenced_sessions>",
    `<session id="${REF_SESSION}" title="Earlier &quot;auth&quot; work" log="${home}/sessions/${REF_WORKSPACE}/${REF_SESSION}/agents/main/wire.jsonl" />`,
    "</referenced_sessions>",
  ].join("\n");
}

async function newSessionState(home: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(home, "sessions", "wd_mock", NEW_SESSION, "state.json"), "utf8"));
}

async function jobs(env: NodeJS.ProcessEnv): Promise<JobRecord[]> {
  const db = new Database(resolvePluginPaths(env).stateDbPath, { readonly: true });
  try {
    return db.query("SELECT * FROM jobs ORDER BY rowid").all() as JobRecord[];
  } finally {
    db.close();
  }
}

async function job(env: NodeJS.ProcessEnv, jobId: string): Promise<JobRecord> {
  const store = new JobStore(resolvePluginPaths(env));
  try {
    return store.getJob(jobId)!;
  } finally {
    store.close();
  }
}

async function waitForTerminal(env: NodeJS.ProcessEnv, jobId: string): Promise<JobRecord> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const current = await job(env, jobId);
    if (current.status !== "running") return current;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`job ${jobId} did not settle`);
}

describe("session references in commands", () => {
  test("ask appends the block last: spawn, digest, log= home spelling, clean preview and title", async () => {
    await withFixture("ask-success", async (fixture) => {
      const output = await runAsk(["--reference-session", REF_SESSION, "What", "changed?"], context(fixture));
      expect(output).toBe("Ask answer from mock Kimi.");
      const invocation = await lastInvocation(fixture);
      const prompt = spawnedPrompt(invocation.argv);
      expect(invocation.env.KIMI_CODE_HOME).toBe(fixture.home);
      expect(prompt.endsWith(`What changed?${expectedBlock(invocation.env.KIMI_CODE_HOME!)}`)).toBe(true);
      const [row] = await jobs(fixture.env);
      expect(row!.prompt_digest).toBe(digestPrompt(prompt));
      expect(row!.read_scope).toBeNull();
      expect(await newSessionState(fixture.home)).toMatchObject({ lastPrompt: "What changed?", title: "Kimi Ask: What changed?" });

      // A preview an earlier release left as the full prompt is repaired to the raw request.
      const statePath = path.join(fixture.home, "sessions", "wd_mock", NEW_SESSION, "state.json");
      await writeFile(statePath, JSON.stringify({ ...(await newSessionState(fixture.home)), lastPrompt: prompt }));
      const repaired = JSON.parse(await runRepairSessions(["--apply"], context(fixture))) as { counts: Record<string, number> };
      expect(repaired.counts).toEqual({ "preview-replaced": 1 });
      expect((await newSessionState(fixture.home)).lastPrompt).toBe("What changed?");
    });
  }, 30_000);

  test("a relative KIMI_CODE_HOME renders the spelling the child receives", async () => {
    await withFixture("ask-success", async (fixture) => {
      const relativeHome = path.join(fixture.repo, "rel-home");
      await seedReferencedSession(relativeHome);
      await indexNewSession(relativeHome);
      fixture.env.KIMI_CODE_HOME = "rel-home";
      await runAsk(["--reference-session", REF_SESSION, "q"], context(fixture));
      const invocation = await lastInvocation(fixture);
      expect(invocation.env.KIMI_CODE_HOME).toBe(relativeHome);
      expect(spawnedPrompt(invocation.argv).endsWith(expectedBlock(relativeHome))).toBe(true);
    });
  }, 30_000);

  test("ask continuation with a reference keeps the continuation summary; a self-reference or missing session refuses before a job row", async () => {
    await withFixture("ask-success", async (fixture) => {
      await runAsk(["first"], context(fixture));
      const [first] = await jobs(fixture.env);
      expect(first!.kimi_session_id).toBe(NEW_SESSION);

      await runAsk(["--reference-session", REF_SESSION, "--resume", first!.job_id], context(fixture));
      const invocation = await lastInvocation(fixture);
      expect(spawnedPrompt(invocation.argv).endsWith(expectedBlock(fixture.home))).toBe(true);
      expect((await newSessionState(fixture.home)).lastPrompt).toBe(CONTINUATION);
      expect((await jobs(fixture.env))).toHaveLength(2);

      for (const argv of [
        ["--reference-session", NEW_SESSION, "-r", "next"],
        ["--reference-session", first!.job_id, "--resume", NEW_SESSION],
        ["--reference-session", "session_missing", "q"],
        ["--network", "--reference-session", "session_missing", "q"],
      ]) {
        await expect(runAsk(argv, context(fixture))).rejects.toMatchObject({ code: "INVALID_ARGS" });
      }
      expect((await jobs(fixture.env))).toHaveLength(2);
    });
  }, 45_000);

  test("a scoped ask reads the referenced log through an added read root, and a networked resume must name it again", async () => {
    await withFixture("ask-success", async (fixture) => {
      const mainDir = await realpath(path.join(fixture.home, "sessions", REF_WORKSPACE, REF_SESSION, "agents", "main"));
      const repo = await realpath(fixture.repo);

      await runAsk(["--fresh", "--network", "--reference-session", REF_SESSION, "q"], context(fixture));
      let invocation = await lastInvocation(fixture);
      expect(spawnedPrompt(invocation.argv).endsWith(expectedBlock(fixture.home))).toBe(true);
      expect(JSON.parse(invocation.env.KIMI_PLUGIN_CC_READ_ROOTS!)).toEqual([repo, mainDir]);
      expect(invocation.env.KIMI_PLUGIN_CC_NETWORK).toBe("1");
      const networked = (await jobs(fixture.env)).at(-1)!;
      // The job row carries the widened roots, so a detached worker and the resume rule see the same scope.
      expect(JSON.parse(networked.read_scope!)).toEqual({ read_roots: [mainDir], network: true });

      // That session has now read the log: resuming it with the web on needs the log inside the roots again.
      await expect(runAsk(["--network", "--resume", networked.job_id], context(fixture))).rejects.toMatchObject({
        code: "INVALID_ARGS", stage: "ask.resume", message: expect.stringContaining("ask --fresh --network"),
      });
      const before = (await jobs(fixture.env)).length;
      await runAsk(["--network", "--reference-session", REF_SESSION, "--resume", networked.job_id], context(fixture));
      invocation = await lastInvocation(fixture);
      expect(JSON.parse(invocation.env.KIMI_PLUGIN_CC_READ_ROOTS!)).toEqual([repo, mainDir]);
      expect(await jobs(fixture.env)).toHaveLength(before + 1);
    });
  }, 60_000);

  test("--read-root with a reference keeps the caller's roots and adds the session's, without the web", async () => {
    await withFixture("ask-success", async (fixture) => {
      const mainDir = await realpath(path.join(fixture.home, "sessions", REF_WORKSPACE, REF_SESSION, "agents", "main"));
      await runAsk(["--read-root", fixture.root, "--reference-session", REF_SESSION, "q"], context(fixture));
      const invocation = await lastInvocation(fixture);
      // The Kimi home sits under the caller's root here; the session root is still listed, never dropped for it.
      expect(JSON.parse(invocation.env.KIMI_PLUGIN_CC_READ_ROOTS!)).toEqual([await realpath(fixture.repo), await realpath(fixture.root), mainDir]);
      expect(invocation.env.KIMI_PLUGIN_CC_NETWORK ?? null).toBeNull();
      // An unscoped call stays unconfined: the reference adds no confinement of its own.
      await runAsk(["--fresh", "--reference-session", REF_SESSION, "q"], context(fixture));
      expect((await lastInvocation(fixture)).env.KIMI_PLUGIN_CC_READ_ROOTS ?? null).toBeNull();
      expect((await jobs(fixture.env)).at(-1)!.read_scope).toBeNull();
    });
  }, 45_000);

  test("a detached scoped ask worker confines reads to the roots stored with the reference", async () => {
    await withFixture("ask-success", async (fixture) => {
      const mainDir = await realpath(path.join(fixture.home, "sessions", REF_WORKSPACE, REF_SESSION, "agents", "main"));
      await runAsk(["--background", "--network", "--reference-session", REF_SESSION, "q"], context(fixture));
      const [queued] = await jobs(fixture.env);
      expect((await waitForTerminal(fixture.env, queued!.job_id)).status).toBe("completed");
      const invocation = await lastInvocation(fixture);
      expect(JSON.parse(invocation.env.KIMI_PLUGIN_CC_READ_ROOTS!)).toEqual([await realpath(fixture.repo), mainDir]);
      expect(invocation.env.KIMI_PLUGIN_CC_NETWORK).toBe("1");
    });
  }, 45_000);

  test("an unscoped reference-bearing ask is later refused by ask --resume <it> --network", async () => {
    await withFixture("ask-success", async (fixture) => {
      await runAsk(["--reference-session", REF_SESSION, "q"], context(fixture));
      const [first] = await jobs(fixture.env);
      expect(first!.read_scope).toBeNull();
      await expect(runAsk(["--network", "--resume", first!.job_id], context(fixture))).rejects.toMatchObject({
        code: "INVALID_ARGS", stage: "ask.resume", message: expect.stringContaining("ask --fresh --network"),
      });
      expect(await jobs(fixture.env)).toHaveLength(1);
    });
  }, 30_000);

  test("below-floor kimi-code refuses before any job row", async () => {
    await withFixture("ask-success", async (fixture) => {
      await expect(runAsk(["--reference-session", REF_SESSION, "q"], context(fixture))).rejects.toMatchObject({
        code: "KIMI_CAPABILITY_NOT_CERTIFIED",
      });
      expect(await jobs(fixture.env)).toHaveLength(0);
    }, { KIMI_PLUGIN_CC_MOCK_VERSION: "2.7.3", KIMI_PLUGIN_CC_MOCK_RECOVERABLE_V2: "" });
  }, 30_000);

  test("a detached ask worker keeps the block out of the running summary and the preview", async () => {
    await withFixture("ask-success", async (fixture) => {
      const started = JSON.parse(await runAsk(["--background", "--reference-session", REF_SESSION, "Background", "question"],
        context(fixture))) as { job_id: string };
      expect((await job(fixture.env, started.job_id)).summary).toBe("Background question");
      const settled = await waitForTerminal(fixture.env, started.job_id);
      expect(settled.status).toBe("completed");
      const invocation = await lastInvocation(fixture);
      expect(spawnedPrompt(invocation.argv).endsWith(`Background question${expectedBlock(fixture.home)}`)).toBe(true);
      expect(settled.prompt_digest).toBe(digestPrompt(spawnedPrompt(invocation.argv)));
      expect(await newSessionState(fixture.home)).toMatchObject({ lastPrompt: "Background question", title: "Kimi Ask: Background question" });
    }, { KIMI_PLUGIN_CC_MOCK_DELAY_MS: "1500" });
  }, 30_000);

  test("timeout recovery binds the session when the prompt carries references", async () => {
    await withFixture("ask-success", async (fixture) => {
      await expect(runAsk(["--budget", "1s", "--reference-session", REF_SESSION, "Inspect"], context(fixture))).rejects.toBeDefined();
      const [row] = await jobs(fixture.env);
      expect(row).toMatchObject({ status: "failed", kimi_session_id: NEW_SESSION, kimi_session_id_source: "recovered_session_dir" });
    }, { KIMI_PLUGIN_CC_MOCK_POST_OUTPUT_DELAY_MS: "5000" });
  }, 30_000);

  test("rescue (foreground) and a job-id reference from another repository", async () => {
    await withFixture("rescue-success", async (fixture) => {
      const other = await createGitRepoFixture("session-references-other-repo");
      try {
        await ensurePluginPaths(resolvePluginPaths(fixture.env));
        const store = new JobStore(resolvePluginPaths(fixture.env));
        try {
          store.createJob({
            job_id: "99999999-9999-4999-8999-999999999999", repo_id: (await resolveRepoIdentity(other)).repoId,
            command_type: "review", cwd: other, model: null, thinking: null, background: false, pid: null, kimi_pid: null,
            status: "completed", kimi_session_id: REF_SESSION, operation_kind: "review", intended_engine: "native-v2",
            observed_engine: "native-v2", kimi_version: "2.8.0", system_version: "2.8.0", agent_profile: "<cli-client>",
            prompt_digest: "digest", summary: "s", final_output_path: null, stream_log_path: "/dev/null", error: null,
          });
        } finally {
          store.close();
        }
        await runRescue(["--reference-session", "99999999-9999-4999-8999-999999999999", "Fix", "it"], context(fixture));
        const prompt = spawnedPrompt((await lastInvocation(fixture)).argv);
        expect(prompt.endsWith(`Fix it${expectedBlock(fixture.home)}`)).toBe(true);
        expect(await newSessionState(fixture.home)).toMatchObject({ lastPrompt: "Fix it", title: "Kimi Rescue: Fix it" });
      } finally {
        await cleanupTestPath(other);
      }
    });
  }, 30_000);

  test.each(["review", "challenge"] as const)("%s appends the block after the diff context", async (commandType) => {
    await withFixture(`${commandType}-success`, async (fixture) => {
      await runReview(["--reference-session", REF_SESSION, "auth"], context(fixture), commandType);
      const prompt = spawnedPrompt((await lastInvocation(fixture)).argv);
      expect(prompt.endsWith(expectedBlock(fixture.home))).toBe(true);
      expect(prompt).toContain("Review focus: auth\n");
      expect((await newSessionState(fixture.home)).lastPrompt).toBe("Review target: current working tree changes. Focus: auth");
      await expect(runReview(["--reference-session", "session_missing"], context(fixture), commandType))
        .rejects.toMatchObject({ code: "INVALID_ARGS", stage: `${commandType}.reference-session` });
      expect(await jobs(fixture.env)).toHaveLength(1);
    });
  }, 30_000);
});

const workerStub = `
import { appendFile } from 'node:fs/promises';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.8.0'); process.exit(0); }
await appendFile(process.env.SWARM_REF_LOG, JSON.stringify({argv:args, home:process.env.KIMI_CODE_HOME ?? null})+'\\n');
console.log(JSON.stringify({role:'meta', type:'system.version', version:'2.8.0'}));
console.log(JSON.stringify({role:'assistant',content:'Swarm done.'}));
console.log(JSON.stringify({role:'meta',type:'session.resume_hint',session_id:'swarm_ref_session',command:'kimi -r swarm_ref_session',content:'To resume this session: kimi -r swarm_ref_session'}));
`;

describe("session references in swarm (exact 2.8.0 direct worker)", () => {
  test.each([false, true])("write=%p appends the block to the coordinator prompt", async (write) => {
    const root = await createTestPluginDataRoot("session-references-swarm");
    const repo = await createGitRepoFixture("session-references-swarm-repo");
    const home = path.join(root, "home");
    const stub = path.join(root, "worker.mjs");
    const logPath = path.join(root, "invocations.jsonl");
    await writeFile(stub, workerStub);
    await seedReferencedSession(home);
    const env: NodeJS.ProcessEnv = {
      HOME: root,
      PATH: process.env.PATH,
      KIMI_PLUGIN_CC_DATA: path.join(root, "data"),
      KIMI_CODE_HOME: home,
      KIMI_PLUGIN_CC_KIMI_BIN: Bun.which("node") ?? "node",
      KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify([stub]),
      KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
      KIMI_PLUGIN_CC_DISABLE_WEB_ANNOUNCE: "1",
      SWARM_REF_LOG: logPath,
    };
    try {
      const argv = [...(write ? ["--write"] : []), "--max-concurrency", "1", "--reference-session", REF_SESSION, "audit", "modules"];
      await runSwarm(argv, { cwd: repo, env, stdout: process.stdout, stderr: process.stderr });
      const entries = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { argv: string[]; home: string });
      expect(entries).toHaveLength(1);
      const prompt = spawnedPrompt(entries[0]!.argv);
      expect(entries[0]!.home).toBe(home);
      expect(prompt.endsWith(expectedBlock(home))).toBe(true);
      const [row] = await jobs(env);
      expect(row!.status).toBe("completed");
      expect(row!.prompt_digest).toBe(digestPrompt(prompt));
      expect(row!.summary).toBe(`[${write ? "swarm-write" : "swarm"}] audit modules`);
      await expect(runSwarm([...(write ? ["--write"] : []), "--reference-session", "session_missing", "x"],
        { cwd: repo, env, stdout: process.stdout, stderr: process.stderr }))
        .rejects.toMatchObject({ code: "INVALID_ARGS", stage: "swarm.reference-session" });
      expect(await jobs(env)).toHaveLength(1);
      // The refused write-swarm removed the worktree it created before resolution.
      const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" });
      expect(worktrees.match(/^worktree /gm)).toHaveLength(1);
    } finally {
      await cleanupTestPath(root);
      await cleanupTestPath(repo);
    }
  }, 45_000);
});
