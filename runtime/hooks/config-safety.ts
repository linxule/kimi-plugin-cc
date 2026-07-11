import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { RuntimeError } from "../errors.js";
import { probeKimiVersion } from "../kimi-version-probe.js";
import { extractValue } from "../vendor/smol-toml/extract.js";
import { parse as parseToml } from "../vendor/smol-toml/parse.js";
import { parseKey } from "../vendor/smol-toml/struct.js";
import { skipVoid } from "../vendor/smol-toml/util.js";

const LOCK_SUFFIX = ".kimi-plugin-cc.lock";
const DEFAULT_LOCK_WAIT_MS = 10_000;
const DEFAULT_LOCK_STALE_MS = 2_000;
const DEFAULT_LOCK_RETRY_MS = 25;
export const KIMI_CONFIG_LOCK_METADATA_MAX_BYTES = 4_096;

const HOOK_FIELDS = new Set(["event", "matcher", "command", "timeout"]);

// These events exist throughout the supported 0.x range. The remaining events
// are additive and require a local version probe before they can be blessed.
const BASE_HOOK_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "SessionStart",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "Notification",
]);

const VERSION_SENSITIVE_HOOK_EVENTS = new Map<string, number>([
  ["PermissionRequest", 8],
  ["PermissionResult", 8],
  ["Interrupt", 14],
]);

interface LockOwner {
  pid: number;
  token: string;
  createdAt: string;
}

interface LockSnapshot {
  /** Immutable filesystem identity, not owner-controlled metadata. */
  identity: string;
  owner: LockOwner | null;
  ageMs: number;
  metadataTruncated: boolean;
}

interface KimiConfigLockTestHooks {
  /** @internal Deterministic race seam used only by regression tests. */
  afterPublish?: (lockPath: string) => void | Promise<void>;
  /** @internal Deterministic ABA seam used only by regression tests. */
  beforeStaleRecovery?: (
    lockPath: string,
    observed: { identity: string; ownerToken: string | null },
  ) => void | Promise<void>;
}

export interface KimiConfigLockOptions {
  waitMs?: number;
  staleMs?: number;
  retryMs?: number;
  /** @internal Tests only; production callers must leave this unset. */
  testHooks?: KimiConfigLockTestHooks;
}

export function kimiConfigLockPath(configPath: string): string {
  return `${configPath}${LOCK_SUFFIX}`;
}

/**
 * Serialize setup read-modify-write operations with a private sibling lock.
 * A crashed owner is recoverable after `staleMs`; a live owner is never
 * stolen, even when old, and wait time is bounded.
 */
export async function withKimiConfigLock<T>(
  configPath: string,
  operation: () => Promise<T>,
  options: KimiConfigLockOptions = {},
): Promise<T> {
  const lockPath = kimiConfigLockPath(configPath);
  const waitMs = options.waitMs ?? DEFAULT_LOCK_WAIT_MS;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const retryMs = options.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  const owner: LockOwner = {
    pid: process.pid,
    token: randomBytes(16).toString("hex"),
    createdAt: new Date().toISOString(),
  };

  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  let lastOwner: LockOwner | null = null;
  let acquired: LockSnapshot | null = null;

  for (;;) {
    try {
      acquired = await createPrivateLockFile(lockPath, owner);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        if (error instanceof RuntimeError) throw error;
        throw new RuntimeError(
          "SETUP_CONFIG_LOCK_FAILED",
          `Failed to acquire setup lock ${lockPath}: ${(error as Error).message}`,
          "setup.config-lock",
          error instanceof Error
            ? { cause: error, details: { configPath, lockPath } }
            : { details: { configPath, lockPath } },
        );
      }
    }

    const snapshot = await readLockSnapshot(lockPath);
    lastOwner = snapshot?.owner ?? null;
    if (snapshot !== null && isStaleLock(snapshot, staleMs)) {
      await options.testHooks?.beforeStaleRecovery?.(lockPath, {
        identity: snapshot.identity,
        ownerToken: snapshot.owner?.token ?? null,
      });
      const recovered = await tryRecoverStaleLock(lockPath, snapshot, staleMs);
      if (recovered) continue;
    }

    if (Date.now() >= deadline) {
      const ownerDetail = lastOwner === null
        ? "owner metadata is unavailable"
        : `owner pid ${lastOwner.pid}, created ${lastOwner.createdAt}`;
      throw new RuntimeError(
        "SETUP_CONFIG_LOCK_TIMEOUT",
        `Timed out after ${waitMs}ms waiting for setup lock ${lockPath} (${ownerDetail}). Another setup may still be running; retry after it finishes or remove the lock only if that process is gone.`,
        "setup.config-lock",
        { details: { configPath, lockPath, waitMs, owner: lastOwner } },
      );
    }
    await sleep(Math.min(retryMs, Math.max(1, deadline - Date.now())));
  }

  try {
    await options.testHooks?.afterPublish?.(lockPath);
    await assertOwnedLock(lockPath, acquired, owner.token);
    return await operation();
  } finally {
    await releaseOwnedLock(lockPath, acquired, owner.token);
  }
}

/**
 * Publish complete owner metadata atomically. `open(lockPath, "wx")` is not
 * sufficient: it exposes a zero-byte inode while metadata is being written,
 * which a stale-lock observer can misclassify and remove. A private candidate
 * is written and synced first; hard-link creation is the atomic create-if-absent
 * operation that makes those complete bytes visible at the public lock path.
 */
async function createPrivateLockFile(lockPath: string, owner: LockOwner): Promise<LockSnapshot> {
  const candidatePath = `${lockPath}.candidate.${owner.pid}.${owner.token}`;
  const handle = await open(
    candidatePath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let candidateIdentity = "";
  try {
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
    const stats = await handle.stat({ bigint: true });
    candidateIdentity = lockIdentity(stats.dev, stats.ino);
  } catch (error) {
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }

  try {
    await link(candidatePath, lockPath);
    const published = await readLockSnapshot(lockPath);
    if (
      published === null ||
      published.identity !== candidateIdentity ||
      published.owner?.token !== owner.token
    ) {
      throw lockOwnershipLost(lockPath, owner.token, published);
    }
    return published;
  } finally {
    await unlink(candidatePath).catch(() => undefined);
  }
}

async function readLockSnapshot(lockPath: string): Promise<LockSnapshot | null> {
  let before;
  try {
    before = await lstat(lockPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile()) throw unsafeLockPath(lockPath, describeFileType(before));

  let handle;
  try {
    handle = await open(
      lockPath,
      fsConstants.O_RDONLY |
        (fsConstants.O_NOFOLLOW ?? 0) |
        (fsConstants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw unsafeLockPath(lockPath, "symbolic link");
    }
    throw error;
  }

  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile()) throw unsafeLockPath(lockPath, describeFileType(stats));

    // Always cap the actual read, even if size changes after fstat(). O_NONBLOCK
    // above prevents a raced FIFO/device replacement from hanging setup.
    const buffer = Buffer.alloc(KIMI_CONFIG_LOCK_METADATA_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const metadataTruncated =
      stats.size > BigInt(KIMI_CONFIG_LOCK_METADATA_MAX_BYTES) ||
      bytesRead > KIMI_CONFIG_LOCK_METADATA_MAX_BYTES;
    const raw = metadataTruncated
      ? ""
      : buffer.subarray(0, bytesRead).toString("utf8");
    return {
      identity: lockIdentity(stats.dev, stats.ino),
      owner: parseLockOwner(raw),
      ageMs: Math.max(0, Date.now() - Number(stats.mtimeMs)),
      metadataTruncated,
    };
  } finally {
    await handle.close();
  }
}

function lockIdentity(device: bigint, inode: bigint): string {
  return `${device.toString()}:${inode.toString()}`;
}

function describeFileType(stats: {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFIFO(): boolean;
  isCharacterDevice(): boolean;
  isBlockDevice(): boolean;
  isSocket(): boolean;
}): string {
  if (stats.isSymbolicLink()) return "symbolic link";
  if (stats.isDirectory()) return "directory";
  if (stats.isFIFO()) return "FIFO";
  if (stats.isCharacterDevice()) return "character device";
  if (stats.isBlockDevice()) return "block device";
  if (stats.isSocket()) return "socket";
  return "non-regular file";
}

function unsafeLockPath(lockPath: string, type: string): RuntimeError {
  return new RuntimeError(
    "SETUP_CONFIG_LOCK_UNSAFE",
    `Refusing setup lock ${lockPath}: the path is a ${type}, not a regular private lock file. Remove it manually after verifying its origin; setup will not follow or read it.`,
    "setup.config-lock",
    { details: { lockPath, type } },
  );
}

function parseLockOwner(raw: string): LockOwner | null {
  try {
    const value = JSON.parse(raw) as Partial<LockOwner>;
    if (
      !Number.isInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.token !== "string" ||
      !/^[a-f0-9]{32}$/.test(value.token) ||
      typeof value.createdAt !== "string"
    ) {
      return null;
    }
    return { pid: value.pid!, token: value.token, createdAt: value.createdAt };
  } catch {
    return null;
  }
}

function isStaleLock(snapshot: LockSnapshot, staleMs: number): boolean {
  if (snapshot.ageMs < staleMs) return false;
  return snapshot.owner === null || !isProcessAlive(snapshot.owner.pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function tryRecoverStaleLock(
  lockPath: string,
  observed: LockSnapshot,
  staleMs: number,
): Promise<boolean> {
  const identityHash = createHash("sha256").update(observed.identity).digest("hex").slice(0, 16);
  const recoveryPath = `${lockPath}.recover.${identityHash}`;
  const recoveryOwner: LockOwner = {
    pid: process.pid,
    token: randomBytes(16).toString("hex"),
    createdAt: new Date().toISOString(),
  };
  let recoverySnapshot: LockSnapshot;

  try {
    recoverySnapshot = await createPrivateLockFile(recoveryPath, recoveryOwner);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existingRecovery = await readLockSnapshot(recoveryPath);
    if (existingRecovery !== null && isStaleLock(existingRecovery, staleMs)) {
      // One bounded, non-recursive claim. A crashed recovery lease is renamed
      // to a unique quarantine path, verified there, and removed only when its
      // inode and owner token still match the snapshot we observed.
      await removeStaleRecoveryLease(recoveryPath, existingRecovery);
    }
    return false;
  }

  let recovered = false;
  try {
    await assertOwnedLock(recoveryPath, recoverySnapshot, recoveryOwner.token);
    const current = await readLockSnapshot(lockPath);
    if (
      current !== null &&
      current.identity === observed.identity &&
      current.owner?.token === observed.owner?.token &&
      isStaleLock(current, staleMs)
    ) {
      // The per-identity recovery lock above ensures only one observer of this
      // inode can claim it. Rename is the atomic removal from the public path;
      // verification happens on the claimed inode before its unique name is
      // unlinked, eliminating the old check(path) -> unlink(path) ABA window.
      const quarantinePath = `${lockPath}.stale.${identityHash}.${recoveryOwner.token}`;
      try {
        await rename(lockPath, quarantinePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      const claimed = await readLockSnapshot(quarantinePath);
      if (!sameObservedLock(claimed, observed)) {
        throw new RuntimeError(
          "SETUP_CONFIG_LOCK_RECOVERY_RACE",
          `Setup lock ${lockPath} changed identity while stale recovery claimed it; the claimed file was preserved at ${quarantinePath} instead of being deleted.`,
          "setup.config-lock",
          { details: { lockPath, quarantinePath, observed: observed.identity, claimed: claimed?.identity } },
        );
      }
      await unlink(quarantinePath);
      recovered = true;
    }
  } finally {
    await releaseOwnedLock(recoveryPath, recoverySnapshot, recoveryOwner.token);
  }
  return recovered;
}

async function removeStaleRecoveryLease(
  recoveryPath: string,
  observed: LockSnapshot,
): Promise<void> {
  const quarantinePath =
    `${recoveryPath}.stale.${process.pid}.${randomBytes(16).toString("hex")}`;
  try {
    await rename(recoveryPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  const claimed = await readLockSnapshot(quarantinePath);
  if (!sameObservedLock(claimed, observed)) {
    throw new RuntimeError(
      "SETUP_CONFIG_LOCK_RECOVERY_RACE",
      `Recovery lease ${recoveryPath} changed identity while being claimed; the claimed file was preserved at ${quarantinePath} instead of being deleted.`,
      "setup.config-lock",
      {
        details: {
          recoveryPath,
          quarantinePath,
          observed: observed.identity,
          claimed: claimed?.identity,
        },
      },
    );
  }
  await unlink(quarantinePath);
}

function sameObservedLock(current: LockSnapshot | null, observed: LockSnapshot): boolean {
  return current !== null &&
    current.identity === observed.identity &&
    current.owner?.token === observed.owner?.token;
}

async function assertOwnedLock(
  lockPath: string,
  acquired: LockSnapshot,
  token: string,
): Promise<void> {
  const current = await readLockSnapshot(lockPath);
  if (
    current === null ||
    current.identity !== acquired.identity ||
    current.owner?.token !== token
  ) {
    throw lockOwnershipLost(lockPath, token, current);
  }
}

function lockOwnershipLost(
  lockPath: string,
  expectedToken: string,
  current: LockSnapshot | null,
): RuntimeError {
  return new RuntimeError(
    "SETUP_CONFIG_LOCK_OWNERSHIP_LOST",
    `Setup lock ${lockPath} changed before the protected operation began; refusing to enter the config transaction.`,
    "setup.config-lock",
    {
      details: {
        lockPath,
        expectedToken,
        currentIdentity: current?.identity,
        currentToken: current?.owner?.token,
      },
    },
  );
}

async function releaseOwnedLock(
  lockPath: string,
  acquired: LockSnapshot,
  token: string,
): Promise<void> {
  const current = await readLockSnapshot(lockPath);
  if (
    current === null ||
    current.identity !== acquired.identity ||
    current.owner?.token !== token
  ) return;

  const releasePath = `${lockPath}.release.${token}`;
  try {
    await rename(lockPath, releasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const claimed = await readLockSnapshot(releasePath);
  if (
    claimed === null ||
    claimed.identity !== acquired.identity ||
    claimed.owner?.token !== token
  ) {
    throw new RuntimeError(
      "SETUP_CONFIG_LOCK_RELEASE_RACE",
      `Setup lock ${lockPath} changed identity during release; the claimed file was preserved at ${releasePath}.`,
      "setup.config-lock",
      { details: { lockPath, releasePath, expectedIdentity: acquired.identity, claimedIdentity: claimed?.identity } },
    );
  }
  await unlink(releasePath);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface InlineHooksNormalization {
  contents: string;
  found: boolean;
  converted: boolean;
  entryCount: number;
}

/**
 * Convert a validated top-level inline `hooks = [...]` assignment to canonical
 * `[[hooks]]` tables so setup can append its own array-table entry without
 * redefining the TOML key. Bytes outside that one assignment are untouched;
 * formatting and comments inside the assignment are intentionally normalized.
 */
export function normalizeTopLevelInlineHooks(
  contents: string,
  lineEnding: "\n" | "\r\n",
): InlineHooksNormalization {
  let config: Record<string, unknown>;
  try {
    config = parseToml(contents) as Record<string, unknown>;
  } catch {
    return { contents, found: false, converted: false, entryCount: 0 };
  }

  const assignment = findTopLevelHooksAssignment(contents);
  if (assignment === null) {
    return { contents, found: false, converted: false, entryCount: 0 };
  }
  const hooks = config["hooks"];
  if (!Array.isArray(hooks)) {
    return { contents, found: true, converted: false, entryCount: 0 };
  }

  const rendered: string[] = [];
  for (const entry of hooks) {
    if (!isPlainRecord(entry)) {
      return { contents, found: true, converted: false, entryCount: hooks.length };
    }
    const table = renderCanonicalHookTable(entry, lineEnding);
    if (table === null) {
      return { contents, found: true, converted: false, entryCount: hooks.length };
    }
    rendered.push(table);
  }

  const replacementBody = rendered.join(`${lineEnding}${lineEnding}`);
  const replacement = replacementBody.length > 0 && assignment.hadLineEnding
    ? `${replacementBody}${lineEnding}`
    : replacementBody;
  return {
    contents: `${contents.slice(0, assignment.start)}${replacement}${contents.slice(assignment.end)}`,
    found: true,
    converted: true,
    entryCount: hooks.length,
  };
}

function findTopLevelHooksAssignment(
  contents: string,
): { start: number; end: number; hadLineEnding: boolean } | null {
  let ptr = skipVoid(contents, 0);
  while (ptr < contents.length) {
    // A root-level direct assignment cannot resume after entering a table.
    if (contents[ptr] === "[") return null;
    const declarationStart = ptr;
    const [key, valueStart] = parseKey(contents, ptr);
    const [, valueEnd] = extractValue(contents, valueStart, undefined, 1_000, undefined);
    if (key.length === 1 && key[0] === "hooks") {
      const lineStart = contents.lastIndexOf("\n", declarationStart - 1) + 1;
      const start = /^[\t ]*$/.test(contents.slice(lineStart, declarationStart))
        ? lineStart
        : declarationStart;
      let end = valueEnd;
      while (end < contents.length && contents[end] !== "\n" && contents[end] !== "\r") end += 1;
      let hadLineEnding = false;
      if (contents[end] === "\r" && contents[end + 1] === "\n") {
        end += 2;
        hadLineEnding = true;
      } else if (contents[end] === "\r" || contents[end] === "\n") {
        end += 1;
        hadLineEnding = true;
      }
      return { start, end, hadLineEnding };
    }
    ptr = skipVoid(contents, valueEnd);
  }
  return null;
}

function renderCanonicalHookTable(
  entry: Record<string, unknown>,
  lineEnding: "\n" | "\r\n",
): string | null {
  const lines = ["[[hooks]]"];
  for (const field of ["event", "matcher", "command", "timeout"] as const) {
    if (!Object.hasOwn(entry, field)) continue;
    const value = entry[field];
    if (field === "timeout") {
      if (typeof value !== "number" || !Number.isInteger(value)) return null;
      lines.push(`${field} = ${value}`);
    } else {
      if (typeof value !== "string") return null;
      lines.push(`${field} = ${JSON.stringify(value)}`);
    }
  }
  if (Object.keys(entry).some((field) => !HOOK_FIELDS.has(field))) return null;
  return lines.join(lineEnding);
}

export interface KimiHookSetValidation {
  valid: boolean;
  reason?: string;
  entry?: number;
  line?: number;
}

interface VersionSensitiveEvent {
  event: string;
  minimumMinor: number;
  entry: number;
  line: number;
}

interface HookSetInspection {
  validation: KimiHookSetValidation;
  versionSensitiveEvents: VersionSensitiveEvent[];
}

/**
 * Validate the complete configured hook array against kimi-code's strict
 * HookDef schema. Upstream salvages a bad `hooks[n]` issue by dropping the
 * entire `hooks` section, so one foreign invalid entry disables our otherwise
 * canonical PreToolUse block too.
 */
export function validateKimiHookSet(
  contents: string,
  version?: { major: number; minor: number },
): KimiHookSetValidation {
  const inspection = inspectKimiHookSet(contents);
  if (!inspection.validation.valid) return inspection.validation;
  return validateVersionSensitiveEvents(inspection.versionSensitiveEvents, version);
}

/** Probe `kimi --version` only when the config uses an additive hook event. */
export async function validateKimiHookSetForEnvironment(
  contents: string,
  env: NodeJS.ProcessEnv,
): Promise<KimiHookSetValidation> {
  const inspection = inspectKimiHookSet(contents);
  if (!inspection.validation.valid || inspection.versionSensitiveEvents.length === 0) {
    return inspection.validation;
  }
  const probe = await probeKimiVersion({
    kimiBin: env.KIMI_PLUGIN_CC_KIMI_BIN || undefined,
    env,
  });
  const first = inspection.versionSensitiveEvents[0]!;
  if (probe.kind === "failed") {
    return invalidHookSet(
      `cannot verify version-sensitive event ${JSON.stringify(first.event)} because kimi-code version detection failed (${probe.reason})`,
      first.entry,
      first.line,
    );
  }
  return validateVersionSensitiveEvents(inspection.versionSensitiveEvents, probe);
}

function inspectKimiHookSet(contents: string): HookSetInspection {
  let config: Record<string, unknown>;
  try {
    config = parseToml(contents) as Record<string, unknown>;
  } catch (error) {
    const line = tomlErrorLine(error);
    return {
      validation: invalidHookSet(
        `TOML parse failed: ${error instanceof Error ? error.message : String(error)}`,
        0,
        line,
        "parse",
      ),
      versionSensitiveEvents: [],
    };
  }

  const versionSensitiveEvents: VersionSensitiveEvent[] = [];
  const hooks = config["hooks"];
  if (hooks === undefined) return { validation: { valid: true }, versionSensitiveEvents };
  if (!Array.isArray(hooks)) {
    return {
      validation: invalidHookSet("top-level `hooks` must be an array of hook entries", 0, 1),
      versionSensitiveEvents,
    };
  }

  const entryLines = findHookEntryLines(contents);
  for (let offset = 0; offset < hooks.length; offset += 1) {
    const entry = hooks[offset];
    const index = offset + 1;
    const line = entryLines[offset] ?? 1;
    if (!isPlainRecord(entry)) {
      return {
        validation: invalidHookSet("hook entry must be a TOML table", index, line),
        versionSensitiveEvents,
      };
    }
    const result = validateHookEntry(entry, index, line, versionSensitiveEvents);
    if (!result.valid) return { validation: result, versionSensitiveEvents };
  }
  return { validation: { valid: true }, versionSensitiveEvents };
}

function validateHookEntry(
  entry: Record<string, unknown>,
  index: number,
  line: number,
  versionSensitiveEvents: VersionSensitiveEvent[],
): KimiHookSetValidation {
  for (const field of Object.keys(entry)) {
    if (!HOOK_FIELDS.has(field)) {
      return invalidHookSet(
        `unknown field ${JSON.stringify(field)} (allowed: event, matcher, command, timeout)`,
        index,
        line,
      );
    }
  }

  const event = entry["event"];
  if (event === undefined) return invalidHookSet("missing required field `event`", index, line);
  if (typeof event !== "string") return invalidHookSet("`event` must be a string", index, line);
  const minimumMinor = VERSION_SENSITIVE_HOOK_EVENTS.get(event);
  if (!BASE_HOOK_EVENTS.has(event) && minimumMinor === undefined) {
    return invalidHookSet(`unsupported hook event ${JSON.stringify(event)}`, index, line);
  }
  if (minimumMinor !== undefined) {
    versionSensitiveEvents.push({
      event,
      minimumMinor,
      entry: index,
      line,
    });
  }

  const command = entry["command"];
  if (command === undefined) return invalidHookSet("missing required field `command`", index, line);
  if (typeof command !== "string" || command.length === 0) {
    return invalidHookSet("`command` must be a non-empty string", index, line);
  }

  const matcher = entry["matcher"];
  if (matcher !== undefined && typeof matcher !== "string") {
    return invalidHookSet("`matcher` must be a string when present", index, line);
  }

  const timeout = entry["timeout"];
  if (
    timeout !== undefined &&
    (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > 600)
  ) {
    return invalidHookSet("`timeout` must be an integer from 1 through 600", index, line);
  }
  return { valid: true };
}

function validateVersionSensitiveEvents(
  events: VersionSensitiveEvent[],
  version?: { major: number; minor: number },
): KimiHookSetValidation {
  if (events.length === 0) return { valid: true };
  const first = events[0]!;
  if (version === undefined) {
    return invalidHookSet(
      `version-sensitive event ${JSON.stringify(first.event)} requires a verified kimi-code version`,
      first.entry,
      first.line,
    );
  }
  if (version.major !== 0) {
    return invalidHookSet(
      `version-sensitive event ${JSON.stringify(first.event)} has no verified schema contract for kimi-code ${version.major}.${version.minor}`,
      first.entry,
      first.line,
    );
  }
  for (const event of events) {
    if (version.minor < event.minimumMinor) {
      return invalidHookSet(
        `event ${JSON.stringify(event.event)} requires kimi-code >= 0.${event.minimumMinor}, but the installed version is 0.${version.minor}`,
        event.entry,
        event.line,
      );
    }
  }
  return { valid: true };
}

function invalidHookSet(
  reason: string,
  entry: number,
  line: number,
  failureKind: "schema" | "parse" = "schema",
): KimiHookSetValidation {
  const location = entry > 0 ? `hooks[${entry - 1}] at line ${line}` : `hooks configuration at line ${line}`;
  const consequence = failureKind === "parse"
    ? "kimi-code cannot parse this config, so no configured PreToolUse hook will load."
    : "kimi-code drops the entire hooks array when any entry fails its strict schema, so no configured PreToolUse hook will run.";
  return {
    valid: false,
    reason: `${location} is invalid: ${reason}. ${consequence}`,
    entry,
    line,
  };
}

function tomlErrorLine(error: unknown): number {
  if (typeof error !== "object" || error === null) return 1;
  const line = (error as { line?: unknown }).line;
  return typeof line === "number" && Number.isInteger(line) && line > 0 ? line : 1;
}

function findHookEntryLines(contents: string): number[] {
  const lines: number[] = [];
  const header = /^\s*\[\[\s*(?:hooks|"hooks"|'hooks')\s*\]\]\s*(?:#.*)?$/;
  for (const [offset, line] of contents.split(/\r?\n/).entries()) {
    if (header.test(line)) lines.push(offset + 1);
  }
  return lines;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
