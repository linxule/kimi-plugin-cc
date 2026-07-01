import { describe, expect, test } from "bun:test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { resolveRepoIdentity } from "../../runtime/git.js";
import { JobStore } from "../../runtime/job-store.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import {
  cleanupTestPath,
  createTestPluginDataRoot,
} from "../helpers/test-env.js";

const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli-v1.ts");
const hookScriptPath = path.join(process.cwd(), "runtime/hooks/review-gate-stop.ts");

describe("review gate stop hook", () => {
  test("disabled gate returns an allow result without invoking Kimi", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("review-gate-disabled");

    try {
      const transcriptPath = path.join(pluginDataRoot, "transcript.jsonl");
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "Do the thing." }] } }),
          JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "I fixed it." }] } }),
        ].join("\n") + "\n",
        "utf8",
      );

      const output = await invokeHook(
        {
          ...process.env,
          CLAUDE_PLUGIN_DATA: pluginDataRoot,
          KIMI_PLUGIN_CC_KIMI_BIN: "bun",
          KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
          KIMI_PLUGIN_CC_MOCK_SCENARIO: "review-gate-block",
        },
        {
          cwd: process.cwd(),
          hook_event_name: "Stop",
          stop_hook_active: false,
          transcript_path: transcriptPath,
        },
      );

      expect(output).toEqual({ systemMessage: "review-gate skipped: disabled" });
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("enabled gate blocks stop on BLOCK plus high confidence", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("review-gate-block");
    const kimiHome = await createTestPluginDataRoot("review-gate-kimi-home");
    const invocationPath = path.join(pluginDataRoot, "review-gate-invocation.jsonl");
    const sessionId = "session_cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    try {
      const statePath = await seedKimiSession(kimiHome, sessionId);
      const paths = resolvePluginPaths({
        ...process.env,
        CLAUDE_PLUGIN_DATA: pluginDataRoot,
      });
      await mkdir(paths.pluginRoot, { recursive: true });
      await writeFile(paths.configPath, `${JSON.stringify({ reviewGateEnabled: true }, null, 2)}\n`, "utf8");

      const transcriptPath = path.join(pluginDataRoot, "transcript.jsonl");
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "Fix the failing path." }] } }),
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "I fixed the issue and everything is complete." }] },
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      const output = await invokeHook(
        {
          ...process.env,
          CLAUDE_PLUGIN_DATA: pluginDataRoot,
          KIMI_PLUGIN_CC_KIMI_BIN: "bun",
          KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
          KIMI_PLUGIN_CC_MOCK_SCENARIO: "review-gate-block",
          KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH: invocationPath,
          KIMI_PLUGIN_CC_MOCK_SESSION_ID: sessionId,
          KIMI_CODE_HOME: kimiHome,
        },
        {
          cwd: process.cwd(),
          hook_event_name: "Stop",
          stop_hook_active: false,
          transcript_path: transcriptPath,
        },
      );

      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as {
        argv: string[];
        env: { KIMI_PLUGIN_CC_CMD: string | null };
      };

      expect(output.decision).toBe("block");
      expect(output.reason).toContain("Kimi review gate blocked stop");
      expect(output.reason).toContain("Requested fix still missing");
      // v1.0: review_gate command label propagates via env, not argv.
      // The agent-file / --session flags are gone — kimi-code does not
      // load YAML agent profiles and assigns its own session id.
      expect(invocation.env.KIMI_PLUGIN_CC_CMD).toBe("review_gate");
      expect(invocation.argv).toContain("--output-format");
      expect(invocation.argv).toContain("stream-json");
      expect(invocation.argv).toContain("-m");
      expect(invocation.argv).toContain("kimi-for-coding");
      // v1.0 alpha.4: review-gate sets `thinking: false` in the options
      // bag for future kimi-code support, but the runtime MUST NOT emit
      // `--no-thinking` in argv — kimi-code 0.1.1 has no such flag and
      // crashes on unknown options. (Round 2 Codex finding.)
      expect(invocation.argv).not.toContain("--no-thinking");

      const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
      expect(state.title).toBe("New Session");
      expect(state.isCustomTitle).toBe(false);

      const repoIdentity = await resolveRepoIdentity(process.cwd());
      const store = new JobStore(paths);
      try {
        const latest = store.findLatestJob({
          repoId: repoIdentity.repoId,
          commandType: "review_gate",
        });
        expect(latest?.status).toBe("completed");
        expect(latest?.summary).toContain("requested work was complete");
        expect(latest?.final_output_path).toBeTruthy();
      } finally {
        store.close();
      }
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(kimiHome);
    }
  });

  test("enabled gate accepts Codex-style inline last assistant message", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("review-gate-codex-inline");

    try {
      const paths = resolvePluginPaths({
        ...process.env,
        PLUGIN_DATA: pluginDataRoot,
      });
      await mkdir(paths.pluginRoot, { recursive: true });
      await writeFile(paths.configPath, `${JSON.stringify({ reviewGateEnabled: true }, null, 2)}\n`, "utf8");

      const output = await invokeHook(
        {
          ...process.env,
          PLUGIN_DATA: pluginDataRoot,
          KIMI_PLUGIN_CC_KIMI_BIN: "bun",
          KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
          KIMI_PLUGIN_CC_MOCK_SCENARIO: "review-gate-block",
        },
        {
          cwd: process.cwd(),
          hook_event_name: "Stop",
          stop_hook_active: false,
          last_user_message: "Fix the failing path.",
          last_assistant_message: {
            role: "assistant",
            content: [{ type: "text", text: "I fixed the issue and everything is complete." }],
          },
        },
      );

      expect(output.decision).toBe("block");
      expect(output.reason).toContain("Kimi review gate blocked stop");
      expect(output.reason).toContain("Requested fix still missing");
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("enabled gate allows stop with a warning on medium-confidence block output", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("review-gate-medium");

    try {
      const paths = resolvePluginPaths({
        ...process.env,
        CLAUDE_PLUGIN_DATA: pluginDataRoot,
      });
      await mkdir(paths.pluginRoot, { recursive: true });
      await writeFile(paths.configPath, `${JSON.stringify({ reviewGateEnabled: true }, null, 2)}\n`, "utf8");

      const transcriptPath = path.join(pluginDataRoot, "transcript.jsonl");
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "Double-check this answer." }] } }),
          JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "This looks correct to me." }] } }),
        ].join("\n") + "\n",
        "utf8",
      );

      const output = await invokeHook(
        {
          ...process.env,
          CLAUDE_PLUGIN_DATA: pluginDataRoot,
          KIMI_PLUGIN_CC_KIMI_BIN: "bun",
          KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
          KIMI_PLUGIN_CC_MOCK_SCENARIO: "review-gate-block-medium",
        },
        {
          cwd: process.cwd(),
          hook_event_name: "Stop",
          stop_hook_active: false,
          transcript_path: transcriptPath,
        },
      );

      expect(output.decision).toBeUndefined();
      expect(output.systemMessage).toContain("noted concerns but allowed stop");
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("enabled gate allows stop with a warning on malformed output", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("review-gate-malformed");

    try {
      const paths = resolvePluginPaths({
        ...process.env,
        CLAUDE_PLUGIN_DATA: pluginDataRoot,
      });
      await mkdir(paths.pluginRoot, { recursive: true });
      await writeFile(paths.configPath, `${JSON.stringify({ reviewGateEnabled: true }, null, 2)}\n`, "utf8");

      const transcriptPath = path.join(pluginDataRoot, "transcript.jsonl");
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "Check this answer carefully." }] } }),
          JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "I am fully done." }] } }),
        ].join("\n") + "\n",
        "utf8",
      );

      const output = await invokeHook(
        {
          ...process.env,
          CLAUDE_PLUGIN_DATA: pluginDataRoot,
          KIMI_PLUGIN_CC_KIMI_BIN: "bun",
          KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
          KIMI_PLUGIN_CC_MOCK_SCENARIO: "review-gate-malformed",
        },
        {
          cwd: process.cwd(),
          hook_event_name: "Stop",
          stop_hook_active: false,
          transcript_path: transcriptPath,
        },
      );

      expect(output.decision).toBeUndefined();
      expect(output.systemMessage).toBe("Kimi review gate returned malformed output; allowing stop.");
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("enabled gate returns an empty result when the transcript has no assistant message", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("review-gate-no-assistant");

    try {
      const paths = resolvePluginPaths({
        ...process.env,
        CLAUDE_PLUGIN_DATA: pluginDataRoot,
      });
      await mkdir(paths.pluginRoot, { recursive: true });
      await writeFile(paths.configPath, `${JSON.stringify({ reviewGateEnabled: true }, null, 2)}\n`, "utf8");

      const transcriptPath = path.join(pluginDataRoot, "transcript.jsonl");
      await writeFile(
        transcriptPath,
        `${JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "Start the work." }] } })}\n`,
        "utf8",
      );

      const output = await invokeHook(
        {
          ...process.env,
          CLAUDE_PLUGIN_DATA: pluginDataRoot,
          KIMI_PLUGIN_CC_KIMI_BIN: "bun",
          KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
          KIMI_PLUGIN_CC_MOCK_SCENARIO: "review-gate-block",
        },
        {
          cwd: process.cwd(),
          hook_event_name: "Stop",
          stop_hook_active: false,
          transcript_path: transcriptPath,
        },
      );

      expect(output).toEqual({ systemMessage: "review-gate skipped: no assistant message" });
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });
});

async function invokeHook(
  env: NodeJS.ProcessEnv,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const child = spawn("node", ["--import", "tsx", hookScriptPath], {
    cwd: process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.stdin.end(`${JSON.stringify(payload)}\n`);

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });

  if (exitCode !== 0) {
    throw new Error(stderr || `hook exited with code ${String(exitCode)}`);
  }

  return JSON.parse(stdout.trim() || "{}") as Record<string, unknown>;
}

async function seedKimiSession(kimiHome: string, sessionId: string): Promise<string> {
  const sessionDir = path.join(kimiHome, "sessions", "wd_repo_123", sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(kimiHome, "session_index.jsonl"),
    `${JSON.stringify({
      sessionId,
      sessionDir,
      workDir: process.cwd(),
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
