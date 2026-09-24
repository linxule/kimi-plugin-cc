import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertExecutionPlanMatchesSpawn,
  classifyHistoricalEngineProvenance,
  executionPlanFromPersisted,
  NATIVE_V2_CERTIFIED,
  NATIVE_V2_CERTIFIED_VERSIONS,
  NATIVE_V2_SAFETY_PROFILE,
  assertResumeEngineCompatible,
  isNativeV2CertifiedVersion,
  selectIntendedEngine,
  prepareKimiExecutionPlan,
  reconcileHistoricalJobProvenance,
} from "../../runtime/kimi-engine.js";
import { JobStore } from "../../runtime/job-store.js";
import { maxTestedMinor } from "../../runtime/kimi-version-probe.js";
import { ensurePluginPaths, resolvePluginPaths } from "../../runtime/paths.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli-v1.ts");

// The first minor past the certified boundary. Derived so advancing
// KIMI_TESTED_MINORS never silently turns this fixture into a certified version.
// Untested by BOTH engine tables: above the legacy tested minors AND above
// every native-v2 certified minor. (0.42.0 is v2-certified, so the old
// "legacy max + 1" = 0.42.0 now routes to native-v2 and is certified — it must
// not be reused as the "untested" fixture.)
const _v2MaxMinor = Math.max(
  0,
  ...NATIVE_V2_CERTIFIED_VERSIONS.map((v) => Number(v.split(".")[1] ?? 0)),
);
const _untestedMinor = Math.max(maxTestedMinor().minor, _v2MaxMinor) + 1;
const NEXT_UNTESTED_VERSION = `${maxTestedMinor().major}.${_untestedMinor}.0`;

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

  test("native-v2 certifies only the exact per-operation version set, under the no-plan profile", async () => {
    expect(NATIVE_V2_CERTIFIED_VERSIONS).toEqual(["0.42.0", "0.43.0", "0.43.1", "2.0.0", "2.0.1", "2.0.2", "2.1.0", "2.1.1"]);
    expect([...NATIVE_V2_CERTIFIED.keys()].sort()).toEqual(
      ["ask", "challenge", "pursue", "rescue", "review", "review_gate", "swarm", "swarm-write"],
    );
    const cwd = await createTestPluginDataRoot("kimi-engine-v2-plan");
    // Empty KIMI_CODE_HOME: no config.toml → default_plan_mode absent → preflight passes.
    const kimiHome = path.join(cwd, "kimi-home");
    const env = {
      ...process.env,
      KIMI_PLUGIN_CC_KIMI_BIN: "bun",
      KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
      KIMI_CODE_HOME: kimiHome,
      KIMI_CODE_EXPERIMENTAL_FLAG: "",
      KIMI_CODE_EXPERIMENTAL_TOWER: "",
      KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK: "",
    };
    try {
      const plan = await prepareKimiExecutionPlan({
        operationKind: "swarm-write",
        cwd,
        env: { ...env, KIMI_PLUGIN_CC_MOCK_VERSION: "0.42.0" },
        intendedEngine: "native-v2",
      });
      expect(plan).toMatchObject({
        intendedEngine: "native-v2",
        kimiVersion: "0.42.0",
        certification: "certified",
        safetyProfile: NATIVE_V2_SAFETY_PROFILE,
      });
      expect(() =>
        assertExecutionPlanMatchesSpawn(plan, plan.command, ["run", mockCliPath]),
      ).not.toThrow();

      // A "v" prefix normalizes to the same exact version.
      await expect(
        prepareKimiExecutionPlan({
          operationKind: "ask",
          cwd,
          env: { ...env, KIMI_PLUGIN_CC_MOCK_VERSION: "v0.42.0" },
          intendedEngine: "native-v2",
        }),
      ).resolves.toMatchObject({ intendedEngine: "native-v2", kimiVersion: "0.42.0" });

      for (const version of ["2.0.2", "2.1.0", "2.1.1"]) {
        for (const operationKind of NATIVE_V2_CERTIFIED.keys()) {
          const majorTwo = await prepareKimiExecutionPlan({
            operationKind,
            cwd,
            env: { ...env, KIMI_PLUGIN_CC_MOCK_VERSION: version },
          });
          expect(majorTwo).toMatchObject({
            operationKind, intendedEngine: "native-v2", kimiVersion: version,
            certification: "certified", safetyProfile: NATIVE_V2_SAFETY_PROFILE,
          });
          expect(() => assertExecutionPlanMatchesSpawn(majorTwo, majorTwo.command, majorTwo.prefixArgs)).not.toThrow();
        }
      }

      for (const version of ["0.41.0", "0.42.1", "0.43.2", "2.0.3", "2.1.2", "2.2.0", "2.1.0-rc.1", "2.1.1+unreviewed", "2.0.2-rc.1", "2.0.2+unreviewed"]) {
        await expect(
          prepareKimiExecutionPlan({
            operationKind: "review",
            cwd,
            env: { ...env, KIMI_PLUGIN_CC_MOCK_VERSION: version },
            intendedEngine: "native-v2",
          }),
        ).rejects.toMatchObject({
          code: "KIMI_CAPABILITY_NOT_CERTIFIED",
          details: {
            refusal_kind: "v2-version-not-certified",
            intended_engine: "native-v2",
            kimi_version: version,
            retryable_after_setup: false,
          },
        });
      }
    } finally {
      await cleanupTestPath(cwd);
    }
  });

  test("native-v2 plans refuse pre-spawn when default_plan_mode is configured", async () => {
    const cwd = await createTestPluginDataRoot("kimi-engine-v2-planmode");
    const kimiHome = path.join(cwd, "kimi-home");
    await mkdir(kimiHome, { recursive: true });
    await writeFile(path.join(kimiHome, "config.toml"), "default_plan_mode = true\n");
    try {
      await expect(
        prepareKimiExecutionPlan({
          operationKind: "ask",
          cwd,
          env: {
            ...process.env,
            KIMI_PLUGIN_CC_KIMI_BIN: "bun",
            KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
            KIMI_PLUGIN_CC_MOCK_VERSION: "0.42.0",
            KIMI_CODE_HOME: kimiHome,
          },
          intendedEngine: "native-v2",
        }),
      ).rejects.toMatchObject({
        code: "CLI_V2_PLAN_MODE_CONFIGURED",
        stage: "kimi-engine.plan",
        details: { refusal_kind: "v2-plan-mode-configured", retryable_after_setup: false },
      });
    } finally {
      await cleanupTestPath(cwd);
    }
  });

  test("selectIntendedEngine routes only exactly certified versions to native-v2", () => {
    expect(selectIntendedEngine("review", { version: "0.42.0" })).toBe("native-v2");
    expect(selectIntendedEngine("swarm-write", { version: "v0.42.0" })).toBe("native-v2");
    expect(selectIntendedEngine("review", { version: "0.41.0" })).toBe("legacy-v1");
    expect(selectIntendedEngine("review", { version: "0.42.1" })).toBe("legacy-v1");
    expect(selectIntendedEngine("review", { version: "garbage" })).toBe("legacy-v1");
  });

  // Setup uses this to avoid the misleading "not certified, commands will
  // refuse" warning on a v2-certified binary that is deliberately outside the
  // legacy KIMI_TESTED_MINORS table.
  test("isNativeV2CertifiedVersion recognizes exactly the certified v2 versions", () => {
    expect(isNativeV2CertifiedVersion("0.42.0")).toBe(true);
    expect(isNativeV2CertifiedVersion("v0.42.0")).toBe(true);
    expect(isNativeV2CertifiedVersion("0.41.0")).toBe(false);
    expect(isNativeV2CertifiedVersion("0.42.1")).toBe(false);
    expect(isNativeV2CertifiedVersion("garbage")).toBe(false);
  });

  test("native-v2 test-bypass plans still carry the safety profile and require the env seam at spawn", async () => {
    const cwd = await createTestPluginDataRoot("kimi-engine-v2-bypass");
    const kimiHome = path.join(cwd, "kimi-home");
    const env = {
      ...process.env,
      KIMI_PLUGIN_CC_KIMI_BIN: "bun",
      KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
      KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: "1",
      KIMI_CODE_HOME: kimiHome,
    };
    try {
      const plan = await prepareKimiExecutionPlan({
        operationKind: "review",
        cwd,
        env,
        intendedEngine: "native-v2",
      });
      expect(plan).toMatchObject({
        certification: "test-bypass",
        kimiVersion: null,
        safetyProfile: NATIVE_V2_SAFETY_PROFILE,
      });
      expect(() =>
        assertExecutionPlanMatchesSpawn(plan, plan.command, ["run", mockCliPath], {}),
      ).toThrowError(expect.objectContaining({ code: "KIMI_EXECUTION_PLAN_INVALID" }));
      expect(() =>
        assertExecutionPlanMatchesSpawn(plan, plan.command, ["run", mockCliPath], env),
      ).not.toThrow();
    } finally {
      await cleanupTestPath(cwd);
    }
  });

  test("resume lineage: unknown rows refuse native-v2, keep legacy behavior, and proven engines never cross", () => {
    const base = {
      job_id: "job-1",
      kimi_session_id: "session_abc",
    } as unknown as import("../../runtime/job-store.js").JobRecord;
    const unknown = { ...base, observed_engine: null };
    expect(() => assertResumeEngineCompatible(unknown, "legacy-v1", "ask")).not.toThrow();
    expect(() => assertResumeEngineCompatible(unknown, "native-v2", "rescue")).toThrowError(
      expect.objectContaining({
        code: "KIMI_SESSION_LINEAGE_UNKNOWN",
        details: expect.objectContaining({
          refusal_kind: "session-lineage-unknown",
          retryable_after_setup: false,
          source_job_id: "job-1",
          target_engine: "native-v2",
        }),
      }),
    );
    const v1 = { ...base, observed_engine: "legacy-v1" as const };
    expect(() => assertResumeEngineCompatible(v1, "native-v2", "ask")).toThrowError(
      expect.objectContaining({ code: "KIMI_SESSION_ENGINE_MISMATCH" }),
    );
    const v2 = { ...base, observed_engine: "native-v2" as const };
    expect(() => assertResumeEngineCompatible(v2, "native-v2", "ask")).not.toThrow();
    expect(() => assertResumeEngineCompatible(v2, "legacy-v1", "ask")).toThrowError(
      expect.objectContaining({ code: "KIMI_SESSION_ENGINE_MISMATCH" }),
    );
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
      details: { refusal_kind: "v2-hook-order-unsafe", retryable_after_setup: false },
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
          env: { ...baseEnv, KIMI_PLUGIN_CC_MOCK_VERSION: NEXT_UNTESTED_VERSION },
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
        details: { minimum_version: "0.18.0", retryable_after_setup: false, refusal_kind: "v1-version-not-certified" },
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
          kimiVersion: NEXT_UNTESTED_VERSION,
          certification: "certified",
          resumedFromJobId: null,
          safetyProfile: null,
        },
        process.execPath,
        [],
      ),
    ).toThrowError(expect.objectContaining({ code: "KIMI_CAPABILITY_NOT_CERTIFIED" }));

    const v2Plan = {
      schemaVersion: 1 as const,
      operationKind: "review" as const,
      intendedEngine: "native-v2" as const,
      command: process.execPath,
      prefixArgs: [],
      kimiVersion: "0.42.0",
      certification: "certified" as const,
      resumedFromJobId: null,
      safetyProfile: NATIVE_V2_SAFETY_PROFILE,
    };
    expect(() => assertExecutionPlanMatchesSpawn(v2Plan, process.execPath, [])).not.toThrow();
    // A forged/deserialized v2 row without the profile it was certified under.
    expect(() =>
      assertExecutionPlanMatchesSpawn({ ...v2Plan, safetyProfile: null }, process.execPath, []),
    ).toThrowError(expect.objectContaining({ code: "KIMI_EXECUTION_PLAN_INVALID" }));
    // An uncertified exact version cannot be smuggled through a persisted row.
    expect(() =>
      assertExecutionPlanMatchesSpawn({ ...v2Plan, kimiVersion: "0.39.0" }, process.execPath, []),
    ).toThrowError(expect.objectContaining({ code: "KIMI_CAPABILITY_NOT_CERTIFIED" }));
    // A v1 plan must not carry the v2 profile.
    expect(() =>
      assertExecutionPlanMatchesSpawn(
        { ...v2Plan, intendedEngine: "legacy-v1", kimiVersion: "0.39.0" },
        process.execPath,
        [],
      ),
    ).toThrowError(expect.objectContaining({ code: "KIMI_EXECUTION_PLAN_INVALID" }));
  });

  test("persisted v2 plans round-trip the safety profile and reject an unknown one", () => {
    const persisted = {
      operation_kind: "ask" as const,
      intended_engine: "native-v2" as const,
      kimi_version: "0.42.0",
      kimi_command: process.execPath,
      kimi_prefix_args: "[]",
      plan_certification: "certified" as const,
      resumed_from_job_id: null,
      safety_profile: NATIVE_V2_SAFETY_PROFILE,
    };
    expect(executionPlanFromPersisted(persisted).safetyProfile).toBe(NATIVE_V2_SAFETY_PROFILE);
    expect(() =>
      executionPlanFromPersisted({ ...persisted, safety_profile: "native-v2-yolo/9" as never }),
    ).toThrowError(expect.objectContaining({ code: "KIMI_EXECUTION_PLAN_INVALID" }));
    // Historical rows predate the column: deserialize as null, refused at spawn for v2.
    const { safety_profile: _dropped, ...historical } = persisted;
    const plan = executionPlanFromPersisted(historical);
    expect(plan.safetyProfile).toBeNull();
    expect(() => assertExecutionPlanMatchesSpawn(plan, process.execPath, [])).toThrowError(
      expect.objectContaining({ code: "KIMI_EXECUTION_PLAN_INVALID" }),
    );
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
      safety_profile: null,
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
