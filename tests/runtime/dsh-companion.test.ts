import { describe, expect, mock, test } from "bun:test";
import path from "node:path";

import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { SubagentStartRequest } from "@deepseek-ai/dsh-subagent";
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";

import {
  DSH_COMPANION_OPERATIONS,
  companionArgv,
  companionEnvironment,
  companionTextTask,
  runCompanionCommand,
  startCompanionRun,
  type DshCompanionSpec,
} from "../../runtime/dsh/companion.js";
import { defaultDshDataRoot } from "../../runtime/dsh/index.js";

const repoRoot = path.resolve(import.meta.dir, "..", "..");

function reader(text: string, lossy = false) {
  return {
    readFrom(fromByte: number) {
      return {
        text: lossy ? text : Buffer.from(text).subarray(fromByte).toString(),
        nextOffset: Buffer.byteLength(text),
        lossy,
      };
    },
  };
}

function fakeHandle(options: {
  outcome?: SubprocessOutcome;
  error?: Error;
  stdout?: string;
  stderr?: string;
  lossy?: boolean;
} = {}) {
  const outcome = options.outcome ?? { exitCode: 0, signal: null };
  const terminate = mock(() => {});
  const waitForExit = mock(async () => true);
  const handle: SubprocessHandle = {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: {
      stdout: reader(options.stdout ?? "", options.lossy),
      stderr: reader(options.stderr ?? "", options.lossy),
    },
    done: options.error ? Promise.reject(options.error) : Promise.resolve(outcome),
    terminate,
    waitForExit,
  };
  return { handle, terminate, waitForExit };
}

function specWith(handle: SubprocessHandle): DshCompanionSpec & { spawned: SubprocessSpawnSpec[] } {
  const spawned: SubprocessSpawnSpec[] = [];
  return {
    companionPath: "/plugin/dist/companion.js",
    dataRoot: "/dsh/plugin-data/kimi-plugin-cc",
    env: { EXPLICIT: "yes" },
    disposeGraceMs: 3000,
    maxOutputBytes: 1024,
    spawned,
    spawn: (spec) => {
      spawned.push(spec);
      return handle;
    },
  };
}

function request(signal = new AbortController().signal): SubagentStartRequest {
  return {
    cwd: repoRoot,
    prompt: [{ type: "text", text: "explain --background literally" }],
    parent: {} as SubagentStartRequest["parent"],
    signal,
  };
}

describe("DSH companion argument and environment boundaries", () => {
  test("all seven operations map to the exact companion command with a flag terminator", () => {
    const expected = {
      ask: ["ask", "--fresh"],
      review: ["review"],
      challenge: ["task", "challenge"],
      rescue: ["task", "rescue", "--fresh"],
      pursue: ["task", "pursue"],
      swarm: ["task", "swarm"],
      "swarm-write": ["task", "swarm", "--write"],
    } as const;
    for (const operation of DSH_COMPANION_OPERATIONS) {
      expect(companionArgv(operation, "--background", "/plugin/dist/companion.js", "/node")).toEqual([
        "/node", "/plugin/dist/companion.js", ...expected[operation], "--", "--background",
      ]);
    }
  });

  test("profile model, thinking, budget, and review-base options precede the task", () => {
    expect(companionArgv("challenge", "focus", "/plugin/dist/companion.js", "/node", {
      model: "provider/model",
      thinkingEffort: "high",
      budget: "1h",
      reviewBase: "main",
    })).toEqual([
      "/node", "/plugin/dist/companion.js", "task", "challenge",
      "-m", "provider/model", "--thinking", "high", "--budget", "1h", "--base", "main", "--", "focus",
    ]);
  });

  test("provider-owned environment cannot be replaced by explicit child env", () => {
    const env = companionEnvironment("/dsh/data", "/workspace", {
      KIMI_PLUGIN_CC_DATA: "/elsewhere",
      KIMI_PLUGIN_CC_HOST_ID: "codex",
      KIMI_PLUGIN_CC_NODE_BIN: "/other-node",
      KIMI_PLUGIN_CC_WORKSPACE_CWD: "/other-workspace",
      KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
      KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: "1",
      KIMI_CODE_TRUST_WORKSPACE: "1",
      CLAUDE_PLUGIN_DATA: "/claude-data",
      CUSTOM: "preserved",
    }, "/node");
    expect(env).toMatchObject({
      CUSTOM: "preserved",
      KIMI_PLUGIN_CC_DATA: "/dsh/data",
      KIMI_PLUGIN_CC_HOST_ID: "dsh",
      KIMI_PLUGIN_CC_NODE_BIN: "/node",
      KIMI_PLUGIN_CC_WORKSPACE_CWD: "/workspace",
    });
    for (const name of [
      "KIMI_PLUGIN_CC_SKIP_HOOK_CHECK",
      "KIMI_PLUGIN_CC_SKIP_VERSION_PROBE",
      "KIMI_CODE_TRUST_WORKSPACE",
      "CLAUDE_PLUGIN_DATA",
      "PLUGIN_DATA",
      "CLAUDE_PLUGIN_ROOT",
      "PLUGIN_ROOT",
      "KIMI_PLUGIN_CC_HOOK_SCRIPT",
      "KIMI_PLUGIN_CC_WORKSPACE_ROOT",
    ]) {
      expect(env).toHaveProperty(name, undefined);
    }
  });

  test("data root derives from DSH_HOME and honors only an absolute explicit override", () => {
    expect(defaultDshDataRoot({ DSH_HOME: "/isolated/dsh" })).toBe(
      path.join("/isolated/dsh", "plugin-data", "kimi-plugin-cc"),
    );
    expect(defaultDshDataRoot({ DSH_HOME: "/isolated/dsh", KIMI_PLUGIN_CC_DATA: "/selected" })).toBe("/selected");
    expect(() => defaultDshDataRoot({ DSH_HOME: "relative" })).toThrow("DSH_HOME must be absolute");
    expect(() => defaultDshDataRoot({ KIMI_PLUGIN_CC_DATA: "relative" })).toThrow("KIMI_PLUGIN_CC_DATA must be absolute");
  });

  test("only non-empty text tasks cross the provider boundary", () => {
    expect(companionTextTask([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ])).toBe("first\n\nsecond");
    expect(() => companionTextTask([])).toThrow("only text");
    expect(() => companionTextTask([{ type: "text", text: "  " }])).toThrow("must not be empty");
    expect(() => companionTextTask([{ type: "image", data: "x" } as unknown as ContentBlock])).toThrow("only text");
  });
});

describe("DSH companion lifecycle", () => {
  test("successful stdout becomes the completed child answer and disposal is idempotent", async () => {
    const { handle, terminate, waitForExit } = fakeHandle({ stdout: "answer\n" });
    const spec = specWith(handle);
    const run = await startCompanionRun(request(), "ask", spec);
    await expect(run.result).resolves.toEqual({
      output: [{ type: "text", text: "answer" }],
      stopReason: "completed",
    });
    expect(spec.spawned[0]?.argv.slice(0, 3)).toEqual([process.execPath, "/plugin/dist/companion.js", "ask"]);
    expect(spec.spawned[0]?.cwd).toBe(repoRoot);
    await run.dispose();
    await run.dispose();
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(waitForExit).toHaveBeenCalledTimes(1);
  });

  test("nonzero exits and truncated stdout become safe errors without returning partial prose", async () => {
    const failure = fakeHandle({ outcome: { exitCode: 7, signal: null }, stdout: "partial" });
    const failed = await startCompanionRun(request(), "review", specWith(failure.handle));
    await expect(failed.result).resolves.toEqual({
      output: [],
      diagnostic: "Kimi review companion failed (exit code: 7; signal: none)",
      stopReason: "error",
    });
    await failed.dispose();

    const truncation = fakeHandle({ stdout: "tail", lossy: true });
    const truncated = await startCompanionRun(request(), "ask", specWith(truncation.handle));
    const result = await truncated.result;
    expect(result.stopReason).toBe("error");
    expect(result.output).toEqual([]);
    expect(result.diagnostic).toContain("stdout truncated");
    expect(result.diagnostic).not.toContain("explain --background");
    await truncated.dispose();
  });

  test("process rejection settles as an error rather than rejecting the published result", async () => {
    const { handle } = fakeHandle({ error: new Error("spawn transport failed") });
    const run = await startCompanionRun(request(), "ask", specWith(handle));
    await expect(run.result).resolves.toMatchObject({
      stopReason: "error",
      diagnostic: "Kimi ask companion failed before producing a terminal exit",
    });
    await run.dispose();
  });

  test("abort before startup spawns nothing; abort after startup settles and tears down", async () => {
    const controller = new AbortController();
    controller.abort();
    const { handle } = fakeHandle();
    const spec = specWith(handle);
    await expect(startCompanionRun(request(controller.signal), "ask", spec)).rejects.toThrow("before companion startup");
    expect(spec.spawned).toHaveLength(0);

    const active = new AbortController();
    let finish!: (outcome: SubprocessOutcome) => void;
    const pending = fakeHandle();
    const pendingSpec = specWith(pending.handle);
    const done = new Promise<SubprocessOutcome>((resolve) => { finish = resolve; });
    pendingSpec.spawn = (spawnSpec) => {
      spawnSpec.signal?.addEventListener("abort", () => finish({ exitCode: null, signal: "SIGTERM" }), { once: true });
      return { ...pending.handle, done };
    };
    const run = await startCompanionRun(request(active.signal), "ask", pendingSpec);
    active.abort();
    await expect(run.result).resolves.toEqual({ output: [], stopReason: "aborted" });
    await run.dispose();
  });
});

describe("DSH human commands", () => {
  test("companion commands retain bounded stdout, stderr, and terminal facts", async () => {
    const { handle } = fakeHandle({
      outcome: { exitCode: 2, signal: null },
      stdout: "status",
      stderr: "diagnostic",
    });
    const result = await runCompanionCommand(["setup", "--check"], repoRoot, specWith(handle));
    expect(result).toEqual({
      exitCode: 2,
      signal: null,
      stdout: "status",
      stderr: "diagnostic",
      truncated: false,
    });
  });

  test("command process failure terminates the managed range before rejecting", async () => {
    const { handle, terminate, waitForExit } = fakeHandle({ error: new Error("process failed") });
    await expect(runCompanionCommand(["status"], repoRoot, specWith(handle))).rejects.toThrow("process failed");
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(waitForExit).toHaveBeenCalledTimes(1);
  });
});
