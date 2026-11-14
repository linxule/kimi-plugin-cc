import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { revalidateProcessIdentities, type ProcessIdentity } from "../../runtime/process-tree.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

const runner = path.join(process.cwd(), "tests/helpers/legacy-cancellation-failure-runner.mjs");
const posixTest = process.platform === "win32" ? test.skip : test;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface RecordedIdentities {
  root?: ProcessIdentity;
  tail?: ProcessIdentity;
}

async function readIdentities(root: string): Promise<RecordedIdentities | undefined> {
  try {
    return JSON.parse(await readFile(path.join(root, "identities.json"), "utf8")) as RecordedIdentities;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function waitForRunner(child: ChildProcess): Promise<{ status: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      // Timeout must remain bounded even if an unexpected descendant inherits
      // this runner's diagnostic pipes. Natural close is required for success.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ status: child.exitCode, timedOut: true });
    }, 7000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve({ status, timedOut: false });
    });
  });
}

async function cleanupRecordedProcesses(recorded: RecordedIdentities | undefined): Promise<void> {
  if (!recorded) return;
  const expected = [recorded.root, recorded.tail].filter((identity): identity is ProcessIdentity =>
    identity !== undefined && identity !== null && typeof identity === "object" &&
    Number.isInteger(identity.pid) && identity.pid > 0 &&
    Number.isInteger(identity.processGroupId) && identity.processGroupId > 0 &&
    typeof identity.startToken === "string" && identity.startToken.length > 0 &&
    typeof identity.state === "string");
  const deadline = Date.now() + 1500;
  while (true) {
    const current = await revalidateProcessIdentities(expected);
    if (!current.complete) throw new Error("Legacy cancellation fixture cleanup could not verify identities");
    if ((current.groupChanged?.length ?? 0) > 0) {
      throw new Error("Legacy cancellation fixture cleanup refused a changed process group");
    }
    if (current.identities.length === 0) return;
    if (Date.now() >= deadline) throw new Error("Legacy cancellation fixture did not reach verified quiescence");
    for (const identity of current.identities) {
      try { process.kill(identity.pid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await pause(10);
  }
}

for (const distribution of ["runtime", "dist", "plugins/kimi-codex/dist", "plugins/kimi-dsh/dist"]) {
  for (const operation of ["ask", "rescue", "pursue"]) {
    for (const failureMode of operation === "ask" ? ["throw", "timeout", "budget"] : ["throw", "timeout"]) {
      posixTest(`${distribution} preserves ${operation} cancellation ${failureMode} failure after root escalation`, async () => {
        const root = await createTestPluginDataRoot("legacy-cancellation-failure");
        const source = distribution === "runtime";
        const child = spawn(source ? process.execPath : "node", [
          runner, path.join(process.cwd(), distribution), source ? "ts" : "js", root, operation, failureMode,
        ], { cwd: process.cwd(), env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        child.stdout.on("data", (chunk) => { output += String(chunk); });
        child.stderr.on("data", (chunk) => { output += String(chunk); });
        try {
          const { status, timedOut } = await waitForRunner(child);
          expect(timedOut, output).toBe(false);
          expect(status, output).toBe(0);
          const result = JSON.parse(await readFile(path.join(root, "result.json"), "utf8"));
          expect(result.operation).toBe(operation);
          expect(result.failureMode).toBe(failureMode);
          expect(result.errorCode).toBe(failureMode === "budget" ? "RESPONSE_TIMEOUT" : "CLI_CANCELLATION_TEARDOWN_FAILED");
          expect(result.cleanupUnverified).toBe(true);
          expect(result.rootQuiescent).toBe(true);
          expect(result.tailAliveAtReturn).toBe(true);
          expect(result.rootTermObserved).toBe(true);
          expect(result.tailTermObserved).toBe(false);

          const recorded = await readIdentities(root);
          expect(recorded?.root).toBeDefined();
          expect(recorded?.tail).toBeDefined();
          const current = await revalidateProcessIdentities([recorded!.root!, recorded!.tail!]);
          expect(current.complete).toBe(true);
          expect(current.groupChanged ?? []).toEqual([]);
          expect(current.identities.map((identity) => identity.pid)).toEqual([recorded!.tail!.pid]);
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          await cleanupRecordedProcesses(await readIdentities(root));
          await cleanupTestPath(root);
        }
      }, 10_000);
    }
  }
}
