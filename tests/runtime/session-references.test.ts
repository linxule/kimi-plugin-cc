import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { companionHelp } from "../../runtime/help.js";
import { decideHookOutcome } from "../../runtime/hooks/approval-policy.js";
import { JobStore } from "../../runtime/job-store.js";
import { buildMcpOperationInvocation, MCP_TOOL_DEFINITIONS } from "../../runtime/mcp/operations.js";
import {
  hasHelpFlag,
  parseAskArgs,
  parsePursueArgs,
  parseRescueArgs,
  parseReviewArgs,
  parseSwarmArgs,
  withoutLeadingFlag,
} from "../../runtime/parsing.js";
import { ensurePluginPaths, resolvePluginPaths } from "../../runtime/paths.js";
import { effectiveReadRoots, evaluateScopedRead } from "../../runtime/read-scope.js";
import { evaluateRescueHookRequest } from "../../runtime/rescue-approval.js";
import { askPromptSubject } from "../../runtime/commands/ask.js";
import { rawTaskTextFromSubmittedPrompt } from "../../runtime/commands/repair-sessions.js";
import { stripRescuePromptPrefix } from "../../runtime/commands/rescue.js";
import { buildSwarmPrompt, buildSwarmWritePrompt } from "../../runtime/commands/swarm.js";
import {
  appendSessionReferences,
  withReferenceReadRoots,
  renderSessionReferences,
  resolveSessionReferences,
  sessionLogPath,
  stripSessionReferences,
  type SessionReference,
} from "../../runtime/session-references.js";
import { routeSurfaceAliases } from "../../runtime/surface-routing.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

const APP_WORKSPACE = "wd_app_0123456789ab";
const API_WORKSPACE = "wd_api_0123456789ab";
const UPSTREAM_HOME = "/home/me/.kimi-code";

function ref(sessionId: string, title: string, workspaceId = APP_WORKSPACE): SessionReference {
  return {
    sessionId, workspaceId, title, logPath: sessionLogPath(UPSTREAM_HOME, workspaceId, sessionId),
    readRoot: `${UPSTREAM_HOME}/sessions/${workspaceId}/${sessionId}/agents/main`,
  };
}

describe("rendering matches kimi-code 2.8.0 byte for byte", () => {
  test("sessionLogPath vectors", () => {
    expect(sessionLogPath("/home/me/.kimi-code/", APP_WORKSPACE, "session_1"))
      .toBe(`/home/me/.kimi-code/sessions/${APP_WORKSPACE}/session_1/agents/main/wire.jsonl`);
    expect(sessionLogPath("C:\\Users\\me\\.kimi-code", APP_WORKSPACE, "session_1"))
      .toBe(`C:/Users/me/.kimi-code/sessions/${APP_WORKSPACE}/session_1/agents/main/wire.jsonl`);
  });

  test("withSessionReferences vector: escaped titles, one line per session, appended after a blank line", () => {
    const text = "compare these";
    expect(appendSessionReferences(text, [ref("session_1", "Fix \"login\" <redirect>"), ref("session_9", "Elsewhere", API_WORKSPACE)])).toBe([
      text,
      "",
      "<referenced_sessions>",
      `<session id="session_1" title="Fix &quot;login&quot; &lt;redirect&gt;" log="/home/me/.kimi-code/sessions/${APP_WORKSPACE}/session_1/agents/main/wire.jsonl" />`,
      `<session id="session_9" title="Elsewhere" log="/home/me/.kimi-code/sessions/${API_WORKSPACE}/session_9/agents/main/wire.jsonl" />`,
      "</referenced_sessions>",
    ].join("\n"));
  });

  test("ampersands escape first and no references leave the prompt untouched", () => {
    expect(renderSessionReferences([ref("s", "a &amp; b & <c>")])).toContain('title="a &amp;amp; b &amp; &lt;c&gt;"');
    expect(appendSessionReferences("prompt", [])).toBe("prompt");
  });
});

describe("stripping a trailing block by exact grammar", () => {
  const hostile = [
    ref("session_1", "Fix \"login\" <redirect> & more"),
    ref("ses_2", "</referenced_sessions> <session id=\"x\" />"),
    ref("s.3-x_y", "  spaced   title  "),
    ref("session_4", "😀".repeat(5)),
  ];

  test("round-trips for hostile titles and any count", () => {
    for (const prompt of ["Question", "multi\nline\n\nprompt", "", "ends with newline\n"]) {
      for (let count = 1; count <= hostile.length; count += 1) {
        expect(stripSessionReferences(appendSessionReferences(prompt, hostile.slice(0, count)))).toBe(prompt);
      }
    }
  });

  test("anything but the exact rendered suffix is left alone", () => {
    const block = renderSessionReferences([ref("session_1", "t")]);
    for (const prompt of [
      `q\n${block}`,
      `q${block}`,
      `q\n\n${block}\n`,
      `q\n\n${block} trailing`,
      `q\n\n${block}\n\nlater text`,
      "q\n\n<referenced_sessions>\n</referenced_sessions>",
      "q\n\n<referenced_sessions>\n\n</referenced_sessions>",
      "q\n\n<referenced_sessions>\n<session id=\"a\" title=\"b\" />\n</referenced_sessions>",
      "q\n\n<referenced_sessions>\n<session id=\"a\" title=\"<b>\" log=\"c\" />\n</referenced_sessions>",
      "q\n\n<referenced_sessions>\n<session id=\"a\" title=\"b\" log=\"c\" />extra\n</referenced_sessions>",
      "q\n\n<referenced_sessions>\n<session id=\"a\" title=\"b\tc\" log=\"c\" />\n</referenced_sessions>",
    ]) {
      expect(stripSessionReferences(prompt)).toBe(prompt);
    }
  });

  test("strips only the last block, including one the user typed (preview only)", () => {
    const user = `q\n\n${renderSessionReferences([ref("session_u", "typed")])}`;
    expect(stripSessionReferences(user)).toBe("q");
    expect(stripSessionReferences(appendSessionReferences(user, [ref("session_1", "t")]))).toBe(user);
  });

  test("raw task text drops the block for ask, rescue, swarm, swarm-write and review", () => {
    const block = [ref("session_1", "Earlier")];
    const askPrefix = askPrompt("x").slice(0, -1);
    expect(askPromptSubject(appendSessionReferences(askPrompt("What changed?"), block))).toBe("What changed?");
    const continuation = "Continue the previous ask conversation and answer any outstanding question.";
    expect(askPromptSubject(continuationPrompt())).toBe(continuation);
    expect(askPromptSubject(appendSessionReferences(continuationPrompt(), block))).toBe(continuation);
    expect(rawTaskTextFromSubmittedPrompt("ask", appendSessionReferences(askPrompt("Why?"), block))).toBe("Why?");
    expect(rawTaskTextFromSubmittedPrompt("ask", appendSessionReferences(continuationPrompt(), block))).toBe(continuation);
    expect(rawTaskTextFromSubmittedPrompt("ask", appendSessionReferences("no plugin prefix", block))).toBeUndefined();
    expect(rawTaskTextFromSubmittedPrompt("ask", appendSessionReferences(askPrefix, block))).toBeUndefined();

    const rescuePrompt = `${rescuePrefix()}Fix it`;
    expect(stripRescuePromptPrefix(appendSessionReferences(rescuePrompt, block))).toBe("Fix it");
    expect(rawTaskTextFromSubmittedPrompt("rescue", appendSessionReferences(rescuePrompt, block))).toBe("Fix it");

    expect(rawTaskTextFromSubmittedPrompt("swarm", appendSessionReferences(buildSwarmPrompt("audit modules", 3, 2), block)))
      .toBe("audit modules");
    expect(rawTaskTextFromSubmittedPrompt("swarm-write", appendSessionReferences(buildSwarmWritePrompt("edit modules", undefined, 1), block)))
      .toBe("edit modules");
    const review = [
      "Perform a read-only code review of the supplied repository changes.",
      "Review focus: auth",
      "",
      "Target: current working tree changes",
      "Scope: current working tree, including tracked and untracked changes",
      "Repository root: /repo",
      "",
      "Unified diff context:",
      "(no diff text available)",
    ].join("\n");
    expect(rawTaskTextFromSubmittedPrompt("review", appendSessionReferences(review, block)))
      .toBe("Review target: current working tree changes. Focus: auth");
  });
});

function askPrompt(question: string): string {
  return `${[
    "Answer directly in free-form prose.",
    "For repository-dependent questions, inspect the relevant code with the allowed read tools and cite file:line for concrete code claims where useful.",
    "Distinguish evidence from inference and state unknowns explicitly.",
    "Do not use shell/Bash, writes, background tasks, or delegated operations.",
    "Do not emit JSON unless the user explicitly asks for it.",
    "Do not narrate tool progress; make the final response self-contained.",
    "",
    "User question:",
    "",
  ].join("\n")}${question}`;
}

function continuationPrompt(): string {
  return askPrompt("").replace(/\n\nUser question:\n$/, "\n\nContinue the previous ask conversation and answer any outstanding question.");
}

function rescuePrefix(): string {
  return [
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
}

describe("--reference-session parsing", () => {
  test("repeatable, deduplicated in first order, leading flags only", () => {
    expect(parseAskArgs(["--reference-session", "b", "--reference-session", "a", "--reference-session", "b", "q"]))
      .toMatchObject({ referenceSessions: ["b", "a"], prompt: "q" });
    expect(parseRescueArgs(["--reference-session", "a", "fix"])).toMatchObject({ referenceSessions: ["a"], prompt: "fix" });
    expect(parseReviewArgs(["--reference-session", "a", "focus"], "challenge")).toMatchObject({ referenceSessions: ["a"], focus: "focus" });
    expect(parseSwarmArgs(["--write", "--reference-session", "a", "edit"])).toMatchObject({ write: true, referenceSessions: ["a"] });
    expect(parseAskArgs(["--", "--reference-session", "a"])).toMatchObject({ prompt: "--reference-session a" });
    expect(parseAskArgs(["q", "--reference-session", "a"])).toMatchObject({ prompt: "q --reference-session a" });
    expect("referenceSessions" in parseAskArgs(["q"])).toBe(false);
    expect("referenceSessions" in parseReviewArgs([])).toBe(false);
    expect("referenceSessions" in parseSwarmArgs(["x"])).toBe(false);
  });

  test("at most 8 distinct values; duplicates do not count", () => {
    const flags = (ids: string[]) => ids.flatMap((id) => ["--reference-session", id]);
    const eight = Array.from({ length: 8 }, (_, index) => `s${index}`);
    expect(parseAskArgs([...flags([...eight, "s0"]), "q"]).referenceSessions).toEqual(eight);
    for (const parse of [
      () => parseAskArgs([...flags([...eight, "s8"]), "q"]),
      () => parseReviewArgs(flags([...eight, "s8"])),
      () => parseSwarmArgs([...flags([...eight, "s8"]), "x"]),
    ]) {
      expect(parse).toThrow(expect.objectContaining({ code: "INVALID_ARGS", message: expect.stringContaining("at most 8") }));
    }
  });

  test("needs a value and combines with the scope flags", () => {
    expect(() => parseAskArgs(["--reference-session"])).toThrow(expect.objectContaining({ code: "INVALID_ARGS" }));
    expect(() => parseAskArgs(["--reference-session", "--network", "q"])).toThrow(expect.objectContaining({ code: "INVALID_ARGS" }));
    expect(parseAskArgs(["--reference-session", "a", "--network", "q"])).toMatchObject({ referenceSessions: ["a"], network: true });
    expect(parseAskArgs(["--read-root", "/a", "--reference-session", "a", "q"])).toMatchObject({ referenceSessions: ["a"], readRoots: ["/a"] });
    expect(parseReviewArgs(["--network", "--reference-session", "a"])).toMatchObject({ referenceSessions: ["a"], network: true });
    expect(parseReviewArgs(["--reference-session", "a", "--read-root", "/a"], "challenge")).toMatchObject({ referenceSessions: ["a"], readRoots: ["/a"] });
    expect(parseSwarmArgs(["--reference-session", "a", "--read-root", "/a", "x"])).toMatchObject({ referenceSessions: ["a"], readRoots: ["/a"] });
  });

  test("a scoped call gains each referenced session's main-agent directory as a read root; the default scope stays unconfined", () => {
    const one = ref("session_one", "One");
    const two = ref("session_two", "Two", API_WORKSPACE);
    expect(withReferenceReadRoots(undefined, [one, two])).toBeUndefined();
    const scope = { readRoots: ["/extra", one.readRoot], network: true };
    expect(withReferenceReadRoots(scope, [])).toBe(scope);
    expect(withReferenceReadRoots(scope, [one, two, one])).toEqual({ readRoots: ["/extra", one.readRoot, two.readRoot], network: true });
    expect(withReferenceReadRoots({ readRoots: [], network: false }, [one])).toEqual({ readRoots: [one.readRoot], network: false });
  });

  test("pursue rejects it as an unknown flag", () => {
    expect(() => parsePursueArgs(["--reference-session", "a", "goal"]))
      .toThrow(expect.objectContaining({ code: "INVALID_ARGS", message: expect.stringContaining("Unknown flag --reference-session") }));
  });

  test("value-taking for help detection and leading-flag routing", () => {
    expect(hasHelpFlag(["--reference-session", "a", "-h"])).toBe(true);
    expect(hasHelpFlag(["--reference-session", "-h"])).toBe(true);
    expect(withoutLeadingFlag(["--reference-session", "a", "--write", "task"], "--write")).toEqual(["--reference-session", "a", "task"]);
    expect(routeSurfaceAliases(["ask", "--reference-session", "a", "--write", "fix"]))
      .toEqual(["task", "rescue", "--reference-session", "a", "fix"]);
    expect(routeSurfaceAliases(["review", "--reference-session", "a", "--challenge"]))
      .toEqual(["task", "challenge", "--reference-session", "a"]);
  });

  test("help lists the flag for every operation that takes it, and not for pursue", () => {
    for (const argv of [["ask", "--help"], ["review", "-h"], ["task", "rescue", "-h"], ["task", "challenge", "-h"], ["task", "swarm", "-h"]]) {
      expect(companionHelp(argv)).toContain("--reference-session <job-id|session-id>");
    }
    expect(companionHelp(["task", "pursue", "-h"])).not.toContain("--reference-session");
  });
});

describe("MCP referenced_sessions", () => {
  test("passes each id as a leading flag before --", () => {
    const references = { referenced_sessions: ["a", "b"] };
    expect(buildMcpOperationInvocation("kimi_ask", { ...references, prompt: "q" }).argv)
      .toEqual(["ask", "--reference-session", "a", "--reference-session", "b", "--", "q"]);
    expect(buildMcpOperationInvocation("kimi_review", { ...references, mode: "challenge" }).argv)
      .toEqual(["task", "challenge", "--reference-session", "a", "--reference-session", "b"]);
    expect(buildMcpOperationInvocation("kimi_rescue", { ...references, prompt: "fix" }).argv)
      .toEqual(["task", "rescue", "--reference-session", "a", "--reference-session", "b", "--", "fix"]);
    expect(buildMcpOperationInvocation("kimi_swarm", { ...references, objective: "x" }).argv)
      .toEqual(["task", "swarm", "--reference-session", "a", "--reference-session", "b", "--", "x"]);
    expect(buildMcpOperationInvocation("kimi_swarm_write", { ...references, objective: "x" }).argv)
      .toEqual(["task", "swarm", "--reference-session", "a", "--reference-session", "b", "--write", "--", "x"]);
  });

  test("type checks, pursue omission, and pass-through with the scope arguments", () => {
    for (const value of ["a", [1], [null], {}]) {
      expect(() => buildMcpOperationInvocation("kimi_ask", { prompt: "q", referenced_sessions: value }))
        .toThrow(expect.objectContaining({ code: "MCP_INVALID_ARGUMENTS" }));
    }
    // An oversized list or id is refused here, before it becomes child argv.
    const nine = Array.from({ length: 9 }, (_, index) => `s${index}`);
    expect(() => buildMcpOperationInvocation("kimi_ask", { prompt: "q", referenced_sessions: nine }))
      .toThrow(expect.objectContaining({ code: "MCP_INVALID_ARGUMENTS", message: expect.stringContaining("at most 8 distinct") }));
    expect(() => buildMcpOperationInvocation("kimi_ask", { prompt: "q", referenced_sessions: ["x".repeat(129)] }))
      .toThrow(expect.objectContaining({ code: "MCP_INVALID_ARGUMENTS", message: expect.stringContaining("at most 128 characters") }));
    expect(buildMcpOperationInvocation("kimi_ask", { prompt: "q", referenced_sessions: Array.from({ length: 5000 }, () => "a") }).argv)
      .toEqual(["ask", "--reference-session", "a", "--", "q"]);
    expect(() => buildMcpOperationInvocation("kimi_pursue", { objective: "x", referenced_sessions: ["a"] }))
      .toThrow(expect.objectContaining({ code: "MCP_INVALID_ARGUMENTS", message: expect.stringContaining("Unknown argument referenced_sessions") }));
    const scoped = buildMcpOperationInvocation("kimi_ask", { prompt: "q", network: true, referenced_sessions: ["a"] });
    expect(parseAskArgs(scoped.argv.slice(1))).toMatchObject({ network: true, referenceSessions: ["a"], prompt: "q" });
    const withSchema = MCP_TOOL_DEFINITIONS.filter((tool) =>
      "referenced_sessions" in (tool.inputSchema.properties as Record<string, unknown>)).map((tool) => tool.name);
    expect(withSchema).toEqual(["kimi_ask", "kimi_review", "kimi_rescue", "kimi_swarm", "kimi_swarm_write"]);
    const property = (MCP_TOOL_DEFINITIONS[0]!.inputSchema.properties as Record<string, { description: string }>).referenced_sessions!;
    expect(property.description).toContain("whole main-agent directory (its log, saved tool outputs and plans)");
    expect(property.description).toContain("with network that content can reach the web");
  });
});

describe("resolution against a Kimi home", () => {
  interface Fixture { root: string; home: string; store: JobStore; cwd: string }

  async function withHome(run: (fixture: Fixture) => Promise<void>): Promise<void> {
    const root = await createTestPluginDataRoot("session-references");
    const home = path.join(root, "kimi-home");
    const cwd = path.join(root, "cwd");
    await mkdir(cwd, { recursive: true });
    const paths = resolvePluginPaths({ KIMI_PLUGIN_CC_DATA: path.join(root, "data") });
    await ensurePluginPaths(paths);
    const store = new JobStore(paths);
    try {
      await run({ root, home, store, cwd });
    } finally {
      store.close();
      await cleanupTestPath(root);
    }
  }

  async function seed(home: string, workspace: string, sessionId: string, state?: unknown): Promise<string> {
    const sessionDir = path.join(home, "sessions", workspace, sessionId);
    await mkdir(path.join(sessionDir, "agents", "main"), { recursive: true });
    await writeFile(path.join(sessionDir, "agents", "main", "wire.jsonl"), "{\"type\":\"metadata\"}\n");
    if (state !== undefined) await writeFile(path.join(sessionDir, "state.json"), JSON.stringify(state));
    return sessionDir;
  }

  function resolve(fixture: Fixture, inputs: string[], overrides: Partial<Parameters<typeof resolveSessionReferences>[1]> = {}) {
    return resolveSessionReferences(inputs, {
      store: fixture.store, env: { KIMI_CODE_HOME: fixture.home }, spawnCwd: fixture.cwd,
      plan: { intendedEngine: "native-v2" }, stage: "ask.reference-session", ...overrides,
    });
  }

  function addJob(store: JobStore, jobId: string, sessionId: string | null): void {
    store.createJob({
      job_id: jobId, repo_id: "other-repo", command_type: "ask", cwd: "/elsewhere", model: null, thinking: null,
      background: false, pid: null, kimi_pid: null, status: "completed", kimi_session_id: sessionId,
      operation_kind: "ask", intended_engine: "native-v2", observed_engine: "native-v2", kimi_version: "2.7.3",
      system_version: "2.7.3", agent_profile: "<cli-client>", prompt_digest: "digest", summary: "s",
      final_output_path: null, stream_log_path: "/dev/null", error: null,
    });
  }

  const refusal = (reason: string) => expect.objectContaining({ code: "INVALID_ARGS", stage: "ask.reference-session",
    message: expect.stringContaining(reason) });

  test("job ids from any repository, session ids, cross-workspace order and resolved dedupe", async () => {
    await withHome(async (fixture) => {
      await seed(fixture.home, APP_WORKSPACE, "session_one", { title: "  Fix login  " });
      await seed(fixture.home, API_WORKSPACE, "ses_two", { title: " ", lastPrompt: "Fix\n  the   login" });
      await seed(fixture.home, APP_WORKSPACE, "3f0c2a1e-0000-4000-8000-000000000003", {});
      const jobId = "11111111-1111-4111-8111-111111111111";
      addJob(fixture.store, jobId, "session_one");
      const references = await resolve(fixture, [jobId, "ses_two", "session_one", "3f0c2a1e-0000-4000-8000-000000000003"]);
      // readRoot is the realpath the hook compares against; logPath keeps the home spelling the child receives.
      const realHome = await realpath(fixture.home);
      const entry = (sessionId: string, workspaceId: string, title: string) => ({
        sessionId, workspaceId, title,
        logPath: `${fixture.home}/sessions/${workspaceId}/${sessionId}/agents/main/wire.jsonl`,
        readRoot: `${realHome}/sessions/${workspaceId}/${sessionId}/agents/main`,
      });
      expect(references).toEqual([
        entry("session_one", APP_WORKSPACE, "Fix login"),
        entry("ses_two", API_WORKSPACE, "Fix the login"),
        entry("3f0c2a1e-0000-4000-8000-000000000003", APP_WORKSPACE, "3f0c2a1e-0000-4000-8000-000000000003"),
      ]);
      expect(await resolve(fixture, [])).toEqual([]);
      // Where the volume ignores letter case, another spelling opens the same
      // session; it must not slip past the self-reference check or the dedupe.
      const caseFolding = await lstat(path.join(fixture.home, "sessions", APP_WORKSPACE, "SESSION_ONE")).then(() => true, () => false);
      if (caseFolding) {
        await expect(resolve(fixture, ["SESSION_ONE"], { resumeSessionId: "session_one" }))
          .rejects.toEqual(refusal("spelled exactly as stored; the store has session_one"));
        await expect(resolve(fixture, ["session_one", "Session_One"])).rejects.toEqual(refusal("spelled exactly as stored"));
      } else {
        await expect(resolve(fixture, ["SESSION_ONE"])).rejects.toEqual(refusal("no plugin job or Kimi session has this id"));
      }
      expect(await resolve(fixture, ["ses_two"], { plan: { intendedEngine: "legacy-v1" }, resumeSessionId: "x" })
        .catch((error: Error) => error.message)).toContain("legacy-v1");
    });
  });

  test("the granted read root must be the validated directory: another stored spelling of agents/main refuses", async () => {
    await withHome(async (fixture) => {
      const sessionDir = path.join(fixture.home, "sessions", APP_WORKSPACE, "session_cased");
      await mkdir(path.join(sessionDir, "agents", "Main"), { recursive: true });
      await writeFile(path.join(sessionDir, "agents", "Main", "wire.jsonl"), "{}\n");
      const foldsCase = await lstat(path.join(sessionDir, "agents", "main")).then(() => true, () => false);
      await expect(resolve(fixture, ["session_cased"])).rejects.toMatchObject({
        code: "INVALID_ARGS",
        message: expect.stringContaining(foldsCase ? "resolves outside its own session" : "has no main agent journal"),
      });
    });
  });

  test("under a scoped call the hook lets Kimi read the referenced journal and nothing else in the session store", async () => {
    await withHome(async (fixture) => {
      await seed(fixture.home, APP_WORKSPACE, "session_one", { title: "One" });
      await seed(fixture.home, APP_WORKSPACE, "session_other", { title: "Other" });
      const sessionDir = path.join(fixture.home, "sessions", APP_WORKSPACE, "session_one");
      await mkdir(path.join(sessionDir, "agents", "child-1"), { recursive: true });
      await writeFile(path.join(sessionDir, "agents", "child-1", "wire.jsonl"), "{}\n");
      const otherLog = path.join(fixture.home, "sessions", APP_WORKSPACE, "session_other", "agents", "main", "wire.jsonl");
      const [reference] = await resolve(fixture, ["session_one"]);
      const scope = withReferenceReadRoots({ readRoots: [], network: true }, [reference!])!;
      const roots = effectiveReadRoots(scope, fixture.cwd);
      expect(roots).toEqual([await realpath(fixture.cwd), reference!.readRoot]);

      // The spelling Kimi is handed, a search of the directory and a search anchored by pattern all pass.
      expect(await evaluateScopedRead("Read", { path: reference!.logPath }, roots)).toEqual({ decision: "allow" });
      expect(await evaluateScopedRead("Grep", { pattern: "token", path: reference!.logPath }, roots)).toEqual({ decision: "allow" });
      expect(await evaluateScopedRead("Glob", { pattern: "*.jsonl", path: reference!.readRoot }, roots)).toEqual({ decision: "allow" });

      for (const outside of [
        otherLog,
        path.join(sessionDir, "state.json"),
        path.join(sessionDir, "agents", "child-1", "wire.jsonl"),
        path.join(sessionDir, "agents"),
        path.join(fixture.home, "sessions"),
        path.join(fixture.home, "config.toml"),
      ]) {
        expect(await evaluateScopedRead("Read", { path: outside }, roots), outside).toMatchObject({ decision: "deny" });
        expect(await evaluateScopedRead("Grep", { pattern: "x", path: outside }, roots), outside).toMatchObject({ decision: "deny" });
      }
      // A link planted in the granted directory after resolution is judged by where it leads.
      await symlink(otherLog, path.join(sessionDir, "agents", "main", "planted.jsonl"));
      expect(await evaluateScopedRead("Read", { path: path.join(sessionDir, "agents", "main", "planted.jsonl") }, roots))
        .toMatchObject({ decision: "deny" });
      // Without the reference, the same scoped call cannot read the journal.
      expect(await evaluateScopedRead("Read", { path: reference!.logPath }, effectiveReadRoots({ readRoots: [], network: true }, fixture.cwd)))
        .toMatchObject({ decision: "deny" });
    });
  });

  test("titles: control characters replaced, 200 code points, unreadable state falls back to the id", async () => {
    await withHome(async (fixture) => {
      await seed(fixture.home, APP_WORKSPACE, "session_a", { title: "line\u0000one\u001btwo\u007f" });
      await seed(fixture.home, APP_WORKSPACE, "session_b", { title: "😀".repeat(250) });
      const badState = await seed(fixture.home, APP_WORKSPACE, "session_c");
      await writeFile(path.join(badState, "state.json"), "{not json");
      await seed(fixture.home, APP_WORKSPACE, "session_d", { title: "\n\t" });
      const titles = (await resolve(fixture, ["session_a", "session_b", "session_c", "session_d"])).map((item) => item.title);
      expect(titles[0]).toBe("line one two");
      expect([...titles[1]!]).toHaveLength(200);
      expect(titles[2]).toBe("session_c");
      expect(titles[3]).toBe("session_d");
      const rendered = renderSessionReferences(await resolve(fixture, ["session_a", "session_b"]));
      expect(stripSessionReferences(`q\n\n${rendered}`)).toBe("q");
    });
  });

  test("refuses bad shapes, unknown ids, sessionless jobs, self-references and legacy-v1", async () => {
    await withHome(async (fixture) => {
      await seed(fixture.home, APP_WORKSPACE, "session_one", {});
      for (const input of ["", ".", "..", "a/b", "a\\b", "a\u0001", ".hidden", "-x", "x".repeat(129)]) {
        await expect(resolve(fixture, [input])).rejects.toEqual(refusal("not a job id or Kimi session id"));
      }
      await expect(resolve(fixture, ["22222222-2222-4222-8222-222222222222"])).rejects.toEqual(refusal("no plugin job or Kimi session has this id"));
      addJob(fixture.store, "33333333-3333-4333-8333-333333333333", null);
      await expect(resolve(fixture, ["33333333-3333-4333-8333-333333333333"])).rejects.toEqual(refusal("has no Kimi session yet"));
      addJob(fixture.store, "44444444-4444-4444-8444-444444444444", "session_gone");
      await expect(resolve(fixture, ["44444444-4444-4444-8444-444444444444"])).rejects.toEqual(refusal("was not found"));
      await expect(resolve(fixture, ["session_one"], { resumeSessionId: "session_one" })).rejects.toEqual(refusal("being resumed"));
      await expect(resolve(fixture, ["session_one"], { plan: { intendedEngine: "legacy-v1" } })).rejects.toEqual(refusal("legacy-v1"));
    });
  });

  test("not found without a sessions directory or after deletion despite an index line; ambiguous across workspaces", async () => {
    await withHome(async (fixture) => {
      await expect(resolve(fixture, ["session_one"])).rejects.toEqual(refusal("no plugin job or Kimi session has this id"));
      const deleted = await seed(fixture.home, APP_WORKSPACE, "session_deleted", {});
      await writeFile(path.join(fixture.home, "session_index.jsonl"),
        `${JSON.stringify({ sessionId: "session_deleted", sessionDir: deleted, workDir: "/w" })}\n`);
      await cleanupTestPath(deleted);
      await expect(resolve(fixture, ["session_deleted"])).rejects.toEqual(refusal("no plugin job or Kimi session has this id"));
      await seed(fixture.home, APP_WORKSPACE, "session_dup", {});
      await seed(fixture.home, API_WORKSPACE, "session_dup", {});
      await expect(resolve(fixture, ["session_dup"])).rejects.toEqual(refusal("ambiguous: it exists in 2 workspaces"));
    });
  });

  test("refuses every symlinked component, a missing journal, and a journal that is a link or FIFO", async () => {
    await withHome(async (fixture) => {
      const outside = path.join(fixture.root, "outside");
      await seed(outside, "wd_x", "session_x", {});
      const sessions = path.join(fixture.home, "sessions");
      await mkdir(sessions, { recursive: true });

      await symlink(path.join(outside, "sessions", "wd_x"), path.join(sessions, "wd_link"));
      await expect(resolve(fixture, ["session_x"])).rejects.toEqual(refusal("symlinked entry in the Kimi session store"));
      await cleanupTestPath(path.join(sessions, "wd_link"));

      await mkdir(path.join(sessions, "wd_s"));
      await symlink(path.join(outside, "sessions", "wd_x", "session_x"), path.join(sessions, "wd_s", "session_x"));
      await expect(resolve(fixture, ["session_x"])).rejects.toEqual(refusal("unsafe path"));
      await cleanupTestPath(path.join(sessions, "wd_s"));

      for (const component of ["agents", "main"]) {
        const sessionDir = await seed(fixture.home, "wd_c", "session_c", {});
        const target = component === "agents" ? path.join(sessionDir, "agents") : path.join(sessionDir, "agents", "main");
        await cleanupTestPath(target);
        await symlink(component === "agents" ? path.join(outside, "sessions", "wd_x", "session_x", "agents")
          : path.join(outside, "sessions", "wd_x", "session_x", "agents", "main"), target);
        await expect(resolve(fixture, ["session_c"])).rejects.toEqual(refusal("unsafe path"));
        await cleanupTestPath(sessionDir);
      }

      const journalLink = await seed(fixture.home, "wd_j", "session_j", {});
      const journal = path.join(journalLink, "agents", "main", "wire.jsonl");
      await cleanupTestPath(journal);
      await symlink(path.join(outside, "sessions", "wd_x", "session_x", "agents", "main", "wire.jsonl"), journal);
      await expect(resolve(fixture, ["session_j"])).rejects.toEqual(refusal("main journal is unusable"));
      await cleanupTestPath(journal);
      execFileSync("mkfifo", [journal]);
      await expect(resolve(fixture, ["session_j"])).rejects.toEqual(refusal("not a regular file"));
      await cleanupTestPath(journal);
      await expect(resolve(fixture, ["session_j"])).rejects.toEqual(refusal("has no main agent journal"));
      await cleanupTestPath(path.join(journalLink, "agents"));
      await expect(resolve(fixture, ["session_j"])).rejects.toEqual(refusal("has no main agent journal"));

      await rename(sessions, path.join(fixture.root, "real-sessions"));
      await symlink(path.join(fixture.root, "real-sessions"), sessions);
      await expect(resolve(fixture, ["session_j"])).rejects.toEqual(refusal("unsafe Kimi sessions directory"));
    });
  });

  test("log= uses the child's KIMI_CODE_HOME spelling: relative homes resolve against the spawn cwd, trailing slashes drop", async () => {
    await withHome(async (fixture) => {
      const relativeHome = path.join(fixture.cwd, "rel-home");
      await seed(relativeHome, APP_WORKSPACE, "session_rel", {});
      const [relative] = await resolve(fixture, ["session_rel"], { env: { KIMI_CODE_HOME: "rel-home" } });
      expect(relative!.logPath).toBe(`${relativeHome}/sessions/${APP_WORKSPACE}/session_rel/agents/main/wire.jsonl`);
      await seed(fixture.home, APP_WORKSPACE, "session_slash", {});
      const [slashed] = await resolve(fixture, ["session_slash"], { env: { KIMI_CODE_HOME: `${fixture.home}//` } });
      expect(slashed!.logPath).toBe(`${fixture.home}/sessions/${APP_WORKSPACE}/session_slash/agents/main/wire.jsonl`);
      await expect(resolve(fixture, ["session_slash"], { env: { KIMI_CODE_HOME: `${fixture.home}\\x` } }))
        .rejects.toEqual(refusal("Kimi home path"));
    });
  });
});

describe("the default-scope hook lets every taking label read the journal", () => {
  test("Read and Grep of a log= path are allowed; Bash stays denied for read-only labels", async () => {
    const log = "/home/me/.kimi-code/sessions/wd_app/session_1/agents/main/wire.jsonl";
    for (const label of ["ask", "review", "challenge", "swarm", "rescue", "swarm-write"]) {
      const operationKind = label;
      const ctx = { commandLabel: label, operationKind, trustedWorkspaceRoot: "/repo", rescueEvaluator: evaluateRescueHookRequest };
      expect(await decideHookOutcome({ tool_name: "Read", tool_input: { path: log, line_offset: 1, n_lines: 1 } }, ctx))
        .toMatchObject({ decision: "allow" });
      expect(await decideHookOutcome({ tool_name: "Grep", tool_input: { pattern: "tool.call", path: log } }, ctx))
        .toMatchObject({ decision: "allow" });
      if (label !== "rescue" && label !== "swarm-write") {
        expect(await decideHookOutcome({ tool_name: "Bash", tool_input: { command: `jq . ${log}` } }, ctx))
          .toMatchObject({ decision: "deny" });
      }
    }
  });
});
