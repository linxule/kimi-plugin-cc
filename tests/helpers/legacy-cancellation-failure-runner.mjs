import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [runtimeRoot, extension, directory, operation, failureMode] = process.argv.slice(2);
if (!runtimeRoot || !extension || !directory || !["ask", "rescue", "pursue"].includes(operation) ||
  !["throw", "timeout", "budget"].includes(failureMode)) throw new Error("Invalid isolated cancellation runner arguments");
const load = (name) => import(pathToFileURL(path.join(runtimeRoot, `${name}.${extension}`)).href);
const { runCliPrompt, runCliPromptWithBudget } = await load("cli-client");
const { probeProcessIdentity, revalidateProcessIdentities } = await load("process-tree");
const fixture = path.join(import.meta.dirname, "legacy-cancellation-failure-fixture.mjs");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const filename = (name) => path.join(directory, `${name}.json`);
async function waitFor(read, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    await pause(10);
  }
  throw new Error("Legacy cancellation fixture precondition timed out");
}
async function within(promise, timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Unverified detached tail stranded cancellation")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function main() {
  const identities = {};
  const controller = new AbortController();
  const useBudget = failureMode === "budget";
  const snapshotError = new Error("scripted legacy descendant snapshot failure");
  let collectorCalls = 0;
  let partialObserved = false;
  let verified = false;
  let promise;
  const persist = () => writeFile(filename("identities"), JSON.stringify(identities));
  try {
    const options = {
      cwd: directory,
      env: { PATH: process.env.PATH, KIMI_CODE_HOME: path.join(directory, "home"), LEGACY_CANCEL_TEST_ROOT: directory },
      command: "node", prefixArgs: [fixture],
      executionPlan: {
        schemaVersion: 1, operationKind: operation, intendedEngine: "native-v2",
        command: "node", prefixArgs: [fixture], kimiVersion: "2.5.3", certification: "certified",
        resumedFromJobId: null, safetyProfile: "native-v2-no-plan/1",
      },
      prompt: "Exercise failed descendant discovery during cancellation.",
      commandLabel: operation === "pursue" ? "rescue" : operation,
      trustedWorkspaceRoot: operation === "ask" ? undefined : directory,
      signal: controller.signal, escalationMs: 75,
      onSpawn: async (pid) => {
        const observed = await probeProcessIdentity(pid);
        assert.equal(observed.complete, true);
        assert.ok(observed.identity);
        identities.root = observed.identity;
        await persist();
      },
      onRecord: (record) => {
        if (record.role === "assistant") partialObserved = true;
      },
      descendantIdentityCollector: async () => {
        collectorCalls++;
        if (failureMode === "throw") throw snapshotError;
        return new Promise(() => {});
      },
    };
    promise = useBudget
      ? runCliPromptWithBudget(options, 750, "legacy-cancellation-test.budget")
      : runCliPrompt(options);
    void promise.catch(() => undefined);
    const ready = await waitFor(async () => JSON.parse(await readFile(filename("tail-ready"), "utf8")));
    const observed = await probeProcessIdentity(ready.pid);
    assert.equal(observed.complete, true);
    assert.ok(observed.identity);
    identities.tail = observed.identity;
    await persist();
    assert.ok(identities.root);
    assert.notEqual(identities.root.processGroupId, identities.tail.processGroupId);
    await waitFor(async () => partialObserved ? true : undefined);
    assert.equal(collectorCalls, 0, "non-bounded operations only collect descendants during teardown");
    const startedAt = Date.now();
    if (!useBudget) controller.abort();
    const outcome = await within(promise.then((result) => ({ result }), (error) => ({ error })));
    const elapsedMs = Date.now() - startedAt;
    assert.equal(outcome.result, undefined, "no success or partial result may escape failed cancellation");
    assert.equal(outcome.error?.code, useBudget ? "RESPONSE_TIMEOUT" : "CLI_CANCELLATION_TEARDOWN_FAILED");
    if (useBudget) {
      assert.equal(outcome.error.partialResult, undefined);
      assert.equal(outcome.error.details.record_count, 0);
      assert.equal(outcome.error.details.partial_output_chars, 0);
      assert.equal(outcome.error.details.settled_post_abort, undefined);
    }
    const cancellationError = useBudget ? outcome.error.cause : outcome.error;
    assert.equal(cancellationError?.code, "CLI_CANCELLATION_TEARDOWN_FAILED");
    assert.equal(cancellationError?.details?.process_cleanup_unverified, true);
    assert.equal(collectorCalls, 1);
    if (failureMode === "throw") {
      assert.equal(cancellationError.cause, snapshotError, "preserve the original snapshot error object");
      assert.match(cancellationError.message, /scripted legacy descendant snapshot failure/);
    } else {
      assert.equal(cancellationError.cause?.message, "descendant ownership snapshot timed out");
      assert.match(cancellationError.message, /descendant ownership snapshot timed out/);
      assert.ok(elapsedMs >= 950, "the real bounded snapshot timeout must elapse");
    }
    assert.ok(elapsedMs < 4000, "a live detached tail must not keep cancellation pending");
    const rootValidation = await revalidateProcessIdentities([identities.root]);
    assert.equal(rootValidation.complete, true);
    assert.deepEqual(rootValidation.identities, []);
    assert.deepEqual(rootValidation.groupChanged ?? [], []);
    const rootTerms = await readFile(filename("root-terms"), "utf8");
    assert.ok(rootTerms.trim().length > 0, "the TERM-ignoring owned root must receive TERM before escalation");
    const tailValidation = await revalidateProcessIdentities([identities.tail]);
    assert.equal(tailValidation.complete, true);
    assert.equal(tailValidation.identities.length, 1, "the undiscovered detached tail must remain alive");
    assert.deepEqual(tailValidation.groupChanged ?? [], []);
    const tailTerms = await readFile(filename("tail-terms"), "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    assert.equal(tailTerms, "", "an unverified detached process must not receive a signal");
    const rootWrites = await readFile(filename("root-writes"), "utf8");
    const tailWrites = await readFile(filename("tail-writes"), "utf8");
    await pause(120);
    assert.equal(await readFile(filename("root-writes"), "utf8"), rootWrites);
    assert.ok((await readFile(filename("tail-writes"), "utf8")).length > tailWrites.length);
    await writeFile(filename("result"), JSON.stringify({
      operation, failureMode, errorCode: outcome.error.code,
      cleanupUnverified: cancellationError.details.process_cleanup_unverified,
      rootQuiescent: true, tailAliveAtReturn: true, rootTermObserved: true, tailTermObserved: false,
      collectorCalls, partialObserved, elapsedMs,
    }));
    verified = true;
  } finally {
    if (!verified) {
      controller.abort();
      const validation = await revalidateProcessIdentities(Object.values(identities));
      if (validation.complete) for (const identity of validation.identities) {
        try { process.kill(identity.pid, "SIGKILL"); } catch { /* Already exited. */ }
      }
    }
  }
}

// The outer test owns the live tail's final cleanup. Never call process.exit:
// natural exit proves cancellation released the inherited stdio handles.
main().catch((error) => { console.error(error); process.exitCode = 1; });
