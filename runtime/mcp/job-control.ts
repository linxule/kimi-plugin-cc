import { runCancel } from "../commands/cancel.js";
import { runModelInventory } from "../commands/models.js";
import { runRecoverSwarm } from "../commands/recover-swarm.js";
import { runRepairSessions } from "../commands/repair-sessions.js";
import { replayJob } from "../commands/replay.js";
import { renderSetupResult, runSetup } from "../commands/setup.js";
import { formatError, RuntimeError } from "../errors.js";
import {
  isCwdWithinWorkspace,
  markJobFailed,
  STALE_SWEEP_GRACE_MS,
  sweepStaleJobs,
} from "../jobs.js";
import {
  JobStore,
  parseHookEscapes,
  parseJobWarnings,
  renderBudgetSource,
  type JobRecord,
  type McpTaskRecord,
} from "../job-store.js";
import { resolveKimiHome } from "../kimi-home.js";
import { ensurePluginPaths, resolvePluginPaths, type PluginPaths } from "../paths.js";
import {
  readProcessIdentity,
  revalidateProcessIdentities,
  revalidateProcessIdentity,
  type ProcessIdentity,
} from "../process-tree.js";
import { readArtifact, renderTerminalJobArtifact } from "../render.js";
import { sleep } from "../util.js";
import {
  assertMcpJobBinding,
  jobCompanionIdentity,
  jobKimiIdentity,
  mcpCompanionIdentity,
  mcpKimiIdentity,
} from "./binding.js";
import {
  readJobControlArguments,
  readSetupArguments,
  type McpJobControlArgs,
} from "./operations.js";
import { textResult, type McpToolResult } from "./tool-result.js";
import { resolveMcpWorkspace, type McpWorkspace } from "./workspace.js";

export interface McpJobSnapshot {
  task: McpTaskRecord | null;
  job: JobRecord | null;
  workspace: McpWorkspace;
}

export interface McpTaskView {
  taskId: string;
  status: "working" | "completed" | "cancelled" | "failed";
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: null;
  pollIntervalMs: number;
  result?: McpToolResult;
  error?: { code: number; message: string; data?: Record<string, unknown> };
}

const DEFAULT_WAIT_MS = 30_000;
const DEFAULT_SYNC_WAIT_TIMEOUT_MS = 50_000;

function pinnedKimiHomeEnv(env: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv {
  return {
    ...env,
    KIMI_CODE_HOME: resolveKimiHome(env, cwd),
  };
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function handleMcpJobTool(
  env: NodeJS.ProcessEnv,
  input: unknown,
  signal?: AbortSignal,
): Promise<McpToolResult> {
  const args = readJobControlArguments(input);
  switch (args.action) {
    case "list":
      return await listMcpJobs(env, args);
    case "status":
      return await getMcpJobStatus(env, input);
    case "result":
      return await getMcpJobResult(env, input);
    case "wait":
      return await awaitMcpJob(env, {
        jobId: args.jobId,
        workspace: args.workspace,
        waitTimeoutMs: args.waitMs ?? DEFAULT_WAIT_MS,
        signal,
      });
    case "cancel":
      return await cancelMcpJob(env, input);
    case "replay":
      return await replayMcpJob(env, args);
    case "recover_swarm":
      return await recoverMcpSwarm(env, args);
  }
}

export async function handleMcpSetupTool(env: NodeJS.ProcessEnv, input: unknown): Promise<McpToolResult> {
  const args = readSetupArguments(input);
  const paths = resolvePluginPaths(env);
  await ensurePluginPaths(paths);
  const workspace = args.workspace !== undefined || env.KIMI_PLUGIN_CC_MCP_WORKSPACE !== undefined
    ? await resolveMcpWorkspace(env, args.workspace)
    : undefined;
  const resolvedCwd = workspace?.cwd ?? env.KIMI_PLUGIN_CC_WORKSPACE_CWD ?? process.cwd();
  const context = {
    cwd: resolvedCwd,
    env: pinnedKimiHomeEnv(env, resolvedCwd),
    stdout: process.stdout,
    stderr: process.stderr,
  };

  switch (args.action) {
    case "models": {
      const jsonText = await runModelInventory(["--json"], context);
      return textResult(jsonText, JSON.parse(jsonText) as Record<string, unknown>, false);
    }
    case "repair_sessions": {
      const repairArgs: string[] = [];
      if (args.apply) repairArgs.push("--apply");
      if (args.all) repairArgs.push("--all");
      const output = await runRepairSessions(repairArgs, context);
      return textResult(output, JSON.parse(output) as Record<string, unknown>, false);
    }
    case "check":
    case "install":
    case "install_kimi": {
      const setupArgs =
        args.action === "check"
          ? ["--check"]
          : args.action === "install_kimi"
            ? ["--install-kimi", "--json"]
            : [];
      const result = await runSetup(setupArgs, context);
      const rendered = renderSetupResult(result);
      const structured: Record<string, unknown> = result.kimiInstall
        ? { ...result.kimiInstall }
        : {
            action: result.action,
            summary: result.summary,
            config_path: result.configPath,
            hook_script_path: result.hookScriptPath,
            block_written: result.blockWritten,
            block_removed: result.blockRemoved,
            probe: result.probe,
            ...(result.probeError ? { probe_error: result.probeError } : {}),
            warnings: result.warnings,
            next_step: result.nextStep,
          };
      return textResult(
        rendered.endsWith("\n") ? rendered : `${rendered}\n`,
        structured,
        result.probe === "failed",
      );
    }
  }
}

export async function awaitMcpJob(
  env: NodeJS.ProcessEnv,
  options: { jobId?: string; workspace?: string; waitTimeoutMs?: number; signal?: AbortSignal },
): Promise<McpToolResult> {
  const timeoutMs = options.waitTimeoutMs ?? DEFAULT_SYNC_WAIT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let delayMs = 50;
  let pinnedJobId = options.jobId;
  let lastMetadata: Record<string, unknown> | undefined;

  for (;;) {
    if (options.signal?.aborted) {
      const payload = {
        ...(lastMetadata ?? { ...(pinnedJobId ? { job_id: pinnedJobId } : {}), status: "running" }),
        wait_aborted: true,
      };
      return textResult(`${JSON.stringify(payload, null, 2)}\n`, payload, false);
    }

    const { task, job, workspace } = await loadJobSnapshot(env, {
      action: "wait",
      jobId: pinnedJobId,
      workspace: options.workspace,
    });
    const resolvedId = task?.task_id ?? job?.job_id;
    if (pinnedJobId === undefined && resolvedId !== undefined) {
      pinnedJobId = resolvedId;
    }
    lastMetadata = jobMetadata(task, job, workspace.cwd);

    if (!job) {
      if (task?.launch_error) return launchFailureResult(task);
    } else if (job.status !== "running") {
      return await terminalJobResult(task, job, workspace.cwd);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return textResult(
        `${JSON.stringify({
          ...lastMetadata,
          timed_out_waiting: true,
          message: `Job ${resolvedId ?? "<unknown>"} is still running after waiting ${timeoutMs}ms. Call kimi_job({ action: "wait", job_id: ${JSON.stringify(resolvedId)} }) to continue waiting, or action="cancel" to stop it.`,
        }, null, 2)}\n`,
        { ...lastMetadata, timed_out_waiting: true },
        false,
      );
    }

    await sleepAbortable(Math.min(delayMs, remaining), options.signal);
    delayMs = Math.min(250, delayMs * 2);
  }
}

async function listMcpJobs(env: NodeJS.ProcessEnv, args: McpJobControlArgs): Promise<McpToolResult> {
  const workspace = await resolveMcpWorkspace(env, args.workspace);
  const paths = resolvePluginPaths(env);
  await ensurePluginPaths(paths);
  const store = new JobStore(paths);
  try {
    await sweepStaleJobs(store, paths, {
      repoId: workspace.repo.repoId,
      workspaceCwd: workspace.cwd,
    });
    const candidates = store.listJobs({
      repoId: workspace.repo.repoId,
      status: args.statusFilter,
      limit: null,
    });
    const limit = args.limit ?? 20;
    const jobs: JobRecord[] = [];
    for (const candidate of candidates) {
      if (await isCwdWithinWorkspace(candidate.cwd, workspace.cwd)) {
        jobs.push(candidate);
        if (jobs.length >= limit) break;
      }
    }
    const projected = jobs.map((job) => ({
      job_id: job.job_id,
      operation_kind: job.operation_kind,
      command_type: job.command_type,
      status: job.status,
      phase: job.phase,
      summary: job.summary,
      created_at: job.created_at,
      updated_at: job.updated_at,
      kimi_session_id: job.kimi_session_id,
    }));
    const payload = {
      workspace: workspace.cwd,
      count: projected.length,
      jobs: projected,
    };
    return textResult(`${JSON.stringify(payload, null, 2)}\n`, payload, false);
  } finally {
    store.close();
  }
}

export async function getMcpJobStatus(env: NodeJS.ProcessEnv, input: unknown): Promise<McpToolResult> {
  const args = normalizeControlArgs(input, "status");
  const { task, job, workspace } = await loadJobSnapshot(env, args);
  const metadata = jobMetadata(task, job, workspace.cwd);
  return textResult(`${JSON.stringify(metadata, null, 2)}\n`, metadata);
}

export async function getMcpJobResult(env: NodeJS.ProcessEnv, input: unknown): Promise<McpToolResult> {
  const args = normalizeControlArgs(input, "result");
  const { task, job, workspace } = await loadJobSnapshot(env, args);
  if (!job) {
    if (task?.launch_error) return launchFailureResult(task);
    throw new RuntimeError("JOB_NOT_TERMINAL", `MCP job ${task?.task_id ?? args.jobId ?? "<unknown>"} is still starting.`, "mcp.result");
  }
  if (job.status === "running") {
    throw new RuntimeError("JOB_NOT_TERMINAL", `Job ${job.job_id} is still running.`, "mcp.result");
  }
  return terminalJobResult(task, job, workspace.cwd);
}

export async function cancelMcpJob(
  env: NodeJS.ProcessEnv,
  input: unknown,
  options?: { requireMcpTask?: boolean },
): Promise<McpToolResult> {
  const args = normalizeControlArgs(input, "cancel");
  const { task, job, workspace } = await loadJobSnapshot(env, args, undefined, options);
  const targetId = task?.task_id ?? job?.job_id;
  if (!job) {
    if (task?.launch_error) return launchFailureResult(task);
    throw new RuntimeError("JOB_NOT_TERMINAL", `MCP job ${targetId ?? "<unknown>"} has not attached to a companion job.`, "mcp.cancel");
  }
  if (job.status !== "running") {
    const metadata = jobMetadata(task, job, workspace.cwd);
    return textResult(`${JSON.stringify({ ...metadata, message: "cancel is a no-op for terminal jobs." }, null, 2)}\n`, metadata);
  }
  const companionIdentity = task ? mcpCompanionIdentity(task) : jobCompanionIdentity(job);
  const kimiIdentity = task ? mcpKimiIdentity(task, job) : jobKimiIdentity(job);
  const output = await runCancel([job.job_id], {
    cwd: workspace.cwd,
    env: pinnedKimiHomeEnv(env, workspace.cwd),
    stdout: process.stdout,
    stderr: process.stderr,
    mcpCompanionIdentity: companionIdentity,
    mcpKimiIdentity: kimiIdentity,
  });
  const current = await loadJobSnapshot(env, { action: "status", jobId: job.job_id, workspace: workspace.cwd });
  const metadata = jobMetadata(current.task, current.job, workspace.cwd);
  return textResult(output, { ...metadata, cancellation: JSON.parse(output) });
}

async function replayMcpJob(env: NodeJS.ProcessEnv, args: McpJobControlArgs): Promise<McpToolResult> {
  const { job, workspace } = await loadJobSnapshot(env, args);
  if (!job) {
    throw new RuntimeError("JOB_NOT_FOUND", `Job ${args.jobId ?? "<unknown>"} has no recorded job log.`, "mcp.replay");
  }
  const replayed = await replayJob(job);
  const output = `${replayed.rendered}${replayed.rendered.endsWith("\n") ? "" : "\n"}`;
  return textResult(
    output,
    {
      job_id: job.job_id,
      workspace: workspace.cwd,
      action: "replay",
      status: job.status,
      operation_kind: job.operation_kind ?? null,
      partial: replayed.partial,
    },
    job.status === "failed",
  );
}

async function recoverMcpSwarm(env: NodeJS.ProcessEnv, args: McpJobControlArgs): Promise<McpToolResult> {
  const { job, workspace } = await loadJobSnapshot(env, args);
  if (!job) {
    throw new RuntimeError("JOB_NOT_FOUND", `Job ${args.jobId ?? "<unknown>"} was not found.`, "mcp.recover_swarm");
  }
  const recoverArgs = args.apply ? [job.job_id, "--apply"] : [job.job_id];
  const output = await runRecoverSwarm(recoverArgs, {
    cwd: workspace.cwd,
    env: pinnedKimiHomeEnv(env, workspace.cwd),
    stdout: process.stdout,
    stderr: process.stderr,
  });
  return textResult(output, JSON.parse(output) as Record<string, unknown>, false);
}

export async function getMcpTaskView(env: NodeJS.ProcessEnv, input: unknown): Promise<McpTaskView> {
  let boundTask: McpTaskRecord | undefined;
  try {
    const args = normalizeControlArgs(input, "status");
    const { task, job, workspace } = await loadJobSnapshot(env, args, (found) => { boundTask = found; });
    if (!task) {
      throw new RuntimeError("JOB_NOT_FOUND", `MCP job ${args.jobId ?? "<unknown>"} was not found.`, "mcp.lookup");
    }
    if (!job) {
      if (task.launch_error) {
        return taskView(task, null, "completed", launchFailureResult(task), task.launch_error);
      }
      return taskView(task, null, "working", undefined, "Starting the supervised companion.");
    }
    switch (job.status) {
      case "running":
        return taskView(task, job, "working", undefined, `${task.operation_kind}: ${job.phase ?? "running"}`);
      case "completed":
      case "failed":
        return taskView(task, job, "completed", await terminalJobResult(task, job, workspace.cwd), job.summary);
      case "cancelled":
        return taskView(task, job, "cancelled", undefined, job.summary);
    }
  } catch (error) {
    if (boundTask && error instanceof RuntimeError && error.code === "MCP_PROCESS_IDENTITY_UNAVAILABLE") {
      return taskView(boundTask, null, "working", undefined, formatError(error));
    }
    if (boundTask && error instanceof RuntimeError && error.code !== "JOB_NOT_FOUND") {
      return {
        taskId: boundTask.task_id,
        status: "failed",
        createdAt: boundTask.created_at,
        lastUpdatedAt: new Date().toISOString(),
        ttlMs: null,
        pollIntervalMs: 2_000,
        error: {
          code: -32_603,
          message: formatError(error),
          data: { job_id: boundTask.task_id, operation_kind: boundTask.operation_kind },
        },
      };
    }
    throw error;
  }
}

function normalizeControlArgs(
  input: unknown,
  defaultAction: McpJobControlArgs["action"],
): McpJobControlArgs {
  if (input && typeof input === "object" && !Array.isArray(input) && "action" in input) {
    return readJobControlArguments(input);
  }
  const raw = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  return readJobControlArguments({ ...raw, action: defaultAction });
}

async function loadBoundTaskSnapshot(
  store: JobStore,
  paths: PluginPaths,
  initialTask: McpTaskRecord,
  workspace: McpWorkspace,
  observeTask?: (task: McpTaskRecord) => void,
): Promise<McpJobSnapshot> {
  let task = initialTask;
  if (task.workspace_cwd !== workspace.cwd || task.repo_id !== workspace.repo.repoId) {
    throw new RuntimeError("JOB_NOT_FOUND", `MCP job ${task.task_id} was not found in this workspace.`, "mcp.lookup");
  }
  observeTask?.(task);
  let job = store.getJob(task.task_id);
  if (!job) {
    task = await reconcileUnattachedTask(store, task);
    return { task, job: null, workspace };
  }
  await assertMcpJobBinding(task, job);

  if (task.launch_state === "starting") {
    let identity: ProcessIdentity | undefined;
    if (job.status === "running") {
      const expected = mcpCompanionIdentity(task);
      if (expected) {
        const validation = await revalidateProcessIdentities([expected]);
        if (!validation.complete) {
          throw new RuntimeError(
            "MCP_PROCESS_IDENTITY_UNAVAILABLE",
            "The companion identity probe was inconclusive; the starting task was not attached or changed.",
            "mcp.reconcile",
          );
        }
        if (validation.identities.length === 0) {
          const taskUpdatedAt = Date.parse(task.updated_at);
          const jobUpdatedAt = Date.parse(job.updated_at);
          const stale = Number.isFinite(taskUpdatedAt) && Number.isFinite(jobUpdatedAt) &&
            Date.now() - taskUpdatedAt >= STALE_SWEEP_GRACE_MS &&
            Date.now() - jobUpdatedAt >= STALE_SWEEP_GRACE_MS;
          if (!stale) {
            throw new RuntimeError(
              "MCP_PROCESS_IDENTITY_MISMATCH",
              "The recorded companion process identity no longer matches; the starting task was not attached and no process was adopted.",
              "mcp.reconcile",
            );
          }
          task = await reconcileStaleCompanion(store, paths, task, job);
          job = store.getJob(task.task_id)!;
          return { task, job, workspace };
        }
        identity = validation.identities[0];
      } else if (job.pid !== null) {
        const updatedAt = Date.parse(task.updated_at);
        if (!Number.isFinite(updatedAt) || Date.now() - updatedAt >= STALE_SWEEP_GRACE_MS) {
          throw new RuntimeError(
            "MCP_PROCESS_IDENTITY_UNAVAILABLE",
            "The starting task has no reusable identity after the attach grace period; refusing to adopt a process by PID alone.",
            "mcp.reconcile",
          );
        }
        identity = await readProcessIdentity(job.pid);
      }
    }
    if (job.status !== "running" || identity) {
      task = store.updateMcpTask(task.task_id, {
        launch_state: "attached",
        attached_at: new Date().toISOString(),
        companion_pid: job.pid ?? task.companion_pid,
        ...(identity ? { companion_identity: JSON.stringify(identity) } : {}),
      })!;
    }
  } else if (task.launch_error) {
    throw new RuntimeError("MCP_JOB_BINDING_FAILED", task.launch_error, "mcp.binding");
  }

  if (job.status === "running") {
    task = await refreshCompanionIdentity(store, task, job);
    task = await captureKimiIdentity(store, task, job);
    task = await reconcileStaleCompanion(store, paths, task, job);
    job = store.getJob(task.task_id)!;
  }
  return { task, job, workspace };
}

async function loadJobSnapshot(
  env: NodeJS.ProcessEnv,
  args: McpJobControlArgs,
  observeTask?: (task: McpTaskRecord) => void,
  options?: { requireMcpTask?: boolean },
): Promise<McpJobSnapshot> {
  const paths = resolvePluginPaths(env);
  await ensurePluginPaths(paths);
  const store = new JobStore(paths);
  try {
    const task: McpTaskRecord | null = args.jobId ? store.getMcpTask(args.jobId) : null;
    if (task) {
      const workspace = await resolveMcpWorkspace(env, args.workspace ?? task.workspace_cwd);
      return await loadBoundTaskSnapshot(store, paths, task, workspace, observeTask);
    }

    if (options?.requireMcpTask) {
      throw new RuntimeError(
        "JOB_NOT_FOUND",
        `MCP task ${args.jobId ?? "<unknown>"} was not found.`,
        "mcp.lookup",
      );
    }

    // Fallback: inspect CLI-launched or latest repo job contained in the validated workspace.
    const workspace = await resolveMcpWorkspace(env, args.workspace);
    await sweepStaleJobs(store, paths, {
      repoId: workspace.repo.repoId,
      workspaceCwd: workspace.cwd,
    });
    let foundJob: JobRecord | null = null;
    if (args.jobId) {
      const candidate = store.getJob(args.jobId);
      if (
        candidate &&
        candidate.repo_id === workspace.repo.repoId &&
        (await isCwdWithinWorkspace(candidate.cwd, workspace.cwd))
      ) {
        foundJob = candidate;
      }
    } else {
      const candidates = store.listJobsByUpdated({
        repoId: workspace.repo.repoId,
        terminalOnly: args.action === "result",
        runningOnly: args.action === "cancel",
      });
      for (const candidate of candidates) {
        if (await isCwdWithinWorkspace(candidate.cwd, workspace.cwd)) {
          foundJob = candidate;
          break;
        }
      }
    }
    if (!foundJob) {
      throw new RuntimeError(
        "JOB_NOT_FOUND",
        args.jobId
          ? `Job ${args.jobId} was not found in this workspace.`
          : "No matching job was found in this workspace.",
        "mcp.lookup",
      );
    }
    const attachedTask = store.getMcpTask(foundJob.job_id);
    if (attachedTask) {
      return await loadBoundTaskSnapshot(store, paths, attachedTask, workspace, observeTask);
    }
    return { task: null, job: foundJob, workspace };
  } finally {
    store.close();
  }
}

async function reconcileUnattachedTask(store: JobStore, task: McpTaskRecord): Promise<McpTaskRecord> {
  if (task.launch_state !== "starting") return task;
  const updatedAt = Date.parse(task.updated_at);
  const fresh = Number.isFinite(updatedAt) && Date.now() - updatedAt < STALE_SWEEP_GRACE_MS;
  if (task.companion_identity === null) {
    if (fresh) {
      if (task.companion_pid === null) return task;
      const current = await readProcessIdentity(task.companion_pid);
      return current
        ? store.updateMcpTask(task.task_id, { companion_identity: JSON.stringify(current) })!
        : task;
    }
    if (task.companion_pid !== null) {
      throw new RuntimeError(
        "MCP_PROCESS_IDENTITY_UNAVAILABLE",
        "The unattached companion has no reusable identity; refusing to adopt a process by PID alone.",
        "mcp.reconcile",
      );
    }
    return store.updateMcpTask(task.task_id, {
      launch_state: "exited",
      launch_error: `No companion process was recorded before creating job ${task.task_id}.`,
    })!;
  }

  if (fresh) return task;
  const validation = await revalidateProcessIdentities([mcpCompanionIdentity(task)!]);
  if (!validation.complete) {
    throw new RuntimeError(
      "MCP_PROCESS_IDENTITY_UNAVAILABLE",
      "The unattached companion identity probe was inconclusive; the task was not changed.",
      "mcp.reconcile",
    );
  }
  if (validation.identities.length > 0) return task;
  return store.updateMcpTask(task.task_id, {
    launch_state: "exited",
    launch_error: `Companion pid ${task.companion_pid} disappeared before creating job ${task.task_id}.`,
  })!;
}

async function refreshCompanionIdentity(
  store: JobStore,
  task: McpTaskRecord,
  job: JobRecord,
): Promise<McpTaskRecord> {
  if (task.companion_identity !== null || job.pid === null) return task;
  const updatedAt = Date.parse(task.updated_at);
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt >= STALE_SWEEP_GRACE_MS) {
    throw new RuntimeError(
      "MCP_PROCESS_IDENTITY_UNAVAILABLE",
      "The companion identity is missing after the attach grace period; refusing to adopt a process by PID alone.",
      "mcp.reconcile",
    );
  }
  const identity = await readProcessIdentity(job.pid);
  if (!identity) return task;
  return store.updateMcpTask(task.task_id, {
    companion_pid: job.pid,
    companion_identity: JSON.stringify(identity),
  })!;
}

async function captureKimiIdentity(
  store: JobStore,
  task: McpTaskRecord,
  job: JobRecord,
): Promise<McpTaskRecord> {
  if (task.kimi_identity !== null) return task;
  const companion = mcpCompanionIdentity(task);
  if (!companion || !(await revalidateProcessIdentity(companion))) return task;
  const identity = job.kimi_pid !== null
    ? await readProcessIdentity(job.kimi_pid)
    : undefined;
  if (!identity) return task;
  return store.updateMcpTask(task.task_id, { kimi_identity: JSON.stringify(identity) })!;
}

async function reconcileStaleCompanion(
  store: JobStore,
  paths: PluginPaths,
  task: McpTaskRecord,
  job: JobRecord,
): Promise<McpTaskRecord> {
  const updatedAt = Date.parse(job.updated_at);
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt < STALE_SWEEP_GRACE_MS) return task;
  const companion = mcpCompanionIdentity(task);
  if (!companion) {
    throw new RuntimeError(
      "MCP_PROCESS_IDENTITY_UNAVAILABLE",
      "The stale companion has no reusable process identity; refusing PID-only reconciliation.",
      "mcp.reconcile",
    );
  }
  const validation = await revalidateProcessIdentities([companion]);
  if (!validation.complete) {
    throw new RuntimeError(
      "MCP_PROCESS_IDENTITY_UNAVAILABLE",
      "The companion process identity probe was inconclusive; no process was signalled and the job was not changed.",
      "mcp.reconcile",
    );
  }
  if (validation.identities.length > 0) return task;

  const orphanWarning = await terminateRecordedKimi(task, job);
  await markJobFailed(
    store,
    paths,
    job,
    new RuntimeError(
      "MCP_COMPANION_DISAPPEARED",
      `The supervised companion disappeared before settling the job.${orphanWarning ? ` ${orphanWarning}` : ""}`,
      "mcp.reconcile",
      orphanWarning ? { details: { orphan_warning: orphanWarning, kimi_pid: job.kimi_pid } } : undefined,
    ),
    "Supervised MCP companion disappeared before reporting a terminal state.",
    { phase: "failed" },
  );
  return store.getMcpTask(task.task_id)!;
}

async function terminateRecordedKimi(task: McpTaskRecord, job: JobRecord): Promise<string | null> {
  const identity = mcpKimiIdentity(task, job);
  if (!identity) {
    return job.kimi_pid === null
      ? null
      : `Kimi pid ${job.kimi_pid} was not signalled because no verified identity had been captured.`;
  }
  if (!(await revalidateProcessIdentity(identity))) return null;
  signalVerifiedIdentity(identity, "SIGTERM");
  await sleep(1_500);
  if (await revalidateProcessIdentity(identity)) signalVerifiedIdentity(identity, "SIGKILL");
  return null;
}

function signalVerifiedIdentity(identity: ProcessIdentity, signal: NodeJS.Signals): void {
  try {
    process.kill(identity.processGroupId === identity.pid ? -identity.processGroupId : identity.pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}

async function terminalJobResult(
  task: McpTaskRecord | null,
  job: JobRecord,
  workspaceCwd: string,
): Promise<McpToolResult> {
  const metadata = jobMetadata(task, job, workspaceCwd);
  const body = job.final_output_path
    ? await readArtifact(job.final_output_path)
    : `${renderTerminalJobArtifact(job)}\n`;
  return textResult(body, {
    ...metadata,
    artifact_path: job.final_output_path,
    partial_output: job.status === "failed" && Number(job.error?.details?.partial_output_chars ?? 0) > 0,
  }, job.status !== "completed");
}

function launchFailureResult(task: McpTaskRecord): McpToolResult {
  const message = task.launch_error ?? "The companion failed before creating its job.";
  return textResult(message, {
    job_id: task.task_id,
    operation_kind: task.operation_kind,
    launch_state: task.launch_state,
    error: { code: "MCP_CHILD_LAUNCH_FAILED", message },
  }, true);
}

function jobMetadata(
  task: McpTaskRecord | null,
  job: JobRecord | null,
  workspaceCwd: string,
): Record<string, unknown> {
  if (!job) {
    if (!task) {
      return {
        workspace: workspaceCwd,
        status: "failed",
        error: "No job metadata available.",
      };
    }
    return {
      job_id: task.task_id,
      operation_kind: task.operation_kind,
      workspace: task.workspace_cwd,
      status: task.launch_error ? "failed" : "starting",
      launch_state: task.launch_state,
      created_at: task.created_at,
      updated_at: task.updated_at,
      error: task.launch_error,
    };
  }
  return {
    job_id: job.job_id,
    operation_kind: job.operation_kind ?? task?.operation_kind ?? null,
    command_type: job.command_type,
    workspace: task?.workspace_cwd ?? workspaceCwd,
    status: job.status,
    phase: job.phase,
    summary: job.summary,
    created_at: job.created_at,
    updated_at: job.updated_at,
    budget_ms: job.budget_ms,
    budget_source: renderBudgetSource(job),
    model: job.model,
    thinking_effort_requested: job.thinking_effort ?? null,
    kimi_session_id: job.kimi_session_id,
    kimi_session_id_source: job.kimi_session_id_source,
    hook_escapes: parseHookEscapes(job.hook_escapes),
    ...(parseJobWarnings(job.warnings).length > 0 ? { warnings: parseJobWarnings(job.warnings) } : {}),
    error: job.error,
  };
}

export function taskView(
  task: McpTaskRecord,
  job: JobRecord | null,
  status: McpTaskView["status"],
  result: McpToolResult | undefined,
  statusMessage?: string,
): McpTaskView {
  return {
    taskId: task.task_id,
    status,
    ...(statusMessage ? { statusMessage } : {}),
    createdAt: task.created_at,
    lastUpdatedAt: job?.updated_at ?? task.updated_at,
    ttlMs: null,
    pollIntervalMs: 2_000,
    ...(result ? { result: { resultType: "complete", ...result } } : {}),
  };
}
