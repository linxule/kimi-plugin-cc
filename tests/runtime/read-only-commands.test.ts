import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runAsk } from "../../runtime/commands/ask.js";
import { runReview } from "../../runtime/commands/review.js";
import { rawTaskTextFromSubmittedPrompt } from "../../runtime/commands/repair-sessions.js";
import type { CommandContext } from "../../runtime/types.js";
import {
  cleanupTestPath,
  createGitRepoFixture,
  createTestPluginDataRoot,
} from "../helpers/test-env.js";

const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli.ts");

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
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KIMI_PLUGIN_CC_DATA: pluginDataRoot,
    KIMI_CODE_HOME: path.join(pluginDataRoot, "kimi-home"),
    KIMI_PLUGIN_CC_KIMI_BIN: "bun",
    KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
    KIMI_PLUGIN_CC_MOCK_SCENARIO: scenario,
    KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH: invocationPath,
    KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
  };
}

async function readSubmittedPrompt(invocationPath: string): Promise<string> {
  const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
  const promptIndex = invocation.argv.indexOf("-p");
  const prompt = promptIndex >= 0 ? invocation.argv[promptIndex + 1] : undefined;
  if (!prompt) {
    throw new Error(`Mock Kimi invocation did not contain a -p prompt: ${invocationPath}`);
  }
  return prompt;
}

function withoutHookCheckBypass(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const guardedEnv = { ...env };
  delete guardedEnv.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK;
  return guardedEnv;
}

describe("read-only command handlers", () => {
  test.each(["review", "challenge"] as const)(
    "%s refuses before spawning Kimi when hook enforcement is absent",
    async (commandType) => {
      const pluginDataRoot = await createTestPluginDataRoot(`${commandType}-missing-hook`);
      const kimiHome = await createTestPluginDataRoot(`${commandType}-missing-hook-kimi-home`);
      const repoRoot = await createGitRepoFixture(`${commandType}-missing-hook-repo`);
      const invocationPath = path.join(pluginDataRoot, `${commandType}-missing-hook-invocation.jsonl`);
      const env = {
        ...withoutHookCheckBypass(
          makeMockEnv(pluginDataRoot, `${commandType}-success`, invocationPath),
        ),
        KIMI_CODE_HOME: kimiHome,
      };

      try {
        await expect(runReview([], makeContext(repoRoot, env), commandType)).rejects.toMatchObject({
          code: `${commandType.toUpperCase()}_HOOK_NOT_INSTALLED`,
          stage: `${commandType}.hook-check`,
        });
        expect(existsSync(invocationPath)).toBe(false);
      } finally {
        await cleanupTestPath(pluginDataRoot);
        await cleanupTestPath(kimiHome);
        await cleanupTestPath(repoRoot);
      }
    },
  );

  test.each([
    ["foreground", ["What", "changed?"]],
    ["background", ["--background", "What", "changed?"]],
  ] as const)(
    "runAsk %s refuses before spawning Kimi when hook enforcement is absent",
    async (mode, argv) => {
      const pluginDataRoot = await createTestPluginDataRoot(`ask-${mode}-missing-hook`);
      const kimiHome = await createTestPluginDataRoot(`ask-${mode}-missing-hook-kimi-home`);
      const invocationPath = path.join(pluginDataRoot, `ask-${mode}-missing-hook-invocation.jsonl`);
      const env = {
        ...withoutHookCheckBypass(
          makeMockEnv(pluginDataRoot, "ask-success", invocationPath),
        ),
        KIMI_CODE_HOME: kimiHome,
      };

      try {
        await expect(runAsk([...argv], makeContext(process.cwd(), env))).rejects.toMatchObject({
          code: "ASK_HOOK_NOT_INSTALLED",
          stage: "ask.hook-check",
        });
        expect(existsSync(invocationPath)).toBe(false);
      } finally {
        await cleanupTestPath(pluginDataRoot);
        await cleanupTestPath(kimiHome);
      }
    },
  );

  test("runAsk returns prose and forwards the native-v2 cli flags + command label", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-command");
    const kimiHome = await createTestPluginDataRoot("ask-command-kimi-home");
    const invocationPath = path.join(pluginDataRoot, "ask-invocation.jsonl");
    const sessionId = "session_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const env = {
      ...makeMockEnv(pluginDataRoot, "ask-success", invocationPath),
      KIMI_CODE_HOME: kimiHome,
      KIMI_PLUGIN_CC_MOCK_SESSION_ID: sessionId,
      KIMI_PLUGIN_CC_MOCK_NO_SESSION_STORE: "1",
    };

    try {
      const statePath = await seedKimiSession(kimiHome, sessionId);
      const result = await runAsk(["What", "changed?"], makeContext(process.cwd(), env));
      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as {
        argv: string[];
        env: { KIMI_PLUGIN_CC_CMD: string | null };
      };
      const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;

      // v1.0 cli-client passes `--output-format stream-json` and `-p <prompt>`.
      // No `--session <uuid>` (kimi-code assigns the id) and no
      // `--agent-file` (kimi-code has no YAML agent profiles).
      expect(result).toBe("Ask answer from mock Kimi.");
      expect(invocation.argv).toContain("--output-format");
      expect(invocation.argv).toContain("stream-json");
      expect(invocation.argv).toContain("-p");
      expect(invocation.env.KIMI_PLUGIN_CC_CMD).toBe("ask");
      // v1.0 alpha.4: ask runs thinking-on always. Only review-gate's
      // internal caller pins thinking=false. (Kimi alpha.4 finding #1.)
      expect(invocation.argv).not.toContain("--no-thinking");
      expect(invocation.argv).not.toContain("--thinking");
      expect(state.title).toBe("Kimi Ask: What changed?");
      expect(state.isCustomTitle).toBe(true);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(kimiHome);
    }
  });

  test.each([
    ["review", [], "Kimi Review: current working tree changes", "Review target: current working tree changes"],
    ["review", ["--base", "HEAD", "--", "edge", "cases"], "Kimi Review: edge cases",
      "Review target: branch diff against HEAD. Focus: edge cases"],
    ["challenge", ["the", "retry", "design"], "Kimi Challenge: the retry design",
      "Review target: current working tree changes. Focus: the retry design"],
  ] as const)("native-v2 %s preview replaces Kimi's recorded prompt with the target and focus", async (commandType, focus, title, preview) => {
    const pluginDataRoot = await createTestPluginDataRoot(`${commandType}-preview`);
    const kimiHome = await createTestPluginDataRoot(`${commandType}-preview-kimi-home`);
    const repoRoot = await createGitRepoFixture(`${commandType}-preview-git`);
    const sessionId = "session_cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";
    const invocationPath = path.join(pluginDataRoot, "invocation.jsonl");
    const env = {
      ...makeMockEnv(pluginDataRoot, `${commandType}-success`, invocationPath),
      KIMI_CODE_HOME: kimiHome,
      KIMI_PLUGIN_CC_MOCK_SESSION_ID: sessionId,
      KIMI_PLUGIN_CC_MOCK_NO_SESSION_STORE: "1",
    };
    try {
      const statePath = await seedKimiSession(kimiHome, sessionId, repoRoot);
      // A preview holding this run's own submitted prompt (truncated), as earlier plugin releases wrote it.
      await writeFile(statePath, JSON.stringify({ id: sessionId, version: 2, title: "New Session", titleKind: "replaceable",
        isCustomTitle: false, lastPrompt: "Perform a read-only code review of the supplied repository changes." }));
      await runReview([...focus], makeContext(repoRoot, env), commandType);
      const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
      expect(state).toMatchObject({ title, titleKind: "replaceable", lastPrompt: preview });
      // repair-sessions derives the same preview from the verified submitted prompt.
      const argv = (JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] }).argv;
      expect(rawTaskTextFromSubmittedPrompt(commandType, argv[argv.indexOf("-p") + 1]!)).toBe(preview);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(kimiHome);
      await cleanupTestPath(repoRoot);
    }
  });

  test("runReview returns prose passthrough and sets the review command label", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("review-command");
    const kimiHome = await createTestPluginDataRoot("review-command-kimi-home");
    const repoRoot = await createGitRepoFixture("review-git");
    const invocationPath = path.join(pluginDataRoot, "review-invocation.jsonl");
    const sessionId = "session_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const env = {
      ...makeMockEnv(pluginDataRoot, "review-success", invocationPath),
      KIMI_CODE_HOME: kimiHome,
      KIMI_PLUGIN_CC_MOCK_SESSION_ID: sessionId,
      KIMI_PLUGIN_CC_MOCK_NO_SESSION_STORE: "1",
    };

    try {
      const statePath = await seedKimiSession(kimiHome, sessionId, repoRoot);
      const result = await runReview([], makeContext(repoRoot, env), "review");
      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as {
        argv: string[];
        env: { KIMI_PLUGIN_CC_CMD: string | null };
      };
      const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;

      // Output passes through as prose — no schema parsing.
      expect(result).toContain("concern");
      expect(result).toContain("Incorrect answer constant");
      expect(invocation.env.KIMI_PLUGIN_CC_CMD).toBe("review");
      expect(state.title).toBe("Kimi Review: current working tree changes");
      expect(state.lastPrompt).toBeUndefined();
      expect(state.isCustomTitle).toBe(true);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(kimiHome);
      await cleanupTestPath(repoRoot);
    }
  });

  test("runChallenge honors the explicit hook-check opt-out and invokes Kimi", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("challenge-command");
    const repoRoot = await createGitRepoFixture("challenge-git");
    const invocationPath = path.join(pluginDataRoot, "challenge-invocation.jsonl");
    const env = makeMockEnv(pluginDataRoot, "challenge-success", invocationPath);

    try {
      expect(env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK).toBe("1");
      const result = await runReview([], makeContext(repoRoot, env), "challenge");
      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as {
        env: { KIMI_PLUGIN_CC_CMD: string | null };
      };

      expect(result).toContain("Mock Kimi challenge");
      expect(invocation.env.KIMI_PLUGIN_CC_CMD).toBe("challenge");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("runReview accepts review output without enforcing a schema", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("review-empty");
    const repoRoot = await createGitRepoFixture("review-git-empty");
    const invocationPath = path.join(pluginDataRoot, "review-empty-invocation.jsonl");
    const env = makeMockEnv(pluginDataRoot, "review-missing-confidence", invocationPath);

    try {
      // The "review-missing-confidence" mock scenario emits JSON without a
      // confidence field. Before v0.2.3 this failed schema parsing; v0.2.3
      // dropped the schema and review now accepts any non-empty text. The
      // only remaining hard failure is empty output, which this mock does
      // not produce — so the call should succeed with non-empty stdout.
      const result = await runReview([], makeContext(repoRoot, env), "review");
      expect(result.length).toBeGreaterThan(0);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("runAsk fresh and resumed prompts share the full prose contract", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("ask-prompt-contract");
    const kimiHome = await createTestPluginDataRoot("ask-prompt-contract-kimi-home");
    const invocationPath = path.join(pluginDataRoot, "ask-prompt-contract-invocation.jsonl");
    const env = {
      ...makeMockEnv(pluginDataRoot, "ask-success", invocationPath),
      KIMI_CODE_HOME: kimiHome,
    };
    const contract = [
      "Answer directly in free-form prose.",
      "For repository-dependent questions, inspect the relevant code with the allowed read tools and cite file:line for concrete code claims where useful.",
      "Distinguish evidence from inference and state unknowns explicitly.",
      "Do not use shell/Bash, writes, background tasks, or delegated operations.",
      "Do not emit JSON unless the user explicitly asks for it.",
      "Do not narrate tool progress; make the final response self-contained.",
    ];

    try {
      await runAsk(["What", "changed?"], makeContext(process.cwd(), env));
      const freshPrompt = await readSubmittedPrompt(invocationPath);
      await runAsk(["-r"], makeContext(process.cwd(), env));
      const resumedPrompt = await readSubmittedPrompt(invocationPath);

      expect(freshPrompt).toBe([...contract, "", "User question:", "What changed?"].join("\n"));
      expect(resumedPrompt).toBe([
        ...contract,
        "",
        "Continue the previous ask conversation and answer any outstanding question.",
      ].join("\n"));
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(kimiHome);
    }
  });

  test("runReview and runChallenge submit their complete read-only review contracts", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("review-prompt-contract");
    const repoRoot = await createGitRepoFixture("review-prompt-contract-repo");
    const reviewInvocationPath = path.join(pluginDataRoot, "review-prompt-contract-invocation.jsonl");
    const challengeInvocationPath = path.join(pluginDataRoot, "challenge-prompt-contract-invocation.jsonl");
    const sharedContract = [
      "Use only the allowed repository read tools; do not use shell/Bash, writes, background tasks, or delegated operations.",
      "Read each complete changed file, relevant surrounding code, and related tests rather than reviewing only the diff excerpt.",
      "Return plain markdown with a short verdict line (approve / concern / block), a brief summary, and findings with file:line references.",
      "For every finding, provide concrete evidence, impact, severity, and confidence. Do not manufacture findings; if there are none, say so honestly and note residual verification gaps.",
      "Do not emit JSON or wrap the whole response in code fences.",
    ].join("\n");

    try {
      await runReview([], makeContext(repoRoot, makeMockEnv(
        pluginDataRoot,
        "review-success",
        reviewInvocationPath,
      )), "review");
      await runReview([], makeContext(repoRoot, makeMockEnv(
        pluginDataRoot,
        "challenge-success",
        challengeInvocationPath,
      )), "challenge");
      const reviewPrompt = await readSubmittedPrompt(reviewInvocationPath);
      const challengePrompt = await readSubmittedPrompt(challengeInvocationPath);

      expect(reviewPrompt).toContain("Focus on concrete bugs, regressions, and missing safeguards in the supplied changes.");
      expect(reviewPrompt).toContain(sharedContract);
      expect(challengePrompt).toContain("Steelman the current approach first, then challenge its assumptions, brittle design choices, and alternatives.");
      expect(challengePrompt).toContain("Say when the current approach is preferable instead of assuming change is necessary.");
      expect(challengePrompt).toContain(sharedContract);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("runReview treats untracked-only files as review inputs without inlining them", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("review-untracked-only");
    const repoRoot = await createGitRepoFixture("review-untracked-only-repo");
    const invocationPath = path.join(pluginDataRoot, "review-untracked-only-invocation.jsonl");
    const env = makeMockEnv(pluginDataRoot, "review-success", invocationPath);

    try {
      await writeFile(path.join(repoRoot, "src.ts"), "export const answer = 41;\n", "utf8");
      await writeFile(
        path.join(repoRoot, "untracked.ts"),
        "export const sentinel = \"UNTRACKED_CONTENT_MUST_NOT_BE_INLINED\";\n",
        "utf8",
      );
      await runReview([], makeContext(repoRoot, env), "review");
      const prompt = await readSubmittedPrompt(invocationPath);

      expect(prompt).toContain("Scope: current working tree, including tracked and untracked changes");
      expect(prompt).toContain("?? untracked.ts");
      expect(prompt).toContain("Files marked ?? in git status are untracked review inputs absent from the unified diff; read their complete contents with allowed read tools.");
      expect(prompt).toContain("(no diff text available)");
      expect(prompt).not.toContain("There are no changes in the declared review scope.");
      expect(prompt).not.toContain("UNTRACKED_CONTENT_MUST_NOT_BE_INLINED");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("runReview preserves the clean-tree no-changes instruction", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("review-clean-tree");
    const repoRoot = await createGitRepoFixture("review-clean-tree-repo");
    const invocationPath = path.join(pluginDataRoot, "review-clean-tree-invocation.jsonl");
    const env = makeMockEnv(pluginDataRoot, "review-success", invocationPath);

    try {
      await writeFile(path.join(repoRoot, "src.ts"), "export const answer = 41;\n", "utf8");
      await runReview([], makeContext(repoRoot, env), "review");
      const prompt = await readSubmittedPrompt(invocationPath);

      expect(prompt).toContain("There are no changes in the declared review scope. Return immediately with a one-line note that there were no changes; do not explore the repository.");
      expect(prompt).toContain("git status --short:\n(clean)");
      expect(prompt).toContain("Unified diff context:\n(no diff text available)");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("runReview --base ignores dirty working-tree inputs and permits a no-changes result", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("review-base-dirty-tree");
    const repoRoot = await createGitRepoFixture("review-base-dirty-tree-repo");
    const invocationPath = path.join(pluginDataRoot, "review-base-dirty-tree-invocation.jsonl");
    const env = makeMockEnv(pluginDataRoot, "review-success", invocationPath);

    try {
      await writeFile(
        path.join(repoRoot, "dirty-untracked.ts"),
        "BASE_DIRTY_CONTENT_MUST_NOT_ENTER_SCOPE\n",
        "utf8",
      );
      await runReview(["--base", "HEAD"], makeContext(repoRoot, env), "review");
      const prompt = await readSubmittedPrompt(invocationPath);

      expect(prompt).toContain("Target: branch diff against HEAD");
      expect(prompt).toContain("Scope: branch diff only; all working-tree changes are out of scope");
      expect(prompt).toContain("There are no changes in the declared review scope. Return immediately with a one-line note that there were no changes; do not explore the repository.");
      expect(prompt).toContain("Unified diff context:\n(no diff text available)");
      expect(prompt).not.toContain("git status --short:");
      expect(prompt).not.toContain("dirty-untracked.ts");
      expect(prompt).not.toContain("export const answer = 42;");
      expect(prompt).not.toContain("BASE_DIRTY_CONTENT_MUST_NOT_ENTER_SCOPE");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("runReview --base does not treat dirty current files as committed snapshots", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("review-base-nonempty-dirty-tree");
    const repoRoot = await createGitRepoFixture("review-base-nonempty-dirty-tree-repo");
    const invocationPath = path.join(pluginDataRoot, "review-base-nonempty-dirty-tree-invocation.jsonl");
    const env = makeMockEnv(pluginDataRoot, "review-success", invocationPath);

    try {
      execFileSync("git", ["add", "src.ts"], { cwd: repoRoot });
      execFileSync("git", ["commit", "-m", "second"], { cwd: repoRoot });
      await runReview(["--base", "HEAD~1"], makeContext(repoRoot, env), "review");
      const cleanPrompt = await readSubmittedPrompt(invocationPath);
      expect(cleanPrompt).toContain("Read each complete changed file at HEAD");

      await writeFile(path.join(repoRoot, "scratch.ts"), "untracked scratch\n", "utf8");
      await runReview(["--base", "HEAD~1"], makeContext(repoRoot, env), "review");
      const untrackedOnlyPrompt = await readSubmittedPrompt(invocationPath);
      expect(untrackedOnlyPrompt).toContain("Read each complete changed file at HEAD");
      expect(untrackedOnlyPrompt).not.toContain("Current working-tree files may differ");

      await writeFile(path.join(repoRoot, "src.ts"), "export const answer = 43;\n", "utf8");
      await runReview(["--base", "HEAD~1"], makeContext(repoRoot, env), "review");
      const dirtyPrompt = await readSubmittedPrompt(invocationPath);

      expect(dirtyPrompt).toContain("Target: branch diff against HEAD~1");
      expect(dirtyPrompt).toContain("Treat the supplied branch diff as the source of truth");
      expect(dirtyPrompt).toContain("do not use their contents or line numbers as evidence for committed changes");
      expect(dirtyPrompt).toContain("+export const answer = 42;");
      expect(dirtyPrompt).not.toContain("export const answer = 43;");
      expect(dirtyPrompt).not.toContain("Read each complete changed file at HEAD");
      expect(dirtyPrompt).not.toContain("git status --short:");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("runReview --base fallback compares committed HEAD instead of dirty working-tree files", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("review-base-fallback-dirty-tree");
    const repoRoot = await createGitRepoFixture("review-base-fallback-dirty-tree-repo");
    const invocationPath = path.join(pluginDataRoot, "review-base-fallback-dirty-tree-invocation.jsonl");
    const env = makeMockEnv(pluginDataRoot, "review-success", invocationPath);
    const fakeBin = path.join(repoRoot, "fake-bin");
    await mkdir(fakeBin, { recursive: true });
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    await writeFile(
      path.join(fakeBin, "git"),
      `#!/bin/sh\ncase "$*" in *...HEAD*) exit 1 ;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;

    try {
      process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
      execFileSync("git", ["add", "src.ts"], { cwd: repoRoot });
      execFileSync("git", ["commit", "-m", "second"], { cwd: repoRoot });
      await writeFile(path.join(repoRoot, "src.ts"), "export const answer = 43;\n", "utf8");
      await runReview(["--base", "HEAD~1"], makeContext(repoRoot, env), "review");
      const prompt = await readSubmittedPrompt(invocationPath);

      expect(prompt).toContain("Target: branch diff against HEAD~1\n");
      expect(prompt).toContain("+export const answer = 42;");
      expect(prompt).not.toContain("export const answer = 43;");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("runReview requires follow-up inspection when the diff is truncated", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("review-truncated-diff");
    const repoRoot = await createGitRepoFixture("review-truncated-diff-repo");
    const invocationPath = path.join(pluginDataRoot, "review-truncated-diff-invocation.jsonl");
    const env = makeMockEnv(pluginDataRoot, "review-success", invocationPath);

    try {
      await writeFile(
        path.join(repoRoot, "src.ts"),
        `export const answer = 42;\n// ${"x".repeat(81_000)}\n`,
        "utf8",
      );
      await runReview([], makeContext(repoRoot, env), "review");
      const prompt = await readSubmittedPrompt(invocationPath);

      expect(prompt).toContain("[diff truncated by companion after 80000 characters]");
      expect(prompt).toContain("The unified diff is truncated. Inspect all omitted hunks and files with allowed read tools before claiming full coverage, and report any remaining verification gaps.");
      expect(prompt).not.toContain("There are no changes in the declared review scope.");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  test("runReview --base reports truncated-diff gaps when dirty files cannot supply snapshots", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("review-base-truncated-dirty-tree");
    const repoRoot = await createGitRepoFixture("review-base-truncated-dirty-tree-repo");
    const invocationPath = path.join(pluginDataRoot, "review-base-truncated-dirty-tree-invocation.jsonl");
    const env = makeMockEnv(pluginDataRoot, "review-success", invocationPath);

    try {
      await writeFile(path.join(repoRoot, "src.ts"), `export const answer = 42;\n// ${"x".repeat(81_000)}\n`, "utf8");
      execFileSync("git", ["add", "src.ts"], { cwd: repoRoot });
      execFileSync("git", ["commit", "-m", "second"], { cwd: repoRoot });
      await writeFile(path.join(repoRoot, "src.ts"), `export const answer = 43;\n// ${"x".repeat(81_000)}\n`, "utf8");
      await runReview(["--base", "HEAD~1"], makeContext(repoRoot, env), "review");
      const prompt = await readSubmittedPrompt(invocationPath);

      expect(prompt).toContain("[diff truncated by companion after 80000 characters]");
      expect(prompt).toContain("the dirty working tree cannot supply reliable committed snapshots");
      expect(prompt).toContain("Do not claim full coverage");
      expect(prompt).not.toContain("Inspect all omitted hunks and files with allowed read tools");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  });

  // v0.4 surfaced a wire-protocol Approval Request through the runtime's
  // ApprovalDispatcher (rejectAllApprovals) so read-only commands would
  // fail loudly if kimi asked for permission. v1.0 moves that enforcement
  // out-of-band into the PreToolUse hook (runtime/hooks/approval-policy.ts),
  // which is exercised by approval-policy.test.ts. There is no
  // runtime-side equivalent in v1: the hook denies before the model can
  // emit a tool call, the model adapts, and the assistant prose comes
  // back as normal. Tests of the deny path live with the hook policy.
});

async function seedKimiSession(
  kimiHome: string,
  sessionId: string,
  workDir = process.cwd(),
): Promise<string> {
  const sessionDir = path.join(kimiHome, "sessions", "wd_repo_123", sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(kimiHome, "session_index.jsonl"),
    `${JSON.stringify({
      sessionId,
      sessionDir,
      workDir,
    })}\n`,
    "utf8",
  );
  const statePath = path.join(sessionDir, "state.json");
  await writeFile(
    statePath,
    `${JSON.stringify({ title: "New Session", isCustomTitle: false }, null, 2)}\n`,
    "utf8",
  );
  return statePath;
}
