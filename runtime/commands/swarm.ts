import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { createCliCancellationHandlers } from "../cli-cancellation.js";
import { runCliPromptWithBudget } from "../cli-client.js";
import { resolveKimiCliCommand } from "../kimi-command.js";
import { RuntimeError } from "../errors.js";
import {
  captureWorktreePatch,
  createEphemeralWorktree,
  hasBornHead,
  isWorkingTreeDirty,
  pruneWorktrees,
  removeWorktree,
  resolveRepoIdentity,
  type RepoIdentity,
} from "../git.js";
import { digestPrompt, markJobCancelled, markJobFailed, sweepStaleJobs } from "../jobs.js";
import { JobStore, type JobRecord } from "../job-store.js";
import { classifyManagedCommandFailure } from "../kimi-errors.js";
import { KIMI_SWARM_DEFAULT_BUDGET_MS } from "../kimi-timeouts.js";
import { probeKimiVersion } from "../kimi-version-probe.js";
import { writeInvocationLogHeader } from "../logging.js";
import { ensurePluginPaths, resolvePluginPaths, type PluginPaths } from "../paths.js";
import { parseSwarmArgs, type SwarmArgs } from "../parsing.js";
import { readArtifact, renderManagedJobOutput, writeArtifact } from "../render.js";
import type { CommandContext } from "../types.js";
import { maybeWarnHookMissing, verifyHookInstalled } from "../hooks/install.js";
import { assertCliResultSuccess, reassembleProseFromRecords, warnIfSessionIdMissing } from "./cli-helpers.js";

// /kimi:swarm — READ-ONLY parallel fan-out (kimi-code 0.12.0 AgentSwarm tool).
//
// PROTOTYPE SCOPE (v1.2). The lowest-risk swarm shape: parallel review/analysis
// over N targets, with NO write surface. Deliberately narrow:
//   - FOREGROUND ONLY. No --background/--detach. A hard wall-clock budget
//     (--budget) bounds the whole run. Two distinct subagent bounds: --cap is a
//     SOFT total-count hint injected into the prompt, and --max-concurrency is a
//     HARD ceiling on how many subagents run AT ONCE via
//     KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY on kimi-code 0.18.0+ (PR #888; older
//     binaries ignore the unknown env var).
//   - READ-ONLY. The PreToolUse hook runs under the "swarm" label, which
//     allowlists the read-only tool set PLUS the AgentSwarm tool. Every
//     subagent inherits that label and fires the SAME hook at policy index 0
//     (kimi-code createPermissionDecisionPolicies puts the hook at index 0 for
//     ALL agents — verified against 0.12.0), so a subagent's Write/Edit/Bash is
//     denied exactly like a single-turn review's.
//   - Reuses the REVIEW job lineage (command_type "review") so /kimi:status /
//     /kimi:result / /kimi:cancel work unchanged. The hook label ("swarm") is
//     independent of the job lineage — mirrors how /kimi:pursue reuses the
//     rescue lineage with its own label. Promoting swarm to a first-class
//     command_type is a follow-up.
//
// SAFETY — why swarm REFUSES without the hook (unlike single-turn review):
//   review/challenge/ask only WARN if the hook is missing (degraded enforcement
//   on ONE agent). A swarm fans out up to `cap` subagents, each capable of
//   attempting writes; without the index-0 hook there is ZERO enforcement on
//   ALL of them — an N-fold blast radius. So swarm fail-CLOSES (refuses) like
//   rescue/pursue. The KIMI_PLUGIN_CC_SKIP_HOOK_CHECK escape hatch remains.

/** kimi-code minor that introduced the AgentSwarm tool (#424, 0.12.0). */
const SWARM_MIN_MINOR = 12;
/**
 * kimi-code minor required for WRITE mode (--write). 0.18.0 is the first version
 * that honors KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY (PR #888); below it a write
 * fan-out has NO hard peak-parallelism bound (the batch ramps to 5 immediately),
 * which is unacceptable for concurrent writers into one shared worktree. So write
 * mode refuses on < 0.18 even though the AgentSwarm tool itself exists from 0.12.
 */
const WRITE_SWARM_MIN_MINOR = 18;
const SWARM_SUMMARY_MAX = 120;
const SWARM_AGENT_PROFILE = "<swarm>";
const SWARM_WRITE_AGENT_PROFILE = "<swarm-write>";
/**
 * Orphaned write-swarm worktrees older than this are reaped by the startup sweep.
 * Every normal run removes its own worktree in a finally; an orphan only survives
 * a hard kill (SIGKILL of the plugin process). Generous vs the default 30m budget
 * so the sweep never races a live concurrent run.
 */
const WORKTREE_ORPHAN_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Default HARD concurrency ceiling applied when the user passes no
 * `--max-concurrency`. Since v1.3 `/kimi:swarm` is ALSO reachable via the
 * model-invocable `kimi-swarm` agent (Claude can auto-dispatch a fan-out), so an
 * unbounded peak-parallelism default is no longer acceptable: we always export
 * `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` (effective on kimi-code 0.18.0+; older
 * binaries ignore it) so simultaneous model spend is capped BY CONSTRUCTION for
 * every swarm run — agent-dispatched or human-typed. Conservative by design;
 * override with an explicit `--max-concurrency N`. The `--budget` wall-clock
 * ceiling remains the always-on hard bound on TOTAL cost; this bounds the peak.
 */
export const SWARM_DEFAULT_MAX_CONCURRENCY = 4;

/**
 * Resolve the effective hard concurrency ceiling: an explicit `--max-concurrency`
 * wins; otherwise fall back to SWARM_DEFAULT_MAX_CONCURRENCY so the ceiling is
 * never unset. Pure + exported for unit testing (the parser leaves the value
 * undefined; swarm.ts owns the default, mirroring `budgetMs`).
 */
export function resolveSwarmMaxConcurrency(requested: number | undefined): number {
  return requested ?? SWARM_DEFAULT_MAX_CONCURRENCY;
}

/**
 * Default HARD concurrency ceiling for WRITE mode — 1 (serialized) vs read's 4.
 * Writes are riskier than reads: disjoint-target partitioning is prompt-only and
 * unenforceable (the hook is stateless), so two concurrent `coder` subagents
 * racing the same file in the shared worktree would corrupt the patch. Serialize
 * by default until a real-binary smoke proves clean concurrent disjoint writes;
 * override with an explicit `--max-concurrency N`. Effective only on kimi-code
 * 0.18.0+ (the write-mode version gate), so the ceiling is always enforced.
 */
export const SWARM_WRITE_DEFAULT_MAX_CONCURRENCY = 1;

/** Resolve the write-mode concurrency ceiling: explicit wins, else default 1. */
export function resolveSwarmWriteMaxConcurrency(requested: number | undefined): number {
  return requested ?? SWARM_WRITE_DEFAULT_MAX_CONCURRENCY;
}

/**
 * Build the swarm coordination prompt. Instructs Kimi to use the AgentSwarm
 * tool to fan READ-ONLY review work over the targets implied by the objective,
 * then consolidate. The optional `cap` is a SOFT subagent-count hint (the hook
 * cannot enforce a count, so the model may exceed it). The HARD concurrency
 * ceiling is separate: --max-concurrency → KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY
 * (see executeSwarmJob / cli-client buildEnv). The --budget wall-clock ceiling
 * is the always-on hard bound on the whole run regardless of kimi-code version.
 */
export function buildSwarmPrompt(objective: string, cap?: number): string {
  const trimmed = objective.trim();
  const capClause =
    cap !== undefined
      ? `Launch at most ${cap} subagents (soft cap — split or group targets to stay within it).`
      : "Launch one subagent per distinct target; group related targets if there are many.";
  return [
    "Coordinate a READ-ONLY parallel review using the AgentSwarm tool.",
    "",
    `Objective: ${trimmed}`,
    "",
    "Use the AgentSwarm tool to fan the work out across subagents (it requires at least 2",
    'items). Set subagent_type to "explore" — a read-only exploration profile that has no',
    "file-editing tools at all (defense-in-depth on top of the safety hook). Give each subagent",
    "a distinct target (a file, module, directory, or question) via the prompt_template + items.",
    capClause,
    "Each subagent must inspect the workspace using read tools only (Read, Grep, Glob) and",
    "must NOT write, edit, run shell commands, or mutate anything. This is a read-only command,",
    "so the safety hook denies any write/edit/shell/web tool call — instruct subagents to report",
    "findings rather than attempt fixes, and to rely on Read/Grep/Glob.",
    "",
    "After the subagents return, consolidate their findings into a single markdown report:",
    "a short verdict line, a brief summary, then one section per target with file:line references.",
    "Return plain markdown — no JSON wrapper, no outer code fences.",
  ].join("\n");
}

/**
 * Build the WRITE-mode coordination prompt. Unlike the read-only prompt, this
 * sets subagent_type="coder" (write-capable) and instructs DISJOINT one-target-
 * per-subagent editing with NO git and NO nested swarm. The coordinator and all
 * subagents run in an ephemeral throwaway worktree; the PreToolUse hook
 * (swarm-write label) confines writes there and the plugin captures a patch the
 * user reviews. The `cap` is the same SOFT total-count hint as read mode.
 */
export function buildSwarmWritePrompt(objective: string, cap?: number): string {
  const trimmed = objective.trim();
  const capClause =
    cap !== undefined
      ? `Launch at most ${cap} subagents (soft cap — split or group targets to stay within it).`
      : "Launch one subagent per distinct target; group related targets if there are many.";
  return [
    "Coordinate a parallel CODE-EDITING task using the AgentSwarm tool.",
    "",
    `Objective: ${trimmed}`,
    "",
    "You are running inside a throwaway git worktree dedicated to this task — edit freely;",
    "your changes will be captured as a patch for the human to review and apply. Use the",
    'AgentSwarm tool to fan the work out across subagents. Set subagent_type to "coder" (the',
    "write-capable profile). Give each subagent ONE distinct, DISJOINT target via prompt_template",
    "+ items: a single file or module per subagent, with NO overlap between subagents (two",
    "subagents editing the same file will corrupt the result).",
    capClause,
    "",
    "Hard rules for every subagent (the safety hook enforces these — violations are denied):",
    "- Edit ONLY your assigned target. Writes are confined to this worktree; an out-of-worktree",
    "  write is denied.",
    "- Do NOT run any git command that mutates state (no add/commit/checkout/etc.) — git mutation",
    "  is denied. The human owns all git operations.",
    "- Do NOT call AgentSwarm yourself (no nested fan-out). One flat generation only.",
    "- Report exactly what you changed and why.",
    "",
    "After the subagents return, consolidate into a single markdown report: a short verdict line,",
    "a summary of what changed across all targets, then one section per target listing the edited",
    "files. Do NOT paste full diffs (the patch is captured separately). Return plain markdown —",
    "no JSON wrapper, no outer code fences.",
  ].join("\n");
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

/** READ-ONLY swarm (default). Unchanged from v1.2/v1.3. */
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
    await assertSwarmSupported(context, SWARM_MIN_MINOR);

    const prompt = buildSwarmPrompt(objective, parsed.cap);
    const jobId = randomUUID();
    const logPath = path.join(paths.logsDir, `swarm-${jobId}.jsonl`);

    const job = store.createJob({
      job_id: jobId,
      repo_id: repoIdentity.repoId,
      // Reuse the read-only review lineage; the hook label below ("swarm") is
      // what actually drives the allowlist.
      command_type: "review",
      cwd: context.cwd,
      model: parsed.model ?? null,
      thinking: parsed.thinking ?? null,
      background: false,
      pid: process.pid,
      kimi_pid: null,
      status: "running",
      kimi_session_id: null,
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
      parsed.budgetMs ?? KIMI_SWARM_DEFAULT_BUDGET_MS,
      resolveSwarmMaxConcurrency(parsed.maxConcurrency),
      context,
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
 * thread reviews + applies. The worktree is created here and removed on EVERY
 * terminal path (the patch is captured inside executeSwarmJob, before this
 * finally removes the tree). Reuses the rescue (write-capable) job lineage.
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
    // Write mode needs the hard concurrency env (kimi-code 0.18.0+), a real git
    // repo, and a born HEAD before any job state is created.
    await assertSwarmSupported(context, WRITE_SWARM_MIN_MINOR);
    assertWriteSwarmPreconditions(repoIdentity);
    if (!(await hasBornHead(context.cwd))) {
      throw new RuntimeError(
        "WRITE_SWARM_NO_HEAD",
        "/kimi:swarm --write needs a git repository with at least one commit (HEAD). This repo has an unborn HEAD; make an initial commit first.",
        "swarm.precondition",
      );
    }
    await sweepStaleWorktrees(paths, repoIdentity);
    if (await isWorkingTreeDirty(context.cwd)) {
      context.stderr.write(
        "[kimi-plugin-cc] /kimi:swarm --write bases its worktree on HEAD — your uncommitted changes are NOT visible to the swarm. Commit or stash them first if the swarm needs them.\n",
      );
    }

    const prompt = buildSwarmWritePrompt(objective, parsed.cap);
    const jobId = randomUUID();
    const logPath = path.join(paths.logsDir, `swarm-write-${jobId}.jsonl`);

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
      thinking: parsed.thinking ?? null,
      background: false,
      pid: process.pid,
      kimi_pid: null,
      status: "running",
      kimi_session_id: null,
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
      await markJobFailed(store, paths, job, classified, "Swarm (write) failed.", { phase: "failed" });
      throw classified;
    }

    // Namespace worktrees per repo so the cross-repo sweep below only ever
    // touches THIS repo's subtree (the worktreesDir is a single global dir shared
    // across every repo the user runs --write in).
    const worktreePath = path.join(paths.worktreesDir, repoIdentity.repoId, `swarm-write-${jobId}`);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    try {
      await createEphemeralWorktree(repoIdentity.repoRoot, "HEAD", worktreePath);
    } catch (error) {
      const classified =
        error instanceof RuntimeError
          ? error
          : new RuntimeError("GIT_WORKTREE_ADD_FAILED", String(error), "swarm.worktree");
      await markJobFailed(store, paths, job, classified, "Swarm (write) failed.", { phase: "failed" });
      throw classified;
    }

    try {
      const completed = await executeSwarmJob(
        job.job_id,
        prompt,
        objective,
        parsed.budgetMs ?? KIMI_SWARM_DEFAULT_BUDGET_MS,
        resolveSwarmWriteMaxConcurrency(parsed.maxConcurrency),
        context,
        { spawnCwd: worktreePath, workspaceRoot: worktreePath },
      );
      if (!completed.final_output_path) {
        throw new RuntimeError(
          "SWARM_RESULT_MISSING",
          "Swarm (write) finished without a rendered result.",
          "swarm.result",
        );
      }
      return readArtifact(completed.final_output_path);
    } finally {
      // Patch was captured inside executeSwarmJob (before this runs) on every
      // terminal path; --force discards the now-disposable worktree.
      await removeWorktree(repoIdentity.repoRoot, worktreePath);
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
 * Reap orphaned write-swarm worktrees from prior crashed runs. Normal runs remove
 * their own worktree in a finally; an orphan only survives a hard kill. Prunes
 * stale admin entries (current repo) then force-removes on-disk worktree dirs
 * older than the TTL. Best-effort — never blocks the run.
 */
async function sweepStaleWorktrees(paths: PluginPaths, repoIdentity: RepoIdentity): Promise<void> {
  await pruneWorktrees(repoIdentity.repoRoot);
  // Only sweep THIS repo's namespaced subdir, so we never `rm` a worktree that a
  // different repo still considers live (and never leave that repo a dangling
  // admin entry). repoId is the realpath-stable hash from resolveRepoIdentity.
  const repoWorktreesDir = path.join(paths.worktreesDir, repoIdentity.repoId);
  const entries = await readdir(repoWorktreesDir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return; // not created yet — nothing to sweep.
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("swarm-write-")) continue;
    const full = path.join(repoWorktreesDir, entry.name);
    try {
      const st = await stat(full);
      if (now - st.mtimeMs > WORKTREE_ORPHAN_TTL_MS) {
        await removeWorktree(repoIdentity.repoRoot, full);
      }
    } catch {
      // best-effort per entry
    }
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
): Promise<{ path: string; bytes: number; empty: boolean } | null> {
  try {
    const patch = await captureWorktreePatch(worktreePath);
    const patchPath = path.join(paths.artifactsDir, `swarm-write-${jobId}.patch`);
    await writeFile(patchPath, patch, "utf8");
    return { path: patchPath, bytes: Buffer.byteLength(patch, "utf8"), empty: patch.trim().length === 0 };
  } catch (error) {
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
   */
  writeMode?: { spawnCwd: string; workspaceRoot: string },
): Promise<JobRecord> {
  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);
  const store = new JobStore(paths);
  const job = store.getJob(jobId);
  if (!job) {
    store.close();
    throw new RuntimeError("JOB_NOT_FOUND", `Swarm job ${jobId} was not found.`, "swarm.worker");
  }

  // Swarm is read-only BY POLICY, but it fans out N subagents — without the
  // PreToolUse hook there is no enforcement on ANY of them. Unlike single-turn
  // review (which only warns), swarm fail-CLOSES: refuse without the hook.
  if (context.env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK !== "1") {
    const installStatus = await verifyHookInstalled(context.env);
    if (!installStatus.installed) {
      maybeWarnHookMissing(installStatus, "swarm", context.stderr);
      const classified = new RuntimeError(
        "SWARM_HOOK_NOT_INSTALLED",
        [
          "/kimi:swarm refuses to run without the kimi-plugin-cc PreToolUse hook.",
          "Swarm fans out multiple subagents; the hook is the ONLY thing keeping every",
          "one of them read-only, so a missing hook means no enforcement across the fan-out.",
          `Hook check failed: ${installStatus.reason ?? "unknown"}.`,
          "Run /kimi:setup, or set KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1 if you've intentionally",
          "configured an alternative safety mechanism.",
        ].join(" "),
        "swarm.hook-check",
        { details: { config_path: installStatus.configPath } },
      );
      try {
        return await markJobFailed(store, paths, job, classified, "Swarm failed.", { phase: "failed" });
      } finally {
        store.close();
      }
    }
  }

  const handlers = createCliCancellationHandlers();
  const kimi = resolveKimiCliCommand(context.env);

  try {
    store.updateRunningJob(job.job_id, { phase: "turn-running" });

    const result = await runCliPromptWithBudget(
      {
        // Read mode spawns in the user's cwd; WRITE mode spawns in the throwaway
        // worktree so coder subagents edit there (job.cwd stays the user's real
        // cwd for lineage). This is the load-bearing isolation seam.
        cwd: writeMode?.spawnCwd ?? job.cwd,
        env: context.env,
        command: kimi.command,
        prefixArgs: kimi.prefixArgs,
        prompt,
        // "swarm" → read-only-plus-AgentSwarm allowlist; "swarm-write" → the same
        // PLUS rescue-grade write confinement to the trusted worktree root. The
        // label drives the hook for the coordinator AND every spawned subagent.
        commandLabel: writeMode ? "swarm-write" : "swarm",
        // The HARD concurrency ceiling on kimi-code 0.18.0+ (exported as
        // KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY; ignored by older binaries).
        // ALWAYS set: defaults to SWARM_DEFAULT_MAX_CONCURRENCY (read) /
        // SWARM_WRITE_DEFAULT_MAX_CONCURRENCY (write) when the user passes no
        // --max-concurrency, so a fan-out is never unbounded. Distinct from --cap
        // (the soft total-count prompt hint).
        swarmMaxConcurrency: maxConcurrency,
        // Trusted allowlist root for the swarm-write hook (forge-proof; ignored
        // by other labels). Only set in write mode.
        swarmWriteWorkspaceRoot: writeMode?.workspaceRoot,
        model: job.model ?? undefined,
        logPath: job.stream_log_path,
        signal: handlers.signal,
      },
      budgetMs,
      "swarm.prompt",
    );

    if (handlers.cancelling) {
      throw new RuntimeError("SWARM_CANCELLED", "Swarm cancelled by user request.", "swarm.runtime");
    }

    assertCliResultSuccess(result, "swarm.runtime");

    if (
      result.sessionId !== undefined &&
      result.sessionId.length > 0 &&
      result.sessionId !== job.kimi_session_id
    ) {
      store.updateRunningJob(job.job_id, { kimi_session_id: result.sessionId });
    }
    warnIfSessionIdMissing(result, "swarm", job.job_id, context.stderr);

    const prose = reassembleProseFromRecords(result.records);
    // WRITE mode: capture the worktree change set as a .patch artifact (before
    // runWriteSwarm's finally removes the worktree) and prepend the patch-handoff
    // header so the consolidated report tells the main thread where the patch is.
    const finalText = writeMode
      ? `${renderWriteSwarmHeader(
          await capturePatchArtifact(paths, job.job_id, writeMode.workspaceRoot, context.stderr),
        )}\n\n---\n\n${prose}`.trimEnd()
      : prose;
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

    return (
      store.markCompleted(job.job_id, {
        summary: `[swarm] ${shorten(objective, SWARM_SUMMARY_MAX)}`,
        phase: "done",
        final_output_path: artifactPath,
        error: null,
      }) ?? job
    );
  } catch (error) {
    // WRITE mode: best-effort capture of any PARTIAL work before we mark the job
    // and before runWriteSwarm's finally removes the worktree, so a cancel /
    // budget-expiry doesn't silently discard edits the subagents already made.
    if (writeMode) {
      const captured = await capturePatchArtifact(
        paths,
        job.job_id,
        writeMode.workspaceRoot,
        context.stderr,
      );
      if (captured && !captured.empty) {
        context.stderr.write(
          `[kimi-plugin-cc] swarm-write run ended early; partial patch captured at ${captured.path}.\n`,
        );
      }
    }
    if (handlers.cancelling) {
      const cancelledError = new RuntimeError(
        "SWARM_CANCELLED",
        "Swarm cancelled by user request.",
        "swarm.runtime",
        error instanceof Error ? { cause: error } : undefined,
      );
      return await markJobCancelled(store, paths, job, "Swarm cancelled by user request.", cancelledError, {
        phase: "cancelled",
      });
    }
    const classified = classifyManagedCommandFailure(error, writeMode ? "rescue" : "review", job.job_id, {
      preserveStage: true,
    });
    return await markJobFailed(store, paths, job, classified, "Swarm failed.", { phase: "failed" });
  } finally {
    handlers.dispose();
    store.close();
  }
}

/**
 * Soft version gate. The AgentSwarm tool shipped in kimi-code 0.12.0; on an
 * older binary the tool does not exist and the coordinator's AgentSwarm call
 * fails inside kimi (degraded, not dangerous — the read-only hook still holds).
 * Refuse on a confirmed-too-old version; a failed probe (flaky spawn) does not
 * block. Honors KIMI_PLUGIN_CC_SKIP_VERSION_PROBE=1 (the smoke harness sets it).
 */
async function assertSwarmSupported(context: CommandContext, minMinor: number): Promise<void> {
  if (context.env.KIMI_PLUGIN_CC_SKIP_VERSION_PROBE === "1") return;
  const kimi = resolveKimiCliCommand(context.env);
  const probe = await probeKimiVersion({ kimiBin: kimi.command, env: context.env });
  if (probe.kind !== "ok") return;
  const supported = probe.major > 0 || (probe.major === 0 && probe.minor >= minMinor);
  if (!supported) {
    const reason =
      minMinor >= WRITE_SWARM_MIN_MINOR
        ? `/kimi:swarm --write needs kimi-code >= 0.${WRITE_SWARM_MIN_MINOR}.0 (the hard AgentSwarm concurrency cap, required for safe concurrent writes)`
        : `/kimi:swarm needs kimi-code >= 0.${SWARM_MIN_MINOR}.0 (the AgentSwarm tool)`;
    throw new RuntimeError(
      "SWARM_UNSUPPORTED",
      `${reason}; detected ${probe.version}. Upgrade kimi-code and retry.`,
      "swarm.version-gate",
    );
  }
}

function shorten(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
