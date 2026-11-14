import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ProcessIdentity } from "../../runtime/process-tree.js";
import type { SwarmRecoveryRecord } from "../../runtime/swarm-recovery.js";

const worktree = "/virtual/swarm-worktree";
const patchPath = "/virtual/artifacts/partial.patch";
const rootIdentity: ProcessIdentity = { pid: 71001, processGroupId: 71001, startToken: "ps:root", state: "S" };
const childIdentity: ProcessIdentity = { pid: 71002, processGroupId: 71002, startToken: "ps:child", state: "S" };
const completedChildIdentity: ProcessIdentity = { pid: 71003, processGroupId: 71003, startToken: "ps:completed-child", state: "S" };

interface PrintOptions {
  onSpawn?: (pid: number) => void | Promise<void>;
  onProcessIdentities?: (identities: readonly ProcessIdentity[], complete: boolean) => void | Promise<void>;
}

type FaultKind = "settlement-code" | "cleanup-flag" | "budget-wrapped" | "ordinary";

async function runFault(options: { kind: FaultKind; complete?: boolean; cancelling?: boolean }) {
  // Execute the emitted command and recovery modules. No TypeScript transform
  // or source-only substitute can satisfy this regression test.
  const dist = path.join(process.cwd(), "dist");
  const [command, errors, cli, recovery, classification, policy] = await Promise.all([
    readFile(path.join(dist, "commands", "swarm.js"), "utf8"),
    import(pathToFileURL(path.join(dist, "errors.js")).href),
    import(pathToFileURL(path.join(dist, "cli-client.js")).href),
    import(pathToFileURL(path.join(dist, "swarm-recovery.js")).href),
    import(pathToFileURL(path.join(dist, "kimi-errors.js")).href),
    import(pathToFileURL(path.join(dist, "swarm-policy.js")).href),
  ]);
  const start = command.indexOf("async function executeSwarmJob(");
  const end = command.indexOf("\nfunction shorten(", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const code = command.slice(start, end);
  const RuntimeError = errors.RuntimeError;
  const settlement = new RuntimeError("CLI_PROCESS_SETTLEMENT_FAILED", "owned worker has not settled", "cli-client.settlement", {
    details: { probe: "settlement-evidence" },
  });
  const fault = options.kind === "settlement-code" ? settlement
    : options.kind === "cleanup-flag"
      ? new RuntimeError("DIFFERENT_RUNTIME_FAILURE", "cleanup could not be verified", "cli-client.teardown", {
          details: { process_cleanup_unverified: true, probe: "flag-evidence" },
        })
      : options.kind === "budget-wrapped"
        ? new cli.ResponseTimeoutError(1_000, "swarm.prompt", "swarm-write", undefined, settlement)
        : new RuntimeError("ORDINARY_MODEL_FAILURE", "the model stopped normally with an error", "swarm.prompt", {
            details: { probe: "ordinary-evidence" },
          });

  const job = { job_id: "settlement-probe", cwd: "/virtual/user-repo", status: "running", kimi_session_id: null,
    stream_log_path: "/virtual/log.jsonl", model: null, thinking_effort: null };
  const plan = { intendedEngine: "native-v2", kimiVersion: "2.6.2", operationKind: "swarm-write",
    command: "/virtual/kimi", prefixArgs: [] };
  const snapshots: SwarmRecoveryRecord[] = [];
  const captureCalls: string[] = [];
  const stderr: string[] = [];
  let retained = false;
  let disposed = false;
  let closed = false;
  let activationCalls = 0;
  let deactivationCalls = 0;
  let identityCallbackCalls = 0;
  let cancelling = false;
  let durableBeforeThrow: SwarmRecoveryRecord | undefined;
  const controller = new AbortController();
  const bindings = {
    RuntimeError,
    ResponseTimeoutError: cli.ResponseTimeoutError,
    recordRecoveryEvent: recovery.recordRecoveryEvent,
    finishRecoveryRecord: recovery.finishRecoveryRecord,
    usesBoundedSwarmPolicy: policy.usesBoundedSwarmPolicy,
    resolveKimiHome: () => "/virtual/home",
    probeProcessIdentity: async (pid: number) => ({
      complete: true,
      identity: pid === rootIdentity.pid ? rootIdentity
        : { pid, processGroupId: pid, startToken: "ps:owner", state: "S" },
    }),
    resolvePluginPaths: () => ({ artifactsDir: "/virtual/artifacts" }),
    ensurePluginPaths: async () => {},
    JobStore: class {
      getJob() { return { ...job }; }
      updateRunningJob() {}
      saveSwarmRecovery(_jobId: string, record: SwarmRecoveryRecord) {
        snapshots.push(structuredClone(record));
      }
      close() { closed = true; }
    },
    createCliCancellationHandlers: () => ({
      signal: controller.signal,
      get cancelling() { return cancelling; },
      dispose() { disposed = true; },
    }),
    executionPlanFromPersisted: () => plan,
    requiresSwarmPreactivation: () => true,
    preactivateSwarmSession: async () => { activationCalls += 1; throw new Error("single worker must not activate native swarm"); },
    deactivateSwarmSession: async () => { deactivationCalls += 1; throw new Error("single worker must not deactivate native swarm"); },
    runCliPromptWithBudget: async (print: PrintOptions) => {
      expect(typeof print.onProcessIdentities).toBe("function");
      await print.onSpawn?.(rootIdentity.pid);
      const firstSnapshot = options.complete === false ? [rootIdentity] : [rootIdentity, completedChildIdentity];
      await print.onProcessIdentities!(firstSnapshot, true);
      identityCallbackCalls += 1;
      expect(snapshots.at(-1)?.launches[0]?.identities).toEqual(firstSnapshot);
      await print.onProcessIdentities!([rootIdentity, childIdentity], options.complete ?? true);
      identityCallbackCalls += 1;
      durableBeforeThrow = structuredClone(snapshots.at(-1)!);
      if (options.cancelling) {
        cancelling = true;
        controller.abort();
      }
      throw fault;
    },
    capturePatchArtifact: async (_paths: unknown, _jobId: string, cwd: string) => {
      captureCalls.push(cwd);
      return { path: patchPath, bytes: 25, empty: false };
    },
    classifyManagedCommandFailure: classification.classifyManagedCommandFailure,
    markJobFailed: async (_store: unknown, _paths: unknown, current: typeof job, error: unknown) =>
      ({ ...current, status: "failed", error }),
    markJobCancelled: async (_store: unknown, _paths: unknown, current: typeof job, _summary: string, error: unknown) =>
      ({ ...current, status: "cancelled", error }),
  };
  const execute = new Function(...Object.keys(bindings), `${code}\nreturn executeSwarmJob;`)(...Object.values(bindings));
  const result = await execute(
    job.job_id, "prompt", "objective", 60_000, 1,
    { env: { KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1" }, stderr: { write(value: string) { stderr.push(value); } } },
    { workspaceRoot: worktree, spawnCwd: worktree, onPatchCaptureFailure() { retained = true; } }, worktree,
  );
  expect(activationCalls).toBe(0);
  expect(deactivationCalls).toBe(0);
  expect(identityCallbackCalls).toBe(2);
  expect(disposed).toBe(true);
  expect(closed).toBe(true);
  expect(durableBeforeThrow?.launches).toHaveLength(1);
  expect(durableBeforeThrow!.launches[0]!.identities).toEqual([rootIdentity, childIdentity]);
  expect(durableBeforeThrow!.launches[0]!.uncertain).toBe(options.complete === false);
  return { result, fault, retained, captureCalls, stderr: stderr.join(""), durableBeforeThrow,
    finalRecovery: snapshots.at(-1)! };
}

function assertCaptureSkipped(outcome: Awaited<ReturnType<typeof runFault>>) {
  expect(outcome.captureCalls).toEqual([]);
  expect(outcome.retained).toBe(true);
  expect(outcome.result.error.details).toMatchObject({
    process_cleanup_unverified: true,
    patch_capture_skipped: true,
    worktreePath: worktree,
  });
  expect(outcome.stderr).toContain("no patch was captured");
  expect(outcome.finalRecovery).toMatchObject({ complete: false, patchPath: null, session: null, sessionDirty: false });
  expect(outcome.finalRecovery.launches).toHaveLength(1);
  expect(outcome.finalRecovery.launches[0]).toMatchObject({ kind: "print", quiescent: false, pending: false });
  expect(outcome.finalRecovery.launches[0]!.identities).toEqual([rootIdentity, childIdentity]);
}

describe("emitted swarm process-settlement integration", () => {
  test("settlement error code alone prevents a patch and preserves owned identities", async () => {
    const outcome = await runFault({ kind: "settlement-code" });
    assertCaptureSkipped(outcome);
    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.error).toMatchObject({
      code: "CLI_PROCESS_SETTLEMENT_FAILED", stage: "cli-client.settlement",
      details: { probe: "settlement-evidence" },
    });
    expect(outcome.finalRecovery.launches[0]!.uncertain).toBe(false);
  });

  test("an unverified-cleanup flag under another error code prevents patch capture", async () => {
    const outcome = await runFault({ kind: "cleanup-flag" });
    assertCaptureSkipped(outcome);
    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.error).toMatchObject({
      code: "DIFFERENT_RUNTIME_FAILURE", stage: "cli-client.teardown", details: { probe: "flag-evidence" },
    });
  });

  test("an incomplete identity observation stays uncertain in durable recovery", async () => {
    const outcome = await runFault({ kind: "settlement-code", complete: false });
    assertCaptureSkipped(outcome);
    expect(outcome.finalRecovery.launches[0]!.uncertain).toBe(true);
  });

  test("a budget wrapper preserves the underlying unsafe-settlement decision", async () => {
    const outcome = await runFault({ kind: "budget-wrapped" });
    assertCaptureSkipped(outcome);
    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.error).toMatchObject({
      code: "RESCUE_KIMI_RESPONSE_TIMEOUT", stage: "swarm.prompt",
      details: { cause_code: "RESPONSE_TIMEOUT", budget_ms: 1_000 },
    });
  });

  test("ordinary failures still capture the partial patch", async () => {
    const outcome = await runFault({ kind: "ordinary" });
    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.error.code).toBe("ORDINARY_MODEL_FAILURE");
    expect(outcome.captureCalls).toEqual([worktree]);
    expect(outcome.finalRecovery.patchPath).toBe(patchPath);
    expect(outcome.result.error.details.patch_capture_skipped).toBeUndefined();
    expect(outcome.stderr).toContain("partial patch captured");
  });

  test("ordinary cancellation still captures the partial patch and stays cancelled", async () => {
    const outcome = await runFault({ kind: "ordinary", cancelling: true });
    expect(outcome.result.status).toBe("cancelled");
    expect(outcome.result.error.code).toBe("SWARM_CANCELLED");
    expect(outcome.captureCalls).toEqual([worktree]);
    expect(outcome.finalRecovery.patchPath).toBe(patchPath);
    expect(outcome.result.error.details.patch_capture_skipped).toBeUndefined();
  });

  test("cancellation with unsafe settlement stays cancelled without capturing a patch", async () => {
    const outcome = await runFault({ kind: "settlement-code", cancelling: true });
    assertCaptureSkipped(outcome);
    expect(outcome.result.status).toBe("cancelled");
    expect(outcome.result.error.code).toBe("SWARM_CANCELLED");
  });
});
