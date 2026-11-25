import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { runAsk } from "../../runtime/commands/ask.js";
import { runRescue } from "../../runtime/commands/rescue.js";
import { runReview } from "../../runtime/commands/review.js";
import { runSwarm } from "../../runtime/commands/swarm.js";
import { resolvePluginPaths } from "../../runtime/paths.js";
import { describeReadScope, parseJobReadScope, resolveReadScope, serializeReadScope } from "../../runtime/read-scope.js";
import { renderManagedJobOutput, renderTerminalJobArtifact } from "../../runtime/render.js";
import {
  hasHelpFlag,
  parseAskArgs,
  parsePursueArgs,
  parseRescueArgs,
  parseReviewArgs,
  parseSwarmArgs,
} from "../../runtime/parsing.js";
import type { CommandContext } from "../../runtime/types.js";
import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";

const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli-v1.ts");

function makeContext(cwd: string, env: NodeJS.ProcessEnv): CommandContext {
  return { cwd, env, stdout: process.stdout, stderr: process.stderr };
}

function makeMockEnv(pluginDataRoot: string, scenario: string, invocationPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginDataRoot,
    KIMI_CODE_HOME: path.join(pluginDataRoot, "kimi-home"),
    KIMI_PLUGIN_CC_KIMI_BIN: "bun",
    KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
    KIMI_PLUGIN_CC_MOCK_SCENARIO: scenario,
    KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH: invocationPath,
    KIMI_PLUGIN_CC_NODE_BIN: "node",
    KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
  };
}

async function invocationEnv(invocationPath: string): Promise<Record<string, unknown>> {
  const lines = (await readFile(invocationPath, "utf8")).trim().split("\n");
  return (JSON.parse(lines.at(-1)!) as { env: Record<string, unknown> }).env;
}

/** No job row can exist when the store was never opened. */
function storeCreated(env: NodeJS.ProcessEnv): boolean {
  return existsSync(resolvePluginPaths(env).stateDbPath);
}

describe("S1 scope flags: parsing", () => {
  test("read-only parsers accept repeatable --read-root and --network", () => {
    expect(parseAskArgs(["--read-root", "/a", "--read-root", "/b", "--network", "q"]))
      .toMatchObject({ readRoots: ["/a", "/b"], network: true, prompt: "q" });
    expect(parseReviewArgs(["--network", "focus"], "challenge")).toMatchObject({ network: true, focus: "focus" });
    expect(parseReviewArgs(["--read-root", "/a"])).toMatchObject({ readRoots: ["/a"] });
    expect(parseSwarmArgs(["--read-root", "/a", "--network", "audit"]))
      .toMatchObject({ readRoots: ["/a"], network: true, objective: "audit" });
  });

  test("without the flags the parsed shape is unchanged", () => {
    expect("readRoots" in parseAskArgs(["q"])).toBe(false);
    expect("network" in parseAskArgs(["q"])).toBe(false);
    expect("readRoots" in parseReviewArgs([])).toBe(false);
    expect("network" in parseSwarmArgs(["x"])).toBe(false);
  });

  test("write-capable operations reject the scope flags with INVALID_ARGS", () => {
    for (const parse of [
      () => parseRescueArgs(["--read-root", "/a", "task"]),
      () => parseRescueArgs(["--network", "task"]),
      () => parsePursueArgs(["--network", "goal"]),
      () => parsePursueArgs(["--read-root", "/a", "goal"]),
      () => parseSwarmArgs(["--write", "--network", "edit"]),
      () => parseSwarmArgs(["--read-root", "/a", "--write", "edit"]),
    ]) {
      expect(parse).toThrow(expect.objectContaining({ code: "INVALID_ARGS", message: expect.stringContaining("read-only operations") }));
    }
  });

  test("--read-root needs a value and is value-taking for --help detection", () => {
    expect(() => parseAskArgs(["--read-root"])).toThrow(expect.objectContaining({ code: "INVALID_ARGS" }));
    expect(() => parseAskArgs(["--read-root", "--network", "q"])).toThrow(expect.objectContaining({ code: "INVALID_ARGS" }));
    expect(hasHelpFlag(["--read-root", "/a", "-h"])).toBe(true);
    expect(hasHelpFlag(["--read-root", "-h"])).toBe(true);
  });
});

describe("S1 scope flags: validation and persistence", () => {
  test("roots must be absolute existing directories; realpaths are stored", async () => {
    const root = await createTestPluginDataRoot("read-scope-validate");
    try {
      await mkdir(path.join(root, "dir"));
      await writeFile(path.join(root, "file"), "x");
      await expect(resolveReadScope(["relative"], false, "ask.parse")).rejects.toMatchObject({ code: "INVALID_ARGS" });
      await expect(resolveReadScope([path.join(root, "missing")], false, "ask.parse")).rejects.toMatchObject({ code: "INVALID_ARGS" });
      await expect(resolveReadScope([path.join(root, "file")], false, "ask.parse")).rejects.toMatchObject({ code: "INVALID_ARGS" });
      const real = await realpath(path.join(root, "dir"));
      const scope = await resolveReadScope([path.join(root, "dir", "."), path.join(root, "dir")], true, "ask.parse");
      expect(scope).toEqual({ readRoots: [real], network: true });
      expect(await resolveReadScope(undefined, undefined, "ask.parse")).toBeUndefined();
      expect(parseJobReadScope(serializeReadScope(scope))).toEqual(scope);
      expect(serializeReadScope(undefined)).toBeNull();
      expect(() => parseJobReadScope("{\"read_roots\":\"x\"}")).toThrow(expect.objectContaining({ code: "READ_SCOPE_INVALID" }));
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("the rendered header shows a non-default scope and leaves default output unchanged", () => {
    const job = { job_id: "j", command_type: "ask", kimi_session_id: null } as never;
    expect(renderManagedJobOutput(job, "Answer.").rendered).toBe("Answer.");
    const scoped = { ...(job as object), read_scope: serializeReadScope({ readRoots: ["/a", "/b"], network: true }) } as never;
    const rendered = renderManagedJobOutput(scoped, "Answer.");
    expect(rendered.output).toBe("Scope: reads confined to the workspace and 2 read roots (/a, /b); network on\n\nAnswer.");
    expect(rendered.rendered).toBe(rendered.output as string);
    expect(describeReadScope({ readRoots: [], network: true })).toBe("Scope: reads confined to the workspace; network on");
  });
});

describe("S1 scope flags: commands", () => {
  test("invalid read roots refuse before any job is created", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("read-scope-refuse");
    const repoRoot = await createGitRepoFixture("read-scope-refuse-repo");
    const env = makeMockEnv(pluginDataRoot, "ask-success", path.join(pluginDataRoot, "invocation.jsonl"));
    try {
      const missing = path.join(pluginDataRoot, "missing");
      await expect(runAsk(["--read-root", missing, "q"], makeContext(repoRoot, env))).rejects.toMatchObject({ code: "INVALID_ARGS" });
      await expect(runReview(["--read-root", missing], makeContext(repoRoot, env), "review")).rejects.toMatchObject({ code: "INVALID_ARGS" });
      await expect(runSwarm(["--read-root", "relative", "x"], makeContext(repoRoot, env))).rejects.toMatchObject({ code: "INVALID_ARGS" });
      await expect(runRescue(["--network", "t"], makeContext(repoRoot, env))).rejects.toMatchObject({ code: "INVALID_ARGS" });
      expect(storeCreated(env)).toBe(false);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  }, 30_000);

  test("foreground ask exports this call's scope and shows it; an ambient network value is scrubbed", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("read-scope-ask");
    const repoRoot = await createGitRepoFixture("read-scope-ask-repo");
    const invocationPath = path.join(pluginDataRoot, "invocation.jsonl");
    const env = { ...makeMockEnv(pluginDataRoot, "ask-success", invocationPath), KIMI_PLUGIN_CC_NETWORK: "1",
      KIMI_PLUGIN_CC_READ_ROOTS: "[\"/\"]" };
    try {
      const plain = await runAsk(["q"], makeContext(repoRoot, env));
      expect(plain).toBe("Ask answer from mock Kimi.");
      const plainEnv = await invocationEnv(invocationPath);
      expect("KIMI_PLUGIN_CC_NETWORK" in plainEnv).toBe(false);
      expect("KIMI_PLUGIN_CC_READ_ROOTS" in plainEnv).toBe(false);

      const extra = await realpath(pluginDataRoot);
      const scoped = await runAsk(["--network", "--read-root", pluginDataRoot, "q"], makeContext(repoRoot, env));
      expect(scoped).toBe(`Scope: reads confined to the workspace and 1 read root (${extra}); network on\n\nAsk answer from mock Kimi.`);
      const scopedEnv = await invocationEnv(invocationPath);
      expect(JSON.parse(scopedEnv.KIMI_PLUGIN_CC_READ_ROOTS as string)).toEqual([await realpath(repoRoot), extra]);
      expect(scopedEnv.KIMI_PLUGIN_CC_NETWORK).toBe("1");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  }, 30_000);

  test("background ask workers apply the scope of the current invocation, not ambient or earlier values", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("read-scope-ask-bg");
    const repoRoot = await createGitRepoFixture("read-scope-ask-bg-repo");
    const invocationPath = path.join(pluginDataRoot, "invocation.jsonl");
    const env = { ...makeMockEnv(pluginDataRoot, "ask-success", invocationPath), KIMI_PLUGIN_CC_NETWORK: "1" };
    try {
      const scoped = await runAsk(["--background", "--wait", "--network", "q"], makeContext(repoRoot, env));
      expect(scoped).toBe("Scope: reads confined to the workspace; network on\n\nAsk answer from mock Kimi.\n");
      const scopedEnv = await invocationEnv(invocationPath);
      expect(JSON.parse(scopedEnv.KIMI_PLUGIN_CC_READ_ROOTS as string)).toEqual([await realpath(repoRoot)]);
      expect(scopedEnv.KIMI_PLUGIN_CC_NETWORK).toBe("1");

      // A resumed turn without flags runs with the default scope.
      const resumed = await runAsk(["--background", "--wait", "-r", "follow-up"], makeContext(repoRoot, env));
      expect(resumed).toBe("Ask answer from mock Kimi.\n");
      const resumedEnv = await invocationEnv(invocationPath);
      expect("KIMI_PLUGIN_CC_NETWORK" in resumedEnv).toBe(false);
      expect("KIMI_PLUGIN_CC_READ_ROOTS" in resumedEnv).toBe(false);
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  }, 60_000);

  test("review exports the scope with its own label", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("read-scope-review");
    const repoRoot = await createGitRepoFixture("read-scope-review-repo");
    const invocationPath = path.join(pluginDataRoot, "invocation.jsonl");
    const env = makeMockEnv(pluginDataRoot, "challenge-success", invocationPath);
    try {
      const output = await runReview(["--network"], makeContext(repoRoot, env), "challenge");
      expect(output.startsWith("Scope: reads confined to the workspace; network on\n\n")).toBe(true);
      const captured = await invocationEnv(invocationPath);
      expect(captured.KIMI_PLUGIN_CC_CMD).toBe("challenge");
      expect(captured.KIMI_PLUGIN_CC_NETWORK).toBe("1");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  }, 30_000);

  test("read-only swarm exports the scope to its spawn and shows it", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("read-scope-swarm");
    const repoRoot = await createGitRepoFixture("read-scope-swarm-repo");
    const invocationPath = path.join(pluginDataRoot, "invocation.jsonl");
    const env = makeMockEnv(pluginDataRoot, "rescue-success", invocationPath);
    try {
      const extra = await realpath(pluginDataRoot);
      const output = await runSwarm(["--network", "--read-root", pluginDataRoot, "audit", "modules"], makeContext(repoRoot, env));
      expect(output.startsWith(`Scope: reads confined to the workspace and 1 read root (${extra}); network on\n\n`)).toBe(true);
      const captured = await invocationEnv(invocationPath);
      expect(captured.KIMI_PLUGIN_CC_CMD).toBe("swarm");
      expect(JSON.parse(captured.KIMI_PLUGIN_CC_READ_ROOTS as string)).toEqual([await realpath(repoRoot), extra]);
      expect(captured.KIMI_PLUGIN_CC_NETWORK).toBe("1");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  }, 30_000);

  test("--network is refused on an uncertified release; --read-root alone still runs there", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("read-scope-uncertified");
    const repoRoot = await createGitRepoFixture("read-scope-uncertified-repo");
    const invocationPath = path.join(pluginDataRoot, "invocation.jsonl");
    const env = { ...makeMockEnv(pluginDataRoot, "ask-success", invocationPath), KIMI_PLUGIN_CC_MOCK_VERSION: "2.8.0",
      KIMI_PLUGIN_CC_MOCK_RECOVERABLE_V2: "1", KIMI_PLUGIN_CC_STRICT_VERSIONS: "" };
    try {
      await expect(runAsk(["--network", "q"], makeContext(repoRoot, env))).rejects.toMatchObject({
        code: "INVALID_ARGS", message: expect.stringContaining("uncertified"),
      });
      await expect(runReview(["--network"], makeContext(repoRoot, env), "review")).rejects.toMatchObject({ code: "INVALID_ARGS" });
      const confined = await runAsk(["--read-root", pluginDataRoot, "q"], makeContext(repoRoot, env));
      expect(confined).toContain("Scope: reads confined to the workspace and 1 read root");
      expect(confined).toContain("not certified");
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  }, 30_000);

  test("terminal artifacts list a non-default scope", () => {
    const job = { job_id: "j", command_type: "ask", status: "failed", summary: "s", kimi_session_id: null, error: null,
      read_scope: serializeReadScope({ readRoots: [], network: true }) } as never;
    expect(renderTerminalJobArtifact(job)).toContain("- Scope: reads confined to the workspace; network on");
    expect(renderTerminalJobArtifact({ ...(job as object), read_scope: undefined } as never)).not.toContain("Scope:");
  });
});
