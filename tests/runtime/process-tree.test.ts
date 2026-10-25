import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { revalidateProcessIdentities, waitForProcessTreeExit } from "../../runtime/process-tree.js";

const captured = { pid: 4_242, processGroupId: 100, startToken: "test:start", state: "S" };

describe("process identity group changes", () => {
  test("same PID and start token under a new PGID remains active but is not signal-valid", async () => {
    const current = { ...captured, processGroupId: captured.pid };
    const validation = await revalidateProcessIdentities([captured], {
      identityReader: async () => current,
    });
    expect(validation).toEqual({ identities: [], groupChanged: [current], complete: true });
  });

  test("a changed PGID cannot be mistaken for process exit", async () => {
    const current = { ...captured, processGroupId: captured.pid };
    const exited = await waitForProcessTreeExit([captured], 10, {
      identityReader: async () => current,
    });
    expect(exited).toBe(false);
  });

  test("an unchanged active identity revalidates and settles only after it exits", async () => {
    let active = true;
    const reader = async () => active ? captured : undefined;
    const validation = await revalidateProcessIdentities([captured], { identityReader: reader });
    expect(validation).toEqual({ identities: [captured], complete: true });
    active = false;
    await expect(waitForProcessTreeExit([captured], 10, { identityReader: reader })).resolves.toBe(true);
  });

  test("teardown treats a changed PGID as unverified and sends no signal", async () => {
    const source = await readFile("runtime/swarm-activation.ts", "utf8");
    const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
      source.slice(source.indexOf("async function teardownOwnedChild("), source.indexOf("function throwIfAborted(")),
    );
    const original = { pid: 102, processGroupId: 101, startToken: "ps:unchanged-start", state: "S" };
    const current = { ...original, processGroupId: 102 };
    const reader = async (pid: number) => pid === current.pid ? current : undefined;
    const signals: Array<{ pid: number; signal: string }> = [];
    const bindings = {
      process: { platform: "darwin", kill: (pid: number, signal: string) => signals.push({ pid, signal }) },
      stopDescendantTracking: async () => undefined,
      refreshOwnedDescendants: async () => undefined,
      revalidateProcessIdentities: (ids: any, options: any) =>
        revalidateProcessIdentities(ids, { ...options, identityReader: reader }),
      waitForProcessTreeExit: (ids: any, timeout: number, options: any) =>
        waitForProcessTreeExit(ids, timeout, { ...options, identityReader: reader }),
      collectProcessGroupsIdentities: async (groups: number[]) => groups.includes(current.processGroupId) ? [current] : [],
      ESCALATION_MS: 1_500,
      POST_KILL_QUIESCENCE_MS: 500,
      IDENTITY_REVALIDATION_TIMEOUT_MS: 250,
    };
    const teardown = new Function(...Object.keys(bindings), `${code}; return teardownOwnedChild;`)(
      ...Object.values(bindings),
    ) as (owned: unknown) => Promise<boolean>;
    const result = await teardown({
      child: { pid: 101 },
      exited: true,
      lastSnapshotComplete: true,
      descendants: [original],
    });
    expect(result).toBe(false);
    expect(signals).toEqual([]);
  }, 10_000);

  test("a genuinely incomplete snapshot stays unverified after root exit", async () => {
    const source = await readFile("runtime/swarm-activation.ts", "utf8");
    const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
      source.slice(source.indexOf("async function teardownOwnedChild("), source.indexOf("function throwIfAborted(")),
    );
    const bindings = {
      process: { platform: "darwin", kill: () => { throw new Error("unexpected signal"); } },
      stopDescendantTracking: async () => undefined,
      refreshOwnedDescendants: async () => undefined,
      revalidateProcessIdentities,
      waitForProcessTreeExit: async () => true,
      collectProcessGroupsIdentities: async () => [],
      ESCALATION_MS: 1_500,
      POST_KILL_QUIESCENCE_MS: 500,
      IDENTITY_REVALIDATION_TIMEOUT_MS: 250,
    };
    const teardown = new Function(...Object.keys(bindings), `${code}; return teardownOwnedChild;`)(
      ...Object.values(bindings),
    ) as (owned: unknown) => Promise<boolean>;
    const result = await teardown({
      child: { pid: 101 },
      exited: true,
      lastSnapshotComplete: false,
      descendants: [],
    });
    expect(result).toBe(false);
  });

  test("capture treats a missing root as a complete probe", async () => {
    const source = await readFile("runtime/swarm-activation.ts", "utf8");
    const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
      source.slice(source.indexOf("async function captureDescendantIdentities("), source.indexOf("function identityKey(")),
    );
    const capture = new Function(
      "collectDescendantIdentities",
      "probeProcessIdentity",
      "DESCENDANT_SNAPSHOT_TIMEOUT_MS",
      `${code}; return captureDescendantIdentities;`,
    )(
      async () => [],
      async () => ({ identity: undefined, complete: true }),
      1_000,
    ) as (pid: number) => Promise<{ identities: unknown[]; complete: boolean }>;
    await expect(capture(101)).resolves.toEqual({ identities: [], complete: true });
  });

  test("a later missing root cannot erase an earlier incomplete snapshot", async () => {
    const source = await readFile("runtime/swarm-activation.ts", "utf8");
    const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
      source.slice(source.indexOf("async function refreshOwnedDescendants("), source.indexOf("async function teardownOwnedChild(")),
    );
    let calls = 0;
    const bindings = {
      process: { platform: "darwin" },
      captureDescendantIdentities: async () => ({ identities: [], complete: calls++ === 0 ? false : true }),
      identityKey: (identity: { pid: number; startToken: string; processGroupId: number }) =>
        `${identity.pid}:${identity.startToken}:${identity.processGroupId}`,
    };
    const refresh = new Function(...Object.keys(bindings), `${code}; return refreshOwnedDescendants;`)(
      ...Object.values(bindings),
    ) as (owned: any) => Promise<void>;
    const owned = {
      child: { pid: 101 },
      exited: false,
      descendants: [],
      lastSnapshotComplete: false,
      snapshotIncomplete: false,
      refreshPromise: undefined,
    };
    await refresh(owned);
    await refresh(owned);
    expect(owned.lastSnapshotComplete).toBe(false);
    expect(owned.snapshotIncomplete).toBe(true);

    const firstMissing = {
      child: { pid: 101 },
      exited: false,
      descendants: [],
      lastSnapshotComplete: false,
      snapshotIncomplete: false,
      rootIdentity: undefined,
      refreshPromise: undefined,
    };
    await refresh(firstMissing);
    expect(firstMissing.lastSnapshotComplete).toBe(false);
    expect(firstMissing.snapshotIncomplete).toBe(true);

    const previouslyRooted = {
      child: { pid: 101 },
      exited: false,
      descendants: [],
      lastSnapshotComplete: false,
      snapshotIncomplete: false,
      rootIdentity: { pid: 101, processGroupId: 101, startToken: "root:start", state: "S" },
      refreshPromise: undefined,
    };
    await refresh(previouslyRooted);
    expect(previouslyRooted.lastSnapshotComplete).toBe(true);
    expect(previouslyRooted.snapshotIncomplete).toBe(false);
  });

  test("an observed descendant's ancestry and PGID changes preserve its verified identity", async () => {
    const source = await readFile("runtime/process-tree.ts", "utf8");
    const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
      source.slice(source.indexOf("async function collectVerifiedDescendantIdentities("), source.indexOf("async function readCurrentSnapshotRows(")),
    );
    const root = { pid: 101, parentPid: 1, processGroupId: 101, startToken: "proc:root", state: "S" };
    const child = { pid: 102, parentPid: 101, processGroupId: 101, startToken: "proc:child", state: "S" };
    const moved = { ...child, parentPid: 1, processGroupId: 102 };
    const bindings = {
      collectProcessSnapshotRows: async () => [root, child],
      readCurrentSnapshotRows: async () => [{ ...root, state: "Z" }, moved],
      isQuiescentState: (state: string) => /^[ZX]/i.test(state),
      toProcessIdentity: (identity: any) => identity,
      MAX_DESCENDANT_DEPTH: 8,
      MAX_DESCENDANT_PIDS: 512,
    };
    const collect = new Function(...Object.keys(bindings), `${code}; return collectVerifiedDescendantIdentities;`)(
      ...Object.values(bindings),
    ) as (pid: number) => Promise<unknown[]>;
    await expect(collect(101)).resolves.toEqual([moved]);
  });
});
