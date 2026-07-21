import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runSetup } from "../../runtime/commands/setup.js";
import type { CommandContext } from "../../runtime/types.js";

function makeContext(): CommandContext {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

describe("setup command parsing", () => {
  test("rejects unknown flags before probing Kimi", async () => {
    await expect(runSetup(["--bogus"], makeContext())).rejects.toMatchObject({
      code: "INVALID_ARGS",
      stage: "setup.parse",
    });
  });

  test("rejects conflicting review-gate flags as INVALID_ARGS", async () => {
    await expect(
      runSetup(["--enable-review-gate", "--disable-review-gate"], makeContext()),
    ).rejects.toMatchObject({
      code: "INVALID_ARGS",
      stage: "setup.parse",
    });
  });

  test("CLI setup --check retains actionable stdout and exits nonzero on failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kimi-plugin-cc-setup-cli-"));
    const kimiHome = path.join(root, "kimi-home");
    const pluginData = path.join(root, "plugin-data");
    await mkdir(kimiHome, { recursive: true });
    await mkdir(pluginData, { recursive: true });
    await writeFile(path.join(kimiHome, "config.toml"), "user_setting = true\n", "utf8");

    try {
      const result = await runCompanion(["setup", "--check"], {
        ...process.env,
        KIMI_CODE_HOME: kimiHome,
        CLAUDE_PLUGIN_DATA: pluginData,
        KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: "1",
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("managed block is NOT installed");
      expect(result.stdout).toContain("Next step: Run /kimi:setup");
      // The tsx loader may emit Node deprecation warnings (e.g. DEP0205
      // module.register() on Node >= 25) that are environment noise, not
      // companion output — strip them before asserting a clean stderr.
      expect(stripNodeDeprecationWarnings(result.stderr)).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function stripNodeDeprecationWarnings(stderr: string): string {
  return stderr
    .split("\n")
    .filter(
      (line) =>
        !/^\(node:\d+\) \[DEP\d+\] DeprecationWarning:/.test(line) &&
        !/^\(Use `node --trace-deprecation /.test(line),
    )
    .join("\n")
    .trim();
}

async function runCompanion(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const companionPath = path.join(process.cwd(), "runtime", "companion.ts");
  return await new Promise((resolve, reject) => {
    const child = spawn("node", ["--import", "tsx", companionPath, ...argv], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}
