import { describe, expect, test } from "bun:test";
import path from "node:path";

import { runAsk } from "../../runtime/commands/ask.js";
import { runPursue } from "../../runtime/commands/pursue.js";
import { runRescue } from "../../runtime/commands/rescue.js";
import { runReview } from "../../runtime/commands/review.js";
import { RuntimeError } from "../../runtime/errors.js";
import { resolveRepoIdentity } from "../../runtime/git.js";
import {
  __resetHookMissingWarning,
  formatHookMissingWarning,
  hookRefusalDetails,
  hookRefusalRetryProtocol,
  verifyHookInstalled,
} from "../../runtime/hooks/install.js";
import { JobStore } from "../../runtime/job-store.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import type { CommandContext } from "../../runtime/types.js";
import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";

const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli-v1.ts");

const READ_ONLY_TAIL = [
  "Run /kimi:setup or $kimi-setup to install or repair this host's managed block.",
  "Set KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1 only if you intentionally accept un-enforced execution.",
];
const WRITE_TAIL = [
  "Repair by running Claude Code /kimi:setup or Codex $kimi-setup, then retry.",
  "KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1 is only for deliberate tests or diagnostics.",
];

type Case = {
  name: string;
  warnLabel: string;
  code: string;
  stage: string;
  intro: string;
  tail: string[];
  // The job-time check in prepareKimiExecutionPlan runs before any job row
  // exists and throws the same gate error; a write command's own gate persists
  // it on the row only when the hook disappears after the plan.
  run: (context: CommandContext) => Promise<unknown>;
  persisted: boolean;
};

const CASES: Case[] = [
  {
    name: "ask", warnLabel: "ask", code: "ASK_HOOK_NOT_INSTALLED", stage: "ask.hook-check",
    intro: "ask refuses to run without the canonical kimi-plugin-cc PreToolUse hook.", tail: READ_ONLY_TAIL,
    run: (context) => runAsk(["What", "changed?"], context), persisted: false,
  },
  {
    name: "review", warnLabel: "review", code: "REVIEW_HOOK_NOT_INSTALLED", stage: "review.hook-check",
    intro: "review refuses to run without the canonical kimi-plugin-cc PreToolUse hook.", tail: READ_ONLY_TAIL,
    run: (context) => runReview([], context, "review"), persisted: false,
  },
  {
    name: "challenge", warnLabel: "challenge", code: "CHALLENGE_HOOK_NOT_INSTALLED", stage: "challenge.hook-check",
    intro: "challenge refuses to run without the canonical kimi-plugin-cc PreToolUse hook.", tail: READ_ONLY_TAIL,
    run: (context) => runReview([], context, "challenge"), persisted: false,
  },
  {
    name: "rescue", warnLabel: "rescue", code: "RESCUE_HOOK_NOT_INSTALLED", stage: "rescue.hook-check",
    intro: "rescue refuses to run without the kimi-plugin-cc PreToolUse hook.", tail: WRITE_TAIL,
    run: (context) => runRescue(["Fix", "it"], context), persisted: false,
  },
  {
    name: "pursue", warnLabel: "rescue", code: "PURSUE_HOOK_NOT_INSTALLED", stage: "pursue.hook-check",
    intro: "/kimi:pursue refuses to run without the kimi-plugin-cc PreToolUse hook.", tail: WRITE_TAIL,
    run: (context) => runPursue(["Fix", "it"], context), persisted: false,
  },
];

describe("hook refusal messages", () => {
  test.each(CASES.map((c) => [c.name, c] as const))("%s pins code, message, stage, details and warning", async (name, c) => {
    const pluginDataRoot = await createTestPluginDataRoot(`hook-refusal-${name}`);
    const kimiHome = await createTestPluginDataRoot(`hook-refusal-${name}-kimi-home`);
    const repoRoot = await createGitRepoFixture(`hook-refusal-${name}-repo`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: pluginDataRoot,
      KIMI_CODE_HOME: kimiHome,
      KIMI_PLUGIN_CC_KIMI_BIN: "bun",
      KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
      KIMI_PLUGIN_CC_MOCK_SCENARIO: `${name}-success`,
      KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH: path.join(pluginDataRoot, "invocation.jsonl"),
    };
    delete env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK;
    const stderrChunks: string[] = [];
    const stderr = { write: (chunk: string) => { stderrChunks.push(String(chunk)); return true; } } as unknown as NodeJS.WriteStream;
    const context: CommandContext = { cwd: repoRoot, env, stdout: process.stdout, stderr };

    try {
      const status = await verifyHookInstalled(env);
      expect(status.installed).toBe(false);
      const expected = {
        code: c.code,
        stage: c.stage,
        message: [c.intro, `Hook check failed: ${status.reason ?? "unknown"}.`, ...c.tail, hookRefusalRetryProtocol(env)].join(" "),
        details: hookRefusalDetails(status),
      };

      __resetHookMissingWarning();
      let actual: { code: string; stage: string; message: string; details?: Record<string, unknown> };
      if (c.persisted) {
        await c.run(context);
        const store = new JobStore(resolvePluginPaths(env));
        try {
          const { repoId } = await resolveRepoIdentity(repoRoot);
          const row = store.findLatestJob({ repoId, commandType: "rescue" })!;
          expect(row.status).toBe("failed");
          actual = row.error!;
        } finally {
          store.close();
        }
      } else {
        const error = await c.run(context).then(() => undefined, (caught: unknown) => caught);
        expect(error).toBeInstanceOf(RuntimeError);
        const runtimeError = error as RuntimeError;
        actual = { code: runtimeError.code, stage: runtimeError.stage, message: runtimeError.message, details: runtimeError.details };
      }
      expect(actual).toEqual(expected);
      expect(stderrChunks.join("")).toBe(formatHookMissingWarning(status, c.warnLabel));
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(kimiHome);
      await cleanupTestPath(repoRoot);
    }
  });
});
