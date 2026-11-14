import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { probeProcessIdentity, type ProcessIdentity } from "../../runtime/process-tree.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

const runner = path.join(process.cwd(), "tests/helpers/swarm-settlement-runner.mjs");
const posixTest = process.platform === "win32" ? test.skip : test;

for (const distribution of ["dist", "plugins/kimi-codex/dist", "plugins/kimi-dsh/dist"]) {
  for (const mode of [
    "success", "failure", "snapshot-error", "identity-error", "persistence-error", "incomplete-retention",
    "snapshot-persistent", "identity-persistent", "persistence-persistent",
  ]) {
    posixTest(`${distribution} settles owned tails and exits naturally after ${mode}`, async () => {
      const root = await createTestPluginDataRoot("compiled-swarm-settlement");
      const child = spawn("node", [runner, path.join(process.cwd(), distribution), "js", root, mode, "2"], {
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
          timer = setTimeout(() => { killedForTimeout = true; child.kill("SIGKILL"); }, 7000);
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
}
