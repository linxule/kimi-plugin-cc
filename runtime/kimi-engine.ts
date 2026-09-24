import { constants as fsConstants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { RuntimeError } from "./errors.js";
import { resolveKimiCliCommand } from "./kimi-command.js";
import { resolveKimiHome } from "./kimi-home.js";
import { assertNativeV2Preflight } from "./native-v2-preflight.js";
import {
  isInTestedRange,
  parseVersionLine,
  probeKimiVersion,
  type KimiVersionProbeOk,
} from "./kimi-version-probe.js";
import type { JobRecord, JobStore } from "./job-store.js";

export type KimiEngine = "legacy-v1" | "native-v2";

/**
 * The user-visible operation actually being performed. This is deliberately
 * separate from JobRecord.command_type: pursue and swarm-write reuse the
 * rescue job lineage, while read-only swarm reuses review.
 */
export type KimiOperationKind =
  | "review"
  | "challenge"
  | "ask"
  | "rescue"
  | "review_gate"
  | "pursue"
  | "swarm"
  | "swarm-write";

export type KimiPlanCertification = "certified" | "test-bypass";

/**
 * Plugin-owned safety construction a native-v2 plan is certified under.
 * "native-v2-no-plan/1": plan mode is never armed in the managed session
 * (default_plan_mode refused pre-spawn, EnterPlanMode hook-denied,
 * plan-tainted journals never resumed), so agent-core-v2's sole final allow
 * is unreachable and every executed tool call passes the managed hook.
 */
export type KimiSafetyProfile = "native-v2-no-plan/1";
export const NATIVE_V2_SAFETY_PROFILE: KimiSafetyProfile = "native-v2-no-plan/1";

/** Immutable description of the exact subprocess route authorized to run. */
export interface KimiExecutionPlan {
  readonly schemaVersion: 1;
  readonly operationKind: KimiOperationKind;
  readonly intendedEngine: KimiEngine;
  readonly command: string;
  readonly prefixArgs: readonly string[];
  readonly kimiVersion: string | null;
  readonly certification: KimiPlanCertification;
  readonly resumedFromJobId: string | null;
  /** Required for native-v2 plans; always null for legacy-v1. */
  readonly safetyProfile: KimiSafetyProfile | null;
}

export interface PrepareKimiExecutionPlanOptions {
  readonly operationKind: KimiOperationKind;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /**
   * Explicit engine (tests/smoke). Production callers omit it: the engine is
   * selected from the probed exact version via `selectIntendedEngine`, so a
   * 0.42.0 binary routes to native-v2 and a pinned <=0.41 binary to legacy-v1.
   * Test-bypass plans without an explicit engine default to legacy-v1.
   */
  readonly intendedEngine?: KimiEngine;
  readonly resumedFromJobId?: string | null;
  /** kimi session the plan will resume; lets the v2 preflight scan its journal. */
  readonly resumeSessionId?: string;
  /**
   * Source job of a resume. Its proven/unknown engine is checked against the
   * SELECTED engine (not a caller guess) before the preflight runs.
   */
  readonly resumeSource?: JobRecord | null;
}

/**
 * Minimum legacy-v1 version that actually contains each operation. The upper
 * boundary is KIMI_TESTED_MINORS, enforced by probe.inTestedRange.
 */
const LEGACY_V1_MINIMUMS: Readonly<Record<KimiOperationKind, { major: number; minor: number }>> = {
  review: { major: 0, minor: 1 },
  challenge: { major: 0, minor: 1 },
  ask: { major: 0, minor: 1 },
  rescue: { major: 0, minor: 1 },
  review_gate: { major: 0, minor: 1 },
  pursue: { major: 0, minor: 8 },
  swarm: { major: 0, minor: 12 },
  "swarm-write": { major: 0, minor: 18 },
};

/**
 * Exact kimi-code releases certified for native v2 under
 * NATIVE_V2_SAFETY_PROFILE. Exact, not minor-ranged: upstream ships
 * behavioural changes in patch releases, and the no-plan construction must be
 * re-proven (mechanized tag scan + real-binary smoke) per tag before a version
 * is appended. Each entry has its own row in tests/audit/v2-tag-scan.test.ts
 * and a dated entry in ROADMAP-TO-GA.md § Post-GA audit log.
 */
export const NATIVE_V2_CERTIFIED_VERSIONS: readonly string[] = Object.freeze([
  "0.42.0",
  "0.43.0",
  "0.43.1",
  "2.0.0",
  "2.0.1",
  "2.0.2",
  "2.1.0",
  "2.1.1",
]);

/** Per-operation native-v2 certification. One green operation never certifies another. */
export const NATIVE_V2_CERTIFIED: ReadonlyMap<KimiOperationKind, readonly string[]> = new Map<
  KimiOperationKind,
  readonly string[]
>([
  ["review", NATIVE_V2_CERTIFIED_VERSIONS],
  ["challenge", NATIVE_V2_CERTIFIED_VERSIONS],
  ["ask", NATIVE_V2_CERTIFIED_VERSIONS],
  ["rescue", NATIVE_V2_CERTIFIED_VERSIONS],
  ["review_gate", NATIVE_V2_CERTIFIED_VERSIONS],
  ["pursue", NATIVE_V2_CERTIFIED_VERSIONS],
  ["swarm", NATIVE_V2_CERTIFIED_VERSIONS],
  ["swarm-write", NATIVE_V2_CERTIFIED_VERSIONS],
]);

export function isNativeV2Certified(
  operationKind: KimiOperationKind,
  version: string,
): boolean {
  const normalized = parseVersionLine(version)?.raw;
  if (normalized === undefined) return false;
  return NATIVE_V2_CERTIFIED.get(operationKind)?.includes(normalized) ?? false;
}

/**
 * True when this exact version is certified for native v2 for ANY operation.
 * Used by setup to phrase its version notice: a v2-certified version is NOT an
 * "out of tested range, will refuse" case even though it is outside the legacy
 * `KIMI_TESTED_MINORS` table (that table intentionally never gains 0.42).
 */
export function isNativeV2CertifiedVersion(version: string): boolean {
  const normalized = parseVersionLine(version)?.raw;
  if (normalized === undefined) return false;
  return NATIVE_V2_CERTIFIED_VERSIONS.includes(normalized);
}

/**
 * Engine selection for a probed binary: native v2 when the exact version is
 * certified for this operation, else legacy-v1 (whose own tested-range check
 * still applies). kimi-code 0.42.0 removed the v1 engine, so a v1 plan on a
 * ≥0.42 binary is refused by the legacy range rather than silently run on v2.
 */
export function selectIntendedEngine(
  operationKind: KimiOperationKind,
  probe: Pick<KimiVersionProbeOk, "version">,
): KimiEngine {
  return isNativeV2Certified(operationKind, probe.version) ? "native-v2" : "legacy-v1";
}

const UNSAFE_EXPERIMENTAL_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * Refuse the ambient experimental-feature selector before any model or version
 * subprocess. cli-client repeats this at the final spawn boundary in case the
 * environment changes after plan creation.
 */
export function assertNoUnsafeExperimentalSelector(
  env: Readonly<NodeJS.ProcessEnv>,
  stage = "kimi-engine.plan",
): void {
  const enabled = UNSAFE_EXPERIMENTAL_VALUES.has(
    (env.KIMI_CODE_EXPERIMENTAL_FLAG ?? "").trim().toLowerCase(),
  );
  if (!enabled) return;
  throw new RuntimeError(
    "CLI_V2_HOOK_ORDER_UNSAFE",
    "Refusing kimi-code experimental features: the master KIMI_CODE_EXPERIMENTAL_FLAG enables unreviewed agent-core-v2 features (tower, subagent fork) that kimi-plugin-cc has not certified under its no-plan safety profile. Unset KIMI_CODE_EXPERIMENTAL_FLAG and retry.",
    stage,
    {
      details: {
        refusal_kind: "v2-hook-order-unsafe",
        retryable_after_setup: false,
        experimental_v2: true,
      },
    },
  );
}

/**
 * Resolve and certify the exact command tuple before a job row is created.
 * The same tuple is persisted and later supplied to cli-client, including by a
 * detached worker, so ambient PATH/config changes cannot silently choose an
 * alternate route between dispatch and execution.
 */
export async function prepareKimiExecutionPlan(
  options: PrepareKimiExecutionPlanOptions,
): Promise<KimiExecutionPlan> {
  assertNoUnsafeExperimentalSelector(options.env);

  if (
    options.intendedEngine === "native-v2" &&
    !NATIVE_V2_CERTIFIED.has(options.operationKind)
  ) {
    throw nativeV2NotCertified(options.operationKind, null);
  }

  const kimi = resolveKimiCliCommand(options.env);

  const exactCommand = await resolveExactExecutable(
    kimi.command,
    options.cwd,
    options.env,
  );

  const runPreflight = async (intendedEngine: KimiEngine) => {
    if (options.resumeSource) {
      assertResumeEngineCompatible(options.resumeSource, intendedEngine, options.operationKind);
    }
    if (intendedEngine !== "native-v2") return;
    // Safety, not certification: runs for test-bypass plans too.
    await assertNativeV2Preflight({
      kimiHome: resolveKimiHome(options.env, options.cwd),
      env: options.env,
      resumeSessionId: options.resumeSessionId,
      stage: "kimi-engine.plan",
    });
  };

  if (options.env.KIMI_PLUGIN_CC_SKIP_VERSION_PROBE === "1") {
    const intendedEngine = options.intendedEngine ?? "legacy-v1";
    const safetyProfile = intendedEngine === "native-v2" ? NATIVE_V2_SAFETY_PROFILE : null;
    await runPreflight(intendedEngine);
    return Object.freeze({
      schemaVersion: 1,
      operationKind: options.operationKind,
      intendedEngine,
      command: exactCommand,
      prefixArgs: Object.freeze([...kimi.prefixArgs]),
      kimiVersion: null,
      certification: "test-bypass",
      resumedFromJobId: options.resumedFromJobId ?? null,
      safetyProfile,
    });
  }

  const probe = await probeKimiVersion({
    kimiBin: exactCommand,
    prefixArgs: kimi.prefixArgs,
    cwd: options.cwd,
    env: options.env,
  });
  if (probe.kind !== "ok") {
    throw new RuntimeError(
      "KIMI_EXECUTION_PLAN_UNRESOLVED",
      `Refusing to spawn kimi because the exact command/version plan could not be established: ${probe.reason}. Run Claude Code \`/kimi:setup\` or Codex \`$kimi-setup\` to verify the active binary, or correct KIMI_PLUGIN_CC_KIMI_BIN / KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS and retry.`,
      "kimi-engine.plan",
      {
        details: {
          operation_kind: options.operationKind,
          intended_engine: options.intendedEngine ?? null,
          command: exactCommand,
          prefix_args: kimi.prefixArgs,
        },
      },
    );
  }

  const intendedEngine =
    options.intendedEngine ?? selectIntendedEngine(options.operationKind, probe);
  const safetyProfile = intendedEngine === "native-v2" ? NATIVE_V2_SAFETY_PROFILE : null;
  assertCertifiedCapability(intendedEngine, options.operationKind, probe);
  await runPreflight(intendedEngine);

  return Object.freeze({
    schemaVersion: 1,
    operationKind: options.operationKind,
    intendedEngine,
    command: exactCommand,
    prefixArgs: Object.freeze([...kimi.prefixArgs]),
    kimiVersion: probe.version,
    certification: "certified",
    resumedFromJobId: options.resumedFromJobId ?? null,
    safetyProfile,
  });
}

export function assertExecutionPlanMatchesSpawn(
  plan: KimiExecutionPlan,
  command: string,
  prefixArgs: readonly string[],
  env: Readonly<NodeJS.ProcessEnv> = {},
): void {
  assertExecutionPlanShape(plan);
  assertPlanCertification(plan, env);
  if (plan.command !== command || !sameStrings(plan.prefixArgs, prefixArgs)) {
    throw new RuntimeError(
      "KIMI_EXECUTION_PLAN_MISMATCH",
      "Refusing to spawn kimi because the command tuple differs from the certified execution plan.",
      "cli-client.pre-spawn",
      {
        details: {
          operation_kind: plan.operationKind,
          intended_engine: plan.intendedEngine,
          planned_command: plan.command,
          planned_prefix_args: plan.prefixArgs,
          requested_command: command,
          requested_prefix_args: prefixArgs,
        },
      },
    );
  }
}

export interface PersistedExecutionPlanFields {
  operation_kind: KimiOperationKind;
  intended_engine: KimiEngine;
  observed_engine: null;
  kimi_version: string | null;
  system_version: null;
  kimi_command: string;
  kimi_prefix_args: string;
  plan_certification: KimiPlanCertification;
  resumed_from_job_id: string | null;
  safety_profile: KimiSafetyProfile | null;
}

export function persistedExecutionPlanFields(
  plan: KimiExecutionPlan,
): PersistedExecutionPlanFields {
  return {
    operation_kind: plan.operationKind,
    intended_engine: plan.intendedEngine,
    observed_engine: null,
    kimi_version: plan.kimiVersion,
    system_version: null,
    kimi_command: plan.command,
    kimi_prefix_args: JSON.stringify(plan.prefixArgs),
    plan_certification: plan.certification,
    resumed_from_job_id: plan.resumedFromJobId,
    safety_profile: plan.safetyProfile,
  };
}

export function observedExecutionFields(result: {
  observedEngine: KimiEngine | null;
  systemVersion?: string;
}): { observed_engine: KimiEngine | null; system_version: string | null } {
  return {
    observed_engine: result.observedEngine,
    system_version: result.systemVersion ?? null,
  };
}

export function executionPlanFromPersisted(fields: {
  operation_kind: KimiOperationKind | null;
  intended_engine: KimiEngine | null;
  kimi_version: string | null;
  kimi_command: string | null;
  kimi_prefix_args: string | null;
  plan_certification: KimiPlanCertification | null;
  resumed_from_job_id: string | null;
  safety_profile?: KimiSafetyProfile | null;
}): KimiExecutionPlan {
  if (
    fields.operation_kind === null ||
    fields.intended_engine === null ||
    fields.kimi_command === null ||
    fields.kimi_prefix_args === null ||
    fields.plan_certification === null
  ) {
    throw new RuntimeError(
      "KIMI_EXECUTION_PLAN_MISSING",
      "This job predates durable engine provenance and cannot be used as a subprocess execution plan.",
      "kimi-engine.persisted-plan",
    );
  }

  if (!isOperationKind(fields.operation_kind)) {
    throw invalidPersistedPlan(`unknown operation_kind ${JSON.stringify(fields.operation_kind)}`);
  }
  if (!isKimiEngine(fields.intended_engine)) {
    throw invalidPersistedPlan(`unknown intended_engine ${JSON.stringify(fields.intended_engine)}`);
  }
  if (!isPlanCertification(fields.plan_certification)) {
    throw invalidPersistedPlan(
      `unknown plan_certification ${JSON.stringify(fields.plan_certification)}`,
    );
  }
  if (fields.kimi_command.length === 0) {
    throw invalidPersistedPlan("kimi_command is empty");
  }

  let prefixArgs: unknown;
  try {
    prefixArgs = JSON.parse(fields.kimi_prefix_args);
  } catch (error) {
    throw invalidPersistedPlan("kimi_prefix_args is not valid JSON", error);
  }
  if (!Array.isArray(prefixArgs) || !prefixArgs.every((entry) => typeof entry === "string")) {
    throw invalidPersistedPlan("kimi_prefix_args is not a string array");
  }

  const plan = Object.freeze({
    schemaVersion: 1,
    operationKind: fields.operation_kind,
    intendedEngine: fields.intended_engine,
    command: fields.kimi_command,
    prefixArgs: Object.freeze([...prefixArgs]),
    kimiVersion: fields.kimi_version,
    certification: fields.plan_certification,
    resumedFromJobId: fields.resumed_from_job_id,
    safetyProfile: fields.safety_profile ?? null,
  });
  assertExecutionPlanShape(plan);
  return plan;
}

export interface HistoricalEngineProvenance {
  readonly observedEngine: KimiEngine | null;
  readonly kimiVersion: string | null;
  readonly operationKind: KimiOperationKind | null;
  readonly evidence: readonly string[];
  readonly conflict: boolean;
}

const MAX_FORENSIC_LOG_BYTES = 32 * 1024 * 1024;

/**
 * Best-effort, evidence-only persistence for a historical row. Missing,
 * oversized, malformed, or conflicting logs leave the row unknown. This is
 * deliberately non-blocking: provenance inspection must not break status or
 * result retrieval for an old job.
 */
export async function reconcileHistoricalJobProvenance(
  store: JobStore,
  job: JobRecord,
): Promise<JobRecord> {
  if (job.observed_engine !== null && job.operation_kind !== null) return job;
  if (!job.stream_log_path) return job;
  try {
    const info = await stat(job.stream_log_path);
    if (!info.isFile() || info.size > MAX_FORENSIC_LOG_BYTES) return job;
    const evidence = classifyHistoricalEngineProvenance(
      await readFile(job.stream_log_path, "utf8"),
    );
    if (evidence.conflict) return job;
    return (
      store.backfillHistoricalProvenance(job.job_id, {
        operation_kind: evidence.operationKind,
        observed_engine: evidence.observedEngine,
        kimi_version: evidence.kimiVersion,
        system_version:
          evidence.observedEngine === "native-v2" ? evidence.kimiVersion : null,
      }) ?? job
    );
  } catch {
    return job;
  }
}

/**
 * Known cross-engine resumes are forbidden. Unknown historical rows keep the
 * pre-provenance legacy-v1 behavior, but can never be continued on native v2:
 * a v2 resume replays the saved journal, so only proven, plugin-managed v2
 * lineage is accepted there.
 */
export function assertResumeEngineCompatible(
  source: JobRecord,
  targetEngine: KimiEngine,
  operationKind: KimiOperationKind,
): void {
  if (source.observed_engine === null && targetEngine === "native-v2") {
    throw new RuntimeError(
      "KIMI_SESSION_LINEAGE_UNKNOWN",
      `Refusing to resume session ${source.kimi_session_id ?? "<unknown>"}: job ${source.job_id} has no proven engine provenance, and native-v2 continues only plugin-managed native-v2 sessions. Start a fresh ${operationKind} session instead; the old job's status/result/replay remain available.`,
      `${operationKind}.resume`,
      {
        details: {
          refusal_kind: "session-lineage-unknown",
          retryable_after_setup: false,
          source_job_id: source.job_id,
          source_engine: null,
          target_engine: targetEngine,
          operation_kind: operationKind,
        },
      },
    );
  }
  if (source.observed_engine === null || source.observed_engine === targetEngine) return;
  throw new RuntimeError(
    "KIMI_SESSION_ENGINE_MISMATCH",
    `Refusing to resume session ${source.kimi_session_id ?? "<unknown>"}: job ${source.job_id} is proven ${source.observed_engine}, while the new ${operationKind} plan is ${targetEngine}. Start a fresh session instead.`,
    `${operationKind}.resume`,
    {
      details: {
        source_job_id: source.job_id,
        source_engine: source.observed_engine,
        target_engine: targetEngine,
        operation_kind: operationKind,
      },
    },
  );
}

/**
 * Re-validate a PERSISTED resume before a detached worker spawns it. The
 * dispatch path checks resume lineage against `resumeSource`, but a worker (or
 * a forged/corrupt queued row) reloads the plan and hands `kimi_session_id`
 * straight to the spawn — so the binding and lineage must be re-established
 * from the store here, not trusted from the row. Callers invoke this ONLY when
 * the row carries a session id to resume; a genuinely fresh session has none
 * yet (kimi assigns it after the run), so it never reaches this check.
 *
 * Refuses when: the row carries a session id but the plan records no source
 * job (a session with no plugin lineage can never be a plugin-managed resume);
 * the recorded source job is missing; the source it names does not actually
 * own the session being resumed (binding forgery); or the source's proven
 * engine is incompatible with the plan's engine (incl. unknown lineage on a
 * native-v2 target). The v2 preflight separately re-scans that session's
 * journal for plan taint at the spawn boundary.
 */
export async function assertPersistedResumeLineage(
  store: JobStore,
  plan: KimiExecutionPlan,
  resumeSessionId: string,
  operationKind: "ask" | "rescue",
): Promise<void> {
  if (plan.resumedFromJobId === null) {
    throw new RuntimeError(
      "KIMI_SESSION_LINEAGE_UNKNOWN",
      `Refusing to resume session ${resumeSessionId}: the persisted job carries a session id but records no source job, so its lineage cannot be established. Start a fresh session.`,
      `${operationKind}.resume`,
      {
        details: {
          refusal_kind: "session-lineage-unknown",
          retryable_after_setup: false,
          source_job_id: null,
        },
      },
    );
  }
  const source = store.getJob(plan.resumedFromJobId);
  if (!source) {
    throw new RuntimeError(
      "KIMI_SESSION_LINEAGE_UNKNOWN",
      `Refusing to resume session ${resumeSessionId}: the persisted source job ${plan.resumedFromJobId} no longer exists, so its engine lineage cannot be established. Start a fresh session.`,
      `${operationKind}.resume`,
      {
        details: {
          refusal_kind: "session-lineage-unknown",
          retryable_after_setup: false,
          source_job_id: plan.resumedFromJobId,
        },
      },
    );
  }
  const reconciled = await reconcileHistoricalJobProvenance(store, source);
  if (reconciled.kimi_session_id !== resumeSessionId) {
    throw new RuntimeError(
      "KIMI_SESSION_LINEAGE_UNKNOWN",
      `Refusing to resume session ${resumeSessionId}: the persisted source job ${plan.resumedFromJobId} owns a different session (${reconciled.kimi_session_id ?? "<none>"}). Start a fresh session.`,
      `${operationKind}.resume`,
      {
        details: {
          refusal_kind: "session-lineage-unknown",
          retryable_after_setup: false,
          source_job_id: plan.resumedFromJobId,
        },
      },
    );
  }
  assertResumeEngineCompatible(reconciled, plan.intendedEngine, operationKind);
}

/**
 * Classify saved plugin logs without guessing. `system.version` and wire
 * protocol 1.5 are positive v2 evidence; a spawn that explicitly records the
 * forced legacy flag, or wire protocol <=1.4, is positive v1 evidence. Absence
 * of either remains unknown, covering the historical v1.9.5 routing window.
 */
export function classifyHistoricalEngineProvenance(
  contents: string,
): HistoricalEngineProvenance {
  let sawLegacy = false;
  let sawNative = false;
  let sawLegacyForcedSpawn = false;
  let sawRunEvidence = false;
  let kimiVersion: string | null = null;
  let operationKind: KimiOperationKind | null = null;
  const evidence: string[] = [];

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;

    if (entry.event === "system_version" && typeof entry.version === "string") {
      sawNative = true;
      kimiVersion = parseVersionLine(entry.version)?.raw ?? entry.version;
      evidence.push("stream-json:system.version");
    }
    if (entry.event === "spawn" && entry.legacy_v1_forced === true) {
      sawLegacyForcedSpawn = true;
    }
    if (
      entry.event === "record" ||
      entry.event === "session_announce" ||
      entry.event === "goal_summary" ||
      (entry.event === "exit" && entry.exit_code === 0)
    ) {
      sawRunEvidence = true;
    }

    const protocolVersions =
      entry.type === "metadata" && typeof entry.protocol_version === "string"
        ? [entry.protocol_version]
        : [];
    for (const protocolVersion of protocolVersions) {
      const parsed = parseProtocolVersion(protocolVersion);
      if (parsed === null) continue;
      if (parsed.major > 1 || (parsed.major === 1 && parsed.minor >= 5)) {
        sawNative = true;
        evidence.push(`session-wire:protocol-${protocolVersion}`);
      } else {
        sawLegacy = true;
        evidence.push(`session-wire:protocol-${protocolVersion}`);
      }
    }

    operationKind ??= operationKindFromLogEntry(entry);
  }

  if (sawLegacyForcedSpawn && sawRunEvidence) {
    sawLegacy = true;
    evidence.push("spawn:legacy_v1_forced+run-evidence");
  }

  const conflict = sawLegacy && sawNative;
  return {
    observedEngine: conflict ? null : sawNative ? "native-v2" : sawLegacy ? "legacy-v1" : null,
    kimiVersion,
    operationKind,
    evidence: Object.freeze([...new Set(evidence)]),
    conflict,
  };
}

function assertCertifiedCapability(
  engine: KimiEngine,
  operationKind: KimiOperationKind,
  probe: KimiVersionProbeOk,
): void {
  if (engine === "native-v2") {
    if (!isNativeV2Certified(operationKind, probe.version)) {
      throw nativeV2NotCertified(operationKind, probe.version);
    }
    return;
  }

  const minimum = LEGACY_V1_MINIMUMS[operationKind];
  const meetsMinimum =
    probe.major > minimum.major ||
    (probe.major === minimum.major && probe.minor >= minimum.minor);
  if (!probe.inTestedRange || !meetsMinimum) {
    const remedy = !probe.inTestedRange
      ? "Update kimi-plugin-cc to a release that certifies this kimi-code minor, or point KIMI_PLUGIN_CC_KIMI_BIN at a certified binary."
      : `Upgrade kimi-code to at least ${minimum.major}.${minimum.minor}.0 within a certified minor.`;
    throw new RuntimeError(
      "KIMI_CAPABILITY_NOT_CERTIFIED",
      `Refusing ${operationKind}: kimi-code ${probe.version} is not in this operation's certified legacy-v1 range. ${remedy} KIMI_PLUGIN_CC_SKIP_VERSION_PROBE is a test/smoke seam, not a production repair path.`,
      "kimi-engine.capability",
      {
        details: {
          refusal_kind: "v1-version-not-certified",
          retryable_after_setup: false,
          operation_kind: operationKind,
          intended_engine: engine,
          kimi_version: probe.version,
          minimum_version: `${minimum.major}.${minimum.minor}.0`,
          tested_minor: probe.inTestedRange,
        },
      },
    );
  }
}

/**
 * Revalidate the persisted certification at the final subprocess boundary.
 * This keeps a corrupt/forged SQLite row from converting a once-certified plan
 * into an untested-version or native-v2 spawn.
 */
function assertPlanCertification(
  plan: KimiExecutionPlan,
  env: Readonly<NodeJS.ProcessEnv>,
): void {
  if (plan.intendedEngine === "native-v2" && plan.safetyProfile !== NATIVE_V2_SAFETY_PROFILE) {
    // A forged/deserialized v2 row cannot reach spawn without the profile it
    // was certified under.
    throw invalidPersistedPlan("native-v2 plans require the native-v2-no-plan safety profile");
  }
  if (plan.intendedEngine === "legacy-v1" && plan.safetyProfile !== null) {
    throw invalidPersistedPlan("legacy-v1 plans must not carry a safety profile");
  }
  if (plan.certification === "test-bypass") {
    if (plan.kimiVersion !== null) {
      throw invalidPersistedPlan("test-bypass plans must have kimi_version=null");
    }
    if (env.KIMI_PLUGIN_CC_SKIP_VERSION_PROBE !== "1") {
      throw invalidPersistedPlan(
        "test-bypass plans require KIMI_PLUGIN_CC_SKIP_VERSION_PROBE=1 at the final spawn boundary",
      );
    }
    return;
  }
  if (plan.kimiVersion === null) {
    throw invalidPersistedPlan("certified plans require kimi_version");
  }
  const parsed = parseVersionLine(plan.kimiVersion);
  if (parsed === undefined) {
    throw invalidPersistedPlan("kimi_version is not a parseable semantic version");
  }
  assertCertifiedCapability(plan.intendedEngine, plan.operationKind, {
    kind: "ok",
    version: parsed.raw,
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    inTestedRange: isInTestedRange(parsed.major, parsed.minor),
  });
}

function assertExecutionPlanShape(plan: KimiExecutionPlan): void {
  const candidate = plan as unknown as Record<string, unknown>;
  if (candidate.schemaVersion !== 1) {
    throw invalidPersistedPlan("unsupported schemaVersion");
  }
  if (typeof candidate.operationKind !== "string" || !isOperationKind(candidate.operationKind)) {
    throw invalidPersistedPlan("operationKind is invalid");
  }
  if (typeof candidate.intendedEngine !== "string" || !isKimiEngine(candidate.intendedEngine)) {
    throw invalidPersistedPlan("intendedEngine is invalid");
  }
  if (
    typeof candidate.certification !== "string" ||
    !isPlanCertification(candidate.certification)
  ) {
    throw invalidPersistedPlan("certification is invalid");
  }
  if (typeof candidate.command !== "string" || candidate.command.length === 0) {
    throw invalidPersistedPlan("command is empty or invalid");
  }
  if (
    !Array.isArray(candidate.prefixArgs) ||
    !candidate.prefixArgs.every((entry) => typeof entry === "string")
  ) {
    throw invalidPersistedPlan("prefixArgs is not a string array");
  }
  if (candidate.kimiVersion !== null && typeof candidate.kimiVersion !== "string") {
    throw invalidPersistedPlan("kimiVersion is invalid");
  }
  if (
    candidate.resumedFromJobId !== null &&
    typeof candidate.resumedFromJobId !== "string"
  ) {
    throw invalidPersistedPlan("resumedFromJobId is invalid");
  }
  if (candidate.safetyProfile !== null && candidate.safetyProfile !== NATIVE_V2_SAFETY_PROFILE) {
    throw invalidPersistedPlan("safetyProfile is invalid");
  }
}

function nativeV2NotCertified(
  operationKind: KimiOperationKind,
  version: string | null,
): RuntimeError {
  const certified = NATIVE_V2_CERTIFIED.get(operationKind) ?? [];
  const observed = version === null ? "an unprobed version" : `kimi-code ${version}`;
  return new RuntimeError(
    "KIMI_CAPABILITY_NOT_CERTIFIED",
    `Refusing ${operationKind} on native v2: ${observed} is not in this operation's exactly certified set [${certified.join(", ")}]. Update kimi-plugin-cc to a release that certifies this kimi-code version, or point KIMI_PLUGIN_CC_KIMI_BIN at a certified binary. KIMI_PLUGIN_CC_SKIP_VERSION_PROBE is a test/smoke seam, not a production repair path.`,
    "kimi-engine.capability",
    {
      details: {
        refusal_kind: "v2-version-not-certified",
        retryable_after_setup: false,
        operation_kind: operationKind,
        intended_engine: "native-v2",
        kimi_version: version,
        certified_versions: [...certified],
      },
    },
  );
}

function invalidPersistedPlan(message: string, cause?: unknown): RuntimeError {
  return new RuntimeError(
    "KIMI_EXECUTION_PLAN_INVALID",
    `Persisted kimi execution plan is invalid: ${message}.`,
    "kimi-engine.persisted-plan",
    cause instanceof Error ? { cause } : undefined,
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function resolveExactExecutable(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const candidates: string[] = [];
  if (command.includes("/") || command.includes("\\")) {
    candidates.push(path.isAbsolute(command) ? command : path.resolve(cwd, command));
  } else {
    const searchPath = env.PATH ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
    const extensions =
      process.platform === "win32"
        ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
        : [""];
    for (const entry of searchPath.split(path.delimiter)) {
      const directory =
        entry.length === 0 ? cwd : path.isAbsolute(entry) ? entry : path.resolve(cwd, entry);
      for (const extension of extensions) {
        candidates.push(path.join(directory, `${command}${extension}`));
      }
    }
  }

  for (const candidate of candidates) {
    try {
      await access(
        candidate,
        process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
      );
      return await realpath(candidate);
    } catch {
      // Keep searching; failure is reported once with the original command.
    }
  }

  throw new RuntimeError(
    "KIMI_EXECUTION_PLAN_UNRESOLVED",
    `Refusing to spawn kimi because executable ${JSON.stringify(command)} could not be resolved to an exact runnable path. Run Claude Code \`/kimi:setup\` or Codex \`$kimi-setup\` to verify the active binary, or correct KIMI_PLUGIN_CC_KIMI_BIN and retry.`,
    "kimi-engine.plan",
    { details: { command, cwd } },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProtocolVersion(value: string): { major: number; minor: number } | null {
  const match = value.match(/^(\d+)\.(\d+)(?:\.\d+)?$/);
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function operationKindFromLogEntry(entry: Record<string, unknown>): KimiOperationKind | null {
  if (typeof entry.operation_kind === "string" && isOperationKind(entry.operation_kind)) {
    return entry.operation_kind;
  }
  const candidate =
    entry.event === "spawn"
      ? entry.command_label
      : entry.direction === "meta" && isRecord(entry.message)
        ? entry.message.commandType
        : null;
  if (typeof candidate !== "string") return null;
  // Historical `rescue` labels cover both ordinary rescue and pursue, whose
  // write-policy label intentionally reuses rescue. Without the newer explicit
  // operation_kind field, choosing either would be a guess.
  if (candidate === "rescue") return null;
  return isOperationKind(candidate) ? candidate : null;
}

function isOperationKind(value: string): value is KimiOperationKind {
  return (
    value === "review" ||
    value === "challenge" ||
    value === "ask" ||
    value === "rescue" ||
    value === "review_gate" ||
    value === "pursue" ||
    value === "swarm" ||
    value === "swarm-write"
  );
}

function isKimiEngine(value: string): value is KimiEngine {
  return value === "legacy-v1" || value === "native-v2";
}

function isPlanCertification(value: string): value is KimiPlanCertification {
  return value === "certified" || value === "test-bypass";
}
