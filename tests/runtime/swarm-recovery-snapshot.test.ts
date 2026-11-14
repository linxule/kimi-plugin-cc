import { describe, expect, test } from "bun:test";

import type { JobStore } from "../../runtime/job-store.js";
import type { ProcessIdentity } from "../../runtime/process-tree.js";
import {
  inspectRecoveryLaunchProcesses,
  recordRecoveryEvent,
  validateRecoveryGroupMembers,
  type SwarmRecoveryEvent,
  type SwarmRecoveryRecord,
} from "../../runtime/swarm-recovery.js";

const rootIdentity: ProcessIdentity = {
  pid: 71001, processGroupId: 71001, startToken: "ps:print-root", state: "S",
};

function childIdentity(sequence: number): ProcessIdentity {
  const pid = 72000 + sequence;
  return { pid, processGroupId: pid, startToken: `ps:child-${sequence}`, state: "S" };
}

function fixture(kind: "print" | "web" = "print", withRoot = true) {
  const record: SwarmRecoveryRecord = {
    schema: 1,
    jobId: "snapshot-probe",
    ownerPid: 71000,
    owner: { pid: 71000, processGroupId: 71000, startToken: "ps:companion", state: "S" },
    kimiHome: "/virtual/kimi-home",
    cwd: "/virtual/user-repo",
    workspaceRoot: null,
    launches: [],
    session: null,
    sessionDirty: false,
    complete: false,
    patchPath: null,
  };
  const saved: SwarmRecoveryRecord[] = [];
  const store = {
    saveSwarmRecovery(jobId: string, value: SwarmRecoveryRecord) {
      expect(jobId).toBe(record.jobId);
      saved.push(structuredClone(value));
    },
  } as unknown as JobStore;
  const emit = (event: SwarmRecoveryEvent) => recordRecoveryEvent(store, record, event);
  emit({ kind: `${kind}-spawn` });
  if (withRoot) emit({ kind: `${kind}-processes`, identities: [rootIdentity], complete: true });
  const snapshot = (identities: ProcessIdentity[], complete = true) => {
    emit({ kind: "print-processes-snapshot", identities, complete });
  };
  return { record, saved, emit, snapshot, launch: record.launches[0]! };
}

describe("bounded swarm recovery process snapshots", () => {
  test("hundreds of completed ephemeral children leave only the root and current child durable", () => {
    const { record, saved, snapshot, launch } = fixture();
    for (let sequence = 0; sequence < 400; sequence++) {
      const current = childIdentity(sequence);
      snapshot([current, rootIdentity]);
      expect(launch.identities).toEqual([rootIdentity, current]);
      expect(saved.at(-1)?.launches[0]?.identities).toEqual([rootIdentity, current]);
    }
    expect(saved).toHaveLength(402);
    expect(Math.max(...saved.map((row) => row.launches[0]!.identities.length))).toBe(2);
    expect(launch).toMatchObject({ pending: false, uncertain: false, quiescent: false });
    expect(saved.at(-1)?.launches[0]?.boundedSnapshot).toBe(true);
    expect(record.complete).toBe(false);
    expect(launch.identities.map((identity) => identity.processGroupId)).toEqual([71001, 72399]);
  });

  test("the original root stays first after it exits and a complete snapshot becomes empty", () => {
    const { snapshot, launch, saved } = fixture();
    const child = childIdentity(1);
    snapshot([child]);
    expect(launch.identities).toEqual([rootIdentity, child]);
    snapshot([]);
    expect(launch.identities).toEqual([rootIdentity]);
    expect(saved.at(-1)?.launches[0]).toMatchObject({
      identities: [rootIdentity], pending: false, uncertain: false, quiescent: false,
    });
  });

  test("incomplete snapshots retain unresolved children until a complete snapshot prunes them", () => {
    const { snapshot, launch, saved } = fixture();
    const oldChild = childIdentity(1);
    const unresolvedChild = childIdentity(2);
    const currentChild = childIdentity(3);
    snapshot([oldChild]);
    snapshot([unresolvedChild], false);
    expect(launch.identities).toEqual([rootIdentity, oldChild, unresolvedChild]);
    expect(launch.uncertain).toBe(true);
    snapshot([], false);
    expect(saved.at(-1)?.launches[0]).toMatchObject({
      identities: [rootIdentity, oldChild, unresolvedChild], uncertain: true, pending: false,
    });
    snapshot([currentChild]);
    expect(launch.identities).toEqual([rootIdentity, currentChild]);
    expect(launch.uncertain).toBe(false);
    expect(saved.at(-1)?.launches[0]?.uncertain).toBe(false);
  });

  test("a complete empty snapshot clears earlier uncertainty without losing the root anchor", () => {
    const { snapshot, launch } = fixture();
    snapshot([childIdentity(1)], false);
    expect(launch.uncertain).toBe(true);
    snapshot([]);
    expect(launch.identities).toEqual([rootIdentity]);
    expect(launch).toMatchObject({ uncertain: false, pending: false, quiescent: false });
  });

  test("a reused child PID with a new start token replaces the old incarnation", () => {
    const { snapshot, launch } = fixture();
    const original = childIdentity(1);
    const replacement = { ...original, startToken: "ps:replacement", processGroupId: 81999 };
    snapshot([original]);
    snapshot([replacement]);
    expect(launch.identities).toEqual([rootIdentity, replacement]);
    expect(launch.identities).not.toContainEqual(original);
  });

  test("changed PGIDs retain the original ownership proof and group validation refuses without signalling", async () => {
    const { snapshot, launch } = fixture();
    const child = childIdentity(1);
    snapshot([child]);
    const movedRoot = { ...rootIdentity, processGroupId: 81001 };
    const movedChild = { ...child, processGroupId: 82001 };
    snapshot([movedChild, movedRoot]);
    expect(launch.identities).toEqual([rootIdentity, child]);

    // Exercise the pure proof gate with synthetic identities; no process is
    // spawned, probed, or signalled by this test.
    const validations: ProcessIdentity[][] = [];
    await expect(validateRecoveryGroupMembers(launch.identities, [movedRoot, movedChild], async (identities) => {
      validations.push([...identities]);
      if (identities.some((identity) => identity.processGroupId === rootIdentity.processGroupId)) {
        return { identities: [], complete: true, groupChanged: [movedRoot, movedChild] };
      }
      return { identities: [...identities], complete: true };
    })).rejects.toMatchObject({ code: "SWARM_RECOVERY_REQUIRED", stage: "swarm.recovery" });
    expect(validations).toContainEqual([rootIdentity, child]);
    expect(launch.identities).toEqual([rootIdentity, child]);
    expect(launch.quiescent).toBe(false);
  });

  test.each([true, false])("a snapshot without a previously durable root fails closed (complete=%s)", (complete) => {
    const { snapshot, launch, saved } = fixture("print", false);
    expect(() => snapshot([rootIdentity, childIdentity(1)], complete)).toThrow(expect.objectContaining({
      code: "SWARM_RECOVERY_REQUIRED", stage: "swarm.recovery",
    }));
    expect(launch).toMatchObject({ identities: [], pending: true, quiescent: false });
    expect(saved).toHaveLength(1);
  });

  test("a print snapshot cannot borrow a web launch as its durable root", () => {
    const { snapshot, launch, saved } = fixture("web");
    expect(() => snapshot([childIdentity(1)])).toThrow(expect.objectContaining({ code: "SWARM_RECOVERY_REQUIRED" }));
    expect(launch.identities).toEqual([rootIdentity]);
    expect(saved).toHaveLength(2);
  });

  test.each(["print", "web"] as const)("legacy %s process events keep their union and sticky uncertainty", (kind) => {
    const { emit, launch } = fixture(kind);
    const oldChild = childIdentity(1);
    const newChild = childIdentity(2);
    emit({ kind: `${kind}-processes`, identities: [oldChild], complete: false });
    emit({ kind: `${kind}-processes`, identities: [newChild], complete: true });
    emit({ kind: `${kind}-processes`, identities: [], complete: true });
    expect(launch.identities).toEqual([rootIdentity, oldChild, newChild]);
    expect(launch).toMatchObject({ uncertain: true, pending: false, quiescent: false });
    expect(launch.boundedSnapshot).toBeUndefined();
  });
});

describe("bounded recovery group inspection", () => {
  test("an exited root's reused group is never queried or offered as a signal target", async () => {
    const { snapshot, launch } = fixture();
    const child = childIdentity(1);
    snapshot([child]);
    const queried: number[][] = [];
    const unrelated = { pid: 85000, processGroupId: rootIdentity.processGroupId, startToken: "ps:unrelated", state: "S" };
    const targets = await inspectRecoveryLaunchProcesses(launch, async (identities) => ({
      identities: identities.filter((identity) => identity.pid !== rootIdentity.pid), complete: true,
    }), async (groups) => {
      queried.push([...groups]);
      return groups.includes(rootIdentity.processGroupId) ? [child, unrelated] : [child];
    });
    expect(queried).toEqual([[child.processGroupId]]);
    expect(targets).toEqual([child]);
    expect(targets).not.toContainEqual(unrelated);
    expect(launch.identities).toEqual([rootIdentity, child]);
  });

  test("when every recorded process is gone, no historical numeric group is queried", async () => {
    const { snapshot, launch } = fixture();
    snapshot([childIdentity(1)]);
    let queries = 0;
    const targets = await inspectRecoveryLaunchProcesses(launch, async () => ({ identities: [], complete: true }), async () => {
      queries += 1;
      throw new Error("an exited process grants no group ownership");
    });
    expect(targets).toEqual([]);
    expect(queries).toBe(0);
    expect(launch.identities[0]).toEqual(rootIdentity);
  });

  test.each(["incomplete", "moved"] as const)("%s live identity evidence refuses before any group query", async (failure) => {
    const { snapshot, launch } = fixture();
    const child = childIdentity(1);
    snapshot([child]);
    let queries = 0;
    await expect(inspectRecoveryLaunchProcesses(launch, async () => ({
      identities: [child], complete: failure !== "incomplete",
      ...(failure === "moved" ? { groupChanged: [{ ...rootIdentity, processGroupId: 81001 }] } : {}),
    }), async () => {
      queries += 1;
      return [child];
    })).rejects.toMatchObject({ code: "SWARM_RECOVERY_REQUIRED", stage: "swarm.recovery" });
    expect(queries).toBe(0);
    expect(launch.quiescent).toBe(false);
  });

  test("an unrecorded member of a live owned group still refuses cleanup", async () => {
    const { snapshot, launch } = fixture();
    const child = childIdentity(1);
    const unrelated = { ...childIdentity(2), processGroupId: child.processGroupId };
    snapshot([child]);
    const queried: number[][] = [];
    await expect(inspectRecoveryLaunchProcesses(launch, async (identities) => ({
      identities: identities.filter((identity) => identity.pid !== rootIdentity.pid), complete: true,
    }), async (groups) => {
      queried.push([...groups]);
      return [child, unrelated];
    })).rejects.toMatchObject({ code: "SWARM_RECOVERY_REQUIRED", stage: "swarm.recovery" });
    expect(queried).toEqual([[child.processGroupId]]);
    expect(launch.identities).toEqual([rootIdentity, child]);
    expect(launch.quiescent).toBe(false);
  });

  test("an unreadable live group fails closed", async () => {
    const { snapshot, launch } = fixture();
    snapshot([]);
    await expect(inspectRecoveryLaunchProcesses(launch,
      async (identities) => ({ identities: [...identities], complete: true }),
      async () => undefined,
    )).rejects.toMatchObject({ code: "SWARM_RECOVERY_REQUIRED", stage: "swarm.recovery" });
  });

  test.each(["print", "web"] as const)("legacy %s launches still inspect all stored groups", async (kind) => {
    const { emit, launch } = fixture(kind);
    const child = childIdentity(1);
    emit({ kind: `${kind}-processes`, identities: [child], complete: true });
    const queried: number[][] = [];
    expect(await inspectRecoveryLaunchProcesses(launch, async () => ({ identities: [], complete: true }), async (groups) => {
      queried.push([...groups]);
      return [];
    })).toEqual([]);
    expect(queried).toEqual([[rootIdentity.processGroupId, child.processGroupId]]);
  });

  test("a snapshot marker on a web launch does not opt it into print-only pruning", async () => {
    const { launch } = fixture("web");
    launch.boundedSnapshot = true;
    const queried: number[][] = [];
    expect(await inspectRecoveryLaunchProcesses(launch, async () => ({ identities: [], complete: true }), async (groups) => {
      queried.push([...groups]);
      return [];
    })).toEqual([]);
    expect(queried).toEqual([[rootIdentity.processGroupId]]);
  });
});
