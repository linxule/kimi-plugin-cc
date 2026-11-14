import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { revalidateProcessIdentities, waitForProcessTreeExit, type ProcessIdentity } from "../../runtime/process-tree.js";

const captured = { pid: 4_242, processGroupId: 100, startToken: "test:start", state: "S" };

describe("targeted ps snapshot exit", () => {
  type Row = ProcessIdentity & { parentPid: number };
  type Exec = (command: string, args: string[], options: unknown) => Promise<{ stdout: string }>;

  async function snapshotReader(exec: Exec) {
    const source = await readFile("runtime/process-tree.ts", "utf8");
    const snippets = [
      ["async function collectVerifiedDescendantIdentities(", "async function collectProcessSnapshotRows():"],
      ["async function collectProcessSnapshotRowsFromPs(", "async function readCurrentIdentityBatch("],
      ["function parsePsSnapshotRows(", "function mergeIdentityBatches("],
      ["function toProcessIdentity(", "function dedupeIdentities("],
      ["function uniqueValidPids(", "function sleep("],
      ["function isExitCode(", undefined],
    ].map(([start, end]) => source.slice(source.indexOf(start!), end === undefined ? undefined : source.indexOf(end)));
    const code = new Bun.Transpiler({ loader: "ts" }).transformSync(snippets.join("\n"));
    let beforeVerification: (rows: Row[]) => Promise<void> = async () => undefined;
    const bindings = {
      execFileAsync: exec,
      process: { platform: "darwin" },
      PROCESS_SNAPSHOT_TIMEOUT_MS: 1_000,
      PROCESS_IDENTITY_PROBE_TIMEOUT_MS: 1_000,
      MAX_DESCENDANT_DEPTH: 8,
      MAX_DESCENDANT_PIDS: 512,
      collectProcessSnapshotRows: async (): Promise<Row[] | undefined> => {
        const rows = await api.read();
        if (rows !== undefined) await beforeVerification(rows);
        return rows;
      },
    };
    const api = new Function(...Object.keys(bindings), `${code}; return { read: collectProcessSnapshotRowsFromPs, collect: collectVerifiedDescendantIdentities };`)(
      ...Object.values(bindings),
    ) as {
      read: (pids?: number[]) => Promise<Row[] | undefined>;
      collect: (pid: number, expectedRoot?: ProcessIdentity) => Promise<ProcessIdentity[]>;
    };
    return { ...api, beforeVerification: (callback: typeof beforeVerification) => { beforeVerification = callback; } };
  }

  test("exit 1 for an explicit PID list is a complete empty snapshot", async () => {
    const reader = await snapshotReader(async () => { throw { code: 1 }; });
    await expect(reader.read([101, 102])).resolves.toEqual([]);
  });

  test("exit 1 for the full process table remains a probe failure", async () => {
    const reader = await snapshotReader(async () => { throw { code: 1 }; });
    await expect(reader.read()).resolves.toBeUndefined();
  });

  test("other targeted errors remain probe failures", async () => {
    for (const error of [{ code: 2 }, { code: "ENOENT" }, { killed: true, signal: "SIGTERM" }]) {
      const reader = await snapshotReader(async () => { throw error; });
      await expect(reader.read([101, 102])).resolves.toBeUndefined();
    }
  });

  test.skipIf(process.platform !== "darwin")("an orphan anchor and child can naturally exit between snapshots", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kimi-process-snapshot-"));
    const release = path.join(dir, "release");
    const ready = path.join(dir, "ready.json");
    const exec = promisify(execFile);
    const deadline = Date.now() + 5_000;
    const waitUntil = async (predicate: () => Promise<boolean>): Promise<void> => {
      while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error("orphan fixture did not settle");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const childCode = `const fs=require('node:fs'); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.exit(0);}},10);setTimeout(()=>process.exit(0),6000).unref();`;
    const anchorCode = `const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({anchor:process.pid,child:child.pid}));child.on('exit',()=>process.exit(0));`;
    const launcherCode = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(anchorCode)}],{detached:true,stdio:'ignore'});child.unref();`;
    try {
      await exec(process.execPath, ["-e", launcherCode]);
      await waitUntil(async () => readFile(ready).then(() => true, () => false));
      const ids = JSON.parse(await readFile(ready, "utf8")) as { anchor: number; child: number };
      const reader = await snapshotReader((command, args, options) => exec(command, args, options as Parameters<typeof execFile>[2]) as Promise<{ stdout: string }>);
      const observed = await reader.read([ids.anchor, ids.child]);
      const anchor = observed?.find((row) => row.pid === ids.anchor);
      expect(anchor).toBeDefined();
      expect(observed?.find((row) => row.pid === ids.child)?.parentPid).toBe(ids.anchor);
      expect(anchor?.parentPid).toBe(1);
      reader.beforeVerification(async (rows) => {
        expect(rows.some((row) => row.pid === ids.anchor)).toBe(true);
        expect(rows.some((row) => row.pid === ids.child && row.parentPid === ids.anchor)).toBe(true);
        await writeFile(release, "exit");
        await waitUntil(async () => (await reader.read([ids.anchor, ids.child]))?.length === 0);
      });
      await expect(reader.collect(ids.anchor, anchor)).resolves.toEqual([]);
    } finally {
      await writeFile(release, "exit").catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);
});

describe("retained process-tree anchor identity", () => {
  type Row = ProcessIdentity & { parentPid: number };
  const root: Row = { pid: 101, parentPid: 1, processGroupId: 101, startToken: "proc:root", state: "S" };
  const child: Row = { pid: 102, parentPid: 101, processGroupId: 101, startToken: "proc:child", state: "S" };

  async function collector(
    initial: Row[] | undefined,
    verified: Row[] = initial ?? [],
  ): Promise<{ collect: (pid: number, expectedRoot?: ProcessIdentity) => Promise<unknown[]>; verificationCount: () => number }> {
    const source = await readFile("runtime/process-tree.ts", "utf8");
    const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
      source.slice(source.indexOf("async function collectVerifiedDescendantIdentities("), source.indexOf("async function readCurrentSnapshotRows(")),
    );
    let verifications = 0;
    const bindings = {
      collectProcessSnapshotRows: async () => initial,
      readCurrentSnapshotRows: async () => { verifications += 1; return verified; },
      isQuiescentState: (state: string) => /^[ZX]/i.test(state),
      toProcessIdentity: (identity: Row) => identity,
      MAX_DESCENDANT_DEPTH: 8,
      MAX_DESCENDANT_PIDS: 512,
    };
    const collect = new Function(...Object.keys(bindings), `${code}; return collectVerifiedDescendantIdentities;`)(
      ...Object.values(bindings),
    ) as (pid: number, expectedRoot?: ProcessIdentity) => Promise<unknown[]>;
    return { collect, verificationCount: () => verifications };
  }

  test("a matching retained anchor collects and verifies its descendants", async () => {
    const { collect, verificationCount } = await collector([root, child]);
    await expect(collect(root.pid, { ...root, state: "R" })).resolves.toEqual([root, child]);
    expect(verificationCount()).toBe(1);
  });

  test("a reused root PID cannot adopt replacement descendants", async () => {
    const replacement = { ...root, startToken: "proc:replacement" };
    const { collect, verificationCount } = await collector([replacement, child]);
    await expect(collect(root.pid, root)).resolves.toEqual([]);
    expect(verificationCount()).toBe(0);
  });

  test("a changed root process group cannot be used as an ownership anchor", async () => {
    const { collect, verificationCount } = await collector([{ ...root, processGroupId: 999 }, child]);
    await expect(collect(root.pid, root)).resolves.toEqual([]);
    expect(verificationCount()).toBe(0);
  });

  test("an expected identity for another PID cannot authorize this root", async () => {
    const { collect, verificationCount } = await collector([root, child]);
    await expect(collect(root.pid, { ...root, pid: 999 })).resolves.toEqual([]);
    expect(verificationCount()).toBe(0);
  });

  test("a missing anchor returns no new descendants without an enumeration error", async () => {
    const { collect, verificationCount } = await collector([child]);
    await expect(collect(root.pid, root)).resolves.toEqual([]);
    expect(verificationCount()).toBe(0);
  });

  test("replacement observed during verification rejects the candidate ancestry", async () => {
    const { collect } = await collector([root, child], [{ ...root, startToken: "proc:replacement" }, child]);
    await expect(collect(root.pid, root)).resolves.toEqual([]);
  });

  test("root exit during verification preserves a previously observed stable child", async () => {
    const reparented = { ...child, parentPid: 1 };
    const { collect } = await collector([root, child], [reparented]);
    await expect(collect(root.pid, root)).resolves.toEqual([reparented]);
  });

  test("omitting the expected anchor preserves fresh snapshot behavior", async () => {
    const replacement = { ...root, startToken: "proc:replacement" };
    const { collect } = await collector([replacement, child]);
    await expect(collect(root.pid)).resolves.toEqual([replacement, child]);
  });

  test("an unreadable snapshot remains distinguishable from an exited anchor", async () => {
    const { collect } = await collector(undefined);
    await expect(collect(root.pid, root)).rejects.toThrow("process snapshot unavailable");
  });
});

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
