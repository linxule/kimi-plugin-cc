import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { probeProcessIdentity, type ProcessIdentity } from "../../runtime/process-tree.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

const runner = path.join(process.cwd(), "tests/helpers/swarm-settlement-runner.mjs");
const posixTest = process.platform === "win32" ? test.skip : test;

for (const [mode, width] of [
  ["success", "1"], ["success", "2"], ["error-exit", "2"], ["cancel", "2"],
  ["legacy", "2"], ["snapshot-error", "2"], ["identity-error", "2"], ["persistence-error", "2"],
  ["incomplete-retention", "2"], ["snapshot-persistent", "2"],
  ["identity-persistent", "2"], ["persistence-persistent", "2"],
  ["sticky", "2"], ["slow-spawn", "2"], ["failure", "2"],
]) {
  posixTest(`bounded swarm settlement ${mode}, concurrency ${width}`, async () => {
    const root = await createTestPluginDataRoot("cli-swarm-settlement");
    const child = spawn(process.execPath, [runner, path.join(process.cwd(), "runtime"), "ts", root, mode!, width!], {
      cwd: process.cwd(), env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killedForTimeout = false;
    try {
      const status = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
        timer = setTimeout(() => {
          killedForTimeout = true;
          child.kill("SIGKILL");
        }, 7000);
      });
      expect(killedForTimeout, output).toBe(false);
      expect(status, output).toBe(0);
      const result = JSON.parse(await readFile(path.join(root, "result.json"), "utf8"));
      expect(result.mode).toBe(mode);
      const hasLiveTail = mode === "failure" || mode === "identity-persistent";
      expect(result.leafAliveAtReturn).toBe(hasLiveTail);
      if (hasLiveTail) {
        expect(result.errorCode).toBe("CLI_PROCESS_SETTLEMENT_FAILED");
        expect(result.cleanupUnverified).toBe(true);
        const identity: ProcessIdentity = JSON.parse(await readFile(path.join(root, "identity.json"), "utf8"));
        expect((await probeProcessIdentity(identity.pid)).identity?.startToken).toBe(identity.startToken);
      }
    } finally {
      if (timer) clearTimeout(timer);
      child.kill("SIGKILL");
      const identity = await readFile(path.join(root, "identity.json"), "utf8")
        .then((text) => JSON.parse(text) as ProcessIdentity).catch(() => undefined);
      if (identity) {
        const current = await probeProcessIdentity(identity.pid);
        if (current.complete && current.identity?.startToken === identity.startToken &&
          current.identity.processGroupId === identity.processGroupId) {
          try { process.kill(identity.pid, "SIGKILL"); } catch { /* Already exited. */ }
        }
      }
      await cleanupTestPath(root);
    }
  }, 10_000);
}
