import { runRecoverSwarm } from "../../runtime/commands/recover-swarm.js";
import { runAsk } from "../../runtime/commands/ask.js";
import { runRescue } from "../../runtime/commands/rescue.js";
import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { companionHelp } from "../../runtime/help.js";

const exec = promisify(execFile);
const companion = path.resolve("dist/companion.js");
const commands = [[], ["setup"], ["review"], ["ask"], ["task"], ["task", "rescue"], ["task", "challenge"], ["task", "pursue"], ["task", "swarm"], ["status"], ["result"], ["cancel"], ["replay"], ["repair-sessions"], ["recover-swarm"], ["worker"]];
for (const command of commands) {
  for (const flag of ["--help", "-h"]) {
    test(`compiled ${command.join(" ")} ${flag} is side-effect-free stdout`, async () => {
      const args = [...command, flag];
      const result = await exec("node", [companion, ...args], {
        env: {
          ...process.env,
          KIMI_PLUGIN_CC_DATA: "/dev/null/not-a-directory",
          KIMI_CODE_HOME: "/dev/null/not-a-directory",
          KIMI_PLUGIN_CC_KIMI_BIN: "/no-such-kimi",
        },
      });
      expect(result.stdout.trim()).toBe(companionHelp(args)!);
      expect(result.stdout).toContain("Usage:");
      expect(result.stderr).toBe("");
    });
  }
}

test("help stops at -- and wins before it, even after prose or an unknown flag", () => {
  expect(companionHelp(["ask", "--", "--help"])).toBeUndefined();
  expect(companionHelp(["ask", "--", "-h"])).toBeUndefined();
  expect(companionHelp(["ask", "prose", "--help", "--"])).toBeUndefined();
  expect(companionHelp(["ask", "-m", "kimi", "-h"])).toContain("--budget");
  expect(companionHelp(["ask", "--unknown", "-h"])).toContain("--budget");
  expect(companionHelp(["review", "-h"])).toContain("Foreground-only (no --background/--wait)");
  expect(companionHelp(["task", "challenge", "--help"])).toContain("Foreground-only (no --background/--wait)");
});

test("direct ask/rescue commands return parser help before hook or state access", async () => {
  const context = { cwd: "/no-such-workspace", env: { KIMI_PLUGIN_CC_DATA: "/dev/null/not-a-directory" }, stdout: process.stdout, stderr: process.stderr };
  expect(await runAsk(["--budget", "--help"], context)).toContain("Usage: companion.sh ask");
  expect(await runRescue(["--background", "-h"], context)).toContain("Usage: companion.sh task rescue");
});

test("thinking value is skipped by help scanning and appears in all model command usage", () => {
  for (const cmd of [["ask"], ["review"], ["task", "challenge"], ["task", "rescue"], ["task", "pursue"], ["task", "swarm"]]) {
    expect(companionHelp([...cmd, "--thinking", "off", "--help"])).toContain("--thinking <off|low|medium|high>");
  }
});

test("recovery rejects unknown and duplicate flags before state access", async () => {
  const context = { cwd: "/no-such-workspace", env: {}, stdout: process.stdout, stderr: process.stderr };
  for (const args of [["job", "--yes"], ["job", "--apply", "--apply"], [], ["first", "second"]]) {
    await expect(runRecoverSwarm(args, context)).rejects.toMatchObject({ code: "INVALID_ARGS" });
  }
});
