import { constants as fsConstants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { RuntimeError } from "./errors.js";
import { resolveKimiCliCommand } from "./kimi-command.js";
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
}

export interface PrepareKimiExecutionPlanOptions {
  readonly operationKind: KimiOperationKind;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly intendedEngine?: KimiEngine;
  readonly resumedFromJobId?: string | null;
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
 * Intentionally empty. Native v2 is not a production route until the released
 * hook-before-final-allow contract and every operation-specific gate in
 * docs/native-v2-certification-provenance.md are green.
 */
export const NATIVE_V2_CERTIFIED_OPERATIONS: ReadonlySet<KimiOperationKind> = new Set();

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
    "Refusing kimi-code experimental features because native-v2 plan-mode writes can final-allow before external PreToolUse hooks run. Unset KIMI_CODE_EXPERIMENTAL_FLAG; kimi-plugin-cc pins accepted runs to the legacy-v1 engine.",
    stage,
    {
      details: {
        refusal_kind: "v2-hook-order-unsafe",
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
  const intendedEngine = options.intendedEngine ?? "legacy-v1";

  assertNoUnsafeExperimentalSelector(options.env);

  if (
    intendedEngine === "native-v2" &&
    !NATIVE_V2_CERTIFIED_OPERATIONS.has(options.operationKind)
  ) {
    throw nativeV2NotCertified(options.operationKind);
  }

  const kimi = resolveKimiCliCommand(options.env);

  const exactCommand = await resolveExactExecutable(
    kimi.command,
    options.cwd,
    options.env,
  );

  if (options.env.KIMI_PLUGIN_CC_SKIP_VERSION_PROBE === "1") {
    return Object.freeze({
      schemaVersion: 1,
      operationKind: options.operationKind,
      intendedEngine,
      command: exactCommand,
      prefixArgs: Object.freeze([...kimi.prefixArgs]),
      kimiVersion: null,
      certification: "test-bypass",
      resumedFromJobId: options.resumedFromJobId ?? null,
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
          intended_engine: intendedEngine,
          command: exactCommand,
          prefix_args: kimi.prefixArgs,
        },
      },
    );
  }

  assertCertifiedCapability(intendedEngine, options.operationKind, probe);

  return Object.freeze({
    schemaVersion: 1,
    operationKind: options.operationKind,
    intendedEngine,
    command: exactCommand,
    prefixArgs: Object.freeze([...kimi.prefixArgs]),
    kimiVersion: probe.version,
    certification: "certified",
    resumedFromJobId: options.resumedFromJobId ?? null,
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

/** Known cross-engine resumes are forbidden; unknown historical rows retain legacy behavior. */
export function assertResumeEngineCompatible(
  source: JobRecord,
  targetEngine: KimiEngine,
  operationKind: "ask" | "rescue",
): void {
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
  if (engine === "native-v2") throw nativeV2NotCertified(operationKind);

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
  if (plan.intendedEngine === "native-v2") {
    // The production matrix is empty today. Keep this independent of the plan
    // constructor so a forged/deserialized plan cannot reach spawn.
    throw nativeV2NotCertified(plan.operationKind);
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
}

function nativeV2NotCertified(operationKind: KimiOperationKind): RuntimeError {
  return new RuntimeError(
    "CLI_V2_HOOK_ORDER_UNSAFE",
    `Native v2 is not certified for ${operationKind}; its production capability matrix is empty until a released external-hook-before-final-allow contract passes the full gate.`,
    "kimi-engine.capability",
    {
      details: {
        refusal_kind: "v2-hook-order-unsafe",
        operation_kind: operationKind,
        intended_engine: "native-v2",
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
