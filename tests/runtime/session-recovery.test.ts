import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { firstUserMessageMatches, recoverSessionIdFromStore } from "../../runtime/session-recovery.js";
import { digestPrompt } from "../../runtime/jobs.js";
import { JobStore, renderBudgetSource } from "../../runtime/job-store.js";
import { ensurePluginPaths, resolvePluginPaths } from "../../runtime/paths.js";
import { captureTimeoutPartialOutput } from "../../runtime/commands/cli-helpers.js";
import { ResponseTimeoutError } from "../../runtime/cli-client.js";
import { RuntimeError } from "../../runtime/errors.js";

let root: string;
let store: JobStore;
let spawnedAt: number;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "session-recovery-"));
  const paths = resolvePluginPaths({ KIMI_PLUGIN_CC_DATA: root });
  await ensurePluginPaths(paths);
  store = new JobStore(paths);
  spawnedAt = Date.now();
});
afterEach(async () => { store.close(); await rm(root, { recursive: true, force: true }); });

const PROMPT = "Inspect the repository";
const DIGEST = digestPrompt(PROMPT);
const userMessage = (text: string) =>
  JSON.stringify({ type: "context.append_message", agentId: "main", message: { role: "user", content: [{ type: "text", text }] }, time: 1 });
const journalFor = (...lines: string[]) =>
  [JSON.stringify({ type: "metadata", protocol_version: "1.5", created_at: 1 }), ...lines].map((line) => `${line}\n`).join("");

async function state(overrides: Record<string, unknown> = {}, workspace = "wd_test", journal: string | null = journalFor(userMessage(PROMPT))) {
  const id = `session_${randomUUID()}`;
  const dir = path.join(root, "sessions", workspace, id);
  await mkdir(path.join(dir, "agents", "main"), { recursive: true });
  await writeFile(path.join(dir, "state.json"), JSON.stringify({ id, version: 2, cwd: root, createdAt: spawnedAt, ...overrides }));
  if (journal !== null) await writeFile(path.join(dir, "agents", "main", "wire.jsonl"), journal);
  return { id, dir };
}
const recover = (promptDigest = DIGEST, entryCap?: number) => recoverSessionIdFromStore({ kimiHome: root, cwd: root, spawnedAt,
  settledAt: spawnedAt + 100, promptDigest, store, jobId: "current", entryCap });

describe("bounded native-v2 session recovery", () => {
  test("one matching candidate", async () => {
    const candidate = await state();
    expect(await recover()).toEqual({ sessionId: candidate.id });
  });
  test("two candidates refuse instead of selecting newest", async () => {
    await state(); await state({ createdAt: spawnedAt + 1 });
    expect(await recover()).toEqual({ reason: "ambiguous:2" });
  });
  test("cwd mismatch", async () => {
    await state({ cwd: tmpdir() });
    expect(await recover()).toEqual({ reason: "none" });
  });
  test("cwd aliases match by realpath", async () => {
    const alias = path.join(root, "alias"); await symlink(root, alias);
    const candidate = await state({ cwd: alias });
    expect(await recover()).toEqual({ sessionId: candidate.id });
  });
  test("createdAt outside both window edges", async () => {
    // No pre-spawn slack: the child writes createdAt after the parent stamped spawnedAt.
    await state({ createdAt: spawnedAt - 1 }); await state({ createdAt: spawnedAt + 101 });
    expect(await recover()).toEqual({ reason: "none" });
  });
  test("boundary timestamps are inclusive", async () => {
    const candidate = await state({ createdAt: spawnedAt });
    expect(await recover()).toEqual({ sessionId: candidate.id });
    await state({ createdAt: spawnedAt + 100 });
    expect(await recover()).toEqual({ reason: "ambiguous:2" });
  });
  test("id on any other job is excluded, regardless of repo/status", async () => {
    const candidate = await state();
    store.createJob({ job_id: "other", repo_id: "other-repo", command_type: "review", cwd: root,
      model: null, thinking: null, background: false, pid: null, kimi_pid: null, status: "failed",
      kimi_session_id: candidate.id, agent_profile: "test", prompt_digest: DIGEST, summary: "test",
      final_output_path: null, stream_log_path: "unused", error: null });
    expect(store.hasSessionId(candidate.id)).toBe(true);
    expect(store.hasSessionId(candidate.id, "other")).toBe(false);
    expect(await recover()).toEqual({ reason: "none" });
  });
  test("journal digest binds the candidate to this spawn", async () => {
    await state({}, "wd_test", journalFor(userMessage("a different prompt")));
    expect(await recover()).toEqual({ reason: "digest_mismatch:1" });
    const candidate = await state();
    expect(await recover()).toEqual({ sessionId: candidate.id });
    expect(await recover(digestPrompt("yet another prompt"))).toEqual({ reason: "digest_mismatch:2" });
  });
  test("a missing or empty journal never binds", async () => {
    await state({}, "wd_test", null);
    expect(await recover()).toEqual({ reason: "journal_missing:1" });
    await state({}, "wd_test", "");
    expect(await recover()).toEqual({ reason: "digest_mismatch:1" });
  });
  test("only the FIRST user message binds; a later matching turn does not", async () => {
    await state({}, "wd_test", journalFor(userMessage("earlier turn"), userMessage(PROMPT)));
    expect(await recover()).toEqual({ reason: "digest_mismatch:1" });
    expect(firstUserMessageMatches(journalFor(userMessage("earlier turn"), userMessage(PROMPT)), DIGEST)).toBe(false);
  });
  test("any text item of the first user message may carry the prompt", async () => {
    const twoItems = JSON.stringify({ type: "context.append_message", message: { role: "user",
      content: [{ type: "text", text: "attached context" }, { type: "text", text: PROMPT }] } });
    const candidate = await state({}, "wd_test", journalFor("not json", twoItems));
    expect(await recover()).toEqual({ sessionId: candidate.id });
    expect(firstUserMessageMatches(journalFor(JSON.stringify({ message: { role: "user", content: "string body" } })), DIGEST)).toBe(false);
  });
  test("a malformed prompt digest refuses before scanning", async () => {
    await state();
    expect(await recover("test")).toEqual({ reason: "none" });
  });
  test("malformed JSON is skipped", async () => {
    const malformed = await state(); await writeFile(path.join(malformed.dir, "state.json"), "{");
    const candidate = await state();
    expect(await recover()).toEqual({ sessionId: candidate.id });
  });
  test("wrong version, id shape and directory/id mismatch are skipped", async () => {
    await state({ version: 1 }); await state({ id: "invalid" }); await state({ id: `session_${randomUUID()}` });
    expect(await recover()).toEqual({ reason: "none" });
  });
  test("enumeration cap cannot return a candidate from an incomplete scan", async () => {
    const candidate = await state();
    // Entries, not only matching directories, count against the same cap:
    // 1 workspace + 64 files + 1 session directory = 66 visited entries.
    const dir = path.join(root, "sessions/wd_test");
    for (let i = 0; i < 64; i++) await writeFile(path.join(dir, `entry-${i}`), "");
    expect(await recover(DIGEST, 64)).toEqual({ reason: "enumeration_capped" });
    expect(await recover(DIGEST, 66)).toEqual({ sessionId: candidate.id });
  });
  test("upstream index state and old sessions cost nothing: dot entries skipped, stale dirs unread", async () => {
    const candidate = await state();
    for (const index of [".index-dirty", ".index-cache"]) {
      const dir = path.join(root, "sessions", index);
      await mkdir(dir, { recursive: true });
      for (let i = 0; i < 300; i++) await writeFile(path.join(dir, `marker-${i}`), "");
    }
    // A pre-spawn session directory with an unreadable (oversized) state.json
    // would abort the scan if it were read; its mtime excludes it first.
    const stale = await state({}, "wd_stale");
    await writeFile(path.join(stale.dir, "state.json"), " ".repeat(1024 * 1024 + 1));
    const past = new Date(spawnedAt - 60_000);
    await utimes(stale.dir, past, past);
    expect(await recover()).toEqual({ sessionId: candidate.id });
  });
  test("a journal larger than the prefix cap is matched on its prefix, not refused", async () => {
    const filler = JSON.stringify({ type: "tool.result", content: "x".repeat(1024 * 1024) });
    const candidate = await state({}, "wd_test", journalFor(userMessage(PROMPT), filler, filler, filler, filler, filler));
    expect(await recover()).toEqual({ sessionId: candidate.id });
    const late = journalFor(filler, filler, filler, filler, filler, userMessage(PROMPT));
    await state({}, "wd_test", late);
    expect(await recover()).toEqual({ sessionId: candidate.id });
  });
  test("oversized state refuses an incomplete scan", async () => {
    const candidate = await state();
    await writeFile(path.join(candidate.dir, "state.json"), " ".repeat(1024 * 1024 + 1));
    expect(await recover()).toEqual({ reason: "unreadable" });
  });
  test("a symlinked entry is skipped, not fatal; a symlinked sessions root is", async () => {
    const stray = await state();
    await rm(stray.dir, { recursive: true });
    await symlink(root, stray.dir);
    expect(await recover()).toEqual({ reason: "none" });
    const candidate = await state();
    expect(await recover()).toEqual({ sessionId: candidate.id });
    await rm(path.join(root, "sessions"), { recursive: true });
    await symlink(tmpdir(), path.join(root, "sessions"));
    expect(await recover()).toEqual({ reason: "unreadable" });
  });

  test("no observed engine: recovery is skipped and the reason recorded", async () => {
    await state();
    const job = store.createJob({ job_id: "current", repo_id: "repo", command_type: "ask", cwd: root,
      model: null, thinking: null, background: false, pid: null, kimi_pid: null, status: "running",
      kimi_session_id: null, intended_engine: "native-v2", agent_profile: "test", prompt_digest: DIGEST,
      summary: "test", final_output_path: null, stream_log_path: "unused", error: null });
    const scan = spyOn(store, "hasSessionId");
    try {
      const timeout = new ResponseTimeoutError(1000, "ask.prompt", "ask", {
        spawnedAt, settledAt: spawnedAt + 100, records: [{ role: "assistant", content: "partial" }],
        observedEngine: null, systemVersion: undefined, malformed: [], stderrTail: "",
        exitCode: -1, signal: "SIGTERM", aborted: true,
      });
      const classified = new RuntimeError("ASK_KIMI_RESPONSE_TIMEOUT", "timed out", "ask.runtime", { cause: timeout });
      const partial = await captureTimeoutPartialOutput(classified, store, job, { KIMI_CODE_HOME: root });
      expect(partial?.text).toBe("partial");
      expect(scan).not.toHaveBeenCalled();
      expect(classified.details.session_recovery).toBe("engine_unobserved");
      expect(store.getJob("current")?.kimi_session_id).toBeNull();
    } finally { scan.mockRestore(); }
  });
  test("cancellation during asynchronous recovery persists no session or partial output", async () => {
    await state();
    const job = store.createJob({ job_id: "current", repo_id: "repo", command_type: "ask", cwd: root,
      model: null, thinking: null, background: false, pid: null, kimi_pid: null, status: "running",
      kimi_session_id: null, intended_engine: "native-v2", agent_profile: "test", prompt_digest: DIGEST,
      summary: "test", final_output_path: null, stream_log_path: "unused", error: null });
    const controller = new AbortController();
    const scan = spyOn(store, "hasSessionId").mockImplementation(() => {
      controller.abort();
      return false;
    });
    try {
      const timeout = new ResponseTimeoutError(1000, "ask.prompt", "ask", {
        spawnedAt, settledAt: spawnedAt + 100, records: [{ role: "assistant", content: "partial" }],
        observedEngine: "native-v2", systemVersion: "2.8.0", malformed: [], stderrTail: "",
        exitCode: -1, signal: "SIGTERM", aborted: true,
      });
      const classified = new RuntimeError("ASK_KIMI_RESPONSE_TIMEOUT", "timed out", "ask.runtime", { cause: timeout });
      expect(await captureTimeoutPartialOutput(classified, store, job, { KIMI_CODE_HOME: root }, controller.signal)).toBeUndefined();
      expect(scan).toHaveBeenCalled();
      expect(store.getJob("current")?.kimi_session_id).toBeNull();
      expect(store.getJob("current")?.kimi_session_id_source).toBeNull();
    } finally { scan.mockRestore(); }
  });
});

test("legacy budget provenance stays default or unknown, never invented", () => {
  expect(renderBudgetSource({ budget_source: null, budget_ms: null })).toBe("default");
  expect(renderBudgetSource({ budget_source: null, budget_ms: 1000 })).toBe("unknown");
  for (const source of ["explicit", "inherited", "default"] as const) {
    expect(renderBudgetSource({ budget_source: source, budget_ms: 1000 })).toBe(source);
  }
});
