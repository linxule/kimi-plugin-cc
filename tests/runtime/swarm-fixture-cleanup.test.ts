import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";

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

posixTest("outer runner drains final stdout and stderr after exit before destroying pipes", async () => {
  for (let iteration = 0; iteration < 3; iteration++) {
    const expectedStdout = Buffer.from(`stdout-${iteration}:` + "out-final-".repeat(800) + "\n");
    const expectedStderr = Buffer.from(`stderr-${iteration}:` + "err-final-".repeat(800) + "\n");
    const script = [
      'const { writeSync } = require("node:fs");',
      'for (const [fd, value] of [[1, process.argv[1]], [2, process.argv[2]]]) {',
      '  const bytes = Buffer.from(value);',
      '  let offset = 0;',
      '  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);',
      '}',
      'process.exit(0);',
    ].join("\n");
    const child = spawn("node", ["-e", script, expectedStdout.toString(), expectedStderr.toString()], {
      env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => { stdout.push(Buffer.from(chunk)); });
    child.stderr.on("data", (chunk) => { stderr.push(Buffer.from(chunk)); });
    // Exercise buffered real-pipe output; the delayed-close control below
    // fixes event ordering independently of host stream scheduling.
    child.stdout.pause();
    child.stderr.pause();
    let resume: ReturnType<typeof setTimeout> | undefined;
    child.once("exit", () => {
      resume = setTimeout(() => { child.stdout.resume(); child.stderr.resume(); }, 30);
    });
    const settled = waitForSwarmRunner(child, 2000);
    try {
      const result = await settled;
      expect(result).toEqual({ status: 0, timedOut: false });
      expect(Buffer.concat(stdout).length).toBe(expectedStdout.length);
      expect(Buffer.concat(stderr).length).toBe(expectedStderr.length);
      expect(Buffer.concat(stdout).equals(expectedStdout)).toBe(true);
      expect(Buffer.concat(stderr).equals(expectedStderr)).toBe(true);
    } finally {
      if (resume) clearTimeout(resume);
      child.stdout.resume();
      child.stderr.resume();
      await settled;
    }
  }
}, 8000);

test("outer runner preserves queued output between exit and delayed pipe close", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    exitCode: null as number | null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  let drained = false;
  let finishDrain!: () => void;
  const drainDone = new Promise<void>((resolve) => { finishDrain = resolve; });
  const settled = waitForSwarmRunner(child as unknown as ChildProcess, 1000);
  queueMicrotask(() => {
    child.exitCode = 0;
    child.emit("exit", 0);
    setTimeout(() => {
      if (!child.stdout.destroyed) child.stdout.end("last stdout bytes\n");
      if (!child.stderr.destroyed) child.stderr.end("last stderr bytes\n");
      drained = true;
      child.emit("close", 0);
      finishDrain();
    }, 20);
  });
  try {
    expect(await settled).toEqual({ status: 0, timedOut: false });
    expect(drained).toBe(true);
    expect(stdout).toBe("last stdout bytes\n");
    expect(stderr).toBe("last stderr bytes\n");
  } finally {
    await drainDone;
    await settled;
    child.stdout.destroy();
    child.stderr.destroy();
  }
}, 2000);

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
