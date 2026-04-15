import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { digestPrompt, markJobCancelled, markJobFailed, normalizeJobError, sweepStaleBackgroundJobs, waitForTerminalJob } from "../jobs.js";
import { JobStore, type JobRecord } from "../job-store.js";
import { buildWireClient, resolveAgentFile } from "../kimi-launch.js";
import { classifyManagedCommandFailure } from "../kimi-errors.js";
import { KIMI_INITIALIZE_TIMEOUT_MS, KIMI_START_TIMEOUT_MS, withTimeout } from "../kimi-timeouts.js";
import { writeInvocationLogHeader } from "../logging.js";
import { ensurePluginPaths, resolvePluginPaths, type PluginPaths } from "../paths.js";
import { parseRescueArgs } from "../parsing.js";
import { readArtifact, renderManagedJobOutput, writeArtifact } from "../render.js";
import { createRescueApprovalPolicy } from "../rescue-approval.js";
import type { CommandContext } from "../types.js";
import { KIMI_PLUGIN_CC_VERSION } from "../version.js";

// Resolves to runtime/companion.ts in dev (via tsx) and dist/companion.js in production (compiled
// with tsc to the same relative layout). The extension is derived from the running module so the
// child-process spawn in startBackgroundRescue targets the right entrypoint in both modes.
const isCompiledRuntime = import.meta.url.endsWith(".js");
const companionEntrypoint = fileURLToPath(
  new URL(isCompiledRuntime ? "../companion.js" : "../companion.ts", import.meta.url),
);
const companionProjectRoot = path.resolve(path.dirname(companionEntrypoint), "..");

const AUTO_RESUME_PATTERN = /\b(continue|resume|keep going|keep working|apply the top fix|dig deeper)\b/i;

export async function runRescue(argv: string[], context: CommandContext): Promise<string> {
  const parsed = parseRescueArgs(argv);
  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);
  const repoIdentity = await resolveRepoIdentity(context.cwd);
  const store = new JobStore(paths);

  try {
    await sweepStaleBackgroundJobs(store, paths);

    const sessionResolution = resolveRescueSession(store, repoIdentity.repoId, parsed.prompt, parsed.fresh, parsed.resume, parsed.resumeTarget);
    const prompt = buildRescuePrompt(parsed.prompt, sessionResolution.reusedSession);
    const jobId = randomUUID();
    const logPath = path.join(paths.logsDir, `rescue-${jobId}.jsonl`);
    const agentProfile = resolveAgentFile("runtime/agents/rescue.yaml");

    const job = store.createJob({
      job_id: jobId,
      repo_id: repoIdentity.repoId,
      command_type: "rescue",
      cwd: context.cwd,
      model: parsed.model ?? null,
      thinking: parsed.thinking ?? null,
      background: parsed.background,
      pid: null,
      kimi_pid: null,
      status: "running",
      kimi_session_id: sessionResolution.sessionId,
      agent_profile: agentProfile,
      prompt_digest: digestPrompt(prompt),
      summary: parsed.background ? "Queued background rescue job." : "Starting rescue job.",
      final_output_path: null,
      stream_log_path: logPath,
      error: null,
    });

    await writeInvocationLogHeader(logPath, {
      commandType: "rescue",
      kimiSessionId: sessionResolution.sessionId,
      cwd: context.cwd,
    });

    if (parsed.background) {
      return startBackgroundRescue(job, prompt, context, paths, parsed.wait);
    }

    const completed = await executeRescueJob(job.job_id, prompt, context);
    if (!completed.final_output_path) {
      throw new RuntimeError("RESCUE_RESULT_MISSING", "Rescue finished without a rendered result.", "rescue.result");
    }

    return readArtifact(completed.final_output_path);
  } finally {
    store.close();
  }
}

export async function executeRescueJob(
  jobId: string,
  prompt: string,
  context: CommandContext,
  options?: { workerPid?: number },
): Promise<JobRecord> {
  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);
  const store = new JobStore(paths);
  const job = store.getJob(jobId);
  if (!job) {
    store.close();
    throw new RuntimeError("JOB_NOT_FOUND", `Rescue job ${jobId} was not found.`, "rescue.worker");
  }

  let cancelling = false;
  let clientClosed = false;
  let cancelEscalationTimer: ReturnType<typeof setTimeout> | undefined;
  const approvalPolicy = await createRescueApprovalPolicy(job.cwd);
  const client = buildWireClient({
    cwd: job.cwd,
    env: context.env,
    sessionId: job.kimi_session_id ?? randomUUID(),
    agentFile: job.agent_profile,
    model: job.model ?? undefined,
    thinking: job.thinking ?? undefined,
    logPath: job.stream_log_path,
    approvalPolicy,
  });

  const requestCancellation = () => {
    if (cancelling) {
      return;
    }

    cancelling = true;
    client.beginCancellation();
    void client.cancel().catch(() => {});
    cancelEscalationTimer = setTimeout(() => {
      client.terminateChild("SIGTERM");
    }, 1_500);
    cancelEscalationTimer.unref();
  };

  process.once("SIGTERM", requestCancellation);
  process.once("SIGINT", requestCancellation);

  try {
    if (options?.workerPid) {
      store.updateRunningJob(job.job_id, { pid: options.workerPid, summary: "Background rescue worker running." });
    }

    await withTimeout(client.start(), KIMI_START_TIMEOUT_MS, "rescue.start");
    store.updateRunningJob(job.job_id, {
      kimi_pid: client.getChildPid(),
      summary: "Rescue turn running.",
    });

    await withTimeout(
      client.initialize({
        protocol_version: "1.9",
        client: { name: "kimi-plugin-cc", version: KIMI_PLUGIN_CC_VERSION },
        capabilities: {
          supports_question: false,
          supports_plan_mode: false,
        },
      }),
      KIMI_INITIALIZE_TIMEOUT_MS,
      "rescue.initialize",
    );

    const completedTurn = await client.prompt(prompt, "rescue");
    const rendered = renderManagedJobOutput(job, completedTurn.finalText);
    const artifactPath = await writeArtifact(paths, job, rendered.rendered);
    return (
      store.markCompleted(job.job_id, {
        summary: rendered.summary,
        final_output_path: artifactPath,
        error: rendered.error,
      }) ?? job
    );
  } catch (error) {
    if (cancelling) {
      return await markJobCancelled(
        store,
        paths,
        job,
        "Rescue cancelled by user request.",
        error,
      );
    }

    const classified = classifyManagedCommandFailure(error, "rescue", job.job_id);
    return await markJobFailed(store, paths, job, classified, "Rescue failed.");
  } finally {
    process.removeListener("SIGTERM", requestCancellation);
    process.removeListener("SIGINT", requestCancellation);
    if (cancelEscalationTimer) {
      clearTimeout(cancelEscalationTimer);
    }

    if (!clientClosed) {
      await client.close().catch(() => {});
      clientClosed = true;
    }

    store.close();
  }
}

function buildRescuePrompt(prompt: string | undefined, reusedSession: boolean): string {
  if (prompt?.trim()) {
    return prompt.trim();
  }

  if (reusedSession) {
    return "Continue the previous rescue task using the latest repository state.";
  }

  throw new RuntimeError("INVALID_ARGS", "rescue requires a task description.", "rescue.parse");
}

function resolveRescueSession(
  store: JobStore,
  repoId: string,
  prompt: string | undefined,
  fresh: boolean,
  resume: boolean,
  resumeTarget: string | undefined,
): { sessionId: string; reusedSession: boolean } {
  if (fresh) {
    return { sessionId: randomUUID(), reusedSession: false };
  }

  if (resumeTarget) {
    const byJob = store.getJob(resumeTarget);
    const exact = byJob?.command_type === "rescue" ? byJob : store.findRescueJobBySession(repoId, resumeTarget);
    if (!exact?.kimi_session_id) {
      throw new RuntimeError(
        "RESCUE_RESUME_NOT_FOUND",
        `No rescue job or session matched ${resumeTarget}.`,
        "rescue.resume",
      );
    }
    ensureSessionIsNotRunning(exact);
    return { sessionId: exact.kimi_session_id, reusedSession: true };
  }

  if (resume) {
    const latest = store.findLatestJob({ repoId, commandType: "rescue" });
    if (!latest?.kimi_session_id) {
      throw new RuntimeError(
        "RESCUE_RESUME_NOT_FOUND",
        "No prior rescue session exists for this repository.",
        "rescue.resume",
      );
    }
    ensureSessionIsNotRunning(latest);
    return { sessionId: latest.kimi_session_id, reusedSession: true };
  }

  if (prompt && AUTO_RESUME_PATTERN.test(prompt)) {
    const latest = store.findLatestJob({ repoId, commandType: "rescue" });
    if (latest?.kimi_session_id) {
      ensureSessionIsNotRunning(latest);
      return { sessionId: latest.kimi_session_id, reusedSession: true };
    }
  }

  return { sessionId: randomUUID(), reusedSession: false };
}

function ensureSessionIsNotRunning(job: JobRecord): void {
  if (job.status === "running") {
    throw new RuntimeError(
      "RESCUE_ALREADY_RUNNING",
      `Rescue session ${job.kimi_session_id ?? "<unknown>"} is already active under job ${job.job_id}.`,
      "rescue.resume",
    );
  }
}

async function startBackgroundRescue(
  job: JobRecord,
  prompt: string,
  context: CommandContext,
  paths: PluginPaths,
  wait: boolean,
): Promise<string> {
  const nodeBinary = context.env.KIMI_PLUGIN_CC_NODE_BIN || process.execPath;
  const spawnArgs = isCompiledRuntime
    ? [companionEntrypoint, "worker", "rescue", job.job_id]
    : ["--import", "tsx", companionEntrypoint, "worker", "rescue", job.job_id];
  const child = spawn(nodeBinary, spawnArgs, {
    cwd: companionProjectRoot,
    env: {
      ...context.env,
      KIMI_PLUGIN_CC_WORKSPACE_CWD: context.cwd,
      KIMI_PLUGIN_CC_RESCUE_PROMPT_B64: Buffer.from(prompt, "utf8").toString("base64"),
    },
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const store = new JobStore(paths);
  try {
    store.updateRunningJob(job.job_id, {
      pid: child.pid ?? null,
      summary: "Background rescue worker spawned.",
    });
  } finally {
    store.close();
  }

  if (wait) {
    const completed = await waitForTerminalJob(() => new JobStore(paths), job.job_id);
    if (!completed.final_output_path) {
      throw new RuntimeError(
        "RESCUE_RESULT_MISSING",
        `Background rescue job ${job.job_id} finished without a rendered result.`,
        "rescue.wait",
      );
    }

    return readArtifact(completed.final_output_path);
  }

  return `${JSON.stringify(
    {
      job_id: job.job_id,
      command_type: job.command_type,
    },
    null,
    2,
  )}\n`;
}
