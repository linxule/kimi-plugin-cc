import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { probeProcessIdentity, revalidateProcessIdentities, type ProcessIdentity } from "../../runtime/process-tree.js";

export async function waitForSwarmRunner(child: ChildProcess, timeoutMs: number): Promise<{ status: number | null; timedOut: boolean }> {
  const original = child.pid === undefined ? Promise.resolve(undefined)
    : probeProcessIdentity(child.pid).then((proof) => proof.complete ? proof.identity : undefined).catch(() => undefined);
  let timedOut = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let killDeadline: ReturnType<typeof setTimeout> | undefined;
  let termination: Promise<void> | undefined;
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      const finish = (code: number | null) => {
        child.removeListener("error", fail);
        child.removeListener("exit", finish);
        resolve(code);
      };
      const fail = (error: Error) => {
        child.removeListener("exit", finish);
        reject(error);
      };
      child.once("error", fail);
      child.once("exit", finish);
      deadline = setTimeout(() => {
        timedOut = true;
        // An inherited pipe may outlive the runner. Neither pipe closure nor
        // a broken kill path may make the outer test wait without a deadline.
        killDeadline = setTimeout(() => finish(null), 500);
        termination = (async () => {
          const identity = await original;
          if (!identity || child.exitCode !== null || child.signalCode !== null) return;
          const proof = await revalidateProcessIdentities([identity], { timeoutMs: 250 });
          if (proof.complete && proof.identities.length === 1 &&
            child.exitCode === null && child.signalCode === null) {
            try { child.kill("SIGKILL"); } catch { /* The owned runner already exited. */ }
          }
        })().catch(() => undefined);
      }, timeoutMs);
    });
    return { status, timedOut };
  } finally {
    if (deadline) clearTimeout(deadline);
    if (killDeadline) clearTimeout(killDeadline);
    child.stdout?.destroy();
    child.stderr?.destroy();
    if (timedOut) child.unref();
    if (termination) {
      let terminationDeadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([termination, new Promise<void>((resolve) => {
          terminationDeadline = setTimeout(resolve, 500);
        })]);
      } finally {
        if (terminationDeadline) clearTimeout(terminationDeadline);
      }
    }
  }
}

export async function readSwarmCleanupIdentities(root: string, filename: string): Promise<ProcessIdentity[]> {
  return readFile(path.join(root, filename), "utf8")
    .then((text) => JSON.parse(text) as ProcessIdentity[]).catch(() => []);
}

export async function cleanupRecordedSwarmProcesses(identities: readonly ProcessIdentity[]): Promise<void> {
  const original = await revalidateProcessIdentities(identities, { timeoutMs: 250 });
  if (!original.complete) return;
  for (const identity of original.identities) {
    try { process.kill(identity.pid, "SIGKILL"); } catch { /* Already exited. */ }
  }
  const deadline = Date.now() + 750;
  while (Date.now() < deadline) {
    const proof = await revalidateProcessIdentities(original.identities, { timeoutMs: 150 });
    if (proof.complete && proof.identities.length === 0 && (proof.groupChanged?.length ?? 0) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
