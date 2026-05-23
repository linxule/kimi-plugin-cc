import { describe, expect, test } from "bun:test";

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
});
