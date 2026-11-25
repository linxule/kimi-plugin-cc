import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { rawTaskTextFromSubmittedPrompt, runRepairSessions } from "../../runtime/commands/repair-sessions.js";
import { buildGoalPrompt } from "../../runtime/commands/pursue.js";
import { buildSwarmPrompt, buildSwarmWritePrompt } from "../../runtime/commands/swarm.js";
import { promptMetadataText } from "../../runtime/session-title.js";
import { resolveRepoIdentity } from "../../runtime/git.js";
import { digestPrompt } from "../../runtime/jobs.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import type { CommandContext } from "../../runtime/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "kimi-repair-"));
  roots.push(root);
  const cwd = path.join(root, "repo");
  const home = path.join(root, "home");
  await mkdir(cwd);
  const env = { KIMI_PLUGIN_CC_DATA: path.join(root, "plugin"), KIMI_CODE_HOME: home };
  const paths = resolvePluginPaths(env);
  await mkdir(paths.logsDir, { recursive: true });
  const db = new Database(paths.stateDbPath);
  db.exec(`CREATE TABLE jobs (job_id TEXT PRIMARY KEY, repo_id TEXT, command_type TEXT, operation_kind TEXT,
    status TEXT, kimi_session_id TEXT, cwd TEXT, kimi_version TEXT, intended_engine TEXT, observed_engine TEXT,
    stream_log_path TEXT, prompt_digest TEXT, updated_at TEXT)`);
  db.close();
  const repoId = (await resolveRepoIdentity(cwd)).repoId;
  const context: CommandContext = { cwd, env, stdout: process.stdout, stderr: process.stderr };
  async function seed(id: string, overrides: Record<string, string | null> = {}, state: Record<string, unknown> = {}, spawnOverrides: Record<string, unknown> = {}, submitted?: string) {
    const prompt = submitted ?? `Investigate ${id} with the original user prompt.\nDo not substitute the answer summary.`;
    const sessionId = `session-${id}`;
    const sessionDir = path.join(home, "sessions", "workspace", sessionId);
    await mkdir(sessionDir, { recursive: true });
    const statePath = path.join(sessionDir, "state.json");
    await writeFile(statePath, JSON.stringify({ version: 2, title: "My custom title", isCustomTitle: true, ...state }));
    await appendFile(path.join(home, "session_index.jsonl"), JSON.stringify({ sessionId, sessionDir }) + "\n");
    const log = path.join(paths.logsDir, `${id}.jsonl`);
    const row = {
      job_id: id, repo_id: repoId, command_type: "ask", operation_kind: "ask", status: "completed", kimi_session_id: sessionId,
      cwd, kimi_version: "2.0.0", intended_engine: "native-v2", observed_engine: "native-v2", stream_log_path: log,
      prompt_digest: digestPrompt(prompt), updated_at: "2026-09-18T00:00:00Z", ...overrides,
    };
    await writeFile(log, JSON.stringify({ direction: "meta", message: { commandType: "ask" } }) + "\n" + JSON.stringify({
      event: "spawn", args: ["--output-format", "stream-json", "-p", prompt], intended_engine: row.intended_engine,
      operation_kind: row.operation_kind, kimi_version: row.kimi_version,
      cwd: row.operation_kind === "swarm-write" ? path.join(paths.worktreesDir, row.repo_id!, `swarm-write-${id}`) : row.cwd,
      ...spawnOverrides,
    }) + "\n");
    const store = new Database(paths.stateDbPath);
    store.prepare(`INSERT INTO jobs (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    store.close();
    return { statePath, log, prompt, sessionId };
  }
  return { root, cwd, home, paths, context, seed };
}

function parse(output: string) {
  return JSON.parse(output) as { mode: string; scope: string; sessions: number; counts: Record<string, number>; results: Array<{ job_id: string; status: string }> };
}

describe("repair-sessions", () => {
  for (const host of ["dist", "plugins/kimi-codex/dist"]) {
    for (const engine of ["node", "bun"]) {
      test(`compiled ${host} opens the real SQLite store read-only under ${engine}`, async () => {
        const f = await fixture();
        const session = await f.seed("compiled");
        const beforeState = await readFile(session.statePath, "utf8");
        const beforeDb = await readFile(f.paths.stateDbPath);
        const beforeStat = await lstat(f.paths.stateDbPath);
        const moduleUrl = pathToFileURL(path.resolve(import.meta.dir, "../..", host, "commands/repair-sessions.js")).href;
        // Execute emitted JS in a separate engine, not Bun's TS loader. A missing
        // store would return before opening SQLite and hide constructor regressions.
        const script = `import(${JSON.stringify(moduleUrl)}).then(async ({ runRepairSessions }) => {
          process.stdout.write(await runRepairSessions([], {
            cwd: ${JSON.stringify(f.cwd)}, env: process.env,
            stdout: process.stdout, stderr: process.stderr
          }));
        }).catch(error => { console.error(error); process.exitCode = 1; });`;
        const result = spawnSync(engine === "bun" ? process.execPath : "node", ["--eval", script], {
          cwd: f.cwd,
          env: { ...process.env, ...f.context.env, KIMI_PLUGIN_CC_DISABLE_WEB_ANNOUNCE: "1" },
          encoding: "utf8",
          timeout: 5000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(parse(result.stdout)).toMatchObject({
          mode: "dry-run", scope: "repository", sessions: 1, counts: { "would-update": 1 },
        });
        expect(result.stdout).not.toContain(session.prompt);
        expect(await readFile(session.statePath, "utf8")).toBe(beforeState);
        expect(await readFile(f.paths.stateDbPath)).toEqual(beforeDb);
        expect((await lstat(f.paths.stateDbPath)).mtimeMs).toBe(beforeStat.mtimeMs);
      });
    }
  }

  test("defaults to a non-mutating preview and applies faithful prompt metadata while preserving a custom title", async () => {
    const f = await fixture();
    const session = await f.seed("repair");
    const beforeState = await readFile(session.statePath, "utf8");
    const beforeDb = await readFile(f.paths.stateDbPath);
    const beforeDbStat = await lstat(f.paths.stateDbPath);
    const beforeHome = await readdir(f.home);
    const previewText = await runRepairSessions([], f.context);
    const preview = parse(previewText);
    expect(preview).toMatchObject({ mode: "dry-run", scope: "repository", sessions: 1, counts: { "would-update": 1 } });
    expect(previewText).not.toContain(session.prompt);
    expect(await readFile(session.statePath, "utf8")).toBe(beforeState);
    expect(await readFile(f.paths.stateDbPath)).toEqual(beforeDb);
    expect((await lstat(f.paths.stateDbPath)).mtimeMs).toBe(beforeDbStat.mtimeMs);
    expect(await readdir(f.home)).toEqual(beforeHome);
    const applied = parse(await runRepairSessions(["--apply"], f.context));
    expect(applied.counts.updated).toBe(1);
    expect(JSON.parse(await readFile(session.statePath, "utf8"))).toMatchObject({
      title: "My custom title", isCustomTitle: true, lastPrompt: session.prompt.replace(/\s+/g, " "),
    });
    expect(await readFile(f.paths.stateDbPath)).toEqual(beforeDb);
  });

  test("excludes unproven, failed, gate and active sessions; deduplicates completed resume jobs", async () => {
    const f = await fixture();
    await f.seed("valid");
    await f.seed("duplicate", { kimi_session_id: "session-valid" });
    await f.seed("legacy", { intended_engine: "legacy-v1" });
    await f.seed("unknown", { observed_engine: null });
    await f.seed("failed", { status: "failed" });
    await f.seed("gate", { command_type: "review_gate", operation_kind: "review_gate" });
    await f.seed("historical", { operation_kind: null });
    await f.seed("future", { operation_kind: "unsupported-future-operation" });
    await f.seed("active-old");
    await f.seed("active-new", { status: "running", kimi_session_id: "session-active-old" });
    const result = parse(await runRepairSessions([], f.context));
    expect(result.sessions).toBe(1);
    expect(result.counts["would-update"]).toBe(1);
  });

  test("cross-checks spawn engine, version, operation and cwd; accepts only the expected removed swarm worktree cwd", async () => {
    const f = await fixture();
    await f.seed("wrong-engine", {}, {}, { intended_engine: "legacy-v1" });
    await f.seed("wrong-version", {}, {}, { kimi_version: "0.43.0" });
    await f.seed("wrong-operation", {}, {}, { operation_kind: "review" });
    await f.seed("wrong-cwd", {}, {}, { cwd: "/another/repository" });
    await f.seed("swarm-write", { operation_kind: "swarm-write", command_type: "rescue" });
    await f.seed("swarm-wrong-cwd", { operation_kind: "swarm-write", command_type: "rescue" }, {}, { cwd: f.cwd });
    const result = parse(await runRepairSessions([], f.context));
    expect(result.counts).toEqual({ "would-update": 1, "unavailable-verified-prompt": 5 });
    expect(result.results.find((item) => item.status === "would-update")?.job_id).toBe("swarm-write");
  });

  test("--all widens repository scope only within the resolved host store", async () => {
    const f = await fixture();
    await f.seed("local");
    await f.seed("other", { repo_id: "another-repository" });
    expect(parse(await runRepairSessions([], f.context)).sessions).toBe(1);
    expect(parse(await runRepairSessions(["--all"], f.context))).toMatchObject({ scope: "host", sessions: 2 });
  });

  test("refuses fabricated prompts, escaped logs and symlinks without rewriting sessions", async () => {
    const f = await fixture();
    const mismatch = await f.seed("mismatch", { prompt_digest: "not-the-original-digest" });
    const outside = await f.seed("outside", { stream_log_path: path.join(f.root, "outside.jsonl") });
    await writeFile(path.join(f.root, "outside.jsonl"), await readFile(outside.log));
    const linked = await f.seed("linked");
    await rm(linked.log);
    await symlink(path.join(f.root, "outside.jsonl"), linked.log);
    const malformed = await f.seed("malformed");
    await writeFile(malformed.log, "{bad json}\n");
    const result = parse(await runRepairSessions(["--apply"], f.context));
    expect(result.counts["unavailable-verified-prompt"]).toBe(4);
    for (const item of [mismatch, outside, linked, malformed]) {
      expect(JSON.parse(await readFile(item.statePath, "utf8")).lastPrompt).toBeUndefined();
    }
  });

  test("reads only the first bounded spawn line even for a large transcript and refuses an oversized first record", async () => {
    const f = await fixture();
    const largeTranscript = await f.seed("large-transcript");
    await appendFile(largeTranscript.log, "x".repeat(3 * 1024 * 1024));
    const oversized = await f.seed("oversized");
    await writeFile(oversized.log, JSON.stringify({ event: "spawn", args: ["-p", "x".repeat(3 * 1024 * 1024)] }) + "\n");
    const result = parse(await runRepairSessions([], f.context));
    expect(result.counts).toEqual({ "would-update": 1, "unavailable-verified-prompt": 1 });
  });

  test("missing and old stores stay untouched and do not gain directories or provenance migrations", async () => {
    const f = await fixture();
    await rm(f.paths.pluginRoot, { recursive: true });
    expect(parse(await runRepairSessions([], f.context)).sessions).toBe(0);
    expect(await lstat(f.paths.pluginRoot).catch(() => null)).toBeNull();
    await mkdir(f.paths.pluginRoot, { recursive: true });
    const db = new Database(f.paths.stateDbPath);
    db.exec("CREATE TABLE jobs (job_id TEXT)");
    db.close();
    const before = await readFile(f.paths.stateDbPath);
    expect(parse(await runRepairSessions(["--apply"], f.context)).sessions).toBe(0);
    expect(await readFile(f.paths.stateDbPath)).toEqual(before);
  });

  test("preserves an existing prompt preview and native generated title", async () => {
    const f = await fixture();
    const session = await f.seed("existing", {}, { title: "Native generated title", titleKind: "generated", isCustomTitle: false, lastPrompt: "Existing meaningful preview" });
    await runRepairSessions(["--apply"], f.context);
    expect(JSON.parse(await readFile(session.statePath, "utf8"))).toMatchObject({
      title: "Native generated title", titleKind: "generated", isCustomTitle: false, lastPrompt: "Existing meaningful preview",
    });
  });

  test("refuses a symlink database and a repair exceeding the row budget before session writes", async () => {
    const f = await fixture();
    const session = await f.seed("budget");
    const before = await readFile(session.statePath, "utf8");
    const db = new Database(f.paths.stateDbPath);
    db.exec(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 1001)
      INSERT INTO jobs SELECT 'duplicate-' || n, repo_id, command_type, operation_kind, status, kimi_session_id, cwd,
      kimi_version, intended_engine, observed_engine, stream_log_path, prompt_digest, updated_at FROM jobs, numbers WHERE job_id = 'budget'`);
    db.close();
    await expect(runRepairSessions(["--apply"], f.context)).rejects.toMatchObject({ code: "SESSION_REPAIR_LIMIT" });
    expect(await readFile(session.statePath, "utf8")).toBe(before);
    const outside = path.join(f.root, "outside.db");
    await writeFile(outside, await readFile(f.paths.stateDbPath));
    await rm(f.paths.stateDbPath);
    await symlink(outside, f.paths.stateDbPath);
    await expect(runRepairSessions([], f.context)).rejects.toMatchObject({ code: "SESSION_REPAIR_UNSAFE_STORE" });
  });

  test("rejects unknown and repeated options before reading the store", async () => {
    const f = await fixture();
    for (const args of [["--bogus"], ["--apply", "--apply"], ["session-id"]]) {
      await expect(runRepairSessions(args, f.context)).rejects.toMatchObject({ code: "INVALID_ARGS" });
    }
  });

  test("replaces a preview that is the plugin's own prefixed prompt, under a distinct status", async () => {
    const f = await fixture();
    const own = await f.seed("own", {}, {}, {}, ASK_PREFIX + "Where are sessions stored?");
    await writeFile(own.statePath, JSON.stringify({ version: 2, title: "My custom title", isCustomTitle: true,
      lastPrompt: promptMetadataText(own.prompt) }));
    const truncated = await f.seed("truncated", { operation_kind: "rescue", command_type: "rescue" }, {}, {}, RESCUE_PREFIX + "Fix the flaky test");
    await writeFile(truncated.statePath, JSON.stringify({ version: 2, title: "Native generated title", titleKind: "generated",
      lastPrompt: "Follow repository instructions and inspect" }));
    const foreign = await f.seed("foreign", {}, { lastPrompt: "Typed later in Kimi Desktop" }, {}, ASK_PREFIX + "Another question");
    const missing = await f.seed("missing", {}, {}, {}, ASK_PREFIX + "A question with no preview");
    const before = await readFile(own.statePath, "utf8");
    const preview = parse(await runRepairSessions([], f.context));
    expect(preview.counts).toEqual({ "would-replace-preview": 2, "would-update": 1, unchanged: 1 });
    expect(await readFile(own.statePath, "utf8")).toBe(before);
    const applied = parse(await runRepairSessions(["--apply"], f.context));
    expect(applied.counts).toEqual({ "preview-replaced": 2, updated: 1, unchanged: 1 });
    expect(JSON.parse(await readFile(own.statePath, "utf8"))).toEqual({ version: 2, title: "My custom title",
      isCustomTitle: true, lastPrompt: "Where are sessions stored?" });
    expect(JSON.parse(await readFile(truncated.statePath, "utf8"))).toMatchObject({ title: "Native generated title",
      titleKind: "generated", lastPrompt: "Fix the flaky test" });
    expect(JSON.parse(await readFile(foreign.statePath, "utf8")).lastPrompt).toBe("Typed later in Kimi Desktop");
    expect(JSON.parse(await readFile(missing.statePath, "utf8")).lastPrompt).toBe("A question with no preview");
    expect(parse(await runRepairSessions(["--apply"], f.context)).counts).toEqual({ unchanged: 4 });
  });

  test("a short native text that merely starts the plugin prompt is kept", async () => {
    const f = await fixture();
    const session = await f.seed("short", {}, {}, {}, ASK_PREFIX + "Where are sessions stored?");
    await writeFile(session.statePath, JSON.stringify({ version: 2, title: "Manual", titleKind: "custom", lastPrompt: "Answer directly" }));
    const before = await readFile(session.statePath, "utf8");
    expect(parse(await runRepairSessions(["--apply"], f.context)).counts).toEqual({ unchanged: 1 });
    expect(await readFile(session.statePath, "utf8")).toBe(before);
  });

  test("an earlier run's own prompt in a resumed session is replaced by the newest run's raw text", async () => {
    const f = await fixture();
    const first = await f.seed("first", { updated_at: "2026-09-01T00:00:00Z" }, {}, {}, ASK_PREFIX + "First question");
    await f.seed("second", { kimi_session_id: first.sessionId }, {}, {}, ASK_PREFIX + "Follow-up question");
    await writeFile(first.statePath, JSON.stringify({ version: 2, title: "Manual", titleKind: "custom",
      lastPrompt: promptMetadataText(first.prompt) }));
    const result = parse(await runRepairSessions(["--apply"], f.context));
    expect(result).toMatchObject({ sessions: 1, counts: { "preview-replaced": 1 } });
    expect(result.results[0]!.job_id).toBe("second");
    expect(JSON.parse(await readFile(first.statePath, "utf8")).lastPrompt).toBe("Follow-up question");
  });

  test("keeps an own-prompt preview when no exact raw text can be derived", async () => {
    const f = await fixture();
    const session = await f.seed("underivable");
    await writeFile(session.statePath, JSON.stringify({ version: 2, title: "Manual", titleKind: "custom",
      lastPrompt: promptMetadataText(session.prompt) }));
    const before = await readFile(session.statePath, "utf8");
    expect(parse(await runRepairSessions(["--apply"], f.context)).counts).toEqual({ unchanged: 1 });
    expect(await readFile(session.statePath, "utf8")).toBe(before);
  });
});

const ASK_PREFIX = [
  "Answer directly in free-form prose.",
  "For repository-dependent questions, inspect the relevant code with the allowed read tools and cite file:line for concrete code claims where useful.",
  "Distinguish evidence from inference and state unknowns explicitly.",
  "Do not use shell/Bash, writes, background tasks, or delegated operations.",
  "Do not emit JSON unless the user explicitly asks for it.",
  "Do not narrate tool progress; make the final response self-contained.",
  "",
  "User question:",
  "",
].join("\n");
const RESCUE_PREFIX = [
  "Follow repository instructions and inspect the current state before editing.",
  "Implement the smallest complete change that satisfies the task instead of stopping at a plan.",
  "Do not mutate git state.",
  "Run proportionate relevant checks, and never claim unrun checks passed.",
  "Do not narrate progress.",
  "Finish with a self-contained report of changed files, verification commands and results, and unfinished work or blockers.",
  "",
  "Rescue task:",
  "",
].join("\n");

describe("rawTaskTextFromSubmittedPrompt", () => {
  test("recovers ask and rescue tasks, including the bare-resume continuation", () => {
    expect(rawTaskTextFromSubmittedPrompt("ask", ASK_PREFIX + "Where are sessions stored?")).toBe("Where are sessions stored?");
    expect(rawTaskTextFromSubmittedPrompt("ask", ASK_PREFIX.replace(/\n\nUser question:\n\n$/, "\n\n") +
      "Continue the previous ask conversation and answer any outstanding question."))
      .toBe("Continue the previous ask conversation and answer any outstanding question.");
    expect(rawTaskTextFromSubmittedPrompt("rescue", RESCUE_PREFIX + "Fix the flaky test")).toBe("Fix the flaky test");
  });

  test.each([
    [undefined], [5],
  ])("inverts the pursue goal prompt exactly (turns %p)", (turns) => {
    const objective = "finish the report and run the tests";
    expect(rawTaskTextFromSubmittedPrompt("pursue", buildGoalPrompt(objective, turns))).toBe(objective);
  });

  test.each([
    [undefined, undefined], [3, undefined], [undefined, 4], [3, 4], [undefined, 1],
  ])("inverts read and write swarm prompts exactly (cap %p, wave %p)", (cap, wave) => {
    const objective = "audit every handler\nunder runtime/commands for at most 2 entries";
    expect(rawTaskTextFromSubmittedPrompt("swarm", buildSwarmPrompt(objective, cap, wave))).toBe(objective);
    expect(rawTaskTextFromSubmittedPrompt("swarm-write", buildSwarmWritePrompt(objective, cap, wave))).toBe(objective);
  });

  test("fails closed on prompts from other templates, edited prompts and unknown operations", () => {
    expect(rawTaskTextFromSubmittedPrompt("ask", "Investigate this without the plugin preamble")).toBeUndefined();
    expect(rawTaskTextFromSubmittedPrompt("ask", ASK_PREFIX)).toBeUndefined();
    expect(rawTaskTextFromSubmittedPrompt("rescue", ASK_PREFIX + "question")).toBeUndefined();
    expect(rawTaskTextFromSubmittedPrompt("pursue", "/goal --  spaced  objective")).toBeUndefined();
    expect(rawTaskTextFromSubmittedPrompt("swarm", buildSwarmPrompt("objective") + "\nextra")).toBeUndefined();
    expect(rawTaskTextFromSubmittedPrompt("swarm", buildSwarmWritePrompt("objective"))).toBeUndefined();
    expect(rawTaskTextFromSubmittedPrompt("review", "Review this please")).toBeUndefined();
    expect(rawTaskTextFromSubmittedPrompt("unsupported-future-operation", ASK_PREFIX + "x")).toBeUndefined();
  });
});
