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

const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli.ts");
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

      expect(output).toEqual({});
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("enabled gate blocks stop on BLOCK plus high confidence", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("review-gate-block");
    const invocationPath = path.join(pluginDataRoot, "review-gate-invocation.jsonl");

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
        },
        {
          cwd: process.cwd(),
          hook_event_name: "Stop",
          stop_hook_active: false,
          transcript_path: transcriptPath,
        },
      );

      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { argv: string[] };
      const sessionIndex = invocation.argv.indexOf("--session");
      const agentIndex = invocation.argv.indexOf("--agent-file");

      expect(output.decision).toBe("block");
      expect(output.reason).toContain("Kimi review gate blocked stop");
      expect(output.reason).toContain("Requested fix still missing");
      expect(sessionIndex).toBeGreaterThan(-1);
      expect(invocation.argv[sessionIndex + 1]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(invocation.argv[agentIndex + 1]).toBe(
        path.join(process.cwd(), "runtime/agents/review-gate.yaml"),
      );
      expect(invocation.argv).toContain("--model");
      expect(invocation.argv).toContain("kimi-for-coding");
      expect(invocation.argv).toContain("--no-thinking");

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

      expect(output).toEqual({});
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
