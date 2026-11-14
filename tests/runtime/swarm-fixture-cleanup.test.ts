import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { probeProcessIdentity, revalidateProcessIdentities, type ProcessIdentity } from "../../runtime/process-tree.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";
import { cleanupRecordedSwarmProcesses, readSwarmCleanupIdentities, waitForSwarmRunner } from "../helpers/swarm-runner-cleanup.js";

const posixTest = process.platform === "win32" ? test.skip : test;

for (const [filename, identitiesFile] of [
  ["swarm-settlement-runner.mjs", "cleanup-identities.json"],
  ["swarm-churn-runner.mjs", "identities.json"],
] as const) {
  posixTest(`${filename} settles its entire fixture after a precondition failure`, async () => {
    const root = await createTestPluginDataRoot("swarm-fixture-precondition");
    const child = spawn(process.execPath, [
      path.join(process.cwd(), "tests/helpers", filename), path.join(process.cwd(), "runtime"), "ts", root, "success", "2",
    ], {
      cwd: process.cwd(), env: { PATH: process.env.PATH, SWARM_TEST_PRECONDITION_FAILURE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    try {
      const { status, timedOut } = await waitForSwarmRunner(child, 7000);
      expect(timedOut, output).toBe(false);
      expect(status, output).toBe(1);
      expect(output).toContain("scripted fixture precondition failure");
      const identities = await readSwarmCleanupIdentities(root, identitiesFile);
      expect(new Set(identities.map((identity) => identity.pid)).size, output).toBeGreaterThanOrEqual(3);
      const proof = await revalidateProcessIdentities(identities, { timeoutMs: 500 });
      expect(proof.complete, output).toBe(true);
      expect(proof.groupChanged ?? [], output).toEqual([]);
      expect(proof.identities, output).toEqual([]);
    } finally {
      await cleanupRecordedSwarmProcesses(await readSwarmCleanupIdentities(root, identitiesFile));
      await cleanupTestPath(root);
    }
  }, 10_000);
}

posixTest("outer runner timeout settles while an owned descendant still holds its pipes", async () => {
  const root = await createTestPluginDataRoot("swarm-runner-pipe-timeout");
  const pidFile = path.join(root, "leaf-pid.json");
  const script = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const leaf = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 3500)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });',
    'writeFileSync(process.argv[1], JSON.stringify({ pid: leaf.pid }));',
    'setInterval(() => {}, 1000);',
    'setTimeout(() => process.exit(91), 3000);',
  ].join("\n");
  const child = spawn("node", ["-e", script, pidFile], { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
  const identities: ProcessIdentity[] = [];
  const settled = waitForSwarmRunner(child, 1500);
  try {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && identities.length === 0) {
      const pid = await readFile(pidFile, "utf8").then((text) => JSON.parse(text).pid as number).catch(() => undefined);
      if (pid !== undefined) {
        const proof = await probeProcessIdentity(pid);
        if (proof.complete && proof.identity) identities.push(proof.identity);
      }
      if (identities.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(identities).toHaveLength(1);
    const result = await settled;
    expect(result.timedOut).toBe(true);
    expect(child.signalCode).toBe("SIGKILL");
    expect((await revalidateProcessIdentities(identities)).identities).toHaveLength(1);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  } finally {
    await settled;
    await cleanupRecordedSwarmProcesses(identities);
    await cleanupTestPath(root);
  }
}, 5000);
