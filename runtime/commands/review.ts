import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";

import { createCancellationHandlers } from "../cancellation.js";
import { collectReviewContext } from "../git.js";
import { digestPrompt, markJobCancelled, markJobFailed } from "../jobs.js";
import { JobStore } from "../job-store.js";
import { announceSessionTitle } from "../kimi-web-client.js";
import { buildAndStartWireClient, resolveAgentFile } from "../kimi-launch.js";
import { WireClient } from "../wire/client.js";
import { KIMI_WIRE_PROTOCOL_VERSION } from "../wire/types.js";
import { classifyManagedCommandFailure } from "../kimi-errors.js";
import {
  KIMI_INITIALIZE_TIMEOUT_MS,
  KIMI_REVIEW_PROMPT_TIMEOUT_MS,
  KIMI_START_TIMEOUT_MS,
  withTimeout,
} from "../kimi-timeouts.js";
import { buildSessionTitle } from "../session-title.js";
import { writeInvocationLogHeader } from "../logging.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { parseReviewArgs } from "../parsing.js";
import { renderManagedJobOutput, writeArtifact } from "../render.js";
import type { CommandContext } from "../types.js";
import { KIMI_PLUGIN_CC_VERSION } from "../version.js";
import { rejectAllApprovals } from "../wire/approval-dispatcher.js";
import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";

export async function runReview(
  argv: string[],
  context: CommandContext,
  commandType: "review" | "challenge",
): Promise<string> {
  const parsed = parseReviewArgs(argv, commandType);

  if (parsed.background || parsed.wait) {
    throw new RuntimeError(
      "INVALID_FLAGS",
      `${commandType} does not support --background or --wait in v1; review runs foreground-synchronously.`,
      `${commandType}.parse`,
    );
  }

  const reviewContext = await collectReviewContext(context.cwd, parsed.base);
  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);
  const repoIdentity = await resolveRepoIdentity(context.cwd);
  const store = new JobStore(paths);

  const jobId = randomUUID();
  const reviewSessionId = randomUUID();
  const logPath = path.join(paths.logsDir, `${commandType}-${jobId}.jsonl`);
  const agentProfile = resolveAgentFile("runtime/agents/review.yaml");
  const previewPrompt = buildReviewPrompt(commandType, reviewContext, parsed.focus);
  const job = store.createJob({
    job_id: jobId,
    repo_id: repoIdentity.repoId,
    command_type: commandType,
    cwd: context.cwd,
    model: parsed.model ?? null,
    thinking: parsed.thinking ?? null,
    background: false,
    pid: process.pid,
    kimi_pid: null,
    status: "running",
    kimi_session_id: reviewSessionId,
    agent_profile: agentProfile,
    prompt_digest: digestPrompt(previewPrompt),
    summary: `Running ${commandType}.`,
    final_output_path: null,
    stream_log_path: logPath,
    error: null,
  });
  await writeInvocationLogHeader(logPath, {
    commandType,
    kimiSessionId: reviewSessionId,
    cwd: context.cwd,
  });

  let client: WireClient | undefined;
  // Shared cancellation handler — see runtime/cancellation.ts.
  const handlers = createCancellationHandlers({ escalationMs: 1_500 });

  try {
    client = await buildAndStartWireClient(
      {
        cwd: context.cwd,
        env: context.env,
        sessionId: reviewSessionId,
        agentFile: agentProfile,
        model: parsed.model,
        thinking: parsed.thinking,
        logPath,
        approvalPolicy: rejectAllApprovals(
          `${commandType} is read-only; unexpected approval requests fail the command.`,
        ),
      },
      KIMI_START_TIMEOUT_MS,
      `${commandType}.start`,
      { shouldRetry: () => !handlers.cancelling },
    );
    handlers.attachClient(client);
    if (handlers.cancelling) {
      throw new RuntimeError(
        reviewCancellationCode(commandType),
        `${commandType} cancelled during startup.`,
        `${commandType}.start`,
      );
    }
    store.updateRunningJob(job.job_id, { kimi_pid: client.getChildPid() });
    await withTimeout(
      client.initialize({
        protocol_version: KIMI_WIRE_PROTOCOL_VERSION,
        client: { name: "kimi-plugin-cc", version: KIMI_PLUGIN_CC_VERSION },
        capabilities: {
          supports_question: false,
          supports_plan_mode: false,
        },
      }),
      KIMI_INITIALIZE_TIMEOUT_MS,
      `${commandType}.initialize`,
      "initialize",
    );

    await announceSessionTitle(
      reviewSessionId,
      buildSessionTitle(commandType, buildReviewTitleExcerpt(commandType, parsed.focus)),
      { env: context.env },
    );

    const completed = await withTimeout(
      client.prompt(previewPrompt, commandType),
      KIMI_REVIEW_PROMPT_TIMEOUT_MS,
      `${commandType}.prompt`,
      "response",
    );
    // Cancel-after-prompt-success check: SIGTERM could have fired between
    // prompt completion and our terminal-state writes. Honour it instead of
    // silently committing markCompleted.
    if (handlers.cancelling) {
      throw new RuntimeError(
        reviewCancellationCode(commandType),
        `${commandType} cancelled by user request after prompt completion.`,
        `${commandType}.runtime`,
      );
    }
    const rendered = renderManagedJobOutput(job, completed.finalText);
    const artifactPath = await writeArtifact(paths, job, rendered.rendered);
    // Re-check after the disk write (writeArtifact awaits I/O) — cancel could
    // have landed during that window too.
    if (handlers.cancelling) {
      throw new RuntimeError(
        reviewCancellationCode(commandType),
        `${commandType} cancelled by user request after artifact write.`,
        `${commandType}.runtime`,
      );
    }
    store.markCompleted(job.job_id, {
      summary: rendered.summary,
      final_output_path: artifactPath,
      error: null,
    });
    return rendered.output as string;
  } catch (error) {
    if (handlers.cancelling) {
      // Clear the escalation timer NOW, before awaiting markJobCancelled
      // (which writes a failure artifact to disk and can take >1.5s under
      // load). Otherwise the timer fires SIGTERM on a client that's already
      // being cancelled — double-signal race.
      handlers.clearEscalation();
      // Always wrap into a canonical *_CANCELLED RuntimeError, even when the
      // underlying error is already a RuntimeError. Otherwise infrastructure
      // failure codes (WIRE_PROCESS_EXITED, TIMEOUT) leak into job.error.code
      // and callers can't distinguish user-cancel from infra failure.
      const cancelledError = new RuntimeError(
        reviewCancellationCode(commandType),
        `${commandType} cancelled by user request.`,
        `${commandType}.runtime`,
        error instanceof Error ? { cause: error } : undefined,
      );
      await markJobCancelled(store, paths, job, `${commandType} cancelled by user request.`, cancelledError);
      throw cancelledError;
    }
    const classified = classifyManagedCommandFailure(error, commandType, job.job_id);
    await markJobFailed(store, paths, job, classified, `${commandType} failed.`);
    throw classified;
  } finally {
    handlers.dispose();
    await client?.close();
    store.close();
  }
}

function reviewCancellationCode(commandType: "review" | "challenge"): "REVIEW_CANCELLED" | "CHALLENGE_CANCELLED" {
  return commandType === "review" ? "REVIEW_CANCELLED" : "CHALLENGE_CANCELLED";
}

function buildReviewTitleExcerpt(
  commandType: "review" | "challenge",
  focus: string | undefined,
): string {
  const trimmed = focus?.trim();
  if (trimmed) return trimmed;
  return commandType === "challenge" ? "pending changes (challenge)" : "pending changes";
}

function buildReviewPrompt(
  commandType: "review" | "challenge",
  reviewContext: Awaited<ReturnType<typeof collectReviewContext>>,
  focus?: string,
): string {
  const modeInstructions =
    commandType === "challenge"
      ? [
          "Take a challenging stance.",
          "Challenge assumptions, identify brittle design choices, and surface safer alternatives.",
        ]
      : ["Focus on concrete bugs, regressions, and missing safeguards in the supplied changes."];

  return [
    "Perform a read-only code review of the supplied repository changes.",
    ...modeInstructions,
    "Use repository read tools as needed, but do not attempt any write, shell, background, or delegated operations.",
    "Return your review as plain markdown — a short verdict line (approve / concern / block), then a brief summary, then one section per finding with file:line refs. No JSON wrapper, no code fences around the whole response.",
    "If the supplied diff context is empty or shows no changes to review, return immediately with a one-line note that there were no changes — do not explore the repository.",
    focus ? `Review focus: ${focus}` : undefined,
    "",
    `Target: ${reviewContext.targetDescription}`,
    `Repository root: ${reviewContext.repoRoot}`,
    "",
    "git status --short:",
    reviewContext.statusSummary || "(clean)",
    "",
    "Unified diff context:",
    reviewContext.diffText || "(no diff text available)",
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}
