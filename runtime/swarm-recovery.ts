import { RuntimeError } from "./errors.js";
import type { JobStore } from "./job-store.js";
import { collectDescendantIdentities, collectProcessGroupsIdentities, probeProcessIdentity, revalidateProcessIdentities, type ProcessIdentity } from "./process-tree.js";

export type SwarmRecoveryEvent =
  | { kind: "web-spawn" | "print-spawn" | "web-exit" | "print-exit" | "disabled" }
  | { kind: "web-processes" | "print-processes"; identities: ProcessIdentity[]; complete: boolean }
  | { kind: "session"; sessionId: string; workspaceId: string };
export interface RecoveryLaunch {
  kind: "web" | "print";
  pending: boolean;
  identities: ProcessIdentity[];
  quiescent: boolean;
  uncertain: boolean;
}
export interface SwarmRecoveryRecord {
  schema: 1;
  jobId: string;
  ownerPid: number;
  owner: ProcessIdentity | null;
  kimiHome: string;
  cwd: string;
  workspaceRoot: string | null;
  launches: RecoveryLaunch[];
  session: { sessionId: string; workspaceId: string } | null;
  sessionDirty: boolean;
  complete: boolean;
  patchPath: string | null;
}

export function recordRecoveryEvent(store: JobStore, record: SwarmRecoveryRecord, event: SwarmRecoveryEvent): void {
  record.complete = false;
  if (event.kind === "session") {
    record.session = { sessionId: event.sessionId, workspaceId: event.workspaceId };
    // Write-ahead: this must commit before the profile mutation is attempted.
    record.sessionDirty = true;
  } else if (event.kind === "disabled") {
    record.sessionDirty = false;
  } else if (event.kind.endsWith("-spawn")) {
    record.launches.push({ kind: event.kind === "web-spawn" ? "web" : "print", pending: true, identities: [], quiescent: false, uncertain: false });
  } else {
    const kind = event.kind.startsWith("web-") ? "web" : "print";
    const launch = [...record.launches].reverse().find((entry) => entry.kind === kind);
    if (!launch) throw recoveryError("Missing durable launch intent.");
    if (event.kind === "web-exit" || event.kind === "print-exit") {
      launch.quiescent = true;
      launch.pending = false;
    } else if ("identities" in event) {
      const all = [...launch.identities, ...event.identities];
      launch.identities = [...new Map(all.map((identity) => [`${identity.pid}:${identity.startToken}:${identity.processGroupId}`, identity])).values()];
      launch.pending = launch.identities.length === 0;
      launch.uncertain ||= !event.complete;
    }
  }
  store.saveSwarmRecovery(record.jobId, record);
}

export function finishRecoveryRecord(store: JobStore, record: SwarmRecoveryRecord): void {
  record.complete = !record.sessionDirty && record.launches.every((entry) => entry.quiescent)
    && (record.workspaceRoot === null || record.patchPath !== null);
  store.saveSwarmRecovery(record.jobId, record);
}

export function recoveryError(message: string): RuntimeError {
  return new RuntimeError("SWARM_RECOVERY_REQUIRED", message, "swarm.recovery");
}

export async function assertRecoveryOwnerGone(record: SwarmRecoveryRecord): Promise<void> {
  if (!record.owner || process.platform === "win32") throw recoveryError("No durable, verifiable owner identity; recovery requires manual inspection on this host.");
  const probe = await probeProcessIdentity(record.ownerPid);
  if (!probe.complete) throw recoveryError("Cannot verify the original companion's identity.");
  if (probe.identity?.startToken === record.owner.startToken && !/^[ZX]/i.test(probe.identity.state)) {
    throw recoveryError("The original companion is still alive. Use cancel for a running job, not recovery.");
  }
}

/**
 * Linux may fall back from /proc to ps for a whole-group snapshot while targeted
 * identity reads still use /proc. Those start tokens are different namespaces,
 * not different processes. Prove both representations current around the known
 * identity read; never accept a member based on PID/PGID equality alone.
 */
export async function validateRecoveryGroupMembers(
  known: readonly ProcessIdentity[],
  members: readonly ProcessIdentity[],
  validate: typeof revalidateProcessIdentities = revalidateProcessIdentities,
): Promise<ProcessIdentity[]> {
  const membership = await validate(members);
  const ownership = await validate(known);
  const membershipAfter = await validate(membership.identities);
  for (const proof of [membership, ownership, membershipAfter]) {
    if (!proof.complete || proof.groupChanged?.length) throw recoveryError("Process ownership or group membership is uncertain.");
  }
  for (const member of membershipAfter.identities) {
    const owner = ownership.identities.find((id) => id.pid === member.pid && id.processGroupId === member.processGroupId);
    const crossNamespace = owner && (
      (owner.startToken.startsWith("proc:") && member.startToken.startsWith("ps:")) ||
      (owner.startToken.startsWith("ps:") && member.startToken.startsWith("proc:"))
    );
    if (!owner || (owner.startToken !== member.startToken && !crossNamespace)) {
      throw recoveryError("An unrecorded process survives in the recorded group; refusing group cleanup.");
    }
  }
  return ownership.identities;
}

/** Never signal an unproven group, PID replacement, or changed-PGID process. */
export async function recoverLaunch(launch: RecoveryLaunch, persist: () => void, signal?: AbortSignal): Promise<void> {
  if (launch.quiescent) return;
  if (launch.pending || launch.uncertain || launch.identities.length === 0) {
    throw recoveryError("Launch ownership was not fully recorded before interruption; manual inspection is required. No process was signalled.");
  }
  const root = launch.identities[0]!;
  const rootProbe = await probeProcessIdentity(root.pid);
  if (!rootProbe.complete) throw recoveryError("Process identity probe is incomplete.");
  if (rootProbe.identity?.startToken === root.startToken) {
    if (rootProbe.identity.processGroupId !== root.processGroupId) throw recoveryError("The recorded root changed process groups; refusing to signal it.");
    const descendants = await collectDescendantIdentities(root.pid);
    // Revalidate the ancestry anchor after collection before retaining new identities.
    const after = await probeProcessIdentity(root.pid);
    if (!after.complete || after.identity?.startToken !== root.startToken || after.identity.processGroupId !== root.processGroupId) {
      throw recoveryError("Process ownership changed during recovery inspection.");
    }
    launch.identities = [...new Map([...launch.identities, ...descendants].map((id) => [`${id.pid}:${id.startToken}:${id.processGroupId}`, id])).values()];
    persist();
  }
  const inspect = async () => {
    const members = await collectProcessGroupsIdentities(launch.identities.map((id) => id.processGroupId));
    if (members === undefined) throw recoveryError("Process group membership is unreadable.");
    return validateRecoveryGroupMembers(launch.identities, members);
  };
  for (const [killSignal, waitMs] of [["SIGTERM", 1500], ["SIGKILL", 500]] as const) {
    signal?.throwIfAborted();
    for (const identity of await inspect()) {
      signal?.throwIfAborted();
      const current = await revalidateProcessIdentities([identity]);
      if (!current.complete || current.groupChanged?.length) throw recoveryError("Process identity changed before signalling.");
      if (current.identities.length) {
        try { process.kill(identity.pid, killSignal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw recoveryError("Unable to stop the recorded process."); }
      }
    }
    const deadline = Date.now() + waitMs;
    do {
      signal?.throwIfAborted();
      if ((await inspect()).length === 0) { launch.quiescent = true; persist(); return; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
  }
  throw recoveryError("Recorded processes did not become quiescent; recovery remains pending.");
}
