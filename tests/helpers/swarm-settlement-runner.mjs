import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [runtimeRoot, extension, root, mode = "success", width = "2"] = process.argv.slice(2);
if (!runtimeRoot || !extension || !root) throw new Error("Missing settlement runner arguments");
const load = (name) => import(pathToFileURL(path.join(runtimeRoot, `${name}.${extension}`)).href);
const { runCliPrompt } = await load("cli-client");
const { NATIVE_V2_CERTIFIED } = await load("kimi-engine");
const { collectDescendantIdentities, probeProcessIdentity } = await load("process-tree");
const fixture = path.join(import.meta.dirname, "swarm-exit-tail.mjs");
const paths = Object.fromEntries([
  "ready", "writes", "signals", "shellRelease", "shellExited", "rootRelease", "rootExited", "identity", "result",
].map((name) => [name, path.join(root, `${name}.json`)]));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
  if (current.complete && current.identity?.startToken === leaf.startToken &&
    current.identity.processGroupId === leaf.processGroupId) {
    try { process.kill(leaf.pid, "SIGKILL"); } catch { /* Already exited. */ }
  }
}

async function main() {
  const version = mode === "legacy" ? "2.5.3" : "2.6.2";
  const exitCode = mode === "error-exit" ? 7 : 0;
  const oldRow = NATIVE_V2_CERTIFIED.get("swarm");
  NATIVE_V2_CERTIFIED.set("swarm", [...new Set([...oldRow, version])]);
  const captured = new Map();
  const controller = new AbortController();
  let collectorCalls = 0;
  let teardownCalls = 0;
  let failureInjected = false;
  let rootCallbackComplete = mode !== "slow-spawn";
  let publishedBeforeRoot = false;
  let capturedDuringRootCallback = false;
  let faultEnabled = false;
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
        if (mode === "snapshot-error" && identities.length > 0 && !failureInjected) {
          failureInjected = true;
          throw new Error("scripted snapshot failure");
        }
        return identities;
      },
      processIdentityReader: mode === "sticky" || mode === "failure" ? async (pid) => {
        const actual = await probeProcessIdentity(pid);
        assert.equal(actual.complete, true);
        if (leaf?.pid === pid && faultEnabled && (mode === "failure" || !actual.identity)) {
          failureInjected = true;
          // Report liveness without granting a signal target under a changed
          // group. The outer test retains the actual identity for safe cleanup.
          return { ...leaf, processGroupId: leaf.processGroupId + 1 };
        }
        return actual.identity;
      } : undefined,
      onProcessIdentities: async (identities) => {
        publishedBeforeRoot ||= !rootCallbackComplete;
        if (mode === "persistence-error" && identities.length > 0 && !failureInjected) {
          failureInjected = true;
          throw new Error("scripted persistence failure");
        }
      },
      onSpawn: mode === "slow-spawn" ? async () => {
        const ready = await waitFor(async () => JSON.parse(await readFile(paths.ready, "utf8")));
        await waitFor(async () => captured.get(ready.pid));
        capturedDuringRootCallback = true;
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
    await writeFile(paths.shellRelease, "release\n");
    const shell = await waitFor(async () => JSON.parse(await readFile(paths.shellExited, "utf8")));
    const shellState = await probeProcessIdentity(shell.pid);
    assert.equal(shellState.complete, true);
    assert.equal(shellState.identity, undefined);
    assert.equal((await probeProcessIdentity(leaf.pid)).identity?.startToken, leaf.startToken);
    faultEnabled = true;
    const releasedAt = Date.now();
    await writeFile(paths.rootRelease, "release\n");
    await waitFor(async () => JSON.parse(await readFile(paths.rootExited, "utf8")));

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
    if (["snapshot-error", "persistence-error", "sticky", "failure"].includes(mode)) {
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
    if (mode === "failure") {
      assert.equal(current.identity?.startToken, leaf.startToken);
      assert.ok((await readFile(paths.writes, "utf8")).length > writesAtReturn.length);
    } else {
      assert.notEqual(current.identity?.startToken, leaf.startToken);
      assert.equal(await readFile(paths.writes, "utf8"), writesAtReturn);
    }
    if (version === "2.6.2") {
      assert.ok(collectorCalls > 0);
      assert.equal(teardownCalls, 1);
      if (mode !== "failure") assert.ok((await readFile(paths.signals, "utf8")).trim().length > 0);
    } else assert.equal(teardownCalls, 0);
    if (mode === "slow-spawn") {
      assert.equal(capturedDuringRootCallback, true);
      assert.equal(publishedBeforeRoot, false);
      assert.equal(rootCallbackComplete, true);
    }
    await writeFile(paths.result, JSON.stringify({
      mode, width: Number(width), version, collectorCalls, teardownCalls,
      failureInjected, capturedDuringRootCallback, publishedBeforeRoot,
      errorCode: outcome.error?.code, cleanupUnverified: outcome.error?.details?.process_cleanup_unverified,
      leafAliveAtReturn: current.identity?.startToken === leaf.startToken,
    }));
  } finally {
    if (mode !== "failure") await killObserved();
    NATIVE_V2_CERTIFIED.set("swarm", oldRow);
  }
}

// Deliberately no process.exit(): a failed settlement must release inherited
// stdio handles so this runner exits even while its separately owned test leaf lives.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
