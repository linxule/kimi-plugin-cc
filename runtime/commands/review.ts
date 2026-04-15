import { randomUUID } from "node:crypto";
import path from "node:path";

import { collectReviewContext } from "../git.js";
import { digestPrompt, markJobFailed } from "../jobs.js";
import { JobStore } from "../job-store.js";
import { announceSessionTitle } from "../kimi-web-client.js";
import { buildWireClient, resolveAgentFile } from "../kimi-launch.js";
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
import type { ReviewOutput } from "../schemas/review-output.js";
import type { CommandContext } from "../types.js";
import { KIMI_PLUGIN_CC_VERSION } from "../version.js";
import { rejectAllApprovals } from "../wire/approval-dispatcher.js";
import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";

export async function runReview(
  argv: string[],
  context: CommandContext,
  commandType: "review" | "adversarial_review",
): Promise<ReviewOutput> {
  const parsed = parseReviewArgs(argv);

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
    pid: null,
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

  const client = buildWireClient({
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
  });

  try {
    await withTimeout(client.start(), KIMI_START_TIMEOUT_MS, `${commandType}.start`);
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
      `${commandType}.initialize`,
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
    );
    const rendered = renderManagedJobOutput(job, completed.finalText);
    const artifactPath = await writeArtifact(paths, job, rendered.rendered);
    store.markCompleted(job.job_id, {
      summary: rendered.summary,
      final_output_path: artifactPath,
      error: null,
    });
    return rendered.output as ReviewOutput;
  } catch (error) {
    const classified = classifyManagedCommandFailure(error, commandType, job.job_id);
    await markJobFailed(store, paths, job, classified, `${commandType} failed.`);
    throw classified;
  } finally {
    await client.close();
    store.close();
  }
}

function buildReviewTitleExcerpt(
  commandType: "review" | "adversarial_review",
  focus: string | undefined,
): string {
  const trimmed = focus?.trim();
  if (trimmed) return trimmed;
  return commandType === "adversarial_review" ? "pending changes (adversarial)" : "pending changes";
}

function buildReviewPrompt(
  commandType: "review" | "adversarial_review",
  reviewContext: Awaited<ReturnType<typeof collectReviewContext>>,
  focus?: string,
): string {
  const schemaReminder = `{
  "summary": "string",
  "verdict": "approve|concern|block",
  "findings": [
    {
      "severity": "low|medium|high",
      "confidence": "low|medium|high",
      "title": "string",
      "file": "string",
      "start_line": 1,
      "end_line": 1,
      "body": "string",
      "suggested_fix": "string|null"
    }
  ]
}`;

  const modeInstructions =
    commandType === "adversarial_review"
      ? [
          "Take an adversarial stance.",
          "Challenge assumptions, identify brittle design choices, and surface safer alternatives.",
        ]
      : ["Focus on concrete bugs, regressions, and missing safeguards in the supplied changes."];

  return [
    "Perform a read-only code review of the supplied repository changes.",
    ...modeInstructions,
    "Use repository read tools as needed, but do not attempt any write, shell, background, or delegated operations.",
    "Return exactly one JSON object with no prose wrapper and no code fences.",
    "If there are no findings, set verdict to approve and findings to an empty array.",
    "Each finding must refer to exactly one file and must include confidence.",
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
    "",
    "Required output schema:",
    schemaReminder,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}
