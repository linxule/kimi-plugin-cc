import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { transform } from "esbuild";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, utimes } from "node:fs/promises";
import path from "node:path";

import { parseSwarmArgs } from "../../runtime/parsing.js";
import { classifyManagedCommandFailure } from "../../runtime/kimi-errors.js";
import {
  buildSwarmPrompt,
  buildSwarmWritePrompt,
  runSwarm,
  resolveSwarmMaxConcurrency,
  resolveSwarmWriteMaxConcurrency,
  SWARM_DEFAULT_MAX_CONCURRENCY,
  SWARM_WRITE_DEFAULT_MAX_CONCURRENCY,
} from "../../runtime/commands/swarm.js";
import { RuntimeError } from "../../runtime/errors.js";
import { resolveRepoIdentity, removeWorktree, createEphemeralWorktree } from "../../runtime/git.js";
import { JobStore, type JobRecord } from "../../runtime/job-store.js";
import { resolvePluginPaths, type PluginPaths } from "../../runtime/paths.js";
import type { CommandContext } from "../../runtime/types.js";
import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";

const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli-v1.ts");

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
  invocationPath: string,
  kimiHome: string,
  options?: { scenario?: string; delayMs?: number },
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginDataRoot,
    KIMI_CODE_HOME: kimiHome,
    KIMI_PLUGIN_CC_KIMI_BIN: "bun",
    KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
    KIMI_PLUGIN_CC_MOCK_SCENARIO: options?.scenario ?? "rescue-success",
    KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH: invocationPath,
    KIMI_PLUGIN_CC_MOCK_DELAY_MS: String(options?.delayMs ?? 0),
    KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
  };
}

async function makeAddNFailureGit(repoRoot: string): Promise<string> {
  const fakeBin = path.join(repoRoot, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  await writeFile(
    path.join(fakeBin, "git"),
    `#!/bin/sh\nif [ "$1" = "add" ] && [ "$2" = "-N" ]; then echo "intent-to-add blocked" >&2; exit 1; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
    { mode: 0o755 },
  );
  return fakeBin;
}

describe("parseSwarmArgs", () => {
  test("captures the objective as trailing prose", () => {
    const args = parseSwarmArgs(["review", "the", "auth", "module", "for", "races"]);
    expect(args.objective).toBe("review the auth module for races");
    expect(args.budgetMs).toBeUndefined();
    expect(args.cap).toBeUndefined();
    expect(args.maxConcurrency).toBeUndefined();
  });

  test("parses --budget into ms and --cap into an integer (cap does NOT set maxConcurrency)", () => {
    const args = parseSwarmArgs(["--budget", "1h", "--cap", "6", "audit", "every", "route"]);
    expect(args.budgetMs).toBe(3_600_000);
    expect(args.cap).toBe(6);
    // --cap is the SOFT total-count hint only; it must NOT feed the hard
    // concurrency ceiling (that is --max-concurrency's job after the v1.2.7 split).
    expect(args.maxConcurrency).toBeUndefined();
    expect(args.objective).toBe("audit every route");
  });

  test("--cap and --max-concurrency are independent (soft total vs hard concurrency)", () => {
    const args = parseSwarmArgs(["--cap", "20", "--max-concurrency", "4", "sweep", "the", "repo"]);
    expect(args.cap).toBe(20);
    expect(args.maxConcurrency).toBe(4);
    expect(args.objective).toBe("sweep the repo");
  });

  test("--max-concurrency alone sets only the hard ceiling", () => {
    const args = parseSwarmArgs(["--max-concurrency", "3", "review", "x"]);
    expect(args.maxConcurrency).toBe(3);
    expect(args.cap).toBeUndefined();
  });

  test("rejects a non-positive or non-integer --max-concurrency", () => {
    expect(() => parseSwarmArgs(["--max-concurrency", "0", "x"])).toThrow(RuntimeError);
    expect(() => parseSwarmArgs(["--max-concurrency", "2.5", "x"])).toThrow(RuntimeError);
    expect(() => parseSwarmArgs(["--max-concurrency", "-1", "x"])).toThrow(RuntimeError);
    expect(() => parseSwarmArgs(["--max-concurrency", "audit", "x"])).toThrow(RuntimeError);
  });

  test("parses -m/--model", () => {
    expect(parseSwarmArgs(["-m", "k2", "do", "x"]).model).toBe("k2");
    expect(parseSwarmArgs(["--model", "k2", "do", "x"]).model).toBe("k2");
  });

  test("rejects unknown flags (no silent slurp into the objective)", () => {
    expect(() => parseSwarmArgs(["--background", "do", "x"])).toThrow(RuntimeError);
    expect(() => parseSwarmArgs(["--turns", "5", "do", "x"])).toThrow(RuntimeError);
    expect(() => parseSwarmArgs(["--apply", "do", "x"])).toThrow(RuntimeError);
  });

  test("--write is a recognized boolean flag (defaults off)", () => {
    expect(parseSwarmArgs(["review", "x"]).write).toBe(false);
    const w = parseSwarmArgs(["--write", "refactor", "the", "parser"]);
    expect(w.write).toBe(true);
    expect(w.objective).toBe("refactor the parser");
  });

  test("--write composes with --budget / --cap / --max-concurrency / -m", () => {
    const w = parseSwarmArgs([
      "--write",
      "--budget",
      "20m",
      "--cap",
      "5",
      "--max-concurrency",
      "2",
      "-m",
      "k2",
      "fix",
      "the",
      "tests",
    ]);
    expect(w.write).toBe(true);
    expect(w.budgetMs).toBe(1_200_000);
    expect(w.cap).toBe(5);
    expect(w.maxConcurrency).toBe(2);
    expect(w.model).toBe("k2");
    expect(w.objective).toBe("fix the tests");
  });

  test("rejects a non-positive or non-integer --cap", () => {
    expect(() => parseSwarmArgs(["--cap", "0", "x"])).toThrow(RuntimeError);
    expect(() => parseSwarmArgs(["--cap", "3.5", "x"])).toThrow(RuntimeError);
    expect(() => parseSwarmArgs(["--cap", "-2", "x"])).toThrow(RuntimeError);
  });

  test("-- escapes flag-shaped objective text", () => {
    const args = parseSwarmArgs(["--", "--look-at", "this"]);
    expect(args.objective).toBe("--look-at this");
  });

  test("no objective yields undefined (runSwarm surfaces the INVALID_ARGS)", () => {
    expect(parseSwarmArgs(["--budget", "30m"]).objective).toBeUndefined();
  });
});

describe("resolveSwarmMaxConcurrency", () => {
  test("applies the hard concurrency default when --max-concurrency is unset", () => {
    // v1.3: swarm is model-invocable via the kimi-swarm agent, so an
    // auto-dispatched fan-out must never run with an unbounded peak. The runtime
    // enforces a finite ceiling by construction rather than trusting agent prose.
    expect(resolveSwarmMaxConcurrency(undefined)).toBe(SWARM_DEFAULT_MAX_CONCURRENCY);
    expect(SWARM_DEFAULT_MAX_CONCURRENCY).toBe(4);
  });

  test("an explicit --max-concurrency overrides the default", () => {
    expect(resolveSwarmMaxConcurrency(8)).toBe(8);
    expect(resolveSwarmMaxConcurrency(1)).toBe(1);
  });
});

describe("resolveSwarmWriteMaxConcurrency", () => {
  test("write mode serializes by default (1), lower than read's 4", () => {
    // Disjoint-target partitioning is prompt-only and unenforceable; serialize
    // concurrent writers into the shared worktree until a real-binary smoke
    // proves clean concurrent disjoint patches.
    expect(resolveSwarmWriteMaxConcurrency(undefined)).toBe(SWARM_WRITE_DEFAULT_MAX_CONCURRENCY);
    expect(SWARM_WRITE_DEFAULT_MAX_CONCURRENCY).toBe(1);
    expect(SWARM_WRITE_DEFAULT_MAX_CONCURRENCY).toBeLessThan(SWARM_DEFAULT_MAX_CONCURRENCY);
  });

  test("an explicit --max-concurrency overrides the write default", () => {
    expect(resolveSwarmWriteMaxConcurrency(2)).toBe(2);
  });
});

describe("runSwarm hook gate", () => {
  test("refuses without the hook and names Claude Code and Codex repair commands", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("swarm-hook-gate-data");
    const workspace = await createTestPluginDataRoot("swarm-hook-gate-ws");
    const kimiHome = await createTestPluginDataRoot("swarm-hook-gate-home");
    try {
      // Execution planning resolves a runnable binary before checking the hook.
      // This fixture must reach that hook gate even on hosts without kimi.
      const kimiBin = path.join(workspace, "kimi-stub");
      await writeFile(kimiBin, "#!/bin/sh\nexit 91\n", { mode: 0o755 });
      const output = await runSwarm(
        ["review", "two", "targets"],
        makeContext(workspace, {
          ...process.env,
          CLAUDE_PLUGIN_DATA: pluginDataRoot,
          KIMI_CODE_HOME: kimiHome,
          KIMI_PLUGIN_CC_KIMI_BIN: kimiBin,
          KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: "1",
        }),
      );

      expect(output).toContain("SWARM_HOOK_NOT_INSTALLED");
      expect(output).toContain("Claude Code /kimi:setup");
      expect(output).toContain("Codex $kimi-setup");
      expect(output).not.toContain("KIMI_PLUGIN_CC_SKIP_HOOK_CHECK");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(workspace);
      await cleanupTestPath(kimiHome);
    }
  });
});

describe("runSwarm certified execution-plan gate", () => {
  // A nonexistent absolute path cannot become an exact command/version plan.
  // Both read and write modes now fail closed at the common provenance gate;
  // KIMI_PLUGIN_CC_SKIP_VERSION_PROBE is neutralized so the gate genuinely runs.
  const BROKEN_KIMI = "/definitely/does/not/exist/kimi-binary-xyz";

  test("--write refuses when the exact binary cannot be resolved", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("swarm-vgate-w-data");
    const workspace = await createTestPluginDataRoot("swarm-vgate-w-ws");
    const kimiHome = await createTestPluginDataRoot("swarm-vgate-w-home");
    try {
      let caught: unknown;
      try {
        await runSwarm(
          ["--write", "edit", "every", "handler"],
          makeContext(workspace, {
            ...process.env,
            CLAUDE_PLUGIN_DATA: pluginDataRoot,
            KIMI_CODE_HOME: kimiHome,
            KIMI_PLUGIN_CC_KIMI_BIN: BROKEN_KIMI,
            KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: "",
          }),
        );
      } catch (error) {
        caught = error;
      }
      // Fail closed before the hook/model boundary: no exact provenance plan,
      // and therefore no certified hard-concurrency capability, exists.
      expect(caught).toBeInstanceOf(RuntimeError);
      expect((caught as RuntimeError).code).toBe("KIMI_EXECUTION_PLAN_UNRESOLVED");
      expect((caught as RuntimeError).message).toContain("exact runnable path");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(workspace);
      await cleanupTestPath(kimiHome);
    }
  });

  test("read-only swarm also refuses an unresolvable exact binary", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("swarm-vgate-r-data");
    const workspace = await createTestPluginDataRoot("swarm-vgate-r-ws");
    const kimiHome = await createTestPluginDataRoot("swarm-vgate-r-home");
    try {
      await expect(
        runSwarm(
          ["review", "two", "targets"],
          makeContext(workspace, {
            ...process.env,
            CLAUDE_PLUGIN_DATA: pluginDataRoot,
            KIMI_CODE_HOME: kimiHome,
            KIMI_PLUGIN_CC_KIMI_BIN: BROKEN_KIMI,
            KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: "",
          }),
        ),
      ).rejects.toMatchObject({ code: "KIMI_EXECUTION_PLAN_UNRESOLVED" });
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(workspace);
      await cleanupTestPath(kimiHome);
    }
  });


});

describe("write-swarm lifecycle", () => {
  test("a new run never age-deletes an abandoned worktree with uncaptured work", async () => {
    const data = await createTestPluginDataRoot("swarm-orphan-data");
    const repo = await createGitRepoFixture("swarm-orphan-repo");
    const home = await createTestPluginDataRoot("swarm-orphan-home");
    const env = makeMockEnv(data, path.join(data, "invocation.jsonl"), home);
    const repoId = (await resolveRepoIdentity(repo)).repoId;
    const orphan = path.join(resolvePluginPaths(env).worktreesDir, repoId, "swarm-write-abandoned");
    try {
      await mkdir(path.dirname(orphan), { recursive: true });
      await createEphemeralWorktree(repo, "HEAD", orphan);
      await writeFile(path.join(orphan, "uncaptured.txt"), "preserve me");
      const old = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      await utimes(orphan, old, old);
      await runSwarm(["--write", "empty patch"], makeContext(repo, env));
      expect(await readFile(path.join(orphan, "uncaptured.txt"), "utf8")).toBe("preserve me");
    } finally {
      if (existsSync(orphan)) await removeWorktree(repo, orphan);
      await cleanupTestPath(data); await cleanupTestPath(repo); await cleanupTestPath(home);
    }
  });

  test("successful completion preserves the write summary and removes the worktree", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("swarm-write-success-data");
    const repoRoot = await createGitRepoFixture("swarm-write-success-repo");
    const kimiHome = await createTestPluginDataRoot("swarm-write-success-home");
    const invocationPath = path.join(pluginDataRoot, "invocation.jsonl");
    const env = makeMockEnv(pluginDataRoot, invocationPath, kimiHome);
    const repoId = (await resolveRepoIdentity(repoRoot)).repoId;

    try {
      const output = await runSwarm(["--write", "prepare", "empty", "patch"], makeContext(repoRoot, env));
      expect(output).toContain("the swarm made NO changes");
      const store = new JobStore(resolvePluginPaths(env));
      let job;
      try {
        job = store.findLatestJob({ repoId, commandType: "rescue" });
        expect(job?.status).toBe("completed");
        expect(job?.summary).toBe("[swarm-write] prepare empty patch");
      } finally {
        store.close();
      }
      const worktreePath = path.join(resolvePluginPaths(env).worktreesDir, repoId, `swarm-write-${job!.job_id}`);
      expect(existsSync(worktreePath)).toBe(false);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
      await cleanupTestPath(kimiHome);
    }
  });

  test("patch capture failure fails the job and retains the worktree for recovery", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("swarm-write-capture-failure-data");
    const repoRoot = await createGitRepoFixture("swarm-write-capture-failure-repo");
    const kimiHome = await createTestPluginDataRoot("swarm-write-capture-failure-home");
    const invocationPath = path.join(pluginDataRoot, "invocation.jsonl");
    const env = makeMockEnv(pluginDataRoot, invocationPath, kimiHome);
    const repoId = (await resolveRepoIdentity(repoRoot)).repoId;
    const fakeBin = await makeAddNFailureGit(repoRoot);
    const previousPath = process.env.PATH;
    let worktreePath = "";

    try {
      process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
      await expect(runSwarm(["--write", "force", "capture", "failure"], makeContext(repoRoot, env))).rejects.toMatchObject({
        code: "SWARM_PATCH_CAPTURE_FAILED",
        stage: "swarm.patch-capture",
      });
      const store = new JobStore(resolvePluginPaths(env));
      let job;
      try {
        job = store.findLatestJob({ repoId, commandType: "rescue" });
        expect(job?.status).toBe("failed");
        expect(job?.error?.code).toBe("SWARM_PATCH_CAPTURE_FAILED");
        worktreePath = job?.error?.details?.worktreePath as string;
      } finally {
        store.close();
      }
      expect(worktreePath).toBe(path.join(resolvePluginPaths(env).worktreesDir, repoId, `swarm-write-${job!.job_id}`));
      expect(existsSync(worktreePath)).toBe(true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (worktreePath) await removeWorktree(repoRoot, worktreePath);
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
      await cleanupTestPath(kimiHome);
    }
  });

  test("timeout with capture failure preserves the timeout and includes the recovery path", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("swarm-write-timeout-capture-data");
    const repoRoot = await createGitRepoFixture("swarm-write-timeout-capture-repo");
    const kimiHome = await createTestPluginDataRoot("swarm-write-timeout-capture-home");
    const invocationPath = path.join(pluginDataRoot, "invocation.jsonl");
    const env = makeMockEnv(pluginDataRoot, invocationPath, kimiHome, { scenario: "rescue-cancel", delayMs: 5000 });
    const repoId = (await resolveRepoIdentity(repoRoot)).repoId;
    const fakeBin = await makeAddNFailureGit(repoRoot);
    const previousPath = process.env.PATH;
    let worktreePath = "";

    try {
      process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
      await expect(runSwarm(["--write", "--budget", "1s", "timeout", "capture"], makeContext(repoRoot, env))).rejects.toMatchObject({
        code: "RESCUE_KIMI_RESPONSE_TIMEOUT",
        details: { worktreePath: expect.any(String) },
      });
      const store = new JobStore(resolvePluginPaths(env));
      let job;
      try {
        job = store.findLatestJob({ repoId, commandType: "rescue" });
        expect(job?.status).toBe("failed");
        expect(job?.error?.code).toBe("RESCUE_KIMI_RESPONSE_TIMEOUT");
        worktreePath = job?.error?.details?.worktreePath as string;
      } finally {
        store.close();
      }
      expect(existsSync(worktreePath)).toBe(true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (worktreePath) await removeWorktree(repoRoot, worktreePath);
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
      await cleanupTestPath(kimiHome);
    }
  }, 15_000);

  test("cancellation with capture failure stays cancelled and includes the recovery path", async () => {
    const source = (await transform(await readFile(path.join(process.cwd(), "runtime/commands/swarm.ts"), "utf8"), {
      loader: "ts",
      format: "esm",
    })).code;
    const capture = source.slice(
      source.indexOf("async function capturePatchArtifact"),
      source.indexOf("function renderWriteSwarmHeader"),
    );
    const execute = source.slice(
      source.indexOf("async function executeSwarmJob"),
      source.indexOf("\nfunction shorten"),
    );
    let retained = false;
    const job = { job_id: "probe", cwd: "/repo", stream_log_path: "/unused" };
    const deps = {
      RuntimeError,
      classifyManagedCommandFailure,
      resolvePluginPaths: () => ({ artifactsDir: "/unused" }),
      ensurePluginPaths: async () => {},
      JobStore: class {
        getJob() { return job; }
        updateRunningJob() {}
        close() {}
      },
      createCliCancellationHandlers: () => ({
        cancelling: true,
        signal: new AbortController().signal,
        dispose() {},
      }),
      executionPlanFromPersisted: () => ({ command: "unused", prefixArgs: [] }),
      runCliPromptWithBudget: async () => {
        throw new RuntimeError("RESPONSE_TIMEOUT", "budget elapsed", "swarm.prompt");
      },
      captureWorktreePatch: async () => {
        throw new Error("forced capture failure");
      },
      markJobFailed: async (_store: JobStore, _paths: PluginPaths, current: JobRecord, error: RuntimeError) => ({ ...current, status: "failed" as const, error }),
      markJobCancelled: async (_store: JobStore, _paths: PluginPaths, current: JobRecord, _summary: string, error: RuntimeError) => ({ ...current, status: "cancelled" as const, error }),
    };
    const build = new Function(
      "deps",
      `const {${Object.keys(deps).join(",")}} = deps; ${capture}\n${execute}\nreturn executeSwarmJob;`,
    );
    const outcome = await build(deps)(
      "probe",
      "prompt",
      "objective",
      10,
      1,
      { env: { KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1" }, stderr: { write() {} } },
      {
        workspaceRoot: "/retained-worktree",
        spawnCwd: "/retained-worktree",
        onPatchCaptureFailure() { retained = true; },
      },
    );

    expect(outcome.status).toBe("cancelled");
    expect(outcome.error.code).toBe("SWARM_CANCELLED");
    expect(outcome.error.details.worktreePath).toBe("/retained-worktree");
    expect(retained).toBe(true);
  });
});

describe("buildSwarmPrompt", () => {
  // v1.8.6: the prompt was slimmed after the kimi-code 0.26.0 (k3) coordinator
  // hung when over-prescribed. It now states the read-only goal + report shape
  // and trusts the model to fan out with its own subagent capability, while
  // still naming the allowed read-only tools and Bash denial so k3 doesn't stall
  // on a denied preliminary shell call. Safety is unchanged — the PreToolUse hook
  // (swarm label) enforces read-only regardless of this prose.
  test("states the read-only goal, objective, and allowed inspection tools", () => {
    const prompt = buildSwarmPrompt("review the parser");
    expect(prompt.toLowerCase()).toContain("read-only");
    expect(prompt).toContain("review the parser");
    expect(prompt).toContain("allowed read-only tools");
    expect(prompt).toContain("Read/Grep/Glob");
    expect(prompt).toContain("ReadMediaFile where relevant");
    expect(prompt).not.toContain("Only Read, Grep, and Glob are available");
  });

  test("names the Bash denial and steers the fan-out to be the first action (k3 anti-hang)", () => {
    const prompt = buildSwarmPrompt("review the parser");
    expect(prompt).toContain("Bash");
    expect(prompt).toContain("FIRST action");
    // Deliberately does NOT prescribe the internal AgentSwarm mechanics that
    // confused k3 — no subagent_type / prompt_template scaffolding.
    expect(prompt).not.toContain("subagent_type");
    expect(prompt).not.toContain("prompt_template");
  });

  test("makes --cap a soft total lifetime subagent count, not a parallel count", () => {
    const prompt = buildSwarmPrompt("audit the routes", 4);
    expect(prompt).toContain("at most 4 subagents in total");
    expect(prompt).toContain("across the whole run");
    expect(prompt).toContain("soft cap");
    expect(prompt).toContain("split or group targets");
    expect(prompt).not.toContain("at most 4 parallel subagents");
  });

  test("consolidates without duplicate findings or dropped empty targets", () => {
    const prompt = buildSwarmPrompt("audit the routes");
    expect(prompt).toContain("deduplicate findings");
    expect(prompt).toContain("preserve coverage");
    expect(prompt).toContain("targets with no findings");
    expect(prompt).toContain("rather than dropping them");
  });

  test("omits the cap number when --cap is unset", () => {
    const prompt = buildSwarmPrompt("audit the routes");
    expect(prompt).not.toContain("at most");
    // Still tells the model to fan the work out in parallel.
    expect(prompt.toLowerCase()).toContain("parallel");
  });
});

describe("buildSwarmWritePrompt", () => {
  test("steers to the write-capable coder profile and disjoint editing", () => {
    const prompt = buildSwarmWritePrompt("apply the rename across the package");
    expect(prompt).toContain("AgentSwarm");
    expect(prompt).toContain("coder");
    expect(prompt).toContain("DISJOINT");
    expect(prompt).toContain("apply the rename across the package");
  });

  test("forbids git mutation and nested swarm in-prompt", () => {
    const prompt = buildSwarmWritePrompt("fix the failing tests");
    expect(prompt).toContain("git");
    expect(prompt.toLowerCase()).toContain("nested");
    // Tells the model the human owns git / merge.
    expect(prompt.toLowerCase()).toContain("human owns");
  });

  test("separates hook-enforced safety from prompt-only coordination", () => {
    const prompt = buildSwarmWritePrompt("fix the failing tests");
    const coordinationMarker = "Coordination rules (prompt-only; the hook does NOT enforce them):";
    expect(prompt).toContain("Safety rules enforced by the PreToolUse hook");
    expect(prompt).toContain(coordinationMarker);
    const [beforeCoordination, coordination] = prompt.split(coordinationMarker);
    expect(beforeCoordination).toContain("Writes are confined to this worktree");
    expect(beforeCoordination).toContain("git mutation");
    expect(beforeCoordination).not.toContain("Keep every assigned target DISJOINT");
    expect(beforeCoordination).not.toContain("no nested fan-out");
    expect(coordination).toContain("Keep every assigned target DISJOINT");
    expect(coordination).toContain("no nested fan-out");
    expect(prompt).not.toContain("the safety hook enforces these");
  });

  test("does NOT claim read-only (it is the write path)", () => {
    const prompt = buildSwarmWritePrompt("refactor x");
    expect(prompt).not.toContain("READ-ONLY");
  });

  test("carries a soft total cap clause like the read prompt", () => {
    const prompt = buildSwarmWritePrompt("x", 3);
    expect(prompt).toContain("at most 3 subagents in total");
    expect(prompt).toContain("across the whole run");
    expect(prompt).toContain("soft cap");
    expect(buildSwarmWritePrompt("x")).toContain("one subagent per distinct target");
  });
});
