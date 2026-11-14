import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import { RuntimeError } from "./errors.js";

const POLICY_CONTENT = `${JSON.stringify({ disabledTools: ["TaskStop"] })}\n`;
const POLICY_MAX_BYTES = 4096;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;

interface DirectoryIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
}

/**
 * Called only for our fresh, stopped, journal-proven session before its first
 * print turn. TaskStop is already denied by the managed hook; disabling it in
 * native policy also makes Bash's allowBackground false for every child,
 * including its automatic foreground-timeout detachment path.
 */
export async function installBoundedSwarmToolPolicy(
  kimiHome: string,
  identity: { sessionId: string; workspaceId: string },
  signal?: AbortSignal,
): Promise<void> {
  const directories: DirectoryIdentity[] = [];
  let candidatePath: string | undefined;
  let candidateIdentity: { dev: bigint; ino: bigint } | undefined;
  try {
    checkSignal(signal);
    if (!SAFE_ID.test(identity.sessionId) || !SAFE_ID.test(identity.workspaceId)) {
      throw policyFailure("invalid-session-identity");
    }
    const canonicalHome = await realpath(kimiHome);
    let current = canonicalHome;
    for (const segment of [undefined, "sessions", identity.workspaceId, identity.sessionId]) {
      if (segment !== undefined) current = path.join(current, segment);
      directories.push(await directoryIdentity(current));
      checkSignal(signal);
    }

    const policyDir = path.join(current, "tool-policy");
    await assertDirectoriesUnchanged(directories);
    await mkdir(policyDir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    directories.push(await directoryIdentity(policyDir));
    const statePath = path.join(policyDir, "state.json");
    // No merge or replacement: this is a fresh-session construction, not an
    // operator-policy editor. link() below closes this absence-check race.
    const existing = await lstat(statePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing !== undefined) throw policyFailure("policy-already-exists");
    checkSignal(signal);
    await assertDirectoriesUnchanged(directories);

    candidatePath = path.join(policyDir, `.state.${process.pid}.${randomUUID()}.tmp`);
    const candidate = await open(
      candidatePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const stats = await candidate.stat({ bigint: true });
      candidateIdentity = { dev: stats.dev, ino: stats.ino };
      if (!stats.isFile()) throw policyFailure("candidate-not-regular");
      if (process.platform !== "win32") await candidate.chmod(0o600);
      await candidate.writeFile(POLICY_CONTENT, "utf8");
      await candidate.sync();
    } finally {
      await candidate.close();
    }

    checkSignal(signal);
    await assertDirectoriesUnchanged(directories);
    // A hard link publishes the complete synced inode atomically and refuses
    // an existing destination, unlike rename(), which could replace policy.
    await link(candidatePath, statePath);
    await verifyPublishedPolicy(statePath, candidateIdentity);
    await assertDirectoriesUnchanged(directories);
    checkSignal(signal);
  } catch (error) {
    if (signal?.aborted) throw policyFailure("cancelled", true);
    if (error instanceof RuntimeError) throw error;
    throw policyFailure("policy-installation-failed");
  } finally {
    // Never unlink a replacement or follow a replaced ancestor while cleaning
    // up our private candidate. An uncertain path remains as failure evidence.
    if (candidatePath !== undefined && candidateIdentity !== undefined) {
      try {
        await assertDirectoriesUnchanged(directories);
        const stats = await lstat(candidatePath, { bigint: true });
        if (stats.isFile() && sameIdentity(stats, candidateIdentity)) await unlink(candidatePath);
      } catch { /* Preserve uncertain paths. */ }
    }
  }
}

async function directoryIdentity(directory: string): Promise<DirectoryIdentity> {
  const stats = await lstat(directory, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink() || await realpath(directory) !== directory) {
    throw policyFailure("unsafe-session-directory");
  }
  return { path: directory, dev: stats.dev, ino: stats.ino };
}

async function assertDirectoriesUnchanged(directories: readonly DirectoryIdentity[]): Promise<void> {
  for (const directory of directories) {
    const current = await directoryIdentity(directory.path);
    if (!sameIdentity(current, directory)) throw policyFailure("session-directory-changed");
  }
}

async function verifyPublishedPolicy(
  statePath: string,
  expected: { dev: bigint; ino: bigint },
): Promise<void> {
  const file = await open(statePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(POLICY_MAX_BYTES) || !sameIdentity(before, expected)) {
      throw policyFailure("published-policy-invalid");
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    const named = await lstat(statePath, { bigint: true });
    if (offset !== bytes.length || bytes.toString("utf8") !== POLICY_CONTENT ||
        before.size !== after.size || !sameIdentity(after, expected) ||
        !named.isFile() || !sameIdentity(named, expected)) {
      throw policyFailure("published-policy-changed");
    }
  } finally {
    await file.close();
  }
}

function sameIdentity(a: Pick<BigIntStats, "dev" | "ino">, b: Pick<BigIntStats, "dev" | "ino">): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function checkSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw policyFailure("cancelled", true);
}

function policyFailure(reason: string, cancelled = false): RuntimeError {
  return new RuntimeError(
    "SWARM_ACTIVATION_FAILED",
    "The fresh swarm session could not install its native tool restriction; refusing the model turn.",
    "swarm-activation.tool-policy",
    { details: { reason, ...(cancelled ? { cancelled: true } : {}) } },
  );
}
