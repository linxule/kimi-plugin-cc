import { randomUUID } from "node:crypto";
import path from "node:path";

import { collectReviewContext } from "../git.js";
import { digestPrompt, markJobFailed } from "../jobs.js";
import { JobStore } from "../job-store.js";
import { buildWireClient, resolveAgentFile } from "../kimi-launch.js";
import { writeInvocationLogHeader } from "../logging.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { parseReviewArgs } from "../parsing.js";
import { renderReviewArtifact, writeArtifact } from "../render.js";
import { parseReviewOutput, type ReviewOutput } from "../schemas/review-output.js";
import type { CommandContext } from "../types.js";
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
      "NOT_IMPLEMENTED",
      `${commandType} background execution is deferred until phase 2.`,
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
    await client.start();
    store.updateRunningJob(job.job_id, { kimi_pid: client.getChildPid() });
    await client.initialize({
      protocol_version: "1.9",
      client: { name: "kimi-plugin-cc", version: "0.1.0" },
      capabilities: {
        supports_question: false,
        supports_plan_mode: false,
      },
    });

    const completed = await client.prompt(
      previewPrompt,
      commandType,
    );

    const output = parseReviewOutput(completed.finalText);
    const artifactPath = await writeArtifact(paths, job, renderReviewArtifact(job, output));
    store.markCompleted(job.job_id, {
      summary: output.summary,
      final_output_path: artifactPath,
      error: null,
    });
    return output;
  } catch (error) {
    await markJobFailed(store, paths, job, error, `${commandType} failed.`);
    throw error;
  } finally {
    await client.close();
    store.close();
  }
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
