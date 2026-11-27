import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";

import type { JobStore } from "../../runtime/job-store.js";
import { processGroupIsProvenEmpty, type ProcessIdentity } from "../../runtime/process-tree.js";
import {
  inspectRecoveryLaunchProcesses,
  recordPrintSnapshot,
  recordRecoveryEvent,
  recoverLaunch,
  validateRecoveryGroupMembers,
  type PrintRootEvidence,
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
  const snapshot = (identities: ProcessIdentity[], complete = true, evidence: Partial<PrintRootEvidence> = {}) => {
    emit({ kind: "print-processes-snapshot", identities, complete, ...evidence });
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

describe("a print root that exited before its identity was read", () => {
  const refusal = expect.objectContaining({
    code: "SWARM_RECOVERY_REQUIRED",
    message: expect.stringContaining("The print root identity was not durably recorded before its process snapshot."),
  });
  const settled: PrintRootEvidence = { rootExited: true, rootClosed: true, rootGroupEmpty: true };

  function rootless(probeComplete = true) {
    const built = fixture("print", false);
    // What the spawn callback records when the probe finds no process, or cannot finish.
    built.emit({ kind: "print-processes", identities: [], complete: probeComplete });
    expect(built.launch).toMatchObject({ pending: true, identities: [], uncertain: !probeComplete, quiescent: false });
    return built;
  }

  test("settles on a complete empty pass once the root exited, its pipes closed and its group is empty", () => {
    const { snapshot, launch, saved, emit } = rootless();
    snapshot([], true, settled);
    expect(launch).toMatchObject({ pending: false, uncertain: false, identities: [], quiescent: false, boundedSnapshot: true, rootUnidentified: true });
    expect(saved.at(-1)?.launches[0]).toMatchObject({ pending: false, rootUnidentified: true });
    // Repeated passes after exit stay accepted, and the exit event completes the launch.
    snapshot([], true, settled);
    emit({ kind: "print-exit" });
    expect(launch).toMatchObject({ quiescent: true, pending: false, identities: [] });
  });

  test("a spawn probe that timed out on a root that later exits settles the same way", () => {
    const { snapshot, launch } = rootless(false);
    snapshot([], true, settled);
    expect(launch).toMatchObject({ pending: false, uncertain: false, rootUnidentified: true });
  });

  test.each([
    ["the root has not been reported as exited", [] as ProcessIdentity[], true, { ...settled, rootExited: false }],
    ["its pipes have not closed", [] as ProcessIdentity[], true, { ...settled, rootClosed: false }],
    ["its process group still has a member, or could not be read", [] as ProcessIdentity[], true, { ...settled, rootGroupEmpty: false }],
    ["the exit report is absent", [] as ProcessIdentity[], true, { rootClosed: true, rootGroupEmpty: true }],
    ["the pipe report is absent", [] as ProcessIdentity[], true, { rootExited: true, rootGroupEmpty: true }],
    ["the group reading is absent", [] as ProcessIdentity[], true, { rootExited: true, rootClosed: true }],
    ["no evidence is carried at all", [] as ProcessIdentity[], true, {}],
    ["the pass is incomplete", [] as ProcessIdentity[], false, settled],
    ["a descendant is still tracked", [childIdentity(1)], true, settled],
    ["a descendant is tracked on an incomplete pass", [childIdentity(1)], false, settled],
  ] as const)("refuses while %s", (_name, identities, complete, evidence) => {
    const { snapshot, launch, saved } = rootless();
    const before = saved.length;
    expect(() => snapshot([...identities], complete, evidence)).toThrow(refusal);
    expect(launch).toMatchObject({ pending: true, identities: [], quiescent: false });
    expect(launch.rootUnidentified).toBeUndefined();
    expect(launch.boundedSnapshot).toBeUndefined();
    expect(saved).toHaveLength(before);
  });

  test("a refusal does not stop a later valid pass from settling", () => {
    const { snapshot, launch } = rootless();
    expect(() => snapshot([childIdentity(1)], true, settled)).toThrow(refusal);
    expect(() => snapshot([], true, { ...settled, rootExited: false })).toThrow(refusal);
    snapshot([], true, settled);
    expect(launch).toMatchObject({ pending: false, rootUnidentified: true });
  });

  test("a descendant seen after a rootless settlement is refused, not adopted", () => {
    const { snapshot, launch } = rootless();
    snapshot([], true, settled);
    expect(() => snapshot([childIdentity(2)], true, settled)).toThrow(refusal);
    expect(launch.identities).toEqual([]);
  });

  test("a recorded root never takes the rootless path, whatever the evidence says", () => {
    const { snapshot, launch } = fixture();
    snapshot([], true, { rootExited: false, rootClosed: false, rootGroupEmpty: false });
    snapshot([], true, settled);
    expect(launch.identities).toEqual([rootIdentity]);
    expect(launch.rootUnidentified).toBeUndefined();
  });
});

describe("the process-group probe behind a rootless settlement", () => {
  const rootPid = 71001;
  const exited = { identities: [] as ProcessIdentity[], complete: true, rootExited: true, rootClosed: true };
  const refusal = expect.objectContaining({ code: "SWARM_RECOVERY_REQUIRED" });

  function build(withRoot: boolean) {
    const built = fixture("print", withRoot);
    if (!withRoot) built.emit({ kind: "print-processes", identities: [], complete: true });
    const probes: number[] = [];
    const probe = (provenEmpty: boolean) => (processGroupId: number) => {
      probes.push(processGroupId);
      return provenEmpty;
    };
    const store = { saveSwarmRecovery() {} } as unknown as JobStore;
    return { ...built, probes, probe, store };
  }

  test("a group the kernel reports as gone settles the launch, and only the root's own group is probed", () => {
    const { record, launch, probes, probe, store } = build(false);
    recordPrintSnapshot(store, record, exited, rootPid, probe(true));
    expect(probes).toEqual([rootPid]);
    expect(launch).toMatchObject({ pending: false, rootUnidentified: true });
  });

  test("a group not proven empty refuses", () => {
    const { record, launch, probes, probe, store } = build(false);
    expect(() => recordPrintSnapshot(store, record, exited, rootPid, probe(false))).toThrow(refusal);
    expect(probes).toEqual([rootPid]);
    expect(launch).toMatchObject({ pending: true, identities: [] });
    expect(launch.rootUnidentified).toBeUndefined();
  });

  test.each([
    ["the root has not exited", { ...exited, rootExited: false }],
    ["its pipes are open", { ...exited, rootClosed: false }],
    ["the pass is incomplete", { ...exited, complete: false }],
    ["a descendant is tracked", { ...exited, identities: [childIdentity(1)] }],
  ])("no group is probed, and the snapshot is refused, while %s", (_name, snapshot) => {
    const { record, probes, probe, store } = build(false);
    expect(() => recordPrintSnapshot(store, record, snapshot, rootPid, probe(true))).toThrow(refusal);
    expect(probes).toEqual([]);
  });

  test("an unknown root PID refuses without probing any group", () => {
    const { record, probes, probe, store } = build(false);
    expect(() => recordPrintSnapshot(store, record, exited, undefined, probe(true))).toThrow(refusal);
    expect(probes).toEqual([]);
  });

  test("a recorded root is never probed", () => {
    const { record, launch, probes, probe, store } = build(true);
    recordPrintSnapshot(store, record, exited, rootPid, probe(false));
    recordPrintSnapshot(store, record, { ...exited, rootExited: false, rootClosed: false, identities: [childIdentity(3)] }, rootPid, probe(false));
    expect(probes).toEqual([]);
    expect(launch.identities).toEqual([rootIdentity, childIdentity(3)]);
    expect(launch.rootUnidentified).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("the kernel process-group probe", () => {
  test("reports a live group as not proven empty and a reaped one as empty, without signalling it", async () => {
    const child = spawn("sleep", ["5"], { detached: true, stdio: "ignore" });
    try {
      const pid = child.pid!;
      expect(processGroupIsProvenEmpty(pid)).toBe(false);
      // The probe delivered nothing: the member is still running.
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      const exit = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exit;
      expect(processGroupIsProvenEmpty(pid)).toBe(true);
    } finally {
      try { child.kill("SIGKILL"); } catch { /* Already gone. */ }
    }
  });

  test.each([0, 1, -5, 1.5, Number.NaN])("refuses the unusable group id %p", (id) => {
    expect(processGroupIsProvenEmpty(id)).toBe(false);
  });
});

describe("recovery of a launch with no recorded root", () => {
  test("a settled one is finished without probing or signalling anything", async () => {
    const { launch, emit } = fixture("print", false);
    emit({ kind: "print-processes", identities: [], complete: true });
    emit({ kind: "print-processes-snapshot", identities: [], complete: true, rootExited: true, rootClosed: true, rootGroupEmpty: true });
    expect(launch).toMatchObject({ quiescent: false, pending: false, rootUnidentified: true });
    let persisted = 0;
    await recoverLaunch(launch, () => { persisted += 1; });
    expect(launch.quiescent).toBe(true);
    expect(persisted).toBe(1);
  });

  test.each([
    ["never settled", {}],
    ["flagged but still pending", { rootUnidentified: true as const, pending: true }],
    ["flagged but uncertain", { rootUnidentified: true as const, pending: false, uncertain: true }],
  ])("one that %s is still refused", async (_name, overrides) => {
    const { launch, emit } = fixture("print", false);
    emit({ kind: "print-processes", identities: [], complete: true });
    Object.assign(launch, overrides);
    let persisted = 0;
    await expect(recoverLaunch(launch, () => { persisted += 1; })).rejects.toMatchObject({ code: "SWARM_RECOVERY_REQUIRED" });
    expect(launch.quiescent).toBe(false);
    expect(persisted).toBe(0);
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
