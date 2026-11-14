import { resolveKimiHome } from "../kimi-home.js";
import { probeProcessIdentity } from "../process-tree.js";
import { recordRecoveryEvent, finishRecoveryRecord, type SwarmRecoveryRecord } from "../swarm-recovery.js";
import { allocateJobId } from "../job-id.js";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { createCliCancellationHandlers } from "../cli-cancellation.js";
import { ResponseTimeoutError, runCliPromptWithBudget } from "../cli-client.js";
import {
  deactivateSwarmSession,
  preactivateSwarmSession,
  requiresSwarmPreactivation,
  type SwarmActivationOptions,
} from "../swarm-activation.js";
import {
  executionPlanFromPersisted,
  observedExecutionFields,
  persistedExecutionPlanFields,
  prepareKimiExecutionPlan,
} from "../kimi-engine.js";
import { RuntimeError } from "../errors.js";
import {
  captureWorktreePatch,
  createEphemeralWorktree,
  hasBornHead,
  isWorkingTreeDirty,
  removeWorktree,
  resolveRepoIdentity,
  type RepoIdentity,
} from "../git.js";
import { digestPrompt, markJobCancelled, markJobFailed, sweepStaleJobs } from "../jobs.js";
import { JobStore, type JobRecord } from "../job-store.js";
import { classifyManagedCommandFailure } from "../kimi-errors.js";
import { KIMI_SWARM_DEFAULT_BUDGET_MS } from "../kimi-timeouts.js";
import { writeInvocationLogHeader } from "../logging.js";
import { ensurePluginPaths, resolvePluginPaths, type PluginPaths } from "../paths.js";
import { parseSwarmArgs, type SwarmArgs } from "../parsing.js";
import { readArtifact, renderManagedJobOutput, writeArtifact } from "../render.js";
import type { CommandContext } from "../types.js";
import {
  hookRefusalDetails,
  hookRefusalRetryProtocol,
  maybeWarnHookMissing,
  verifyHookInstalled,
} from "../hooks/install.js";
import { assertCliResultSuccess, reassembleProseFromRecords, warnIfSessionIdMissing, warnHookEscapes } from "./cli-helpers.js";
import { buildKimiSessionTitle, syncKimiSessionTitle } from "../session-title.js";
import { usesBoundedSwarmPolicy } from "../swarm-policy.js";

// /kimi:swarm — parallel fan-out, read-only by default and runtime-foreground-only.
// A finite wall-clock budget bounds the whole run. --cap is a SOFT total-count
// prompt hint. Exact native-v2 2.6.2 bounds admitted waves and prevents native
// child timeouts from returning a continuing coordinator before children stop.
// Concurrency 1 uses a direct worker without native fan-out. Older versions keep
// their normal-launch setting and inherited recovery limitation. Read/write
// modes reuse review/rescue lineage, and the
// mandatory PreToolUse hook enforces read-only policy or trusted-worktree write
// confinement on the coordinator and every subagent. Write mode requires
// kimi-code 0.18.0+. Exact 2.3.2, 2.3.3, 2.4.0, 2.4.1, 2.5.0, 2.5.1, 2.5.2,
// and certified 2.5.3 activate a same-job session through a bounded loopback
// web lifecycle, then resume it through the normal print path. 2.6.2 parallel
// waves and candidate-only 2.6.0 use that lifecycle too. The per-operation certification
// table controls whether each exact version is reachable in production.

const SWARM_SUMMARY_MAX = 120;
const SWARM_AGENT_PROFILE = "<swarm>";
const SWARM_WRITE_AGENT_PROFILE = "<swarm-write>";
/**
 * Default concurrency setting when the user passes no `--max-concurrency`.
 * Exact native-v2 2.6.2 also enforces this as the admitted wave size. The plugin exports
 * KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY; older read-only swarms ignore it and
 * retain only the wall-clock hard bound. Rate-limit recovery can exceed it on
 * older reviewed sources; their setting is not an unconditional peak guarantee.
 */
export const SWARM_DEFAULT_MAX_CONCURRENCY = 4;

/**
 * Resolve the requested normal-launch concurrency: an explicit
 * `--max-concurrency` wins; otherwise use SWARM_DEFAULT_MAX_CONCURRENCY so the
 * setting is never unset. Pure + exported for unit testing (the parser leaves
 * the value undefined; swarm.ts owns the default, mirroring `budgetMs`).
 */
export function resolveSwarmMaxConcurrency(requested: number | undefined): number {
  return requested ?? SWARM_DEFAULT_MAX_CONCURRENCY;
}

/**
 * Default concurrency for WRITE mode — 1 vs read's 4. Exact native-v2 2.6.2
 * runs one direct worker; older versions serialize normal child launches but
 * retain the rate-limit recovery overrun. Disjoint-target partitioning remains
 * prompt-only when parallel workers are explicitly requested.
 * Override with an explicit `--max-concurrency N`.
 */
export const SWARM_WRITE_DEFAULT_MAX_CONCURRENCY = 1;

/** Resolve the write-mode normal-launch concurrency: explicit wins, else default 1. */
export function resolveSwarmWriteMaxConcurrency(requested: number | undefined): number {
  return requested ?? SWARM_WRITE_DEFAULT_MAX_CONCURRENCY;
}

/**
 * Build the swarm coordination prompt. States the READ-ONLY review GOAL and the
 * desired report shape, then trusts the model to fan the work out with its own
 * subagent capability — we deliberately do NOT prescribe the AgentSwarm tool call,
 * subagent_type, or prompt_template/items mechanics. Over-prescribing those made
 * the kimi-code 0.26.0 (k3) coordinator emit a non-sole-tool-call response that
 * failed to launch (0 records, hang to budget); a goal-only prompt lets it launch.
 * Read-only is NOT enforced by this prose — the PreToolUse hook (swarm label) at
 * policy index 0 denies every write/edit/shell for the coordinator AND every
 * subagent, so slimming this text does not move the safety boundary. The optional
 * `cap` is a SOFT total subagent-count hint. `waveSize` is supplied only for
 * the exact bounded policy: 1 runs directly; larger values guide the model to
 * satisfy the separately enforced admission rule. Older versions keep their
 * existing prompt and normal-launch concurrency semantics.
 */
export function buildSwarmPrompt(objective: string, cap?: number, waveSize?: number): string {
  const trimmed = objective.trim();
  if (waveSize === 1) {
    return [
      "Review the following read-only as the single worker: inspect and report; do not modify anything.",
      "",
      `Objective: ${trimmed}`,
      "",
      "Complete every target yourself, one at a time. Do not delegate: Agent and AgentSwarm are denied.",
      "Use the allowed read-only tools, primarily Read/Grep/Glob and ReadMediaFile where relevant;",
      "shell/Bash and every write/edit tool are denied.",
      "",
      "Return a single markdown report: deduplicate findings, preserve coverage across every target,",
      "and explicitly mention targets with no findings. Include a short verdict line, a brief summary,",
      "then findings as `file:line — issue — severity`. No JSON wrapper or outer code fences.",
    ].join("\n");
  }
  const capClause =
    cap !== undefined
      ? `Use at most ${cap} subagents in total across the whole run (soft cap); split or group targets to stay within it.`
      : undefined;
  return [
    "Review the following read-only: inspect and report; do not modify anything.",
    "",
    `Objective: ${trimmed}`,
    "",
    "Use the allowed read-only tools, primarily Read/Grep/Glob and ReadMediaFile where relevant;",
    "shell/Bash and every write/edit tool are denied. Launch the parallel fan-out as your FIRST action;",
    "do NOT run preliminary shell commands to size or list files first (the subagents inspect the",
    "workspace directly with the allowed read-only tools).",
    "Fan the work out across the relevant targets in parallel using your own subagent capability,",
    "as you judge best — split or group the work however fits the objective.",
    ...boundedWaveInstructions(waveSize),
    ...(capClause ? [capClause] : []),
    "",
    "Consolidate into a single markdown report: deduplicate findings, preserve coverage across",
    "every target, and explicitly mention targets with no findings rather than dropping them.",
    "Include a short verdict line, a brief summary, then findings as `file:line — issue — severity`.",
    "Return plain markdown — no JSON wrapper, no outer code fences.",
  ].join("\n");
}

/**
 * Build the WRITE-mode coordination prompt. Unlike the read-only prompt, this
 * sets subagent_type="coder" (write-capable) and instructs DISJOINT target
 * assignments with NO git and NO nested swarm. The coordinator and all
 * subagents run in an ephemeral throwaway worktree; the PreToolUse hook
 * (swarm-write label) confines writes there and the plugin captures a patch the
 * user reviews. The `cap` is the same SOFT total-count hint as read mode.
 */
export function buildSwarmWritePrompt(objective: string, cap?: number, waveSize?: number): string {
  const trimmed = objective.trim();
  if (waveSize === 1) {
    return [
      "Perform the following CODE-EDITING task as the single worker.",
      "",
      `Objective: ${trimmed}`,
      "",
      "You are running inside a throwaway git worktree dedicated to this task.",
      "Complete every target yourself, one at a time. Do not delegate: Agent and AgentSwarm are denied.",
      "Your changes will be captured as a patch for the human to review and apply.",
      "",
      "Safety rules enforced by the PreToolUse hook:",
      "- Writes are confined to this worktree; an out-of-worktree write is denied.",
      "- Git mutation is denied: do not add, commit, checkout, or change repository state.",
      "",
      "Report what changed and why, with a short verdict and a section for each target listing edited files.",
      "Do not paste full diffs; the patch is captured separately. Return plain markdown,",
      "without a JSON wrapper or outer code fences.",
    ].join("\n");
  }
  const capClause =
    cap !== undefined
      ? `Launch at most ${cap} subagents in total across the whole run (soft cap — split or group targets to stay within it).`
      : waveSize === undefined
        ? "Launch one subagent per distinct target; group related targets if there are many."
        : "Assign disjoint targets or target groups to subagents; group related targets when needed.";
  return [
    "Coordinate a parallel CODE-EDITING task using the AgentSwarm tool.",
    "",
    `Objective: ${trimmed}`,
    "",
    "You are running inside a throwaway git worktree dedicated to this task — edit freely;",
    "your changes will be captured as a patch for the human to review and apply. Use the",
    'AgentSwarm tool to fan the work out across subagents. Set subagent_type to "coder" (the',
    ...(waveSize === undefined
      ? [
          "write-capable profile). Give each subagent ONE target via prompt_template + items: a single",
          "file or module per subagent.",
        ]
      : [
          "write-capable profile). Give each subagent a DISJOINT target or target group via prompt_template + items.",
          "Each file must belong to only one subagent's assignment.",
        ]),
    ...boundedWaveInstructions(waveSize),
    capClause,
    "",
    "Safety rules enforced by the PreToolUse hook (violations are denied):",
    "- Writes are confined to this worktree; an out-of-worktree write is denied.",
    "- Do NOT run any git command that mutates state (no add/commit/checkout/etc.) — git mutation",
    "  is denied. The human owns all git operations.",
    "",
    "Coordination rules (prompt-only; the hook does NOT enforce them):",
    "- Keep every assigned target DISJOINT: no overlap between subagents (two subagents editing",
    "  the same file will corrupt the result).",
    "- Subagents must NOT call AgentSwarm (no nested fan-out). One flat generation only.",
    "- Report exactly what you changed and why.",
    "",
    "After the subagents return, consolidate into a single markdown report: a short verdict line,",
    "a summary of what changed across all targets, then one section per target listing the edited",
    "files. Do NOT paste full diffs (the patch is captured separately). Return plain markdown —",
    "no JSON wrapper, no outer code fences.",
  ].join("\n");
}

function boundedWaveInstructions(waveSize: number | undefined): string[] {
  return waveSize === undefined ? [] : [
    `Each AgentSwarm call must contain at most ${waveSize} entries in total, counting both new items and resumed agents.`,
    "A wave with no resumed agents must contain at least two new entries; a single resumed agent is allowed.",
    "For odd target counts, group multiple targets into disjoint worker entries so the final wave is not a lone fresh entry.",
    "Split larger work into sequential waves and wait for each wave to finish before starting the next.",
    "Oversized calls and forks are denied; if a call is denied, group or split its targets into smaller waves.",
  ];
}

export async function runSwarm(argv: string[], context: CommandContext): Promise<string> {
  const parsed = parseSwarmArgs(argv);
  const objective = parsed.objective?.trim();
  if (!objective) {
    throw new RuntimeError(
      "INVALID_ARGS",
      "/kimi:swarm requires an objective. Usage: /kimi:swarm [--write] [--budget 30m] [--cap N] [--max-concurrency N] [-m model] <objective>",
      "swarm.parse",
    );
  }

  return parsed.write
    ? runWriteSwarm(parsed, objective, context)
    : runReadSwarm(parsed, objective, context);
}

/** Read-only swarm (default). */
async function runReadSwarm(
  parsed: SwarmArgs,
  objective: string,
  context: CommandContext,
): Promise<string> {
  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);
  const repoIdentity = await resolveRepoIdentity(context.cwd);
  const store = new JobStore(paths);

  try {
    await sweepStaleJobs(store, paths);
    const executionPlan = await prepareKimiExecutionPlan({
      operationKind: "swarm",
      cwd: context.cwd,
      env: context.env,
    });

    const maxConcurrency = resolveSwarmMaxConcurrency(parsed.maxConcurrency);
    const prompt = buildSwarmPrompt(
      objective, parsed.cap, usesBoundedSwarmPolicy(executionPlan) ? maxConcurrency : undefined,
    );
    const jobId = allocateJobId(context);
    const logPath = path.join(paths.logsDir, `swarm-${jobId}.jsonl`);

    const job = store.createJob({
      job_id: jobId,
      repo_id: repoIdentity.repoId,
      // Reuse the read-only review lineage; the hook label below ("swarm") is
      // what actually drives the allowlist.
      command_type: "review",
      cwd: context.cwd,
      model: parsed.model ?? null,
      thinking: null,
      thinking_effort: parsed.thinkingEffort ?? null,
      background: false,
      budget_ms: parsed.budgetMs ?? KIMI_SWARM_DEFAULT_BUDGET_MS,
      budget_source: parsed.budgetMs !== undefined ? "explicit" : "default",
      pid: process.pid,
      kimi_pid: null,
      status: "running",
      kimi_session_id: null,
      ...persistedExecutionPlanFields(executionPlan),
      agent_profile: SWARM_AGENT_PROFILE,
      prompt_digest: digestPrompt(prompt),
      summary: `[swarm] ${shorten(objective, SWARM_SUMMARY_MAX)}`,
      phase: "starting",
      final_output_path: null,
      stream_log_path: logPath,
      error: null,
    });

    try {
      await writeInvocationLogHeader(logPath, {
        commandType: "swarm",
        kimiSessionId: "(pending)",
        cwd: context.cwd,
      });
    } catch (error) {
      const classified = new RuntimeError(
        "SWARM_LOG_HEADER_FAILED",
        `Failed to write swarm invocation log header: ${(error as Error).message ?? String(error)}`,
        "swarm.log-header",
        error instanceof Error ? { cause: error } : undefined,
      );
      await markJobFailed(store, paths, job, classified, "Swarm failed.", { phase: "failed" });
      throw classified;
    }

    const completed = await executeSwarmJob(
      job.job_id,
      prompt,
      objective,
      job.budget_ms!,
      maxConcurrency,
      context,
      undefined,
      await realpath(context.cwd),
    );
    if (!completed.final_output_path) {
      throw new RuntimeError("SWARM_RESULT_MISSING", "Swarm finished without a rendered result.", "swarm.result");
    }
    return readArtifact(completed.final_output_path);
  } finally {
    store.close();
  }
}

/**
 * WRITE-capable swarm (--write, v1.4). Spawns the coordinator in an ephemeral
 * throwaway worktree off HEAD; `coder` subagents edit there; writes are confined
 * by the swarm-write hook label; the result is captured as a patch the main
 * thread reviews + applies. The worktree is removed after successful patch
 * capture; capture failure retains it and reports its path for recovery.
 * Reuses the rescue (write-capable) job lineage.
 */
async function runWriteSwarm(
  parsed: SwarmArgs,
  objective: string,
  context: CommandContext,
): Promise<string> {
  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);
  const repoIdentity = await resolveRepoIdentity(context.cwd);
  const store = new JobStore(paths);

  try {
    await sweepStaleJobs(store, paths);
    // Write mode needs a real git repo and a born HEAD before any job state is
    // created. Its execution plan is certified below from the actual throwaway
    // worktree cwd, not from the user's tree.
    assertWriteSwarmPreconditions(repoIdentity);
    if (!(await hasBornHead(context.cwd))) {
      throw new RuntimeError(
        "WRITE_SWARM_NO_HEAD",
        "/kimi:swarm --write needs a git repository with at least one commit (HEAD). This repo has an unborn HEAD; make an initial commit first.",
        "swarm.precondition",
      );
    }
    // Abandoned trees are recovery evidence, never age-based garbage.
    if (await isWorkingTreeDirty(context.cwd)) {
      context.stderr.write(
        "[kimi-plugin-cc] /kimi:swarm --write bases its worktree on HEAD — your uncommitted changes are NOT visible to the swarm. Commit or stash them first if the swarm needs them.\n",
      );
    }

    const maxConcurrency = resolveSwarmWriteMaxConcurrency(parsed.maxConcurrency);
    const jobId = allocateJobId(context);
    const logPath = path.join(paths.logsDir, `swarm-write-${jobId}.jsonl`);

    // Namespace worktrees per repo so the cross-repo sweep below only ever
    // touches THIS repo's subtree (the worktreesDir is a single global dir shared
    // across every repo the user runs --write in).
    const worktreePath = path.join(paths.worktreesDir, repoIdentity.repoId, `swarm-write-${jobId}`);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    try {
      await createEphemeralWorktree(repoIdentity.repoRoot, "HEAD", worktreePath);
    } catch (error) {
      throw (
        error instanceof RuntimeError
          ? error
          : new RuntimeError("GIT_WORKTREE_ADD_FAILED", String(error), "swarm.worktree")
      );
    }

    let preserveWorktree = false;
    try {
      // Prefix args can contain relative wrapper/script paths. Probe from the
      // exact spawn cwd so the certified command tuple and its effective target
      // cannot diverge merely because --write runs in a separate worktree.
      const executionPlan = await prepareKimiExecutionPlan({
        operationKind: "swarm-write",
        cwd: worktreePath,
        env: context.env,
      });
      const prompt = buildSwarmWritePrompt(
        objective, parsed.cap, usesBoundedSwarmPolicy(executionPlan) ? maxConcurrency : undefined,
      );

      const job = store.createJob({
        job_id: jobId,
        repo_id: repoIdentity.repoId,
        // Reuse the rescue (write-capable) lineage, like pursue; the hook label
        // below ("swarm-write") drives the allowlist. cwd stays the USER's real
        // cwd for lineage — the kimi spawn cwd is the worktree (threaded via the
        // writeMode arg to executeSwarmJob).
        command_type: "rescue",
        cwd: context.cwd,
        model: parsed.model ?? null,
        thinking: null,
        thinking_effort: parsed.thinkingEffort ?? null,
        background: false,
        budget_ms: parsed.budgetMs ?? KIMI_SWARM_DEFAULT_BUDGET_MS,
        budget_source: parsed.budgetMs !== undefined ? "explicit" : "default",
        pid: process.pid,
        kimi_pid: null,
        status: "running",
        kimi_session_id: null,
        ...persistedExecutionPlanFields(executionPlan),
        agent_profile: SWARM_WRITE_AGENT_PROFILE,
        prompt_digest: digestPrompt(prompt),
        summary: `[swarm-write] ${shorten(objective, SWARM_SUMMARY_MAX)}`,
        phase: "starting",
        final_output_path: null,
        stream_log_path: logPath,
        error: null,
      });

      try {
        await writeInvocationLogHeader(logPath, {
          commandType: "swarm-write",
          kimiSessionId: "(pending)",
          cwd: context.cwd,
        });
      } catch (error) {
        const classified = new RuntimeError(
          "SWARM_LOG_HEADER_FAILED",
          `Failed to write swarm-write invocation log header: ${(error as Error).message ?? String(error)}`,
          "swarm.log-header",
          error instanceof Error ? { cause: error } : undefined,
        );
        await markJobFailed(store, paths, job, classified, "Swarm (write) failed.", {
          phase: "failed",
        });
        throw classified;
      }

      const completed = await executeSwarmJob(
        job.job_id,
        prompt,
        objective,
        job.budget_ms!,
        maxConcurrency,
        context,
        {
          spawnCwd: worktreePath,
          workspaceRoot: worktreePath,
          onPatchCaptureFailure: () => {
            preserveWorktree = true;
          },
        },
        await realpath(worktreePath),
      );
      if (preserveWorktree && completed.error) {
        throw new RuntimeError(completed.error.code, completed.error.message, completed.error.stage, {
          details: completed.error.details,
        });
      }
      if (!completed.final_output_path) {
        throw new RuntimeError(
          "SWARM_RESULT_MISSING",
          "Swarm (write) finished without a rendered result.",
          "swarm.result",
        );
      }
      return readArtifact(completed.final_output_path);
    } finally {
      if (preserveWorktree) {
        context.stderr.write(
          `[kimi-plugin-cc] swarm-write patch capture or session cleanup failed; worktree retained at ${worktreePath}.\n`,
        );
      } else {
        await removeWorktree(repoIdentity.repoRoot, worktreePath);
      }
    }
  } finally {
    store.close();
  }
}

/** Refuse --write outside a git repo (git worktree add has nothing to fork). */
function assertWriteSwarmPreconditions(repoIdentity: RepoIdentity): void {
  if (!repoIdentity.isGitRepo) {
    throw new RuntimeError(
      "WRITE_SWARM_NOT_A_REPO",
      "/kimi:swarm --write requires a git repository (it works in a throwaway worktree off HEAD). The current directory is not inside a git repo.",
      "swarm.precondition",
    );
  }
}

/**
 * Capture the worktree change set as a `.patch` artifact (write mode). Returns
 * the artifact path + size, or null on capture failure. Called on EVERY terminal
 * path so partial work survives a cancel/budget-expiry.
 */
async function capturePatchArtifact(
  paths: PluginPaths,
  jobId: string,
  worktreePath: string,
  stderr: CommandContext["stderr"],
  onFailure?: () => void,
): Promise<{ path: string; bytes: number; empty: boolean } | null> {
  try {
    const patch = await captureWorktreePatch(worktreePath);
    const patchPath = path.join(paths.artifactsDir, `swarm-write-${jobId}.patch`);
    await writeFile(patchPath, patch, "utf8");
    return { path: patchPath, bytes: Buffer.byteLength(patch, "utf8"), empty: patch.trim().length === 0 };
  } catch (error) {
    onFailure?.();
    stderr.write(
      `[kimi-plugin-cc] swarm-write patch capture failed for job ${jobId}: ${(error as Error).message ?? String(error)}\n`,
    );
    return null;
  }
}

/** Render the patch-handoff header prepended to a write-swarm report. */
function renderWriteSwarmHeader(captured: { path: string; bytes: number; empty: boolean } | null): string {
  if (captured === null) {
    return "**Patch:** capture FAILED — no patch was written; inspect the run logs.";
  }
  if (captured.empty) {
    return "**Patch:** the swarm made NO changes (empty patch).";
  }
  return [
    `**Patch written to:** \`${captured.path}\` (${captured.bytes} bytes).`,
    `Review it, then apply from the repo root with: \`git apply --3way ${captured.path}\` ` +
      "(the worktree was based on HEAD, so `--3way` reconciles against your current tree; " +
      "plain `git apply` works only if your tree hasn't moved since).",
    "The plugin did NOT apply or commit anything — you own the merge.",
  ].join("\n");
}

async function executeSwarmJob(
  jobId: string,
  prompt: string,
  objective: string,
  budgetMs: number,
  maxConcurrency: number,
  context: CommandContext,
  /**
   * Write mode (v1.4): when set, the kimi spawn cwd is the throwaway worktree
   * (`spawnCwd`), the hook label is "swarm-write", and `workspaceRoot` (the same
   * worktree) is exported as the trusted allowlist root + used to capture the
   * patch. Undefined ⇒ read-only swarm (label "swarm", spawn cwd = job.cwd).
   * Real command paths supply the canonical execution cwd for activation/resume,
   * trusted-root checks, read-mode preflight, and the print spawn. Virtual test
   * doubles may omit the canonical path and retain their original spawn spelling.
   */
  writeMode?: { spawnCwd: string; workspaceRoot: string; onPatchCaptureFailure?: () => void },
  executionCwd?: string,
): Promise<JobRecord> {
  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);
  const store = new JobStore(paths);
  const job = store.getJob(jobId);
  if (!job) {
    store.close();
    throw new RuntimeError("JOB_NOT_FOUND", `Swarm job ${jobId} was not found.`, "swarm.worker");
  }

  // Both modes require the PreToolUse hook, including a direct single worker:
  // read mode enforces read-only policy; write mode confines writes to its
  // worktree. Fail closed before spawning.
  if (context.env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK !== "1") {
    const installStatus = await verifyHookInstalled(context.env);
    if (!installStatus.installed) {
      maybeWarnHookMissing(installStatus, "swarm", context.stderr);
      const classified = new RuntimeError(
        "SWARM_HOOK_NOT_INSTALLED",
        [
          "/kimi:swarm refuses to run without the kimi-plugin-cc PreToolUse hook.",
          "The hook enforces each worker's tool permissions, write confinement, and delegation limits.",
          `Hook check failed: ${installStatus.reason ?? "unknown"}.`,
          "Repair by running Claude Code /kimi:setup or Codex $kimi-setup, then retry.",
          hookRefusalRetryProtocol(context.env),
        ].join(" "),
        "swarm.hook-check",
        { details: hookRefusalDetails(installStatus) },
      );
      try {
        return await markJobFailed(store, paths, job, classified, "Swarm failed.", { phase: "failed" });
      } finally {
        store.close();
      }
    }
  }

  const handlers = createCliCancellationHandlers();
  const budgetDeadline = Date.now() + budgetMs;
  let activationOptions: SwarmActivationOptions | undefined;
  let preactivated: Awaited<ReturnType<typeof preactivateSwarmSession>> | undefined;
  let deactivationRequired = false;
  let cleanupAttempted = false;
  let cleanupFailure: RuntimeError | undefined;
  let finalText: string | undefined;
  let recovery: SwarmRecoveryRecord | undefined;
  const commandLabel = writeMode ? "swarm-write" : "swarm";
  const recoveryCleanupTimeoutMs = 2_000;
  const cleanupSignal = (timeoutMs: number) => AbortSignal.any([
    handlers.signal,
    AbortSignal.timeout(Math.max(1, timeoutMs)),
  ]);
  const attemptDeactivation = async (
    identity: Awaited<ReturnType<typeof preactivateSwarmSession>>,
    fallbackStage: string,
    timeoutMs = Math.max(1, budgetDeadline - Date.now()),
  ): Promise<RuntimeError | undefined> => {
    cleanupAttempted = true;
    try {
      await deactivateSwarmSession({
        ...activationOptions!,
        ...identity,
        signal: cleanupSignal(timeoutMs),
      });
      deactivationRequired = false;
      return undefined;
    } catch (error) {
      return error instanceof RuntimeError
        ? error
        : new RuntimeError(
            "SWARM_SESSION_CLEANUP_FAILED",
            "Swarm session cleanup failed without a safe diagnostic payload.",
            fallbackStage,
          );
    }
  };

  try {
    const executionPlan = executionPlanFromPersisted(job);
    const boundedSwarm = usesBoundedSwarmPolicy(executionPlan);
    const singleWorker = boundedSwarm && maxConcurrency === 1;
    const needsPreactivation = !singleWorker && requiresSwarmPreactivation(executionPlan.kimiVersion);
    // A direct worker still needs durable print ownership and patch recovery.
    // Its record has no activated session and never requires web cleanup.
    if (requiresSwarmPreactivation(executionPlan.kimiVersion)) {
      const owner = await probeProcessIdentity(process.pid);
      recovery = { schema: 1, jobId: job.job_id, ownerPid: process.pid, owner: owner.identity ?? null,
        kimiHome: resolveKimiHome(context.env, writeMode?.spawnCwd ?? job.cwd),
        cwd: writeMode?.spawnCwd ?? job.cwd, workspaceRoot: writeMode?.workspaceRoot ?? null,
        launches: [], session: null, sessionDirty: false, complete: false, patchPath: null };
      store.saveSwarmRecovery(job.job_id, recovery);
    }
    activationOptions = {
      cwd: executionCwd ?? writeMode?.spawnCwd ?? job.cwd,
      env: context.env,
      command: executionPlan.command,
      prefixArgs: executionPlan.prefixArgs,
      executionPlan,
      commandLabel,
      model: job.model ?? undefined,
      thinkingEffort: job.thinking_effort ?? undefined,
      swarmMaxConcurrency: maxConcurrency,
      trustedWorkspaceRoot: executionCwd ?? writeMode?.workspaceRoot,
      expectedVersion: executionPlan.kimiVersion ?? undefined,
      onRecoveryEvent: recovery ? (event) => recordRecoveryEvent(store, recovery!, event) : undefined,
    };

    if (needsPreactivation) {
      store.updateRunningJob(job.job_id, { phase: "turn-running" });
      const activationController = new AbortController();
      const onParentAbort = () => activationController.abort();
      let activationTimedOut = false;
      handlers.signal.addEventListener("abort", onParentAbort, { once: true });
      if (handlers.signal.aborted) onParentAbort();
      const activationTimer = setTimeout(() => {
        activationTimedOut = true;
        activationController.abort();
      }, Math.max(1, budgetDeadline - Date.now()));
      activationTimer.unref();
      try {
        preactivated = await preactivateSwarmSession({
          ...activationOptions,
          signal: activationController.signal,
        });
        deactivationRequired = true;
        store.updateRunningJob(job.job_id, {
          kimi_session_id: preactivated.sessionId,
          kimi_session_id_source: "preactivated",
        });
      } catch (error) {
        const activationDidTimeOut = activationTimedOut;
        clearTimeout(activationTimer);
        handlers.signal.removeEventListener("abort", onParentAbort);
        const details = error instanceof RuntimeError ? error.details : {};
        const sessionId = typeof details.session_id === "string" ? details.session_id : undefined;
        const workspaceId = typeof details.workspace_id === "string" ? details.workspace_id : undefined;
        const hasSessionIdentity = sessionId !== undefined && workspaceId !== undefined;
        if (
          error instanceof RuntimeError &&
          error.code === "SWARM_SESSION_CLEANUP_FAILED" &&
          details.process_cleanup_unverified === true
        ) {
          cleanupFailure = error;
        }
        if (hasSessionIdentity) {
          store.updateRunningJob(job.job_id, {
            kimi_session_id: sessionId,
            kimi_session_id_source: "preactivated",
          });
        }
        if (hasSessionIdentity && !handlers.cancelling) {
          const sessionCleanupFailure = await attemptDeactivation(
            { sessionId, workspaceId },
            "swarm.activation-cleanup",
            recoveryCleanupTimeoutMs,
          );
          if (sessionCleanupFailure) cleanupFailure = sessionCleanupFailure;
        } else if (hasSessionIdentity && cleanupFailure === undefined) {
          cleanupFailure = new RuntimeError(
            "SWARM_SESSION_CLEANUP_FAILED",
            "Swarm session cleanup was not completed after activation was cancelled.",
            "swarm.activation-cleanup",
            { details: { cancelled: true, cleanup_unverified: true } },
          );
        }
        if (activationDidTimeOut && !handlers.cancelling) {
          throw new ResponseTimeoutError(budgetMs, "swarm.activation", commandLabel, undefined, error);
        }
        throw error;
      } finally {
        clearTimeout(activationTimer);
        handlers.signal.removeEventListener("abort", onParentAbort);
      }
    }

    const promptBudgetMs = budgetDeadline - Date.now();
    if (promptBudgetMs <= 0) throw new ResponseTimeoutError(budgetMs, "swarm.prompt", commandLabel);
    store.updateRunningJob(job.job_id, { phase: "turn-running" });
    if (recovery) recordRecoveryEvent(store, recovery, { kind: "print-spawn" });
    const result = await runCliPromptWithBudget(
      {
        cwd: activationOptions.cwd,
        env: context.env,
        command: executionPlan.command,
        prefixArgs: [...executionPlan.prefixArgs],
        executionPlan,
        prompt,
        commandLabel,
        swarmMaxConcurrency: maxConcurrency,
        trustedWorkspaceRoot: executionCwd ?? writeMode?.workspaceRoot,
        model: job.model ?? undefined,
        thinkingEffort: job.thinking_effort ?? undefined,
        resumeSessionId: preactivated?.sessionId,
        logPath: job.stream_log_path,
        onSpawn: async (pid) => {
          store.updateRunningJob(job.job_id, { kimi_pid: pid });
          if (recovery) {
            const probe = await probeProcessIdentity(pid);
            recordRecoveryEvent(store, recovery, { kind: "print-processes", identities: probe.identity ? [probe.identity] : [], complete: probe.complete });
          }
        },
        onProcessIdentities: recovery
          ? (identities, complete) => recordRecoveryEvent(store, recovery!, {
              kind: boundedSwarm ? "print-processes-snapshot" : "print-processes",
              identities: [...identities], complete,
            })
          : undefined,
        signal: handlers.signal,
      },
      promptBudgetMs,
      "swarm.prompt",
    );

    if (recovery) recordRecoveryEvent(store, recovery, { kind: "print-exit" });
    store.updateRunningJob(job.job_id, observedExecutionFields(result));
    finalText = reassembleProseFromRecords(result.records);
    let resultError: unknown;
    if (handlers.cancelling) {
      resultError = new RuntimeError("SWARM_CANCELLED", "Swarm cancelled by user request.", "swarm.runtime");
    } else {
      try {
        assertCliResultSuccess(result, "swarm.runtime");
        if (preactivated && result.sessionId !== preactivated.sessionId) {
          throw new RuntimeError(
            "SWARM_SESSION_MISMATCH",
            "The resumed print session differs from the preactivated swarm session.",
            "swarm.session-provenance",
            { details: { expected_session_id: preactivated.sessionId, actual_session_id: result.sessionId ?? null } },
          );
        }
      } catch (error) {
        resultError = error;
      }
    }
    warnHookEscapes(result, "swarm", context.stderr);

    if (preactivated) {
      cleanupFailure = await attemptDeactivation(preactivated, "swarm.cleanup");
    }
    if (resultError !== undefined) throw resultError;
    if (handlers.cancelling) {
      throw new RuntimeError("SWARM_CANCELLED", "Swarm cancelled by user request.", "swarm.runtime");
    }
    if (cleanupFailure) throw cleanupFailure;
    if (
      !preactivated &&
      result.sessionId !== undefined &&
      result.sessionId.length > 0 &&
      result.sessionId !== job.kimi_session_id
    ) {
      store.updateRunningJob(job.job_id, { kimi_session_id_source: "announced", kimi_session_id: result.sessionId });
    }
    await syncKimiSessionTitle({
      promptText: objective,
      env: context.env,
      cwd: job.cwd,
      sessionId: result.sessionId ?? job.kimi_session_id,
      title: buildKimiSessionTitle(writeMode ? "swarm-write" : "swarm", objective),
      stderr: context.stderr,
    });
    warnIfSessionIdMissing(result, "swarm", job.job_id, context.stderr);

    const prose = reassembleProseFromRecords(result.records);
    finalText = prose;
    if (writeMode) {
      const captured = await capturePatchArtifact(
        paths,
        job.job_id,
        writeMode.workspaceRoot,
        context.stderr,
        writeMode.onPatchCaptureFailure,
      );
      if (captured === null) {
        throw new RuntimeError(
          "SWARM_PATCH_CAPTURE_FAILED",
          `Swarm patch capture failed; worktree retained at ${writeMode.workspaceRoot}.`,
          "swarm.patch-capture",
          { details: { worktreePath: writeMode.workspaceRoot } },
        );
      }
      if (recovery) recovery.patchPath = captured.path;
      finalText = `${renderWriteSwarmHeader(captured)}\n\n---\n\n${prose}`.trimEnd();
    }
    const rendered = renderManagedJobOutput(job, finalText);

    let artifactPath: string;
    try {
      artifactPath = await writeArtifact(paths, job, rendered.rendered);
    } catch (writeError) {
      context.stderr.write(
        `[kimi-plugin-cc] swarm artifact write failed for job ${job.job_id}; raw output preserved in error details.\n`,
      );
      const classified = new RuntimeError(
        "SWARM_ARTIFACT_WRITE_FAILED",
        `Failed to write swarm artifact: ${(writeError as Error).message ?? String(writeError)}`,
        "swarm.artifact",
        {
          ...(writeError instanceof Error ? { cause: writeError } : {}),
          details: { rawOutput: finalText },
        },
      );
      return await markJobFailed(store, paths, job, classified, "Swarm failed.", { phase: "failed" });
    }

    if (handlers.cancelling) {
      throw new RuntimeError("SWARM_CANCELLED", "Swarm cancelled after artifact write.", "swarm.runtime");
    }

    if (recovery) finishRecoveryRecord(store, recovery);
    return (
      store.markCompleted(job.job_id, {
        summary: `[${writeMode ? "swarm-write" : "swarm"}] ${shorten(objective, SWARM_SUMMARY_MAX)}`,
        phase: "done",
        final_output_path: artifactPath,
        error: null,
      }) ?? job
    );
  } catch (error) {
    if (preactivated && deactivationRequired && activationOptions) {
      if (handlers.cancelling) {
        cleanupFailure = new RuntimeError(
          "SWARM_SESSION_CLEANUP_FAILED",
          "Swarm session cleanup was not completed after cancellation.",
          "swarm.cleanup",
          { details: { cancelled: true, cleanup_unverified: true } },
        );
      } else if (!cleanupAttempted) {
        cleanupFailure = await attemptDeactivation(preactivated, "swarm.cleanup", recoveryCleanupTimeoutMs);
      } else if (error instanceof RuntimeError && error.code === "SWARM_SESSION_CLEANUP_FAILED") {
        cleanupFailure ??= error;
      }
    }
    if (cleanupFailure) {
      writeMode?.onPatchCaptureFailure?.();
      context.stderr.write(
        `[kimi-plugin-cc] swarm session cleanup also failed: ${cleanupFailure.message}\n`,
      );
    }
    const processCleanupUnverified = hasUnverifiedProcessCleanup(error) || hasUnverifiedProcessCleanup(cleanupFailure);
    const patchCaptureSkipped = writeMode !== undefined && processCleanupUnverified;
    if (patchCaptureSkipped) {
      writeMode.onPatchCaptureFailure?.();
      context.stderr.write(
        `[kimi-plugin-cc] swarm-write process cleanup is unverified; no patch was captured. Worktree retained at ${writeMode.workspaceRoot}.\n`,
      );
    }
    let captureFailed = writeMode !== undefined && error instanceof RuntimeError && error.code === "SWARM_PATCH_CAPTURE_FAILED";
    if (writeMode && !patchCaptureSkipped && !(error instanceof RuntimeError && error.code === "SWARM_PATCH_CAPTURE_FAILED")) {
      const captured = await capturePatchArtifact(
        paths,
        job.job_id,
        writeMode.workspaceRoot,
        context.stderr,
        writeMode.onPatchCaptureFailure,
      );
      captureFailed = captured === null;
      if (recovery && captured) recovery.patchPath = captured.path;
      if (captured && !captured.empty) {
        context.stderr.write(
          `[kimi-plugin-cc] swarm-write run ended early; partial patch captured at ${captured.path}.\n`,
        );
      }
    }
    const recoveryDetails = {
      ...(error instanceof RuntimeError && typeof error.details.exit_code === "number"
        ? { exit_code: error.details.exit_code }
        : {}),
      ...((captureFailed || cleanupFailure || patchCaptureSkipped) && writeMode ? { worktreePath: writeMode.workspaceRoot } : {}),
      ...(processCleanupUnverified ? { process_cleanup_unverified: true } : {}),
      ...(patchCaptureSkipped ? { patch_capture_skipped: true } : {}),
      ...(cleanupFailure
        ? {
            cleanup_error: {
              code: cleanupFailure.code,
              stage: cleanupFailure.stage,
              cancelled: handlers.cancelling,
              unverified: true,
            },
            ...(finalText !== undefined ? { rawOutput: finalText } : {}),
          }
        : {}),
    };
    if (handlers.cancelling) {
      const cancellationCause = classifyManagedCommandFailure(error, writeMode ? "rescue" : "review", job.job_id, {
        preserveStage: true,
      });
      const cancelledError = new RuntimeError(
        "SWARM_CANCELLED",
        patchCaptureSkipped && writeMode
          ? `Swarm cancelled; process cleanup is unverified. No patch was captured; worktree retained at ${writeMode.workspaceRoot}.`
          : captureFailed && writeMode
            ? `Swarm cancelled; patch capture failed and worktree retained at ${writeMode.workspaceRoot}.`
            : "Swarm cancelled by user request.",
        "swarm.runtime",
        {
          ...(error instanceof Error ? { cause: error } : {}),
          details: {
            ...(cancellationCause instanceof RuntimeError ? cancellationCause.details : {}),
            ...recoveryDetails,
          },
        },
      );
      return await markJobCancelled(store, paths, job, "Swarm cancelled by user request.", cancelledError, {
        phase: "cancelled",
      });
    }
    if (error === cleanupFailure && budgetDeadline <= Date.now() && !(error instanceof ResponseTimeoutError)) {
      error = new ResponseTimeoutError(budgetMs, "swarm.cleanup", commandLabel, undefined, cleanupFailure);
    }
    const classified = classifyManagedCommandFailure(error, writeMode ? "rescue" : "review", job.job_id, {
      preserveStage: true,
    });
    const withRecovery = captureFailed || cleanupFailure || processCleanupUnverified
      ? classified instanceof RuntimeError
        ? new RuntimeError(classified.code, classified.message, classified.stage, {
            cause: classified,
            details: { ...classified.details, ...recoveryDetails },
          })
        : new RuntimeError(
            cleanupFailure?.code ?? (processCleanupUnverified ? "CLI_PROCESS_SETTLEMENT_FAILED" : "SWARM_PATCH_CAPTURE_FAILED"),
            classified.message,
            cleanupFailure?.stage ?? (processCleanupUnverified ? "cli-client.settlement" : "swarm.patch-capture"),
            { cause: classified, details: recoveryDetails },
          )
      : classified;
    return await markJobFailed(store, paths, job, withRecovery, "Swarm failed.", { phase: "failed" });
  } finally {
    handlers.dispose();
    try {
      if (recovery) finishRecoveryRecord(store, recovery);
      if (recovery && !recovery.complete) {
        writeMode?.onPatchCaptureFailure?.();
        context.stderr.write(`[kimi-plugin-cc] recovery record retained: companion.sh recover-swarm ${job.job_id} (preview).\n`);
      }
    } catch (error) {
      // A failed final journal commit cannot authorize removal of recovery evidence.
      writeMode?.onPatchCaptureFailure?.();
      throw error;
    } finally { store.close(); }
  }
}

function hasUnverifiedProcessCleanup(error: unknown): boolean {
  // Budget expiry wraps teardown failures. Preserve the unsafe-settlement
  // signal through that cause chain before considering any patch capture.
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if (error instanceof RuntimeError && (
      error.code === "CLI_PROCESS_SETTLEMENT_FAILED" || error.details.process_cleanup_unverified === true
    )) return true;
    error = error.cause;
  }
  return false;
}

function shorten(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
