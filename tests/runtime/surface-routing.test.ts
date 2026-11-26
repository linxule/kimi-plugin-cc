import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";

import { RuntimeError } from "../../runtime/errors.js";
import { companionHelp } from "../../runtime/help.js";
import { routeSurfaceAliases } from "../../runtime/surface-routing.js";
import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";

const companionPath = path.join(process.cwd(), "runtime/companion.ts");
const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli.ts");

describe("surface selector routing", () => {
  test("primary read subcommand routes --mode from leading flags only", () => {
    expect(routeSurfaceAliases(["read", "explain", "auth"])).toEqual(["ask", "explain", "auth"]);
    expect(routeSurfaceAliases(["read", "--mode", "ask", "-m", "k2", "--", "hello"])).toEqual(["ask", "-m", "k2", "--", "hello"]);
    expect(routeSurfaceAliases(["read", "--mode=review", "--base", "main", "focus"])).toEqual(["review", "--base", "main", "focus"]);
    expect(routeSurfaceAliases(["read", "--mode", "challenge", "--", "--mode", "ask"])).toEqual(["task", "challenge", "--", "--mode", "ask"]);
    expect(routeSurfaceAliases(["read", "--mode", "swarm", "--cap", "4", "audit"])).toEqual(["task", "swarm", "--cap", "4", "audit"]);
    // `--mode` or `-h`/`--help` after prose, negative numbers, or `--` stays prompt text, defaulting to ask.
    expect(routeSurfaceAliases(["read", "what", "does", "--mode", "review", "do"])).toEqual(["ask", "what", "does", "--mode", "review", "do"]);
    expect(routeSurfaceAliases(["read", "-5", "--mode", "review", "points"])).toEqual(["ask", "-5", "--mode", "review", "points"]);
    expect(routeSurfaceAliases(["read", "--", "--mode", "review"])).toEqual(["ask", "--", "--mode", "review"]);
    expect(routeSurfaceAliases(["read", "--", "--write", "text"])).toEqual(["ask", "--", "--write", "text"]);
    expect(routeSurfaceAliases(["read", "explain", "--write"])).toEqual(["ask", "explain", "--write"]);
    expect(routeSurfaceAliases(["read", "--", "--help"])).toEqual(["ask", "--", "--help"]);
    expect(routeSurfaceAliases(["read", "what", "does", "du", "-h", "do"])).toEqual(["ask", "what", "does", "du", "-h", "do"]);
  });

  test("read rejects leading --write across all read modes", () => {
    for (const argv of [
      ["read", "--write", "fix"],
      ["read", "--mode", "swarm", "--write", "audit"],
      ["read", "--mode=review", "--write"],
    ]) {
      expect(() => routeSurfaceAliases(argv)).toThrow(expect.objectContaining({
        code: "INVALID_ARGS",
        stage: "read.parse",
        message: expect.stringContaining("--write is not allowed with `read`"),
      }));
    }
  });

  test("primary write subcommand routes --mode from leading flags only", () => {
    expect(routeSurfaceAliases(["write", "fix", "bug"])).toEqual(["task", "rescue", "fix", "bug"]);
    expect(routeSurfaceAliases(["write", "--mode", "rescue", "--background", "fix"])).toEqual(["task", "rescue", "--background", "fix"]);
    expect(routeSurfaceAliases(["write", "--mode=pursue", "--turns", "5", "finish"])).toEqual(["task", "pursue", "--turns", "5", "finish"]);
    expect(routeSurfaceAliases(["write", "--mode", "swarm-patch", "--max-concurrency", "2", "refactor"])).toEqual(["task", "swarm", "--write", "--max-concurrency", "2", "refactor"]);
    expect(routeSurfaceAliases(["write", "--mode=swarm_patch", "refactor"])).toEqual(["task", "swarm", "--write", "refactor"]);
    expect(routeSurfaceAliases(["write", "--", "--mode", "pursue"])).toEqual(["task", "rescue", "--", "--mode", "pursue"]);
    expect(routeSurfaceAliases(["write", "--", "-h"])).toEqual(["task", "rescue", "--", "-h"]);
  });

  test("read and write reject invalid or missing --mode values", () => {
    for (const argv of [
      ["read", "--mode"],
      ["read", "--mode", "-m", "k2"],
      ["read", "--mode="],
      ["read", "--mode", "rescue"],
      ["write", "--mode"],
      ["write", "--mode="],
      ["write", "--mode", "review"],
    ]) {
      expect(() => routeSurfaceAliases(argv)).toThrow(RuntimeError);
    }
  });

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
      ["ask", "-5", "--write", "x"],
      ["ask", "-", "--write"],
      ["ask", "-rf", "--write"],
      ["review", "-5", "--challenge"],
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

  test("help follows the routed operation and documents primary subcommands", () => {
    expect(companionHelp(["--help"])).toContain("read, write, job, setup, mcp");
    expect(companionHelp(routeSurfaceAliases(["read", "--help"]))).toContain("Usage: companion.sh read");
    expect(companionHelp(routeSurfaceAliases(["write", "-h"]))).toContain("Usage: companion.sh write");
    expect(companionHelp(["job", "--help"])).toContain("Usage: companion.sh job");
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
    const kimiHome = await createTestPluginDataRoot("surface-routing-kimi-home");
    try {
      await run({
        ...process.env,
        KIMI_PLUGIN_CC_DATA: pluginDataRoot,
        KIMI_CODE_HOME: kimiHome,
        KIMI_PLUGIN_CC_KIMI_BIN: "bun",
        KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
        KIMI_PLUGIN_CC_MOCK_SCENARIO: "ask-success",
        KIMI_PLUGIN_CC_WORKSPACE_CWD: repoRoot,
        KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
      });
    } finally {
      await cleanupTestPath(pluginDataRoot);
      await cleanupTestPath(repoRoot);
      await cleanupTestPath(kimiHome);
    }
  }

  async function latestKind(env: NodeJS.ProcessEnv): Promise<string> {
    const result = await runCompanion(["job", "result", "--json"], env);
    expect(result.exitCode, result.stderr).toBe(0);
    return JSON.parse(result.stdout).kind;
  }

  test("primary read/write/job/setup CLI subcommands route end-to-end", async () => {
    await withFixture(async (env) => {
      const asked = await runCompanion(["read", "--mode", "ask", "--fresh", "Explain", "src.ts"], env);
      expect(asked.exitCode, asked.stderr).toBe(0);
      expect(asked.stdout).toContain("Ask answer from mock Kimi.");
      expect(await latestKind(env)).toBe("ask");

      const reviewed = await runCompanion(["read", "--mode", "review"], {
        ...env,
        KIMI_PLUGIN_CC_MOCK_SCENARIO: "review-success",
      });
      expect(reviewed.exitCode, reviewed.stderr).toBe(0);
      expect(await latestKind(env)).toBe("review");

      const challenged = await runCompanion(["read", "--mode=challenge", "pushback"], {
        ...env,
        KIMI_PLUGIN_CC_MOCK_SCENARIO: "challenge-success",
      });
      expect(challenged.exitCode, challenged.stderr).toBe(0);
      expect(await latestKind(env)).toBe("challenge");

      const written = await runCompanion(["write", "--mode", "rescue", "--fresh", "Apply", "fix"], {
        ...env,
        KIMI_PLUGIN_CC_MOCK_SCENARIO: "rescue-success",
      });
      expect(written.exitCode, written.stderr).toBe(0);
      expect(written.stdout).toContain("Applied the requested change.");
      expect(await latestKind(env)).toBe("rescue");

      const listed = await runCompanion(["job", "list", "--status", "completed", "--limit", "10"], env);
      expect(listed.exitCode, listed.stderr).toBe(0);
      const listPayload = JSON.parse(listed.stdout) as { count: number; jobs: Array<{ job_id: string; command_type: string; status: string }> };
      expect(listPayload.count).toBe(4);
      expect(listPayload.jobs.every((job) => job.status === "completed")).toBe(true);

      const latestId = listPayload.jobs[0]!.job_id;
      const status = await runCompanion(["job", "status", latestId], env);
      expect(status.exitCode, status.stderr).toBe(0);
      expect(JSON.parse(status.stdout).job_id).toBe(latestId);

      const waited = await runCompanion(["job", "wait", latestId, "--timeout", "5s"], env);
      expect(waited.exitCode, waited.stderr).toBe(0);
      expect(waited.stdout).toContain("Applied the requested change.");

      const repair = await runCompanion(["setup", "--repair-sessions"], env);
      expect(repair.exitCode, repair.stderr).toBe(0);
      const repairPayload = JSON.parse(repair.stdout) as { mode: string; sessions: number };
      expect(repairPayload.mode).toBe("dry-run");
      expect(typeof repairPayload.sessions).toBe("number");
    });
  }, 60_000);

  test("ask --write runs rescue; ask with --write as prose stays ask", async () => {
    await withFixture(async (env) => {
      const rescued = await runCompanion(["ask", "--write", "--fresh", "apply", "the", "fix"], env);
      expect(rescued.exitCode, rescued.stderr).toBe(0);
      expect(await latestKind(env)).toBe("rescue");

      const asked = await runCompanion(["ask", "--fresh", "--", "--write", "explained"], env);
      expect(asked.exitCode, asked.stderr).toBe(0);
      expect(await latestKind(env)).toBe("ask");

      await runCompanion(["ask", "--write", "--fresh", "apply", "again"], env);
      expect(await latestKind(env)).toBe("rescue");
      const prose = await runCompanion(["ask", "--fresh", "-5", "--write", "is", "what?"], env);
      expect(prose.exitCode, prose.stderr).toBe(0);
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
        [["job", "bogus"], "Unknown job action bogus"],
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
