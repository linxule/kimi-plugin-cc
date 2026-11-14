import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const filename = fileURLToPath(import.meta.url);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pathsFor = (root) => Object.fromEntries([
  "wave", "done", "leaf", "writes", "signals", "orphanRelease", "orphanExited", "rootRelease", "identities", "result",
].map((name) => [name, path.join(root, `${name}.json`)]));

async function waitFor(read, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    await pause(10);
  }
  throw new Error("Churn fixture precondition timed out");
}

async function fixture(root) {
  const paths = pathsFor(root);
  process.stdout.write(`${JSON.stringify({ role: "meta", type: "system.version", version: "2.6.2" })}\n`);
  const intermediary = spawn("/bin/sh", ["-c", [
    '"$CHURN_NODE" "$CHURN_FIXTURE" --leaf "$CHURN_ROOT" &',
    'while [ ! -f "$CHURN_ORPHAN_RELEASE" ]; do sleep 0.02; done',
    "exit 0",
  ].join("\n")], {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, CHURN_NODE: process.execPath, CHURN_FIXTURE: filename,
      CHURN_ROOT: root, CHURN_ORPHAN_RELEASE: paths.orphanRelease },
  });
  intermediary.once("error", (error) => { throw error; });
  intermediary.once("exit", () => writeFileSync(paths.orphanExited, JSON.stringify({ pid: intermediary.pid })));
  for (let index = 0; index < 11; index++) {
    const children = Array.from({ length: 20 }, () => spawn("/bin/sleep", ["20"], { stdio: "ignore" }));
    const exited = children.map((child) => new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }));
    writeFileSync(paths.wave, JSON.stringify({ index, pids: children.map((child) => child.pid) }));
    await waitFor(async () => existsSync(path.join(root, `ack-${index}`)) ? true : undefined);
    for (const child of children) child.kill("SIGTERM");
    await Promise.all(exited);
  }
  writeFileSync(paths.done, "done\n");
  await waitFor(async () => existsSync(paths.rootRelease) ? true : undefined);
  process.stdout.write(`${JSON.stringify({ role: "assistant", content: "churn completed" })}\n`, () => process.exit(0));
}

async function runner(runtimeRoot, extension, root) {
  const load = (name) => import(pathToFileURL(path.join(runtimeRoot, `${name}.${extension}`)).href);
  const { runCliPrompt } = await load("cli-client");
  const { NATIVE_V2_CERTIFIED } = await load("kimi-engine");
  const {
    collectDescendantIdentities, collectDescendantIdentitiesForRoots,
    probeProcessIdentity, revalidateProcessIdentities,
  } = await load("process-tree");
  assert.equal(typeof collectDescendantIdentitiesForRoots, "function");
  const paths = pathsFor(root);
  const identityKey = (identity) => `${identity.pid}:${identity.startToken}:${identity.processGroupId}`;
  const captured = new Map();
  const ephemeral = new Set();
  const acknowledged = new Set();
  const batchCounts = new Map();
  const controller = new AbortController();
  let currentIdentities = new Map();
  let rootIdentity;
  let leaf;
  let pass = 0;
  let injectPending = false;
  let incompletePass;
  let incompleteCheckpoint = false;
  let recovered = false;
  let rootReleased = false;
  let settled = false;
  let staleSnapshot;
  let batchCalls = 0;
  let recoveryRoots;
  let finalCheckpoint;
  let checkpointFailure;
  const oldRow = NATIVE_V2_CERTIFIED.get("swarm");
  NATIVE_V2_CERTIFIED.set("swarm", [...new Set([...oldRow, "2.6.2"])]);
  let promise;
  const persistIdentities = () => writeFile(paths.identities, JSON.stringify([
    ...(rootIdentity ? [rootIdentity] : []), ...captured.values(),
  ]));
  try {
    promise = runCliPrompt({
      cwd: root, env: { PATH: process.env.PATH, KIMI_CODE_HOME: path.join(root, "home") },
      command: "node", prefixArgs: [filename, "--fixture", root],
      executionPlan: {
        schemaVersion: 1, operationKind: "swarm", intendedEngine: "native-v2",
        command: "node", prefixArgs: [filename, "--fixture", root], kimiVersion: "2.6.2",
        certification: "certified", resumedFromJobId: null, safetyProfile: "native-v2-no-plan/1",
      },
      prompt: "Exercise bounded process-identity churn.", commandLabel: "swarm",
      swarmMaxConcurrency: 2, signal: controller.signal, escalationMs: 75,
      onSpawn: async (pid) => {
        const state = await probeProcessIdentity(pid);
        assert.equal(state.complete, true);
        assert.ok(state.identity);
        rootIdentity = state.identity;
        await persistIdentities();
      },
      descendantIdentityCollector: async (...args) => {
        pass++;
        const identities = await collectDescendantIdentities(...args);
        for (const identity of identities) {
          if (identity.pid !== args[0]) captured.set(identityKey(identity), identity);
        }
        const validation = await revalidateProcessIdentities([...captured.values()]);
        assert.equal(validation.complete, true);
        currentIdentities = new Map(validation.identities.map((identity) => [identity.pid, identity]));
        await persistIdentities();
        const wave = await readFile(paths.wave, "utf8").then(JSON.parse).catch(() => undefined);
        if (wave && !acknowledged.has(wave.index) && wave.pids.every((pid) => identities.some((identity) => identity.pid === pid))) {
          acknowledged.add(wave.index);
          for (const pid of wave.pids) {
            const identity = identities.find((candidate) => candidate.pid === pid);
            ephemeral.add(identityKey(identity));
          }
          await writeFile(path.join(root, `ack-${wave.index}`), "captured\n");
        }
        if (injectPending) {
          injectPending = false;
          incompletePass = pass;
          // Every replayed identity was captured from a real owned descendant.
          // Replaying once models children exiting after snapshot acquisition.
          staleSnapshot = [...captured.values()];
          return staleSnapshot;
        }
        return identities;
      },
      processIdentityReader: async (pid) => {
        if (!rootReleased) {
          if (pass === incompletePass && pid === leaf.pid) throw new Error("one incomplete churn validation");
          return currentIdentities.get(pid);
        }
        const state = await probeProcessIdentity(pid);
        assert.equal(state.complete, true);
        return state.identity;
      },
      descendantIdentityBatchCollector: async (roots) => {
        batchCalls++;
        if (!rootReleased) {
          const calls = (batchCounts.get(pass) ?? 0) + 1;
          batchCounts.set(pass, calls);
          assert.equal(calls, 1, "a tracker pass must use one batch for all live anchors");
          assert.notEqual(pass, incompletePass, "incomplete validation must skip anchor discovery");
          assert.ok(roots.every((identity) => currentIdentities.get(identity.pid)?.startToken === identity.startToken),
            "dead identities must not be sent to the batch collector");
          assert.ok(roots.every((identity) => !ephemeral.has(identityKey(identity))),
            "reaped churn children must not be rediscovered as anchors");
          if (incompleteCheckpoint) recoveryRoots = roots.map((identity) => ({ ...identity }));
        }
        return collectDescendantIdentitiesForRoots(roots);
      },
      onProcessIdentities: async (identities, complete) => {
        try {
          finalCheckpoint = { identities, complete };
          if (pass === incompletePass) {
            assert.equal(complete, false);
            assert.ok(staleSnapshot.length >= 220);
            const retained = new Set(identities.map(identityKey));
            assert.ok(staleSnapshot.every((identity) => retained.has(identityKey(identity))),
              `one incomplete validation must retain every prior identity: ${JSON.stringify({
                retainedCount: identities.length,
                missing: staleSnapshot.filter((identity) => !retained.has(identityKey(identity))).slice(0, 3),
              })}`);
            assert.equal(batchCounts.get(pass) ?? 0, 0);
            incompleteCheckpoint = true;
          } else if (incompleteCheckpoint && !rootReleased && complete) {
            assert.deepEqual(identities.map(identityKey), [identityKey(leaf)]);
            assert.deepEqual(recoveryRoots?.map(identityKey), [identityKey(leaf)]);
            recovered = true;
          }
        } catch (error) {
          checkpointFailure ??= String(error);
          throw error;
        }
      },
    });
    void promise.finally(() => { settled = true; }).catch(() => undefined);
    const ready = await waitFor(async () => JSON.parse(await readFile(paths.leaf, "utf8")));
    const observed = await probeProcessIdentity(ready.pid);
    assert.equal(observed.complete, true);
    assert.ok(observed.identity);
    leaf = observed.identity;
    await waitFor(async () => existsSync(paths.done) ? true : undefined);
    assert.equal(ephemeral.size, 220);
    assert.equal(acknowledged.size, 11);
    await writeFile(paths.orphanRelease, "release\n");
    const exited = await waitFor(async () => JSON.parse(await readFile(paths.orphanExited, "utf8")));
    assert.equal((await probeProcessIdentity(exited.pid)).identity, undefined);
    injectPending = true;
    try {
      await waitFor(async () => recovered ? true : undefined);
    } catch (error) {
      throw new Error(`Churn recovery stalled: ${JSON.stringify({
        pass, incompletePass, incompleteCheckpoint, staleCount: staleSnapshot?.length,
        batchCalls, recoveryRoots, finalCheckpointCount: finalCheckpoint?.identities.length,
        finalCheckpointComplete: finalCheckpoint?.complete, checkpointFailure,
      })}`, { cause: error });
    }
    assert.equal(incompleteCheckpoint, true);
    assert.equal(batchCounts.get(incompletePass) ?? 0, 0);
    assert.ok(batchCalls > 0);
    rootReleased = true;
    await writeFile(paths.rootRelease, "release\n");
    const result = await promise;
    assert.equal(result.exitCode, 0);
    assert.equal(result.aborted, false);
    assert.equal(finalCheckpoint.complete, true);
    assert.deepEqual(finalCheckpoint.identities, []);
    const current = await probeProcessIdentity(leaf.pid);
    assert.equal(current.complete, true);
    const quiescence = await revalidateProcessIdentities([leaf], {
      // Linux may retain a reparented zombie until its new parent reaps it.
      identityReader: async () => current.identity,
    });
    assert.equal(quiescence.complete, true);
    assert.deepEqual(quiescence.identities, []);
    assert.deepEqual(quiescence.groupChanged ?? [], []);
    const atReturn = await readFile(paths.writes, "utf8");
    await pause(100);
    assert.equal(await readFile(paths.writes, "utf8"), atReturn);
    assert.ok((await readFile(paths.signals, "utf8")).length > 0);
    await writeFile(paths.result, JSON.stringify({
      ephemeralIdentities: ephemeral.size, maxConcurrentEphemeral: 20,
      incompleteCheckpoint, recovered, batchCalls,
      maxBatchesPerPass: Math.max(...batchCounts.values()),
      incompletePassBatchCalls: batchCounts.get(incompletePass) ?? 0,
      recoveryAnchorCount: recoveryRoots.length,
    }));
  } finally {
    rootReleased = true;
    if (!settled) controller.abort();
    const validation = await revalidateProcessIdentities([
      ...(rootIdentity ? [rootIdentity] : []), ...captured.values(),
    ]);
    if (validation.complete) {
      for (const identity of validation.identities) {
        try { process.kill(identity.pid, "SIGKILL"); } catch { /* Already exited. */ }
      }
    }
    NATIVE_V2_CERTIFIED.set("swarm", oldRow);
  }
}

if (process.argv[2] === "--leaf") {
  const paths = pathsFor(process.argv[3]);
  process.on("SIGTERM", () => appendFileSync(paths.signals, "TERM\n"));
  writeFileSync(paths.leaf, JSON.stringify({ pid: process.pid }));
  setInterval(() => appendFileSync(paths.writes, "tick\n"), 10);
  setTimeout(() => process.exit(0), 20_000);
} else if (process.argv[2] === "--fixture") {
  fixture(process.argv[3]).catch((error) => { console.error(error); process.exitCode = 1; });
} else {
  const [runtimeRoot, extension, root] = process.argv.slice(2);
  runner(runtimeRoot, extension, root).catch((error) => { console.error(error); process.exitCode = 1; });
}
