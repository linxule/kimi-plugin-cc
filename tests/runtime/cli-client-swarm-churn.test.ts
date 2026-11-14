import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";
import { cleanupRecordedSwarmProcesses, readSwarmCleanupIdentities, waitForSwarmRunner } from "../helpers/swarm-runner-cleanup.js";

const runner = path.join(process.cwd(), "tests/helpers/swarm-churn-runner.mjs");
const posixTest = process.platform === "win32" ? test.skip : test;

for (const distribution of ["runtime", "dist", "plugins/kimi-codex/dist", "plugins/kimi-dsh/dist"]) {
  posixTest(`${distribution} batches only live swarm anchors after 220-child churn`, async () => {
    const root = await createTestPluginDataRoot("swarm-churn");
    const source = distribution === "runtime";
    const child = spawn(source ? process.execPath : "node", [
      runner, path.join(process.cwd(), distribution), source ? "ts" : "js", root,
    ], { cwd: process.cwd(), env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    try {
      const { status, timedOut } = await waitForSwarmRunner(child, 20_000);
      expect(timedOut, output).toBe(false);
      expect(status, output).toBe(0);
      const result = JSON.parse(await readFile(path.join(root, "result.json"), "utf8"));
      expect(result.ephemeralIdentities).toBe(220);
      expect(result.maxConcurrentEphemeral).toBe(20);
      expect(result.incompleteCheckpoint).toBe(true);
      expect(result.recovered).toBe(true);
      expect(result.maxBatchesPerPass).toBe(1);
      expect(result.incompletePassBatchCalls).toBe(0);
      expect(result.recoveryAnchorCount).toBe(1);
    } finally {
      await cleanupRecordedSwarmProcesses(await readSwarmCleanupIdentities(root, "identities.json"));
      await cleanupTestPath(root);
    }
  }, 25_000);
}
