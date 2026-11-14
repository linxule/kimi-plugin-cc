import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [runtimeRoot, extension, root, mode = "success", width = "2"] = process.argv.slice(2);
if (!runtimeRoot || !extension || !root) throw new Error("Missing settlement runner arguments");
const load = (name) => import(pathToFileURL(path.join(runtimeRoot, `${name}.${extension}`)).href);
const { runCliPrompt } = await load("cli-client");
const { NATIVE_V2_CERTIFIED } = await load("kimi-engine");
const { collectDescendantIdentities, collectDescendantIdentitiesForRoots, probeProcessIdentity } = await load("process-tree");
const fixture = path.join(import.meta.dirname, "swarm-exit-tail.mjs");
const paths = Object.fromEntries([
  "ready", "writes", "signals", "shellRelease", "shellExited", "rootRelease", "rootExited", "identity", "result", "spawnFailureRelease",
].map((name) => [name, path.join(root, `${name}.json`)]));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const transientModes = ["snapshot-error", "batch-snapshot-error", "identity-error", "persistence-error", "incomplete-retention"];
const persistentModes = ["snapshot-persistent", "identity-persistent", "persistence-persistent"];
const liveTailModes = ["failure", "identity-persistent"];
const isQuiescent = (identity) => identity === undefined || /^[ZX]/.test(identity.state.trim().toUpperCase());
const isObservedAlive = (identity, expected) => identity?.startToken === expected.startToken && !isQuiescent(identity);
async function waitFor(read, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read().catch(() => undefined);
    if (result !== undefined) return result;
    await pause(10);
  }
  throw new Error("Settlement fixture precondition timed out");
}
async function within(promise, timeoutMs = 4000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Owned descendant prevented settlement")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

let leaf;
async function killObserved() {
  if (!leaf) return;
  const current = await probeProcessIdentity(leaf.pid);
  if (current.complete && isObservedAlive(current.identity, leaf) &&
    current.identity.processGroupId === leaf.processGroupId) {
    try { process.kill(leaf.pid, "SIGKILL"); } catch { /* Already exited. */ }
  }
}

async function main() {
  const version = mode === "legacy" ? "2.5.3" : "2.6.2";
  const exitCode = ["error-exit", "persistence-persistent"].includes(mode) ? 7 : 0;
  const oldRow = NATIVE_V2_CERTIFIED.get("swarm");
  NATIVE_V2_CERTIFIED.set("swarm", [...new Set([...oldRow, version])]);
  const captured = new Map();
  const controller = new AbortController();
  let collectorCalls = 0;
  let batchCollectorCalls = 0;
  let teardownCalls = 0;
  let failureInjected = false;
  let rootCallbackComplete = !["slow-spawn", "spawn-callback-error"].includes(mode);
  let publishedBeforeRoot = false;
  let capturedDuringRootCallback = false;
  let faultEnabled = false;
  let incompletePassActive = false;
  let retentionBaseline = [];
  let snapshotFailures = 0;
  let batchSnapshotFailures = 0;
  let identityFailures = 0;
  let checkpointFailures = 0;
  const checkpoints = [];
  let recoveredComplete = false;
  let retainedDuringIncomplete = false;
  let retriedCheckpoint = false;
  let failedCheckpointSignature;
  const injectSnapshotFailure = (batch) => {
    if (faultEnabled && (
      mode === "snapshot-persistent" ||
      (mode === "snapshot-error" && !batch && !failureInjected) ||
      (mode === "batch-snapshot-error" && batch && !failureInjected) ||
      (mode === "incomplete-retention" && !batch && !failureInjected)
    )) {
      failureInjected = true;
      snapshotFailures++;
      if (batch) batchSnapshotFailures++;
      if (mode === "incomplete-retention") {
        incompletePassActive = true;
        retentionBaseline = checkpoints.at(-1)?.identities ?? [];
      }
      throw new Error("scripted snapshot failure");
    }
  };
  let promise;
  try {
    promise = runCliPrompt({
      cwd: root,
      env: {
        PATH: process.env.PATH,
        KIMI_CODE_HOME: path.join(root, "home"),
        SWARM_TEST_VERSION: version, SWARM_TEST_EXIT_CODE: String(exitCode),
        SWARM_TEST_LEAF_READY: paths.ready, SWARM_TEST_WRITES: paths.writes,
        SWARM_TEST_SIGNALS: paths.signals, SWARM_TEST_SHELL_RELEASE: paths.shellRelease,
        SWARM_TEST_SHELL_EXITED: paths.shellExited, SWARM_TEST_ROOT_RELEASE: paths.rootRelease,
        SWARM_TEST_ROOT_EXITED: paths.rootExited,
      },
      command: "node", prefixArgs: [fixture],
      executionPlan: {
        schemaVersion: 1, operationKind: "swarm", intendedEngine: "native-v2",
        command: "node", prefixArgs: [fixture], kimiVersion: version,
        certification: "certified", resumedFromJobId: null, safetyProfile: "native-v2-no-plan/1",
      },
      prompt: "Exercise owned process settlement.", commandLabel: "swarm",
      swarmMaxConcurrency: Number(width), signal: controller.signal, escalationMs: 75,
      descendantIdentityCollector: async (...args) => {
        collectorCalls++;
        const identities = await collectDescendantIdentities(...args);
        for (const identity of identities) captured.set(identity.pid, identity);
        injectSnapshotFailure(false);
        return identities;
      },
      descendantIdentityBatchCollector: async (roots) => {
        batchCollectorCalls++;
        const identities = await collectDescendantIdentitiesForRoots(roots);
        for (const identity of identities) captured.set(identity.pid, identity);
        injectSnapshotFailure(true);
        return identities;
      },
      processIdentityReader: async (pid) => {
        const actual = await probeProcessIdentity(pid);
        assert.equal(actual.complete, true);
        if (leaf?.pid === pid && faultEnabled) {
          if (mode === "incomplete-retention" && incompletePassActive) return undefined;
          if (mode === "identity-persistent" || (mode === "identity-error" && !failureInjected)) {
            failureInjected = true;
            identityFailures++;
            throw new Error("scripted identity read failure");
          }
          if (mode === "failure" || (mode === "sticky" && isQuiescent(actual.identity))) {
            failureInjected = true;
            // Report liveness without granting a signal target under a changed
            // group. The outer test retains the actual identity for safe cleanup.
            return { ...leaf, processGroupId: leaf.processGroupId + 1 };
          }
        }
        return actual.identity;
      },
      onProcessIdentities: async (identities, complete) => {
        publishedBeforeRoot ||= !rootCallbackComplete;
        const snapshot = identities.map((identity) => ({ ...identity }));
        const signature = JSON.stringify([snapshot, complete]);
        const checkpoint = { identities: snapshot, complete, faultEnabled, succeeded: false };
        checkpoints.push(checkpoint);
        if (faultEnabled && (
          mode === "persistence-persistent" || (mode === "persistence-error" && !failureInjected)
        )) {
          failureInjected = true;
          checkpointFailures++;
          failedCheckpointSignature ??= signature;
          throw new Error("scripted persistence failure");
        }
        checkpoint.succeeded = true;
        if (faultEnabled && !complete && snapshot.some((identity) => identity.pid === leaf.pid)) {
          retainedDuringIncomplete = true;
        }
        if (mode === "incomplete-retention" && incompletePassActive) {
          assert.equal(complete, false);
          assert.ok(retentionBaseline.length > 0);
          assert.ok(retentionBaseline.every((prior) => snapshot.some((identity) =>
            identity.pid === prior.pid && identity.startToken === prior.startToken &&
            identity.processGroupId === prior.processGroupId)),
          "an incomplete pass must retain every previously checkpointed identity");
          assert.ok(snapshot.some((identity) => identity.pid === leaf.pid && identity.startToken === leaf.startToken),
            "an incomplete pass must retain the leaf even when a later substep reports it missing");
          incompletePassActive = false;
        }
        if (failureInjected && complete && snapshot.some((identity) => identity.pid === leaf?.pid)) {
          recoveredComplete = true;
        }
        if (failedCheckpointSignature === signature) retriedCheckpoint = true;
      },
      onSpawn: ["slow-spawn", "spawn-callback-error"].includes(mode) ? async () => {
        const ready = await waitFor(async () => JSON.parse(await readFile(paths.ready, "utf8")));
        await waitFor(async () => captured.get(ready.pid));
        capturedDuringRootCallback = true;
        if (mode === "spawn-callback-error") {
          await waitFor(async () => readFile(paths.spawnFailureRelease, "utf8"));
          failureInjected = true;
          throw new Error("scripted root checkpoint failure");
        }
        await pause(200);
        rootCallbackComplete = true;
      } : undefined,
      cancellationTeardownHook: async () => {
        teardownCalls++;
        if (mode === "cancel") {
          queueMicrotask(() => controller.abort());
          await pause(25);
        }
      },
    });
    void promise.catch(() => undefined);
    const ready = await waitFor(async () => JSON.parse(await readFile(paths.ready, "utf8")));
    const observed = await probeProcessIdentity(ready.pid);
    assert.equal(observed.complete, true);
    assert.ok(observed.identity);
    leaf = observed.identity;
    await writeFile(paths.identity, JSON.stringify(leaf));
    if (version === "2.6.2") {
      await waitFor(async () => captured.get(leaf.pid));
      assert.equal(captured.get(leaf.pid).startToken, leaf.startToken);
    }
    await pause(700);
    // Arm before the shell disappears so checkpoint errors occur on a changed,
    // nonempty snapshot. Keep the root alive until transient recovery is proved.
    if ([...transientModes, ...persistentModes].includes(mode)) faultEnabled = true;
    await writeFile(paths.shellRelease, "release\n");
    const shell = await waitFor(async () => JSON.parse(await readFile(paths.shellExited, "utf8")));
    const shellState = await probeProcessIdentity(shell.pid);
    assert.equal(shellState.complete, true);
    assert.equal(isQuiescent(shellState.identity), true);
    assert.equal(isObservedAlive((await probeProcessIdentity(leaf.pid)).identity, leaf), true);
    if (transientModes.includes(mode)) {
      await waitFor(async () => recoveredComplete ? true : undefined);
      assert.equal(failureInjected, true);
      if (mode === "persistence-error") {
        await waitFor(async () => retriedCheckpoint ? true : undefined);
      } else {
        assert.equal(retainedDuringIncomplete, true);
      }
    }
    if (persistentModes.includes(mode)) {
      await waitFor(async () => failureInjected ? true : undefined);
      if (mode !== "persistence-persistent") {
        await waitFor(async () => retainedDuringIncomplete ? true : undefined);
      }
    }
    faultEnabled = true;
    const releasedAt = Date.now();
    if (mode === "spawn-callback-error") {
      await writeFile(paths.spawnFailureRelease, "release\n");
    } else {
      await writeFile(paths.rootRelease, "release\n");
      await waitFor(async () => JSON.parse(await readFile(paths.rootExited, "utf8")));
    }

    if (mode === "legacy") {
      let settled = false;
      void promise.finally(() => { settled = true; }).catch(() => undefined);
      const before = await readFile(paths.writes, "utf8");
      await pause(150);
      assert.equal(settled, false);
      assert.ok((await readFile(paths.writes, "utf8")).length > before.length);
      assert.equal(collectorCalls, 0);
      await killObserved();
    }

    const outcome = await within(promise.then((result) => ({ result }), (error) => ({ error })));
    assert.ok(Date.now() - releasedAt < 3000);
    if (["identity-persistent", "persistence-persistent", "sticky", "failure", "spawn-callback-error"].includes(mode)) {
      assert.equal(failureInjected, true);
      assert.equal(outcome.error?.code, "CLI_PROCESS_SETTLEMENT_FAILED");
      assert.equal(outcome.error?.details?.process_cleanup_unverified, true);
    } else {
      assert.equal(outcome.error, undefined);
      assert.equal(outcome.result.exitCode, exitCode);
      assert.equal(outcome.result.aborted, mode === "cancel");
      assert.equal(outcome.result.observedEngine, "native-v2");
      assert.equal(outcome.result.systemVersion, version);
    }
    const current = await probeProcessIdentity(leaf.pid);
    assert.equal(current.complete, true);
    const writesAtReturn = await readFile(paths.writes, "utf8");
    await pause(120);
    if (liveTailModes.includes(mode)) {
      assert.equal(isObservedAlive(current.identity, leaf), true);
      assert.ok((await readFile(paths.writes, "utf8")).length > writesAtReturn.length);
    } else {
      assert.equal(isObservedAlive(current.identity, leaf), false);
      assert.equal(await readFile(paths.writes, "utf8"), writesAtReturn);
    }
    if (version === "2.6.2") {
      assert.ok(collectorCalls > 0);
      assert.equal(teardownCalls, 1);
      if (!liveTailModes.includes(mode)) assert.ok((await readFile(paths.signals, "utf8")).trim().length > 0);
      if (!outcome.error) {
        const finalCheckpoint = checkpoints.at(-1);
        assert.equal(finalCheckpoint?.complete, true);
        assert.equal(finalCheckpoint?.succeeded, true);
        assert.deepEqual(finalCheckpoint?.identities, []);
      }
    } else assert.equal(teardownCalls, 0);
    if (mode === "snapshot-persistent" || mode === "identity-persistent") {
      const incomplete = checkpoints.filter((checkpoint) => checkpoint.faultEnabled && !checkpoint.complete);
      assert.ok(incomplete.length > 0);
      assert.ok(incomplete.every((checkpoint) => checkpoint.identities.some((identity) =>
        identity.pid === leaf.pid && identity.startToken === leaf.startToken)),
      "persistent incomplete passes must never publish false empty ownership");
      assert.equal(checkpoints.at(-1)?.complete, mode === "snapshot-persistent");
      assert.ok((mode === "snapshot-persistent" ? snapshotFailures : identityFailures) > 1);
      if (mode === "snapshot-persistent") {
        assert.ok(batchSnapshotFailures > 0, "a live orphan must exercise the failing batch collector");
        assert.equal(outcome.error, undefined, "complete dead-identity proof needs no further anchor snapshot");
      }
    }
    if (mode === "persistence-persistent") {
      assert.ok(checkpointFailures > 1);
      assert.equal(checkpoints.at(-1)?.succeeded, false);
      assert.ok(checkpoints.some((checkpoint) => checkpoint.faultEnabled && checkpoint.identities.length === 0),
        "quiescent processes still require a successful final checkpoint");
      assert.match(outcome.error.cause.message, /scripted persistence failure/);
      assert.match(outcome.error.message, /scripted persistence failure/);
      assert.equal(outcome.error.details.process_exit_code, 7);
      assert.equal(outcome.error.details.process_signal, null);
    }
    if (mode === "batch-snapshot-error") assert.equal(batchSnapshotFailures, 1);
    if (mode === "slow-spawn") {
      assert.equal(capturedDuringRootCallback, true);
      assert.equal(publishedBeforeRoot, false);
      assert.equal(rootCallbackComplete, true);
    }
    if (mode === "spawn-callback-error") {
      assert.equal(capturedDuringRootCallback, true);
      assert.equal(publishedBeforeRoot, false);
      assert.equal(rootCallbackComplete, false);
      assert.equal(checkpoints.length, 0);
      assert.equal(outcome.error.cause?.code, "CLI_SPAWN_CALLBACK_FAILED");
      assert.match(outcome.error.cause?.cause?.message, /scripted root checkpoint failure/);
      assert.match(outcome.error.message, /scripted root checkpoint failure/);
    }
    await writeFile(paths.result, JSON.stringify({
      mode, width: Number(width), version, collectorCalls, batchCollectorCalls, teardownCalls,
      failureInjected, capturedDuringRootCallback, publishedBeforeRoot,
      recoveredComplete, retainedDuringIncomplete, retriedCheckpoint,
      snapshotFailures, batchSnapshotFailures, identityFailures, checkpointFailures,
      checkpoints,
      errorCode: outcome.error?.code, cleanupUnverified: outcome.error?.details?.process_cleanup_unverified,
      leafAliveAtReturn: isObservedAlive(current.identity, leaf),
    }));
  } finally {
    if (!liveTailModes.includes(mode)) await killObserved();
    NATIVE_V2_CERTIFIED.set("swarm", oldRow);
  }
}

// Deliberately no process.exit(): a failed settlement must release inherited
// stdio handles so this runner exits even while its separately owned test leaf lives.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
