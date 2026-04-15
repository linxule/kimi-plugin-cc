import { randomUUID } from "node:crypto";
import path from "node:path";

import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { digestPrompt, markJobFailed } from "../jobs.js";
import { JobStore, type JobRecord } from "../job-store.js";
import { buildWireClient, resolveAgentFile } from "../kimi-launch.js";
import {
  KIMI_ASK_PROMPT_TIMEOUT_MS,
  KIMI_INITIALIZE_TIMEOUT_MS,
  KIMI_START_TIMEOUT_MS,
  withTimeout,
} from "../kimi-timeouts.js";
import { writeInvocationLogHeader } from "../logging.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { parseAskArgs } from "../parsing.js";
import { renderManagedJobOutput, writeArtifact } from "../render.js";
import type { CommandContext } from "../types.js";
import { KIMI_PLUGIN_CC_VERSION } from "../version.js";
import { rejectAllApprovals } from "../wire/approval-dispatcher.js";
import { classifyManagedCommandFailure } from "../kimi-errors.js";

export async function runAsk(argv: string[], context: CommandContext): Promise<string> {
  const parsed = parseAskArgs(argv);
  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);
  const repoIdentity = await resolveRepoIdentity(context.cwd);
  const store = new JobStore(paths);
  try {
    const jobId = randomUUID();
    const sessionResolution = resolveAskSession(
      store,
      repoIdentity.repoId,
      parsed.fresh,
      parsed.resume,
      parsed.resumeTarget,
    );
    const askPrompt = buildAskPrompt(parsed.prompt, sessionResolution.reusedSession);
    const kimiSessionId = sessionResolution.sessionId;
    const logPath = path.join(paths.logsDir, `ask-${jobId}.jsonl`);
    const agentProfile = resolveAgentFile("runtime/agents/ask.yaml");
    const job = store.createJob({
      job_id: jobId,
      repo_id: repoIdentity.repoId,
      command_type: "ask",
      cwd: context.cwd,
      model: parsed.model ?? null,
      thinking: parsed.thinking ?? null,
      background: false,
      pid: null,
      kimi_pid: null,
      status: "running",
      kimi_session_id: kimiSessionId,
      agent_profile: agentProfile,
      prompt_digest: digestPrompt(askPrompt),
      summary: "Running ask.",
      final_output_path: null,
      stream_log_path: logPath,
      error: null,
    });
    await writeInvocationLogHeader(logPath, {
      commandType: "ask",
      kimiSessionId,
      cwd: context.cwd,
    });

    const client = buildWireClient({
      cwd: context.cwd,
      env: context.env,
      sessionId: sessionResolution.sessionId,
      agentFile: agentProfile,
      model: parsed.model,
      thinking: parsed.thinking,
      logPath,
      approvalPolicy: rejectAllApprovals("ask is read-only; approval requests fail the command."),
    });

    try {
      await withTimeout(client.start(), KIMI_START_TIMEOUT_MS, "ask.start");
      store.updateRunningJob(job.job_id, { kimi_pid: client.getChildPid() });
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
        "ask.initialize",
      );

      const completed = await withTimeout(
        client.prompt(askPrompt, "ask"),
        KIMI_ASK_PROMPT_TIMEOUT_MS,
        "ask.prompt",
      );
      const rendered = renderManagedJobOutput(job, completed.finalText);
      const artifactPath = await writeArtifact(paths, job, rendered.rendered);
      store.markCompleted(job.job_id, {
        summary: rendered.summary,
        final_output_path: artifactPath,
        error: null,
      });

      return rendered.output as string;
    } catch (error) {
      const classified = classifyManagedCommandFailure(error, "ask", job.job_id);
      await markJobFailed(store, paths, job, classified, "Ask failed.");
      throw classified;
    } finally {
      await client.close();
    }
  } finally {
    store.close();
  }
}

function resolveAskSession(
  store: JobStore,
  repoId: string,
  fresh: boolean,
  resume: boolean,
  resumeTarget: string | undefined,
): { sessionId: string; reusedSession: boolean } {
  if (fresh) {
    return { sessionId: randomUUID(), reusedSession: false };
  }

  if (resumeTarget) {
    const byJob = store.getJob(resumeTarget);
    const exact = byJob?.command_type === "ask" ? byJob : store.findAskJobBySession(repoId, resumeTarget);
    if (!exact?.kimi_session_id) {
      throw new RuntimeError(
        "ASK_RESUME_NOT_FOUND",
        `No ask job or session matched ${resumeTarget}.`,
        "ask.resume",
      );
    }
    ensureAskSessionIsNotRunning(exact);
    return { sessionId: exact.kimi_session_id, reusedSession: true };
  }

  if (resume) {
    const latest = store.findLatestJob({ repoId, commandType: "ask" });
    if (!latest?.kimi_session_id) {
      throw new RuntimeError(
        "ASK_RESUME_NOT_FOUND",
        "No prior ask session exists for this repository.",
        "ask.resume",
      );
    }
    ensureAskSessionIsNotRunning(latest);
    return { sessionId: latest.kimi_session_id, reusedSession: true };
  }

  return { sessionId: randomUUID(), reusedSession: false };
}

function ensureAskSessionIsNotRunning(job: JobRecord): void {
  if (job.status === "running") {
    throw new RuntimeError(
      "ASK_ALREADY_RUNNING",
      `Ask session ${job.kimi_session_id ?? "<unknown>"} is already active under job ${job.job_id}.`,
      "ask.resume",
    );
  }
}

function buildAskPrompt(question: string | undefined, reusedSession: boolean): string {
  if (question?.trim()) {
    return [
      "Answer the user's question directly in free-form prose.",
      "Stay read-only.",
      "Do not emit JSON unless the user explicitly asks for it.",
      "",
      "User question:",
      question.trim(),
    ].join("\n");
  }

  if (reusedSession) {
    return [
      "Continue the previous ask conversation in free-form prose.",
      "Stay read-only.",
      "Do not emit JSON unless the user explicitly asks for it.",
    ].join("\n");
  }

  throw new RuntimeError("INVALID_ARGS", "ask requires a question after the flags.", "ask.parse");
}
