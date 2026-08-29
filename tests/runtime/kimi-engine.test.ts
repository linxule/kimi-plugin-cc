import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertExecutionPlanMatchesSpawn,
  classifyHistoricalEngineProvenance,
  executionPlanFromPersisted,
  NATIVE_V2_CERTIFIED_OPERATIONS,
  prepareKimiExecutionPlan,
  reconcileHistoricalJobProvenance,
} from "../../runtime/kimi-engine.js";
import { JobStore } from "../../runtime/job-store.js";
import { ensurePluginPaths, resolvePluginPaths } from "../../runtime/paths.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli-v1.ts");

describe("kimi execution plan", () => {
  test("certifies the exact forced-v1 command tuple and version", async () => {
    const cwd = await createTestPluginDataRoot("kimi-engine-plan");
    try {
      const plan = await prepareKimiExecutionPlan({
        operationKind: "rescue",
        cwd,
        env: {
          ...process.env,
          KIMI_PLUGIN_CC_KIMI_BIN: "bun",
          KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
          KIMI_PLUGIN_CC_MOCK_VERSION: "0.39.0",
        },
        intendedEngine: "legacy-v1",
      });

      expect(plan).toMatchObject({
        operationKind: "rescue",
        intendedEngine: "legacy-v1",
        prefixArgs: ["run", mockCliPath],
        kimiVersion: "0.39.0",
        certification: "certified",
      });
      expect(plan.command).toContain("bun");
      expect(() =>
        assertExecutionPlanMatchesSpawn(plan, plan.command, ["run", mockCliPath]),
      ).not.toThrow();
    } finally {
      await cleanupTestPath(cwd);
    }
  });

  test("native-v2 has an empty production capability matrix and refuses before probing", async () => {
    expect(NATIVE_V2_CERTIFIED_OPERATIONS.size).toBe(0);
    await expect(
      prepareKimiExecutionPlan({
        operationKind: "review",
        cwd: process.cwd(),
        env: { ...process.env, KIMI_PLUGIN_CC_KIMI_BIN: "/does/not/exist" },
        intendedEngine: "native-v2",
      }),
    ).rejects.toMatchObject({
      code: "CLI_V2_HOOK_ORDER_UNSAFE",
      details: { intended_engine: "native-v2", operation_kind: "review" },
    });
  });

  test("the ambient experimental selector refuses before exact-binary resolution", async () => {
    await expect(
      prepareKimiExecutionPlan({
        operationKind: "review",
        cwd: process.cwd(),
        env: {
          ...process.env,
          KIMI_CODE_EXPERIMENTAL_FLAG: " yes ",
          KIMI_PLUGIN_CC_KIMI_BIN: "/does/not/exist",
        },
        intendedEngine: "legacy-v1",
      }),
    ).rejects.toMatchObject({
      code: "CLI_V2_HOOK_ORDER_UNSAFE",
      stage: "kimi-engine.plan",
      details: { refusal_kind: "v2-hook-order-unsafe" },
    });
  });

  test("refuses an untested exact version and an operation below its minimum", async () => {
    const cwd = await createTestPluginDataRoot("kimi-engine-range");
    const baseEnv = {
      ...process.env,
      KIMI_PLUGIN_CC_KIMI_BIN: "bun",
      KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
    };
    try {
      await expect(
        prepareKimiExecutionPlan({
          operationKind: "review",
          cwd,
          env: { ...baseEnv, KIMI_PLUGIN_CC_MOCK_VERSION: "0.40.0" },
        }),
      ).rejects.toMatchObject({ code: "KIMI_CAPABILITY_NOT_CERTIFIED" });

      await expect(
        prepareKimiExecutionPlan({
          operationKind: "swarm-write",
          cwd,
          env: { ...baseEnv, KIMI_PLUGIN_CC_MOCK_VERSION: "0.12.0" },
        }),
      ).rejects.toMatchObject({
        code: "KIMI_CAPABILITY_NOT_CERTIFIED",
        details: { minimum_version: "0.18.0" },
      });
    } finally {
      await cleanupTestPath(cwd);
    }
  });

  test("refuses command drift from a certified plan", async () => {
    const plan = await prepareKimiExecutionPlan({
      operationKind: "ask",
      cwd: process.cwd(),
      env: {
        ...process.env,
        KIMI_PLUGIN_CC_KIMI_BIN: "bun",
        KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
        KIMI_PLUGIN_CC_MOCK_VERSION: "0.39.0",
      },
    });
    expect(() => assertExecutionPlanMatchesSpawn(plan, plan.command, ["run", "/other.ts"]))
      .toThrowError(expect.objectContaining({ code: "KIMI_EXECUTION_PLAN_MISMATCH" }));
  });

  test("revalidates deserialized certification at the subprocess boundary", () => {
    expect(() =>
      assertExecutionPlanMatchesSpawn(
        {
          schemaVersion: 1,
          operationKind: "review",
          intendedEngine: "legacy-v1",
          command: process.execPath,
          prefixArgs: [],
          kimiVersion: "0.40.0",
          certification: "certified",
          resumedFromJobId: null,
        },
        process.execPath,
        [],
      ),
    ).toThrowError(expect.objectContaining({ code: "KIMI_CAPABILITY_NOT_CERTIFIED" }));

    expect(() =>
      assertExecutionPlanMatchesSpawn(
        {
          schemaVersion: 1,
          operationKind: "review",
          intendedEngine: "native-v2",
          command: process.execPath,
          prefixArgs: [],
          kimiVersion: "0.39.0",
          certification: "certified",
          resumedFromJobId: null,
        },
        process.execPath,
        [],
      ),
    ).toThrowError(expect.objectContaining({ code: "CLI_V2_HOOK_ORDER_UNSAFE" }));
  });

  test("rejects malformed persisted plan enums and bypass/version conflicts", () => {
    const persisted = {
      operation_kind: "review" as const,
      intended_engine: "legacy-v1" as const,
      kimi_version: "0.39.0",
      kimi_command: process.execPath,
      kimi_prefix_args: "[]",
      plan_certification: "certified" as const,
      resumed_from_job_id: null,
    };

    expect(() =>
      executionPlanFromPersisted({ ...persisted, operation_kind: "tower" as never }),
    ).toThrowError(expect.objectContaining({ code: "KIMI_EXECUTION_PLAN_INVALID" }));

    const bypassWithVersion = executionPlanFromPersisted({
      ...persisted,
      plan_certification: "test-bypass",
    });
    expect(() =>
      assertExecutionPlanMatchesSpawn(bypassWithVersion, process.execPath, []),
    ).toThrowError(expect.objectContaining({ code: "KIMI_EXECUTION_PLAN_INVALID" }));

    const validBypass = executionPlanFromPersisted({
      ...persisted,
      kimi_version: null,
      plan_certification: "test-bypass",
    });
    expect(() =>
      assertExecutionPlanMatchesSpawn(validBypass, process.execPath, []),
    ).toThrowError(expect.objectContaining({ code: "KIMI_EXECUTION_PLAN_INVALID" }));
    expect(() =>
      assertExecutionPlanMatchesSpawn(validBypass, process.execPath, [], {
        KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: "1",
      }),
    ).not.toThrow();
  });
});

describe("historical engine provenance", () => {
  test("leaves a log without positive engine evidence unknown", () => {
    const result = classifyHistoricalEngineProvenance(
      `${JSON.stringify({ direction: "meta", message: { commandType: "ask" } })}\n`,
    );
    expect(result).toEqual({
      observedEngine: null,
      kimiVersion: null,
      operationKind: "ask",
      evidence: [],
      conflict: false,
    });
  });

  test("classifies current forced-v1 and native-v2 stream evidence", () => {
    const legacy = classifyHistoricalEngineProvenance(
      [
        JSON.stringify({ event: "spawn", command_label: "swarm", legacy_v1_forced: true }),
        JSON.stringify({ event: "exit", exit_code: 0 }),
      ].join("\n"),
    );
    expect(legacy.observedEngine).toBe("legacy-v1");
    expect(legacy.operationKind).toBe("swarm");

    const native = classifyHistoricalEngineProvenance(
      `${JSON.stringify({ event: "system_version", version: "0.39.0" })}\n`,
    );
    expect(native.observedEngine).toBe("native-v2");
    expect(native.kimiVersion).toBe("0.39.0");
  });

  test("uses explicit operation evidence and leaves an old ambiguous rescue label unknown", () => {
    const explicitPursue = classifyHistoricalEngineProvenance(
      [
        JSON.stringify({
          event: "spawn",
          command_label: "rescue",
          operation_kind: "pursue",
          legacy_v1_forced: true,
        }),
        JSON.stringify({ event: "exit", exit_code: 0 }),
      ].join("\n"),
    );
    expect(explicitPursue.operationKind).toBe("pursue");

    const oldAmbiguous = classifyHistoricalEngineProvenance(
      [
        JSON.stringify({ event: "spawn", command_label: "rescue", legacy_v1_forced: true }),
        JSON.stringify({ event: "exit", exit_code: 0 }),
      ].join("\n"),
    );
    expect(oldAmbiguous.operationKind).toBeNull();
    expect(oldAmbiguous.observedEngine).toBe("legacy-v1");
  });

  test("uses old wire protocol evidence and refuses conflicting inference", () => {
    const legacy = classifyHistoricalEngineProvenance(
      `${JSON.stringify({ type: "metadata", protocol_version: "1.4", created_at: 1 })}\n`,
    );
    expect(legacy.observedEngine).toBe("legacy-v1");

    const unrelatedRpcProtocol = classifyHistoricalEngineProvenance(
      `${JSON.stringify({ direction: "in", message: { result: { protocol_version: "1.10" } } })}\n`,
    );
    expect(unrelatedRpcProtocol.observedEngine).toBeNull();

    const conflict = classifyHistoricalEngineProvenance(
      [
        JSON.stringify({ event: "spawn", legacy_v1_forced: true }),
        JSON.stringify({ event: "record", record: { role: "assistant", content: "x" } }),
        JSON.stringify({ event: "system_version", version: "0.39.0" }),
      ].join("\n"),
    );
    expect(conflict.conflict).toBe(true);
    expect(conflict.observedEngine).toBeNull();
  });

  test("persists positive forensic evidence without reordering the old job", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("kimi-engine-forensic-persist");
    const paths = resolvePluginPaths({ ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot });
    await ensurePluginPaths(paths);
    const logPath = path.join(paths.logsDir, "old-ask.jsonl");
    await writeFile(
      logPath,
      [
        JSON.stringify({ direction: "meta", message: { commandType: "ask" } }),
        JSON.stringify({ event: "spawn", command_label: "ask", legacy_v1_forced: true }),
        JSON.stringify({ event: "exit", exit_code: 0 }),
      ].join("\n"),
      "utf8",
    );

    const store = new JobStore(paths);
    try {
      const old = store.createJob({
        job_id: "old-ask",
        repo_id: "repo",
        command_type: "ask",
        cwd: process.cwd(),
        model: null,
        thinking: null,
        background: false,
        pid: null,
        kimi_pid: null,
        status: "completed",
        kimi_session_id: "session-old",
        agent_profile: "<historical>",
        prompt_digest: "digest",
        summary: "old",
        final_output_path: null,
        stream_log_path: logPath,
        error: null,
      });
      const reconciled = await reconcileHistoricalJobProvenance(store, old);
      expect(reconciled).toMatchObject({
        operation_kind: "ask",
        observed_engine: "legacy-v1",
        intended_engine: null,
        kimi_version: null,
      });
      expect(reconciled.updated_at).toBe(old.updated_at);
    } finally {
      store.close();
      await cleanupTestPath(pluginDataRoot);
    }
  });
});
