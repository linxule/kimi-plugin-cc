import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";

import { companionHelp } from "../../runtime/help.js";
import { routeSurfaceAliases } from "../../runtime/surface-routing.js";
import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";

const companionPath = path.join(process.cwd(), "runtime/companion.ts");
const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli-v1.ts");

describe("surface selector routing", () => {
  test("a leading --write turns ask into task rescue", () => {
    expect(routeSurfaceAliases(["ask", "--write", "fix it"])).toEqual(["task", "rescue", "fix it"]);
    expect(routeSurfaceAliases(["ask", "--background", "--write", "-m", "k2", "--", "fix"]))
      .toEqual(["task", "rescue", "--background", "-m", "k2", "--", "fix"]);
    expect(routeSurfaceAliases(["ask", "-r", "--write"])).toEqual(["task", "rescue", "-r"]);
  });

  test("a leading --challenge turns review into task challenge", () => {
    expect(routeSurfaceAliases(["review", "--challenge", "--base", "main", "focus"]))
      .toEqual(["task", "challenge", "--base", "main", "focus"]);
  });

  test("selectors in prose, after --, or as a flag value never change the operation", () => {
    for (const argv of [
      ["ask", "what", "does", "--write", "do"],
      ["ask", "--", "--write", "this"],
      ["ask", "-m", "--write", "x"],
      ["review", "--", "--challenge"],
      ["review", "focus", "--challenge"],
      ["review", "--base", "--challenge"],
    ]) {
      expect(routeSurfaceAliases(argv)).toEqual(argv);
    }
  });

  test("selectors only apply to their own command", () => {
    for (const argv of [
      ["ask", "--challenge", "x"],
      ["review", "--write"],
      ["task", "rescue", "--write", "x"],
      ["task", "swarm", "--write", "x"],
      ["status", "--write"],
    ]) {
      expect(routeSurfaceAliases(argv)).toEqual(argv);
    }
  });

  test("help follows the routed operation", () => {
    expect(companionHelp(routeSurfaceAliases(["ask", "--write", "--help"]))).toContain("Usage: companion.sh task rescue");
    expect(companionHelp(routeSurfaceAliases(["review", "--challenge", "-h"]))).toContain("Usage: companion.sh task challenge");
    expect(companionHelp(["ask", "--help"])).toContain("A leading --write runs the write-capable task rescue instead.");
    expect(companionHelp(["review", "--help"])).toContain("A leading --challenge runs task challenge instead.");
  });
});

describe("companion entry point routing", () => {
  async function withFixture(run: (env: NodeJS.ProcessEnv) => Promise<void>): Promise<void> {
    const pluginDataRoot = await createTestPluginDataRoot("surface-routing");
    const repoRoot = await createGitRepoFixture("surface-routing-repo");
    try {
      await run({
        ...process.env,
        CLAUDE_PLUGIN_DATA: pluginDataRoot,
        KIMI_PLUGIN_CC_KIMI_BIN: "bun",
        KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
        KIMI_PLUGIN_CC_MOCK_SCENARIO: "ask-success",
        KIMI_PLUGIN_CC_WORKSPACE_CWD: repoRoot,
        KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
      });
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
    }
  }

  async function latestKind(env: NodeJS.ProcessEnv): Promise<string> {
    const result = await runCompanion(["result", "--json"], env);
    expect(result.exitCode, result.stderr).toBe(0);
    return JSON.parse(result.stdout).kind;
  }

  test("ask --write runs rescue; ask with --write as prose stays ask", async () => {
    await withFixture(async (env) => {
      const rescued = await runCompanion(["ask", "--write", "--fresh", "apply", "the", "fix"], env);
      expect(rescued.exitCode, rescued.stderr).toBe(0);
      expect(await latestKind(env)).toBe("rescue");

      const asked = await runCompanion(["ask", "--fresh", "--", "--write", "explained"], env);
      expect(asked.exitCode, asked.stderr).toBe(0);
      expect(await latestKind(env)).toBe("ask");
    });
  }, 60_000);

  test("review --challenge runs challenge", async () => {
    await withFixture(async (env) => {
      const challenged = await runCompanion(["review", "--challenge", "pushback"], { ...env, KIMI_PLUGIN_CC_MOCK_SCENARIO: "review-success" });
      expect(challenged.exitCode, challenged.stderr).toBe(0);
      expect(await latestKind(env)).toBe("challenge");
    });
  }, 60_000);

  test("selectors refuse where the routed operation forbids them", async () => {
    await withFixture(async (env) => {
      for (const [argv, message] of [
        [["ask", "--write", "--network", "fix"], "rescue rejects --network"],
        [["ask", "--write", "--read-root", "/tmp", "fix"], "rescue rejects --read-root"],
        [["ask", "--challenge", "x"], "Unknown flag --challenge for ask"],
        [["review", "--write"], "Unknown flag --write for review"],
        [["review", "--challenge", "--write"], "Unknown flag --write for challenge"],
      ] as const) {
        const result = await runCompanion([...argv], env);
        expect(result.exitCode, argv.join(" ")).toBe(1);
        expect(result.stderr, argv.join(" ")).toContain("INVALID_ARGS");
        expect(result.stderr, argv.join(" ")).toContain(message);
      }
    });
  }, 60_000);
});

async function runCompanion(argv: string[], env: NodeJS.ProcessEnv): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--import", "tsx", companionPath, ...argv], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}
