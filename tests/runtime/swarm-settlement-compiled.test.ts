import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";
import { cleanupRecordedSwarmProcesses, readSwarmCleanupIdentities, waitForSwarmRunner } from "../helpers/swarm-runner-cleanup.js";

const runner = path.join(process.cwd(), "tests/helpers/swarm-settlement-runner.mjs");
const posixTest = process.platform === "win32" ? test.skip : test;

for (const distribution of ["dist", "plugins/kimi-codex/dist", "plugins/kimi-dsh/dist"]) {
  for (const mode of [
    "success", "failure", "snapshot-error", "batch-snapshot-error", "identity-error", "persistence-error", "incomplete-retention",
    "snapshot-persistent", "identity-persistent", "persistence-persistent", "spawn-callback-error",
  ]) {
    posixTest(`${distribution} settles owned tails and exits naturally after ${mode}`, async () => {
      const root = await createTestPluginDataRoot("compiled-swarm-settlement");
      const child = spawn("node", [runner, path.join(process.cwd(), distribution), "js", root, mode, "2"], {
        cwd: process.cwd(), env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += String(chunk); });
      child.stderr.on("data", (chunk) => { output += String(chunk); });
      try {
        const { status, timedOut } = await waitForSwarmRunner(child, 7000);
        expect(timedOut, output).toBe(false);
        expect(status, output).toBe(0);
        const result = JSON.parse(await readFile(path.join(root, "result.json"), "utf8"));
        expect(result.mode).toBe(mode);
        const hasLiveTail = mode === "failure" || mode === "identity-persistent";
        expect(result.leafAliveAtReturn).toBe(hasLiveTail);
        if (hasLiveTail) {
          expect(result.errorCode).toBe("CLI_PROCESS_SETTLEMENT_FAILED");
          expect(result.cleanupUnverified).toBe(true);
        }
      } finally {
        await cleanupRecordedSwarmProcesses(await readSwarmCleanupIdentities(root, "cleanup-identities.json"));
        await cleanupTestPath(root);
      }
    }, 10_000);
  }
}
