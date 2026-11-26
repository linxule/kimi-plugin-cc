import { constants as fsConstants, existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateKimiHookSetForEnvironment } from "./config-safety.js";
import {
  countCleanEntriesInFile,
  evaluateInstalled,
  findShortHookTimeout,
  type HookCommandDrift,
} from "./managed-block.js";
import {
  parseHookShellCommand,
  tryBuildExpectedHookCommand,
  verifyManagedHookArtifact,
} from "./install-paths.js";
import { RuntimeError } from "../errors.js";
import type { KimiOperationKind } from "../kimi-engine.js";
import { resolveKimiCodeConfigPath } from "../kimi-home.js";
import type { KimiVersionProbeOk } from "../kimi-version-probe.js";

/**
 * Verify the managed PreToolUse hook and require its decoded command to equal
 * the canonical command for the current environment. The expected command is
 * always reconstructed; exact equality rejects stale paths and substring
 * lookalikes that could otherwise fail open upstream.
 *
 * A byte match alone does not prove the hook can run. The verifier also checks
 * the script for readability and its pinned interpreter for executability,
 * because a spawn failure is ALLOW to kimi-code's hook runner.
 *
 * `KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1` bypasses hook-install refusal gates and
 * the review gate's enforcement check for tests/diagnostics. It does not bypass
 * the independent native-v2 preflight in cli-client.
 */
export interface HookInstallStatus {
  installed: boolean;
  /**
   * Job-time only, recorded by the job (channel W): the setup remedy for an
   * installed hook whose markers need repair (duplicate or orphan).
   */
  warnings?: string[];
  /** Human-readable reason (filled when `installed === false`). */
  reason?: string;
  /** Path examined. Useful for the warning message. */
  configPath: string;
  /**
   * Machine-readable drift classification (see `InstalledCheck.drift`), present
   * only when a structurally sound block names different canonical paths.
   * Other refusals are not re-pin-recoverable and carry no drift.
   *
   * The classification is exposed through structured refusal details so a
   * caller can explicitly run setup and retry when eligible. Verification never
   * writes config or silently re-pins the hook.
   */
  drift?: HookCommandDrift;
  /**
   * Machine-readable refusal discriminator. Present only where `reason` alone
   * would be ambiguous to a non-human caller.
   *
   * `"node-bin-not-executable"` is the sole value today, and it marks the ONE
   * refusal whose remedy is NOT "run /kimi:setup": setup cannot repair a broken
   * Node install. Every other refusal emits an identical `{config_path}`
   * payload, so without this an agent caller cannot tell them apart and would
   * guess. See LLM-caller discipline in AGENTS.md.
   */
  refusalKind?: "node-bin-not-executable";
  /** The interpreter path that failed the probe (pairs with `refusalKind`). */
  nodeBin?: string;
  /** The configured hooks array fails validation, so kimi-code would load no hook. */
  hookSetInvalid?: true;
}

export async function verifyHookInstalled(
  env: NodeJS.ProcessEnv,
  options: {
    /** The execution plan's exact probe; omitted elsewhere, which probes when needed. */
    kimiVersion?: KimiVersionProbeOk;
  } = {},
): Promise<HookInstallStatus> {
  const configPath = resolveKimiCodeConfigPath(env);
  if (env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK === "1") {
    return { installed: true, configPath };
  }

  // Canonical expected shell command for the current env. If this
  // can't be resolved (KIMI_PLUGIN_CC_NODE_BIN not absolute,
  // install-paths module can't infer plugin root, etc.) treat the hook
  // as un-verifiable — installed=false with a structured reason. The
  // caller's stderr warning surfaces the underlying error code.
  const expected = tryBuildExpectedHookCommand(env);
  if ("error" in expected) {
    return {
      installed: false,
      reason: `unable to resolve canonical hook command for this companion: ${expected.error.message}`,
      configPath,
    };
  }

  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        installed: false,
        reason: "kimi-code config file does not exist",
        configPath,
      };
    }
    return {
      installed: false,
      reason: `failed to read kimi-code config: ${(err as Error).message}`,
      configPath,
    };
  }

  const hookSet = await validateKimiHookSetForEnvironment(raw, env, options.kimiVersion);
  if (!hookSet.valid) {
    return {
      installed: false,
      reason: hookSet.reason ?? "configured hooks failed whole-array validation",
      configPath,
      hookSetInvalid: true,
    };
  }

  const check = evaluateInstalled(raw, expected.command, {
    nodeExists: (binPath) => existsSync(binPath),
    env,
  });
  // Markers are bookkeeping, not the security boundary. At job time a
  // duplicate or orphan marker is tolerated when the real parser finds a clean,
  // unconditional PreToolUse entry with the byte-exact command (the whole hook
  // set already validated above), and the job records the setup remedy. setup
  // and setup --check use evaluateInstalled directly and keep failing.
  const warnings: string[] = [];
  if (
    !check.installed &&
    (check.state.kind === "duplicate" || check.state.kind === "orphan") &&
    countCleanEntriesInFile(raw, expected.command) >= 1 &&
    // A short-timeout copy of the command can be the one kimi-code runs.
    findShortHookTimeout(raw, expected.command) === null
  ) {
    warnings.push(
      `The managed kimi-code PreToolUse hook is installed and enforcing, but its config markers need repair: ${check.reason}`,
    );
  } else if (!check.installed) {
    return {
      installed: false,
      reason: check.reason,
      configPath,
      // Forwarded verbatim. Present only for a parseable path/binary mismatch;
      // the earlier short-circuits above (unresolvable command, unreadable
      // config, invalid hook set) return before this point and therefore never
      // carry drift — those are not re-pin-recoverable.
      ...(check.drift !== undefined ? { drift: check.drift } : {}),
    };
  }

  const artifact = await verifyManagedHookArtifact(env, expected.hookScriptPath);
  if (!artifact.ok) {
    if (artifact.kind === "sha256-mismatch") {
      return {
        installed: false,
        reason: artifact.reason,
        configPath,
        drift: {
          axis: "hook-script",
          installedCommand: expected.command,
          expectedCommand: expected.command,
          nodeInterpreterUnchanged: true,
        },
      };
    }
    return {
      installed: false,
      reason: artifact.reason,
      configPath,
    };
  }

  try {
    await access(expected.hookScriptPath, fsConstants.R_OK);
  } catch {
    return {
      installed: false,
      reason: `hook script ${expected.hookScriptPath} is missing or unreadable — run \`kimi_setup\` (action "install") or \`scripts/companion.sh setup\` to reinstall`,
      configPath,
    };
  }

  try {
    await access(expected.nodeBin, fsConstants.X_OK);
  } catch {
    return {
      installed: false,
      reason:
        `hook interpreter ${expected.nodeBin} is missing or not executable, so the PreToolUse hook ` +
        `cannot spawn (kimi-code reads a failed hook as ALLOW). Repair the Node install, or set ` +
        `KIMI_PLUGIN_CC_NODE_BIN to a valid Node >=22.5 executable and run \`kimi_setup\` (action "install").`,
      configPath,
      refusalKind: "node-bin-not-executable",
      nodeBin: expected.nodeBin,
    };
  }

  return warnings.length > 0 ? { installed: true, configPath, warnings } : { installed: true, configPath };
}

/**
 * Caller-facing repair protocol shared by every hook-refusal surface. Re-pin
 * cleanly, retry ONCE only when `retryable_after_setup` is literally true and
 * setup exits zero, and never use the skip-check environment variable as a repair.
 */
export function hookRefusalRetryProtocol(_env: NodeJS.ProcessEnv): string {
  const hereRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
  return (
    `If details shows retryable_after_setup:true (routine after a plugin update — the ` +
    `hook script or node path moved), run \`${hereRoot}/scripts/companion.sh setup\` and, only ` +
    `if it exits 0, retry the refused command once. Anything else — or a second refusal — ` +
    `surface the refusal instead of retrying.`
  );
}

/**
 * Structured details for a hook-refusal RuntimeError. `retryable_after_setup`
 * is present only for drift and is literally true only when setup can re-pin
 * every differing token: hook-script drift, or node-bin/both drift whose Node
 * tokens name the same file. A different interpreter is not automatically
 * repairable. Callers must also require a zero setup exit before one retry.
 */
export function hookRefusalDetails(status: HookInstallStatus): Record<string, unknown> {
  return {
    config_path: status.configPath,
    // Routes the caller to "tell the human to repair Node" instead of the
    // default "run /kimi:setup and retry" reflex. Never co-occurs with `drift`:
    // drift requires the equality check to FAIL, this requires it to PASS.
    ...(status.refusalKind !== undefined
      ? { refusal_kind: status.refusalKind, node_bin: status.nodeBin }
      : {}),
    ...(status.drift !== undefined
      ? {
          drift_axis: status.drift.axis,
          drift_installed_command: status.drift.installedCommand,
          drift_expected_command: status.drift.expectedCommand,
          retryable_after_setup:
            status.drift.dataOverrideFromCanonical === true
              ? false
              : status.drift.axis === "hook-script" || status.drift.nodeInterpreterUnchanged === true,
        }
      : {}),
  };
}

/** Repair sentences of the read-only (ask, review, challenge) hook refusal. */
export const READ_ONLY_HOOK_REPAIR = [
  "Run `kimi_setup` (action \"install\") or `scripts/companion.sh setup` to install or repair the canonical managed block.",
  "Set KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1 only if you intentionally accept un-enforced execution.",
];

/** Repair sentences of the write-capable (rescue, pursue) hook refusal. */
export const WRITE_HOOK_REPAIR = [
  "Repair by running `kimi_setup` (action \"install\") or `scripts/companion.sh setup`, then retry.",
  "KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1 is only for deliberate tests or diagnostics.",
];

interface HookGate {
  readonly code: string;
  readonly stage: string;
  /** Label of the once-per-process stderr warning. */
  readonly warnLabel: string;
  /** Sentences before "Hook check failed". */
  readonly intro: readonly string[];
  readonly repair: readonly string[];
}

function readOnlyGate(name: string, code: string): HookGate {
  return {
    code,
    stage: `${name}.hook-check`,
    warnLabel: name,
    intro: [`${name} refuses to run without the canonical kimi-plugin-cc PreToolUse hook.`],
    repair: READ_ONLY_HOOK_REPAIR,
  };
}

const SWARM_GATE: HookGate = {
  code: "SWARM_HOOK_NOT_INSTALLED",
  stage: "swarm.hook-check",
  warnLabel: "swarm",
  intro: [
    "swarm refuses to run without the kimi-plugin-cc PreToolUse hook.",
    "The hook enforces each worker's tool permissions, write confinement, and delegation limits.",
  ],
  repair: ["Repair by running `kimi_setup` (action \"install\") or `scripts/companion.sh setup`, then retry."],
};

/**
 * The refusal each operation's hook gate raises. The command gates and the
 * job-time check in prepareKimiExecutionPlan share it, so a definite negative
 * reads the same whichever check sees it.
 */
const HOOK_GATES: Readonly<Record<KimiOperationKind, HookGate>> = {
  ask: readOnlyGate("ask", "ASK_HOOK_NOT_INSTALLED"),
  review: readOnlyGate("review", "REVIEW_HOOK_NOT_INSTALLED"),
  challenge: readOnlyGate("challenge", "CHALLENGE_HOOK_NOT_INSTALLED"),
  rescue: {
    code: "RESCUE_HOOK_NOT_INSTALLED",
    stage: "rescue.hook-check",
    warnLabel: "rescue",
    intro: ["rescue refuses to run without the kimi-plugin-cc PreToolUse hook."],
    repair: WRITE_HOOK_REPAIR,
  },
  pursue: {
    code: "PURSUE_HOOK_NOT_INSTALLED",
    stage: "pursue.hook-check",
    warnLabel: "rescue",
    intro: ["pursue refuses to run without the kimi-plugin-cc PreToolUse hook."],
    repair: WRITE_HOOK_REPAIR,
  },
  swarm: SWARM_GATE,
  "swarm-write": SWARM_GATE,
};

/**
 * Warn once on stderr and build `operation`'s hook refusal for a status whose
 * `installed` is false.
 */
export function hookGateRefusal(
  operation: KimiOperationKind,
  status: HookInstallStatus,
  env: NodeJS.ProcessEnv,
  stderr: NodeJS.WritableStream = process.stderr,
): RuntimeError {
  const gate = HOOK_GATES[operation];
  maybeWarnHookMissing(status, gate.warnLabel, stderr);
  const repairParts =
    status.drift?.dataOverrideFromCanonical === true
      ? [
          "Unset KIMI_PLUGIN_CC_DATA in your host environment and restart the host, then retry.",
          "KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1 is only for deliberate tests or diagnostics.",
        ]
      : [...gate.repair, hookRefusalRetryProtocol(env)];
  return new RuntimeError(
    gate.code,
    [
      ...gate.intro,
      `Hook check failed: ${status.reason ?? "unknown"}.`,
      ...repairParts,
    ].join(" "),
    gate.stage,
    { details: hookRefusalDetails(status) },
  );
}

export function formatHookMissingWarning(
  status: HookInstallStatus,
  commandLabel: string,
): string {
  const fixLines =
    status.drift?.dataOverrideFromCanonical === true
      ? [
          "  Fix: unset KIMI_PLUGIN_CC_DATA in your host environment (for example in",
          "  ~/.claude/settings.json) and restart the host so it uses the shared canonical",
          "  hook.",
        ]
      : [
          "  Fix: run `kimi_setup` (action \"install\") or `scripts/companion.sh setup`",
          "  to install or repair the canonical managed block in ~/.kimi-code/config.toml.",
          "  If you use nvm, asdf, mise, or fnm, re-run setup after any Node version",
          "  switch — the verifier pins the absolute Node binary path and a switch",
          "  invalidates the previously-installed block by design. See docs/safety.md.",
        ];
  return [
    "",
    "WARNING: kimi-plugin-cc safety hook is NOT installed (or is invalid).",
    `  Command: ${commandLabel}`,
    `  Config:  ${status.configPath}`,
    `  Reason:  ${status.reason ?? "unknown"}`,
    "",
    "  Without a valid PreToolUse hook, kimi-code's `-p` mode auto-approves",
    "  every tool call — including Bash, Write, Edit — even from commands",
    "  documented as read-only.",
    "",
    "  This command will not start a Kimi model run until enforcement is",
    "  repaired.",
    "",
    ...fixLines,
    "",
    "  KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1 explicitly bypasses hook-verification",
    "  refusals and restores un-enforced `permission: auto` execution. It does",
    "  NOT bypass the experimental-v2 safety refusal. Reserve it for tests or",
    "  diagnostics where the hook risk is intentional.",
    "",
  ].join("\n");
}

/** Once-per-process latch for missing-hook warnings. */
let warnedThisProcess = false;

/**
 * Emit the warning to stderr at most once per process. Stderr is for humans;
 * stdout remains reserved for load-bearing command output.
 */
export function maybeWarnHookMissing(
  status: HookInstallStatus,
  commandLabel: string,
  stderr: NodeJS.WritableStream = process.stderr,
): void {
  if (status.installed) return;
  if (warnedThisProcess) return;
  warnedThisProcess = true;
  stderr.write(formatHookMissingWarning(status, commandLabel));
}

/** Test hook — resets the once-per-process latch. */
export function __resetHookMissingWarning(): void {
  warnedThisProcess = false;
}
