import { resolveKimiHome } from "../kimi-home.js";
import { probeProcessIdentity } from "../process-tree.js";
import { recordRecoveryEvent, finishRecoveryRecord } from "../swarm-recovery.js";
import { allocateJobId } from "../job-id.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCliCancellationHandlers } from "../cli-cancellation.js";
import { ResponseTimeoutError, runCliPromptWithBudget } from "../cli-client.js";
import { deactivateSwarmSession, preactivateSwarmSession, requiresSwarmPreactivation, } from "../swarm-activation.js";
import { executionPlanFromPersisted, observedExecutionFields, persistedExecutionPlanFields, prepareKimiExecutionPlan, } from "../kimi-engine.js";
import { RuntimeError } from "../errors.js";
import { captureWorktreePatch, createEphemeralWorktree, hasBornHead, isWorkingTreeDirty, removeWorktree, resolveRepoIdentity, } from "../git.js";
import { digestPrompt, markJobCancelled, markJobFailed, sweepStaleJobs } from "../jobs.js";
import { JobStore } from "../job-store.js";
import { classifyManagedCommandFailure } from "../kimi-errors.js";
import { KIMI_SWARM_DEFAULT_BUDGET_MS } from "../kimi-timeouts.js";
import { writeInvocationLogHeader } from "../logging.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { parseSwarmArgs } from "../parsing.js";
import { readArtifact, renderManagedJobOutput, writeArtifact } from "../render.js";
import { hookRefusalDetails, hookRefusalRetryProtocol, maybeWarnHookMissing, verifyHookInstalled, } from "../hooks/install.js";
import { assertCliResultSuccess, reassembleProseFromRecords, warnIfSessionIdMissing, warnHookEscapes } from "./cli-helpers.js";
import { buildKimiSessionTitle, syncKimiSessionTitle } from "../session-title.js";
// /kimi:swarm — parallel fan-out, read-only by default and runtime-foreground-only.
// A finite wall-clock budget bounds the whole run. --cap is a SOFT total-count
// prompt hint; --max-concurrency is a HARD peak ceiling enforced on kimi-code
// 0.18.0+. The plugin always exports that setting; older read-only swarms retain
// only the wall-clock hard bound. Read/write modes reuse review/rescue lineage,
// and the mandatory PreToolUse hook enforces read-only policy or trusted-worktree
// write confinement on the coordinator and every subagent. Write mode requires
// kimi-code 0.18.0+. Exact 2.3.2, 2.3.3 and 2.4.0 additionally activate a same-job
// session through a bounded loopback web lifecycle, then resume it through the normal print path.
const SWARM_SUMMARY_MAX = 120;
const SWARM_AGENT_PROFILE = "<swarm>";
const SWARM_WRITE_AGENT_PROFILE = "<swarm-write>";
/**
 * Default concurrency setting when the user passes no `--max-concurrency`.
 * The plugin always exports KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY; kimi-code
 * 0.18.0+ enforces it as a hard peak ceiling, while older read-only swarms
 * ignore it and retain only the wall-clock hard bound. Conservative by design;
 * override with an explicit `--max-concurrency N`.
 */
export const SWARM_DEFAULT_MAX_CONCURRENCY = 4;
/**
 * Resolve the effective hard concurrency ceiling: an explicit `--max-concurrency`
 * wins; otherwise fall back to SWARM_DEFAULT_MAX_CONCURRENCY so the ceiling is
 * never unset. Pure + exported for unit testing (the parser leaves the value
 * undefined; swarm.ts owns the default, mirroring `budgetMs`).
 */
export function resolveSwarmMaxConcurrency(requested) {
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
export function resolveSwarmWriteMaxConcurrency(requested) {
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
 * `cap` is a SOFT subagent-count hint (the hook cannot enforce a count). The HARD
 * concurrency ceiling is separate: --max-concurrency →
 * KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY (see executeSwarmJob / cli-client buildKimiCliEnvironment).
 * The --budget wall-clock ceiling is the always-on hard bound on the whole run.
 */
export function buildSwarmPrompt(objective, cap) {
    const trimmed = objective.trim();
    const capClause = cap !== undefined
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
 * sets subagent_type="coder" (write-capable) and instructs DISJOINT one-target-
 * per-subagent editing with NO git and NO nested swarm. The coordinator and all
 * subagents run in an ephemeral throwaway worktree; the PreToolUse hook
 * (swarm-write label) confines writes there and the plugin captures a patch the
 * user reviews. The `cap` is the same SOFT total-count hint as read mode.
 */
export function buildSwarmWritePrompt(objective, cap) {
    const trimmed = objective.trim();
    const capClause = cap !== undefined
        ? `Launch at most ${cap} subagents in total across the whole run (soft cap — split or group targets to stay within it).`
        : "Launch one subagent per distinct target; group related targets if there are many.";
    return [
        "Coordinate a parallel CODE-EDITING task using the AgentSwarm tool.",
        "",
        `Objective: ${trimmed}`,
        "",
        "You are running inside a throwaway git worktree dedicated to this task — edit freely;",
        "your changes will be captured as a patch for the human to review and apply. Use the",
        'AgentSwarm tool to fan the work out across subagents. Set subagent_type to "coder" (the',
        "write-capable profile). Give each subagent ONE target via prompt_template + items: a single",
        "file or module per subagent.",
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
export async function runSwarm(argv, context) {
    const parsed = parseSwarmArgs(argv);
    const objective = parsed.objective?.trim();
    if (!objective) {
        throw new RuntimeError("INVALID_ARGS", "/kimi:swarm requires an objective. Usage: /kimi:swarm [--write] [--budget 30m] [--cap N] [--max-concurrency N] [-m model] <objective>", "swarm.parse");
    }
    return parsed.write
        ? runWriteSwarm(parsed, objective, context)
        : runReadSwarm(parsed, objective, context);
}
/** Read-only swarm (default). */
async function runReadSwarm(parsed, objective, context) {
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
        const prompt = buildSwarmPrompt(objective, parsed.cap);
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
        }
        catch (error) {
            const classified = new RuntimeError("SWARM_LOG_HEADER_FAILED", `Failed to write swarm invocation log header: ${error.message ?? String(error)}`, "swarm.log-header", error instanceof Error ? { cause: error } : undefined);
            await markJobFailed(store, paths, job, classified, "Swarm failed.", { phase: "failed" });
            throw classified;
        }
        const completed = await executeSwarmJob(job.job_id, prompt, objective, job.budget_ms, resolveSwarmMaxConcurrency(parsed.maxConcurrency), context);
        if (!completed.final_output_path) {
            throw new RuntimeError("SWARM_RESULT_MISSING", "Swarm finished without a rendered result.", "swarm.result");
        }
        return readArtifact(completed.final_output_path);
    }
    finally {
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
async function runWriteSwarm(parsed, objective, context) {
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
            throw new RuntimeError("WRITE_SWARM_NO_HEAD", "/kimi:swarm --write needs a git repository with at least one commit (HEAD). This repo has an unborn HEAD; make an initial commit first.", "swarm.precondition");
        }
        // Abandoned trees are recovery evidence, never age-based garbage.
        if (await isWorkingTreeDirty(context.cwd)) {
            context.stderr.write("[kimi-plugin-cc] /kimi:swarm --write bases its worktree on HEAD — your uncommitted changes are NOT visible to the swarm. Commit or stash them first if the swarm needs them.\n");
        }
        const prompt = buildSwarmWritePrompt(objective, parsed.cap);
        const jobId = allocateJobId(context);
        const logPath = path.join(paths.logsDir, `swarm-write-${jobId}.jsonl`);
        // Namespace worktrees per repo so the cross-repo sweep below only ever
        // touches THIS repo's subtree (the worktreesDir is a single global dir shared
        // across every repo the user runs --write in).
        const worktreePath = path.join(paths.worktreesDir, repoIdentity.repoId, `swarm-write-${jobId}`);
        await mkdir(path.dirname(worktreePath), { recursive: true });
        try {
            await createEphemeralWorktree(repoIdentity.repoRoot, "HEAD", worktreePath);
        }
        catch (error) {
            throw (error instanceof RuntimeError
                ? error
                : new RuntimeError("GIT_WORKTREE_ADD_FAILED", String(error), "swarm.worktree"));
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
            }
            catch (error) {
                const classified = new RuntimeError("SWARM_LOG_HEADER_FAILED", `Failed to write swarm-write invocation log header: ${error.message ?? String(error)}`, "swarm.log-header", error instanceof Error ? { cause: error } : undefined);
                await markJobFailed(store, paths, job, classified, "Swarm (write) failed.", {
                    phase: "failed",
                });
                throw classified;
            }
            const completed = await executeSwarmJob(job.job_id, prompt, objective, job.budget_ms, resolveSwarmWriteMaxConcurrency(parsed.maxConcurrency), context, {
                spawnCwd: worktreePath,
                workspaceRoot: worktreePath,
                onPatchCaptureFailure: () => {
                    preserveWorktree = true;
                },
            });
            if (preserveWorktree && completed.error) {
                throw new RuntimeError(completed.error.code, completed.error.message, completed.error.stage, {
                    details: completed.error.details,
                });
            }
            if (!completed.final_output_path) {
                throw new RuntimeError("SWARM_RESULT_MISSING", "Swarm (write) finished without a rendered result.", "swarm.result");
            }
            return readArtifact(completed.final_output_path);
        }
        finally {
            if (preserveWorktree) {
                context.stderr.write(`[kimi-plugin-cc] swarm-write patch capture or session cleanup failed; worktree retained at ${worktreePath}.\n`);
            }
            else {
                await removeWorktree(repoIdentity.repoRoot, worktreePath);
            }
        }
    }
    finally {
        store.close();
    }
}
/** Refuse --write outside a git repo (git worktree add has nothing to fork). */
function assertWriteSwarmPreconditions(repoIdentity) {
    if (!repoIdentity.isGitRepo) {
        throw new RuntimeError("WRITE_SWARM_NOT_A_REPO", "/kimi:swarm --write requires a git repository (it works in a throwaway worktree off HEAD). The current directory is not inside a git repo.", "swarm.precondition");
    }
}
/**
 * Capture the worktree change set as a `.patch` artifact (write mode). Returns
 * the artifact path + size, or null on capture failure. Called on EVERY terminal
 * path so partial work survives a cancel/budget-expiry.
 */
async function capturePatchArtifact(paths, jobId, worktreePath, stderr, onFailure) {
    try {
        const patch = await captureWorktreePatch(worktreePath);
        const patchPath = path.join(paths.artifactsDir, `swarm-write-${jobId}.patch`);
        await writeFile(patchPath, patch, "utf8");
        return { path: patchPath, bytes: Buffer.byteLength(patch, "utf8"), empty: patch.trim().length === 0 };
    }
    catch (error) {
        onFailure?.();
        stderr.write(`[kimi-plugin-cc] swarm-write patch capture failed for job ${jobId}: ${error.message ?? String(error)}\n`);
        return null;
    }
}
/** Render the patch-handoff header prepended to a write-swarm report. */
function renderWriteSwarmHeader(captured) {
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
async function executeSwarmJob(jobId, prompt, objective, budgetMs, maxConcurrency, context, 
/**
 * Write mode (v1.4): when set, the kimi spawn cwd is the throwaway worktree
 * (`spawnCwd`), the hook label is "swarm-write", and `workspaceRoot` (the same
 * worktree) is exported as the trusted allowlist root + used to capture the
 * patch. Undefined ⇒ read-only swarm (label "swarm", spawn cwd = job.cwd).
 */
writeMode) {
    const paths = resolvePluginPaths(context.env);
    await ensurePluginPaths(paths);
    const store = new JobStore(paths);
    const job = store.getJob(jobId);
    if (!job) {
        store.close();
        throw new RuntimeError("JOB_NOT_FOUND", `Swarm job ${jobId} was not found.`, "swarm.worker");
    }
    // Both modes fan out subagents and require the PreToolUse hook: read mode
    // enforces read-only policy, while write mode confines writes to the trusted
    // worktree. Fail closed before spawning.
    if (context.env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK !== "1") {
        const installStatus = await verifyHookInstalled(context.env);
        if (!installStatus.installed) {
            maybeWarnHookMissing(installStatus, "swarm", context.stderr);
            const classified = new RuntimeError("SWARM_HOOK_NOT_INSTALLED", [
                "/kimi:swarm refuses to run without the kimi-plugin-cc PreToolUse hook.",
                "Swarm fans out multiple subagents; the hook is the ONLY thing keeping every",
                "one of them read-only, so a missing hook means no enforcement across the fan-out.",
                `Hook check failed: ${installStatus.reason ?? "unknown"}.`,
                "Repair by running Claude Code /kimi:setup or Codex $kimi-setup, then retry.",
                hookRefusalRetryProtocol(context.env),
            ].join(" "), "swarm.hook-check", { details: hookRefusalDetails(installStatus) });
            try {
                return await markJobFailed(store, paths, job, classified, "Swarm failed.", { phase: "failed" });
            }
            finally {
                store.close();
            }
        }
    }
    const handlers = createCliCancellationHandlers();
    const budgetDeadline = Date.now() + budgetMs;
    let activationOptions;
    let preactivated;
    let deactivationRequired = false;
    let cleanupAttempted = false;
    let cleanupFailure;
    let finalText;
    let recovery;
    const commandLabel = writeMode ? "swarm-write" : "swarm";
    const recoveryCleanupTimeoutMs = 2_000;
    const cleanupSignal = (timeoutMs) => AbortSignal.any([
        handlers.signal,
        AbortSignal.timeout(Math.max(1, timeoutMs)),
    ]);
    const attemptDeactivation = async (identity, fallbackStage, timeoutMs = Math.max(1, budgetDeadline - Date.now())) => {
        cleanupAttempted = true;
        try {
            await deactivateSwarmSession({
                ...activationOptions,
                ...identity,
                signal: cleanupSignal(timeoutMs),
            });
            deactivationRequired = false;
            return undefined;
        }
        catch (error) {
            return error instanceof RuntimeError
                ? error
                : new RuntimeError("SWARM_SESSION_CLEANUP_FAILED", "Swarm session cleanup failed without a safe diagnostic payload.", fallbackStage);
        }
    };
    try {
        const executionPlan = executionPlanFromPersisted(job);
        if (requiresSwarmPreactivation(executionPlan.kimiVersion)) {
            const owner = await probeProcessIdentity(process.pid);
            recovery = { schema: 1, jobId: job.job_id, ownerPid: process.pid, owner: owner.identity ?? null,
                kimiHome: resolveKimiHome(context.env, writeMode?.spawnCwd ?? job.cwd),
                cwd: writeMode?.spawnCwd ?? job.cwd, workspaceRoot: writeMode?.workspaceRoot ?? null,
                launches: [], session: null, sessionDirty: false, complete: false, patchPath: null };
            store.saveSwarmRecovery(job.job_id, recovery);
        }
        activationOptions = {
            cwd: writeMode?.spawnCwd ?? job.cwd,
            env: context.env,
            command: executionPlan.command,
            prefixArgs: executionPlan.prefixArgs,
            executionPlan,
            commandLabel,
            model: job.model ?? undefined,
            thinkingEffort: job.thinking_effort ?? undefined,
            swarmMaxConcurrency: maxConcurrency,
            trustedWorkspaceRoot: writeMode?.workspaceRoot,
            expectedVersion: executionPlan.kimiVersion ?? undefined,
            onRecoveryEvent: recovery ? (event) => recordRecoveryEvent(store, recovery, event) : undefined,
        };
        if (requiresSwarmPreactivation(executionPlan.kimiVersion)) {
            store.updateRunningJob(job.job_id, { phase: "turn-running" });
            const activationController = new AbortController();
            const onParentAbort = () => activationController.abort();
            let activationTimedOut = false;
            handlers.signal.addEventListener("abort", onParentAbort, { once: true });
            if (handlers.signal.aborted)
                onParentAbort();
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
            }
            catch (error) {
                const activationDidTimeOut = activationTimedOut;
                clearTimeout(activationTimer);
                handlers.signal.removeEventListener("abort", onParentAbort);
                const details = error instanceof RuntimeError ? error.details : {};
                const sessionId = typeof details.session_id === "string" ? details.session_id : undefined;
                const workspaceId = typeof details.workspace_id === "string" ? details.workspace_id : undefined;
                const hasSessionIdentity = sessionId !== undefined && workspaceId !== undefined;
                if (error instanceof RuntimeError &&
                    error.code === "SWARM_SESSION_CLEANUP_FAILED" &&
                    details.process_cleanup_unverified === true) {
                    cleanupFailure = error;
                }
                if (hasSessionIdentity) {
                    store.updateRunningJob(job.job_id, {
                        kimi_session_id: sessionId,
                        kimi_session_id_source: "preactivated",
                    });
                }
                if (hasSessionIdentity && !handlers.cancelling) {
                    const sessionCleanupFailure = await attemptDeactivation({ sessionId, workspaceId }, "swarm.activation-cleanup", recoveryCleanupTimeoutMs);
                    if (sessionCleanupFailure)
                        cleanupFailure = sessionCleanupFailure;
                }
                else if (hasSessionIdentity && cleanupFailure === undefined) {
                    cleanupFailure = new RuntimeError("SWARM_SESSION_CLEANUP_FAILED", "Swarm session cleanup was not completed after activation was cancelled.", "swarm.activation-cleanup", { details: { cancelled: true, cleanup_unverified: true } });
                }
                if (activationDidTimeOut && !handlers.cancelling) {
                    throw new ResponseTimeoutError(budgetMs, "swarm.activation", commandLabel, undefined, error);
                }
                throw error;
            }
            finally {
                clearTimeout(activationTimer);
                handlers.signal.removeEventListener("abort", onParentAbort);
            }
        }
        const promptBudgetMs = budgetDeadline - Date.now();
        if (promptBudgetMs <= 0)
            throw new ResponseTimeoutError(budgetMs, "swarm.prompt", commandLabel);
        store.updateRunningJob(job.job_id, { phase: "turn-running" });
        if (recovery)
            recordRecoveryEvent(store, recovery, { kind: "print-spawn" });
        const result = await runCliPromptWithBudget({
            cwd: activationOptions.cwd,
            env: context.env,
            command: executionPlan.command,
            prefixArgs: [...executionPlan.prefixArgs],
            executionPlan,
            prompt,
            commandLabel,
            swarmMaxConcurrency: maxConcurrency,
            trustedWorkspaceRoot: writeMode?.workspaceRoot,
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
            signal: handlers.signal,
        }, promptBudgetMs, "swarm.prompt");
        if (recovery)
            recordRecoveryEvent(store, recovery, { kind: "print-exit" });
        store.updateRunningJob(job.job_id, observedExecutionFields(result));
        finalText = reassembleProseFromRecords(result.records);
        let resultError;
        if (handlers.cancelling) {
            resultError = new RuntimeError("SWARM_CANCELLED", "Swarm cancelled by user request.", "swarm.runtime");
        }
        else {
            try {
                assertCliResultSuccess(result, "swarm.runtime");
                if (preactivated && result.sessionId !== preactivated.sessionId) {
                    throw new RuntimeError("SWARM_SESSION_MISMATCH", "The resumed print session differs from the preactivated swarm session.", "swarm.session-provenance", { details: { expected_session_id: preactivated.sessionId, actual_session_id: result.sessionId ?? null } });
                }
            }
            catch (error) {
                resultError = error;
            }
        }
        warnHookEscapes(result, "swarm", context.stderr);
        if (preactivated) {
            cleanupFailure = await attemptDeactivation(preactivated, "swarm.cleanup");
        }
        if (resultError !== undefined)
            throw resultError;
        if (handlers.cancelling) {
            throw new RuntimeError("SWARM_CANCELLED", "Swarm cancelled by user request.", "swarm.runtime");
        }
        if (cleanupFailure)
            throw cleanupFailure;
        if (!preactivated &&
            result.sessionId !== undefined &&
            result.sessionId.length > 0 &&
            result.sessionId !== job.kimi_session_id) {
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
            const captured = await capturePatchArtifact(paths, job.job_id, writeMode.workspaceRoot, context.stderr, writeMode.onPatchCaptureFailure);
            if (captured === null) {
                throw new RuntimeError("SWARM_PATCH_CAPTURE_FAILED", `Swarm patch capture failed; worktree retained at ${writeMode.workspaceRoot}.`, "swarm.patch-capture", { details: { worktreePath: writeMode.workspaceRoot } });
            }
            if (recovery)
                recovery.patchPath = captured.path;
            finalText = `${renderWriteSwarmHeader(captured)}\n\n---\n\n${prose}`.trimEnd();
        }
        const rendered = renderManagedJobOutput(job, finalText);
        let artifactPath;
        try {
            artifactPath = await writeArtifact(paths, job, rendered.rendered);
        }
        catch (writeError) {
            context.stderr.write(`[kimi-plugin-cc] swarm artifact write failed for job ${job.job_id}; raw output preserved in error details.\n`);
            const classified = new RuntimeError("SWARM_ARTIFACT_WRITE_FAILED", `Failed to write swarm artifact: ${writeError.message ?? String(writeError)}`, "swarm.artifact", {
                ...(writeError instanceof Error ? { cause: writeError } : {}),
                details: { rawOutput: finalText },
            });
            return await markJobFailed(store, paths, job, classified, "Swarm failed.", { phase: "failed" });
        }
        if (handlers.cancelling) {
            throw new RuntimeError("SWARM_CANCELLED", "Swarm cancelled after artifact write.", "swarm.runtime");
        }
        if (recovery)
            finishRecoveryRecord(store, recovery);
        return (store.markCompleted(job.job_id, {
            summary: `[${writeMode ? "swarm-write" : "swarm"}] ${shorten(objective, SWARM_SUMMARY_MAX)}`,
            phase: "done",
            final_output_path: artifactPath,
            error: null,
        }) ?? job);
    }
    catch (error) {
        if (preactivated && deactivationRequired && activationOptions) {
            if (handlers.cancelling) {
                cleanupFailure = new RuntimeError("SWARM_SESSION_CLEANUP_FAILED", "Swarm session cleanup was not completed after cancellation.", "swarm.cleanup", { details: { cancelled: true, cleanup_unverified: true } });
            }
            else if (!cleanupAttempted) {
                cleanupFailure = await attemptDeactivation(preactivated, "swarm.cleanup", recoveryCleanupTimeoutMs);
            }
            else if (error instanceof RuntimeError && error.code === "SWARM_SESSION_CLEANUP_FAILED") {
                cleanupFailure ??= error;
            }
        }
        if (cleanupFailure) {
            writeMode?.onPatchCaptureFailure?.();
            context.stderr.write(`[kimi-plugin-cc] swarm session cleanup also failed: ${cleanupFailure.message}\n`);
        }
        let captureFailed = writeMode !== undefined && error instanceof RuntimeError && error.code === "SWARM_PATCH_CAPTURE_FAILED";
        if (writeMode && !(error instanceof RuntimeError && error.code === "SWARM_PATCH_CAPTURE_FAILED")) {
            const captured = await capturePatchArtifact(paths, job.job_id, writeMode.workspaceRoot, context.stderr, writeMode.onPatchCaptureFailure);
            captureFailed = captured === null;
            if (recovery && captured)
                recovery.patchPath = captured.path;
            if (captured && !captured.empty) {
                context.stderr.write(`[kimi-plugin-cc] swarm-write run ended early; partial patch captured at ${captured.path}.\n`);
            }
        }
        const recoveryDetails = {
            ...(error instanceof RuntimeError && typeof error.details.exit_code === "number"
                ? { exit_code: error.details.exit_code }
                : {}),
            ...((captureFailed || cleanupFailure) && writeMode ? { worktreePath: writeMode.workspaceRoot } : {}),
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
            const cancelledError = new RuntimeError("SWARM_CANCELLED", captureFailed && writeMode
                ? `Swarm cancelled; patch capture failed and worktree retained at ${writeMode.workspaceRoot}.`
                : "Swarm cancelled by user request.", "swarm.runtime", {
                ...(error instanceof Error ? { cause: error } : {}),
                details: {
                    ...(cancellationCause instanceof RuntimeError ? cancellationCause.details : {}),
                    ...recoveryDetails,
                },
            });
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
        const withRecovery = captureFailed || cleanupFailure
            ? classified instanceof RuntimeError
                ? new RuntimeError(classified.code, classified.message, classified.stage, {
                    cause: classified,
                    details: { ...classified.details, ...recoveryDetails },
                })
                : new RuntimeError(cleanupFailure?.code ?? "SWARM_PATCH_CAPTURE_FAILED", classified.message, cleanupFailure?.stage ?? "swarm.patch-capture", { cause: classified, details: recoveryDetails })
            : classified;
        return await markJobFailed(store, paths, job, withRecovery, "Swarm failed.", { phase: "failed" });
    }
    finally {
        handlers.dispose();
        try {
            if (recovery)
                finishRecoveryRecord(store, recovery);
            if (recovery && !recovery.complete) {
                writeMode?.onPatchCaptureFailure?.();
                context.stderr.write(`[kimi-plugin-cc] recovery record retained: companion.sh recover-swarm ${job.job_id} (preview).\n`);
            }
        }
        catch (error) {
            // A failed final journal commit cannot authorize removal of recovery evidence.
            writeMode?.onPatchCaptureFailure?.();
            throw error;
        }
        finally {
            store.close();
        }
    }
}
function shorten(text, max) {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= max) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
