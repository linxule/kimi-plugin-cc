import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runCancel } from "../../runtime/commands/cancel.js";
import { runRescue } from "../../runtime/commands/rescue.js";
import { rawTaskTextFromSubmittedPrompt } from "../../runtime/commands/repair-sessions.js";
import { runResult } from "../../runtime/commands/result.js";
import { runStatus } from "../../runtime/commands/status.js";
import { JobStore } from "../../runtime/job-store.js";
import { digestPrompt, waitForTerminalJob } from "../../runtime/jobs.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import type { CommandContext } from "../../runtime/types.js";
import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";

// v1.0 cutover note (PR 3):
//
//   The v0.4 rescue tests injected in-band approval requests and
//   asserted that `createRescueApprovalPolicy` accepted/rejected each
//   one. In v1.0 those approvals are mediated by the PreToolUse hook
//   process, which is exercised by:
//
//     - tests/runtime/rescue-approval.test.ts (helper-level allowlist)
//     - tests/runtime/approval-policy.test.ts (decideHookOutcome
//       routing)
//     - tests/runtime/approval-hook-subprocess.test.ts (entry script
//       protocol)
//
//   This file tests rescue's command lifecycle — happy path, session
//   resume, background spawn, cancel, empty output — under the v1
//   cli-client transport. The approval enforcement story is verified
//   transitively: rescue passes `commandLabel: "rescue"` to cli-client,
//   which puts it on the kimi env, which kimi forwards to the hook;
//   the hook then routes to evaluateRescueHookRequest.

const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli-v1.ts");
const RESCUE_SUCCESS_OUTPUT = [
  "Applied the requested change.",
  "",
  "- Updated note.txt with the requested fix.",
  "- Ran pwd to verify the workspace context.",
  "- Mock verification passed.",
  "",
].join("\n");
const RESCUE_CONTINUE_TASK = "Continue the previous rescue task using the latest repository state.";
const EXPECTED_RESCUE_PROMPT_PREFIX = [
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

function makeContext(cwd: string, env: NodeJS.ProcessEnv): CommandContext {
  return {
    cwd,
    env,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

function makeMockEnv(
  pluginDataRoot: string,
  scenario: string,
  invocationPath: string,
  options?: { delayMs?: number },
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginDataRoot,
    KIMI_PLUGIN_CC_KIMI_BIN: "bun",
    KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
    KIMI_PLUGIN_CC_MOCK_SCENARIO: scenario,
    KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH: invocationPath,
    KIMI_PLUGIN_CC_MOCK_DELAY_MS: String(options?.delayMs ?? 0),
    KIMI_PLUGIN_CC_NODE_BIN: "node",
    // Tests bypass the rescue hook-installation refusal — the mock
    // doesn't go through kimi-code's hook system, so the real hook
    // contract isn't being exercised here. Hook policy is tested
    // separately in approval-policy.test.ts, rescue-approval.test.ts,
    // and approval-hook-subprocess.test.ts.
    KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
  };
}

function parseStartedJobId(output: string): string {
  return (JSON.parse(output) as { job_id: string }).job_id;
}

function promptFromArgv(argv: string[]): string {
  const promptIndex = argv.indexOf("-p");
  expect(promptIndex).toBeGreaterThan(-1);
  return argv[promptIndex + 1]!;
}

async function waitForJobState(
  env: NodeJS.ProcessEnv,
  jobId: string,
  predicate: (job: ReturnType<JobStore["getJob"]>) => boolean,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const store = new JobStore(resolvePluginPaths(env));
    try {
      const job = store.getJob(jobId);
      if (predicate(job)) {
        return job;
      }
    } finally {
      store.close();
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }

  throw new Error(`Timed out while waiting for job ${jobId} to reach the expected state.`);
}

describe("rescue command lifecycle", () => {
  test("native-v2 preview replaces Kimi's recorded rescue prompt with the raw task", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("rescue-preview");
    const repoRoot = await createGitRepoFixture("rescue-preview-repo");
    const kimiHome = await createTestPluginDataRoot("rescue-preview-kimi-home");
    const invocationPath = path.join(pluginDataRoot, "rescue-preview.jsonl");
    const sessionId = "abababab-abab-4bab-8bab-abababababab";
    const env = {
      ...makeMockEnv(pluginDataRoot, "rescue-success", invocationPath),
      KIMI_CODE_HOME: kimiHome,
      KIMI_PLUGIN_CC_MOCK_SESSION_ID: sessionId,
    };
    try {
      const statePath = await seedKimiSession(kimiHome, sessionId, repoRoot);
      // A preview holding this run's own submitted prompt (truncated), as earlier plugin releases wrote it.
      await writeFile(statePath, JSON.stringify({ id: sessionId, version: 2, title: "New Session",
        titleKind: "replaceable", isCustomTitle: false, lastPrompt: EXPECTED_RESCUE_PROMPT_PREFIX }));
      await runRescue(["Implement", "the", "requested", "fix"], makeContext(repoRoot, env));
      const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
      expect(state).toMatchObject({ title: "Kimi Rescue: Implement the requested fix", titleKind: "replaceable",
        lastPrompt: "Implement the requested fix" });
      const argv = (JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] }).argv;
      expect(rawTaskTextFromSubmittedPrompt("rescue", promptFromArgv(argv))).toBe("Implement the requested fix");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
      await cleanupTestPath(kimiHome);
    }
  });

  test("foreground rescue returns prose, persists the session id, and forwards the rescue command label", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("rescue-foreground");
    const repoRoot = await createGitRepoFixture("rescue-foreground-repo");
    const kimiHome = await createTestPluginDataRoot("rescue-foreground-kimi-home");
    const invocationPath = path.join(pluginDataRoot, "rescue-foreground.jsonl");
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const env = {
      ...makeMockEnv(pluginDataRoot, "rescue-success", invocationPath),
      KIMI_CODE_HOME: kimiHome,
      KIMI_PLUGIN_CC_MOCK_SESSION_ID: sessionId,
    };

    try {
      const statePath = await seedKimiSession(kimiHome, sessionId, repoRoot);
      const output = await runRescue(
        ["Implement", "the", "requested", "fix"],
        makeContext(repoRoot, env),
      );
      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as {
        argv: string[];
        env: {
          KIMI_PLUGIN_CC_CMD: string | null;
          KIMI_PLUGIN_CC_WORKSPACE_ROOT: string | null;
        };
      };
      const status = JSON.parse(
        await runStatus(["--type", "rescue"], makeContext(repoRoot, env)),
      ) as {
        job_id: string;
        status: string;
        kimi_session_id: string;
        summary: string;
        phase: string | null;
      };
      const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
      const spawnedPrompt = promptFromArgv(invocation.argv);

      expect(output).toBe(RESCUE_SUCCESS_OUTPUT);
      expect(status.status).toBe("completed");
      expect(status.summary).toBe("Applied the requested change.");
      expect(status.phase).toBe("done");
      expect(status.kimi_session_id).toBe(sessionId);
      expect(spawnedPrompt).toBe(`${EXPECTED_RESCUE_PROMPT_PREFIX}Implement the requested fix`);
      expect(state.title).toBe("Kimi Rescue: Implement the requested fix");
      expect(state.lastPrompt).toBeUndefined();
      const store = new JobStore(resolvePluginPaths(env));
      try {
        expect(store.getJob(status.job_id)?.prompt_digest).toBe(digestPrompt(spawnedPrompt));
      } finally {
        store.close();
      }
      // The hook gets KIMI_PLUGIN_CC_CMD=rescue so it can call
      // evaluateRescueHookRequest. That env propagation is the only
      // runtime-side signal that selects the rescue policy.
      expect(invocation.env.KIMI_PLUGIN_CC_CMD).toBe("rescue");
      expect(invocation.env.KIMI_PLUGIN_CC_WORKSPACE_ROOT).toBe(repoRoot);
      expect(invocation.argv).toContain("--output-format");
      expect(invocation.argv).toContain("stream-json");
      // v1.0 alpha.4: rescue runs thinking-on always. Locks the contract
      // against future regressions that re-introduce --no-thinking via
      // some new caller path. (Round 2 code-reviewer finding.)
      expect(invocation.argv).not.toContain("--no-thinking");
      expect(invocation.argv).not.toContain("--thinking");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
      await cleanupTestPath(kimiHome);
    }
  });

  test("rescue --resume by job id passes the prior session id via -r", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("rescue-resume-job");
    const repoRoot = await createGitRepoFixture("rescue-resume-job-repo");
    const invocationPath = path.join(pluginDataRoot, "rescue-resume-job.jsonl");
    const env = makeMockEnv(pluginDataRoot, "rescue-success", invocationPath);

    try {
      await runRescue(["Initial", "task"], makeContext(repoRoot, env));
      const firstStatus = JSON.parse(
        await runStatus(["--type", "rescue"], makeContext(repoRoot, env)),
      ) as { job_id: string; kimi_session_id: string };

      await runRescue(["--resume", firstStatus.job_id], makeContext(repoRoot, env));
      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
      const dashRIndex = invocation.argv.indexOf("-r");
      expect(dashRIndex).toBeGreaterThan(-1);
      expect(invocation.argv[dashRIndex + 1]).toBe(firstStatus.kimi_session_id);
      expect(promptFromArgv(invocation.argv)).toBe(`${EXPECTED_RESCUE_PROMPT_PREFIX}${RESCUE_CONTINUE_TASK}`);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("rescue -r prefixes both follow-up tasks and bare continuation prompts", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("rescue-resume-prompts");
    const repoRoot = await createGitRepoFixture("rescue-resume-prompts-repo");
    const invocationPath = path.join(pluginDataRoot, "rescue-resume-prompts.jsonl");
    const env = makeMockEnv(pluginDataRoot, "rescue-success", invocationPath);

    try {
      await runRescue(["Initial", "task"], makeContext(repoRoot, env));
      await runRescue(["-r", "Apply", "the", "next", "fix"], makeContext(repoRoot, env));
      let invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
      expect(promptFromArgv(invocation.argv)).toBe(`${EXPECTED_RESCUE_PROMPT_PREFIX}Apply the next fix`);

      await runRescue(["-r"], makeContext(repoRoot, env));
      invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
      expect(promptFromArgv(invocation.argv)).toBe(`${EXPECTED_RESCUE_PROMPT_PREFIX}${RESCUE_CONTINUE_TASK}`);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  // The AUTO_RESUME_PATTERN regex in runtime/commands/rescue.ts:38 is
  // an invariant: the six "continue working" verbs trigger an implicit
  // --resume against the latest rescue session. Each verb is exercised
  // independently so a future refactor that drops one is caught
  // immediately. The trade-off (auto-resume picking a stale session
  // from a different bug) is a documented UX limitation.
  test.each([
    ["continue", "continue with the next step"],
    ["resume", "resume the in-progress rescue"],
    ["keep going", "keep going on the bug"],
    ["keep working", "keep working on the fix"],
    ["apply the top fix", "apply the top fix you mentioned"],
    ["dig deeper", "dig deeper into the failure"],
  ])("auto-resume verb '%s' triggers an implicit --resume", async (_label, prompt) => {
    const pluginDataRoot = await createTestPluginDataRoot(`rescue-auto-resume-${_label.replace(/\s+/g, "-")}`);
    const repoRoot = await createGitRepoFixture(`rescue-auto-resume-${_label.replace(/\s+/g, "-")}-repo`);
    const invocationPath = path.join(pluginDataRoot, "rescue-auto-resume.jsonl");
    const env = makeMockEnv(pluginDataRoot, "rescue-success", invocationPath);

    try {
      await runRescue(["Initial", "task"], makeContext(repoRoot, env));
      const firstStatus = JSON.parse(
        await runStatus(["--type", "rescue"], makeContext(repoRoot, env)),
      ) as { job_id: string; kimi_session_id: string };

      await runRescue(prompt.split(" "), makeContext(repoRoot, env));
      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
      const dashRIndex = invocation.argv.indexOf("-r");
      expect(dashRIndex).toBeGreaterThan(-1);
      expect(invocation.argv[dashRIndex + 1]).toBe(firstStatus.kimi_session_id);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("rescue --fresh always starts a new session, even with prior history", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("rescue-fresh");
    const repoRoot = await createGitRepoFixture("rescue-fresh-repo");
    const invocationPath = path.join(pluginDataRoot, "rescue-fresh.jsonl");
    const env = makeMockEnv(pluginDataRoot, "rescue-success", invocationPath);

    try {
      await runRescue(["Initial", "task"], makeContext(repoRoot, env));
      const firstStatus = JSON.parse(
        await runStatus(["--type", "rescue"], makeContext(repoRoot, env)),
      ) as { kimi_session_id: string };

      await runRescue(["--fresh", "Different", "task"], makeContext(repoRoot, env));
      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
      // -r should NOT be present (fresh path)
      expect(invocation.argv.indexOf("-r")).toBe(-1);
      const secondStatus = JSON.parse(
        await runStatus(["--type", "rescue"], makeContext(repoRoot, env)),
      ) as { kimi_session_id: string };
      expect(secondStatus.kimi_session_id).not.toBe(firstStatus.kimi_session_id);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("rescue resume by job id is scoped to the current repo", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("rescue-resume-cross-repo");
    const repoA = await createGitRepoFixture("rescue-resume-cross-repo-a");
    const repoB = await createGitRepoFixture("rescue-resume-cross-repo-b");
    const invocationPath = path.join(pluginDataRoot, "rescue-resume-cross-repo.jsonl");
    const env = makeMockEnv(pluginDataRoot, "rescue-success", invocationPath);

    try {
      await runRescue(["Initial", "task"], makeContext(repoA, env));
      const repoAStatus = JSON.parse(
        await runStatus(["--type", "rescue"], makeContext(repoA, env)),
      ) as { job_id: string };

      await expect(
        runRescue(["--resume", repoAStatus.job_id], makeContext(repoB, env)),
      ).rejects.toMatchObject({
        code: "RESCUE_RESUME_NOT_FOUND",
      });
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoA);
      await cleanupTestPath(repoB);
    }
  });

  test("background rescue supports status/result and safely prefixes /goal-leading tasks", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("rescue-background");
    const repoRoot = await createGitRepoFixture("rescue-background-repo");
    const invocationPath = path.join(pluginDataRoot, "rescue-background.jsonl");
    const env = makeMockEnv(pluginDataRoot, "rescue-success", invocationPath, { delayMs: 150 });

    try {
      const startOutput = await runRescue(
        ["--background", "/goal", "Do", "the", "work"],
        makeContext(repoRoot, env),
      );
      const jobId = parseStartedJobId(startOutput);
      const runningStatus = JSON.parse(
        await runStatus([jobId], makeContext(repoRoot, env)),
      ) as { status: string; summary: string; phase: string | null };

      expect(["running", "completed"]).toContain(runningStatus.status);
      expect(runningStatus.summary).toBe("/goal Do the work");

      const completed = await waitForTerminalJob(
        () => new JobStore(resolvePluginPaths(env)),
        jobId,
        10_000,
      );
      const resultOutput = await runResult([jobId], makeContext(repoRoot, env));
      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
      const spawnedPrompt = promptFromArgv(invocation.argv);

      expect(completed.status).toBe("completed");
      expect(completed.summary).toBe("Applied the requested change.");
      expect(completed.phase).toBe("done");
      expect(resultOutput).toBe(RESCUE_SUCCESS_OUTPUT);
      expect(spawnedPrompt).toBe(`${EXPECTED_RESCUE_PROMPT_PREFIX}/goal Do the work`);
      expect(spawnedPrompt.startsWith("/goal")).toBe(false);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("empty rescue output fails with RESCUE_EMPTY_OUTPUT", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("rescue-empty");
    const repoRoot = await createGitRepoFixture("rescue-empty-repo");
    const invocationPath = path.join(pluginDataRoot, "rescue-empty.jsonl");
    const env = makeMockEnv(pluginDataRoot, "rescue-empty", invocationPath);

    try {
      const output = await runRescue(["Investigate", "the", "workspace"], makeContext(repoRoot, env));
      const status = JSON.parse(
        await runStatus(["--type", "rescue"], makeContext(repoRoot, env)),
      ) as {
        status: string;
        summary: string;
        phase: string | null;
        error: { code?: string; stage?: string; message?: string } | null;
      };

      expect(output).toContain("# Failed Job");
      expect(output).toContain("RESCUE_EMPTY_OUTPUT");
      expect(output).toContain("Rescue returned empty output.");
      expect(status.status).toBe("failed");
      expect(status.summary).toBe("Rescue failed.");
      expect(status.phase).toBe("failed");
      expect(status.error?.code).toBe("RESCUE_EMPTY_OUTPUT");
      expect(status.error?.stage).toBe("rescue.runtime");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("background rescue can be cancelled and remains terminal with a session id", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("rescue-background-cancel");
    const repoRoot = await createGitRepoFixture("rescue-background-cancel-repo");
    const invocationPath = path.join(pluginDataRoot, "rescue-background-cancel.jsonl");
    // Mock holds the response for 5s so /kimi:cancel races the close
    // event. cli-client's SIGKILL escalation guarantees the subprocess
    // doesn't outlive the cancel even if it ignores SIGTERM.
    const env = makeMockEnv(pluginDataRoot, "rescue-cancel", invocationPath, { delayMs: 5_000 });

    try {
      const startOutput = await runRescue(
        ["--background", "Keep", "working"],
        makeContext(repoRoot, env),
      );
      const jobId = parseStartedJobId(startOutput);
      // Wait until the worker has spawned kimi (so cancel has something
      // to SIGTERM); pid is recorded once the worker calls cli-client.
      await waitForJobState(env, jobId, (job) => Boolean(job?.pid));

      const cancelOutput = JSON.parse(
        await runCancel([jobId], makeContext(repoRoot, env)),
      ) as { status: string };
      const terminal = await waitForTerminalJob(
        () => new JobStore(resolvePluginPaths(env)),
        jobId,
        10_000,
      );

      expect(cancelOutput.status).toBe("cancelled");
      expect(terminal.status).toBe("cancelled");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });
});

async function seedKimiSession(kimiHome: string, sessionId: string, workDir: string): Promise<string> {
  const sessionDir = path.join(kimiHome, "sessions", "wd_repo_123", sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(kimiHome, "session_index.jsonl"),
    `${JSON.stringify({ sessionId, sessionDir, workDir })}\n`,
    "utf8",
  );
  const statePath = path.join(sessionDir, "state.json");
  await writeFile(statePath, `${JSON.stringify({ title: "New Session", isCustomTitle: false }, null, 2)}\n`, "utf8");
  return statePath;
}
