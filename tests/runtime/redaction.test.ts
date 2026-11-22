import { describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";

import { runCliPrompt } from "../../runtime/cli-client.js";
import {
  loadRedactionPatterns,
  redactPromptForWorkspace,
  redactText,
} from "../../runtime/redaction.js";
import type { KimiExecutionPlan } from "../../runtime/kimi-engine.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

const mockKimiStreamPath = path.join(process.cwd(), "tests/helpers/mock-kimi-stream.ts");

async function policy(root: string, source: string): Promise<void> {
  await writeFile(path.join(root, ".kimi-plugin.toml"), source, "utf8");
}

function executionPlan(): KimiExecutionPlan {
  return {
    schemaVersion: 1,
    operationKind: "review",
    intendedEngine: "legacy-v1",
    command: "bun",
    prefixArgs: ["run", mockKimiStreamPath],
    kimiVersion: "0.39.0",
    certification: "certified",
    resumedFromJobId: null,
    safetyProfile: null,
  };
}

describe("workspace redaction", () => {
  test("passes through without a policy and applies stable ordered replacements", async () => {
    const root = await createTestPluginDataRoot("redaction-basics");
    try {
      expect(await loadRedactionPatterns(root)).toEqual([]);
      expect(await redactPromptForWorkspace(root, "unchanged secret-one")).toEqual({
        text: "unchanged secret-one",
        replacements: 0,
      });
      await policy(root, `[redaction]\npatterns = ["secret-[a-z]+", "token-[0-9]+"]\n`);
      expect(await redactPromptForWorkspace(root, "secret-one token-42 secret-two")).toEqual({
        text: "[REDACTED-0] [REDACTED-1] [REDACTED-0]",
        replacements: 3,
      });
      expect(redactText("secret-one", ["secret-[a-z]+"])).toEqual({
        text: "[REDACTED-0]",
        replacements: 1,
      });
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("accepts an empty policy table and empty pattern list", async () => {
    const root = await createTestPluginDataRoot("redaction-empty");
    try {
      await policy(root, "[redaction]\npatterns = []\n");
      expect(await redactPromptForWorkspace(root, "unchanged")).toEqual({ text: "unchanged", replacements: 0 });
    } finally {
      await cleanupTestPath(root);
    }
  });

  test.each([
    ["malformed TOML", "[redaction\npatterns = []"],
    ["empty pattern", `[redaction]\npatterns = [""]`],
    ["invalid regex", `[redaction]\npatterns = ["("]`],
    ["non-string pattern", `[redaction]\npatterns = [42]`],
    ["too many patterns", `[redaction]\npatterns = [${Array.from({ length: 65 }, () => `"x"`).join(",")}]`],
    ["oversized policy", `[redaction]\npatterns = ["${"a".repeat(70_000)}"]`],
  ])("fails closed for %s", async (_name, source) => {
    const root = await createTestPluginDataRoot("redaction-invalid");
    try {
      await policy(root, source);
      await expect(redactPromptForWorkspace(root, "do not send")).rejects.toMatchObject({
        code: "REDACTION_POLICY_INVALID",
        stage: "redaction.policy",
      });
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("terminates a catastrophic regex instead of sending the prompt", async () => {
    const root = await createTestPluginDataRoot("redaction-timeout");
    try {
      await policy(root, `[redaction]\npatterns = ["(a+)+$"]\n`);
      await expect(redactPromptForWorkspace(root, `${"a".repeat(20_000)}!`)).rejects.toMatchObject({
        code: "REDACTION_TIMEOUT",
        stage: "redaction.worker",
      });
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("spawn argv and diagnostics contain only redacted prompt text", async () => {
    const root = await createTestPluginDataRoot("redaction-spawn");
    const originalSpawn = childProcess.spawn;
    let capturedArgs: string[] | undefined;
    const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(((...args: Parameters<typeof spawn>) => {
      capturedArgs = [...(args[1] ?? [])];
      return originalSpawn(...args);
    }) as typeof spawn);
    const diagnostics = new PassThrough();
    let diagnosticText = "";
    diagnostics.on("data", (chunk) => { diagnosticText += chunk.toString(); });
    const logPath = path.join(root, "logs", "spawn.jsonl");
    try {
      await policy(root, `[redaction]\npatterns = ["secret-[A-Za-z0-9]+"]\n`);
      await runCliPrompt({
        cwd: root,
        env: {
          ...process.env,
          KIMI_MOCK_RECORDS: "[]",
          KIMI_MOCK_EMIT_ANNOUNCE: "0",
          KIMI_MOCK_EXIT_CODE: "0",
        },
        command: "bun",
        prefixArgs: ["run", mockKimiStreamPath],
        executionPlan: executionPlan(),
        prompt: "send secret-Ab123 but keep ordinary text",
        commandLabel: "review",
        logPath,
        stderr: diagnostics as unknown as NodeJS.WriteStream,
      });

      const prompt = capturedArgs?.[capturedArgs.indexOf("-p") + 1];
      expect(prompt).toBe("send [REDACTED-0] but keep ordinary text");
      expect(capturedArgs?.join(" ")).not.toContain("secret-Ab123");
      const log = await readFile(logPath, "utf8");
      expect(log).not.toContain("secret-Ab123");
      expect(log).toContain('"redaction_replacements":1');
      expect(diagnosticText).toBe("Redacted 1 match(es) before starting Kimi.\n");
      expect(diagnosticText).not.toContain("secret-Ab123");
    } finally {
      spawnSpy.mockRestore();
      diagnostics.destroy();
      await cleanupTestPath(root);
    }
  });

  test("an invalid policy prevents process creation", async () => {
    const root = await createTestPluginDataRoot("redaction-no-spawn");
    const spawnSpy = spyOn(childProcess, "spawn");
    try {
      await mkdir(root, { recursive: true });
      await policy(root, `[redaction]\npatterns = ["("]\n`);
      await expect(runCliPrompt({
        cwd: root,
        env: { ...process.env },
        command: "bun",
        prefixArgs: ["run", mockKimiStreamPath],
        executionPlan: executionPlan(),
        prompt: "do not send",
      })).rejects.toMatchObject({ code: "REDACTION_POLICY_INVALID" });
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
      await cleanupTestPath(root);
    }
  });
});
