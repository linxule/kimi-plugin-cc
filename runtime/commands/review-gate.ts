import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readPluginConfig } from "../config.js";
import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { digestPrompt, markJobFailed } from "../jobs.js";
import { JobStore } from "../job-store.js";
import { classifyManagedCommandFailure, summarizeKimiAvailabilityWarning } from "../kimi-errors.js";
import { buildWireClient, resolveAgentFile } from "../kimi-launch.js";
import { writeInvocationLogHeader } from "../logging.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import {
  type ReviewGateOutput,
} from "../schemas/review-gate-output.js";
import {
  renderManagedJobOutput,
  writeArtifact,
} from "../render.js";
import type { CommandContext } from "../types.js";
import { rejectAllApprovals } from "../wire/approval-dispatcher.js";

const REVIEW_GATE_TIMEOUT_MS = 8_000;
const DEFAULT_REVIEW_GATE_MODEL = "kimi-for-coding";

export interface StopHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd: string;
  hook_event_name: "Stop";
  stop_hook_active?: boolean;
}

export interface StopHookOutput {
  decision?: "block";
  reason?: string;
  systemMessage?: string;
}

export async function runReviewGateStopHook(
  payload: StopHookInput,
  context: CommandContext,
): Promise<StopHookOutput> {
  if (payload.hook_event_name !== "Stop") {
    throw new RuntimeError(
      "INVALID_HOOK_EVENT",
      `review gate hook expected Stop input, received ${payload.hook_event_name}.`,
      "review_gate.hook",
    );
  }

  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);
  const config = await readPluginConfig(paths);

  if (!config.reviewGateEnabled || payload.stop_hook_active) {
    return {};
  }

  const assistantMessage = await extractLastAssistantMessage(payload.transcript_path);
  if (!assistantMessage) {
    return {};
  }

  try {
    const output = await executeReviewGate(payload, assistantMessage, context);

    if (output.decision === "BLOCK" && output.confidence === "high") {
      return {
        decision: "block",
        reason: buildBlockReason(output),
      };
    }

    if (output.decision === "BLOCK") {
      return {
        systemMessage: `Kimi review gate noted concerns but allowed stop: ${output.summary}`,
      };
    }

    return {};
  } catch (error) {
    return {
      systemMessage: buildWarningMessage(error),
    };
  }
}

async function executeReviewGate(
  payload: StopHookInput,
  assistantMessage: string,
  context: CommandContext,
): Promise<ReviewGateOutput> {
  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);
  const repoIdentity = await resolveRepoIdentity(payload.cwd);
  const store = new JobStore(paths);
  const userRequest = await extractLastUserMessage(payload.transcript_path);

  const jobId = randomUUID();
  const kimiSessionId = randomUUID();
  const logPath = path.join(paths.logsDir, `review-gate-${jobId}.jsonl`);
  const agentProfile = resolveAgentFile("runtime/agents/review-gate.yaml");
  const prompt = buildReviewGatePrompt({
    assistantMessage,
    userRequest,
    cwd: payload.cwd,
    repoRoot: repoIdentity.repoRoot,
  });

  const job = store.createJob({
    job_id: jobId,
    repo_id: repoIdentity.repoId,
    command_type: "review_gate",
    cwd: payload.cwd,
    model: context.env.KIMI_PLUGIN_CC_REVIEW_GATE_MODEL ?? DEFAULT_REVIEW_GATE_MODEL,
    thinking: false,
    background: false,
    pid: null,
    kimi_pid: null,
    status: "running",
    kimi_session_id: kimiSessionId,
    agent_profile: agentProfile,
    prompt_digest: digestPrompt(prompt),
    summary: "Running review gate.",
    final_output_path: null,
    stream_log_path: logPath,
    error: null,
  });
  await writeInvocationLogHeader(logPath, {
    commandType: "review_gate",
    kimiSessionId,
    cwd: payload.cwd,
  });

  const client = buildWireClient({
    cwd: payload.cwd,
    env: context.env,
    sessionId: kimiSessionId,
    agentFile: agentProfile,
    model: context.env.KIMI_PLUGIN_CC_REVIEW_GATE_MODEL ?? DEFAULT_REVIEW_GATE_MODEL,
    thinking: false,
    logPath,
    approvalPolicy: rejectAllApprovals(
      "review_gate is read-only; unexpected approval requests fail the command.",
    ),
  });

  try {
    const rendered = await withTimeout(
      (async () => {
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

        const completed = await client.prompt(prompt, "review_gate");
        return renderManagedJobOutput(job, completed.finalText);
      })(),
      REVIEW_GATE_TIMEOUT_MS,
      "review_gate.runtime",
    );

    const artifactPath = await writeArtifact(paths, job, rendered.rendered);
    store.markCompleted(job.job_id, {
      summary: rendered.summary,
      final_output_path: artifactPath,
      error: null,
    });
    return rendered.output as ReviewGateOutput;
  } catch (error) {
    const classified = classifyManagedCommandFailure(error, "review_gate", job.job_id);
    const summary =
      classified instanceof RuntimeError && classified.code === "TIMEOUT"
        ? "Review gate timed out."
        : "Review gate failed.";
    await markJobFailed(store, paths, job, classified, summary);
    throw classified;
  } finally {
    await client.close();
    store.close();
  }
}

function buildReviewGatePrompt(input: {
  assistantMessage: string;
  userRequest: string | null;
  cwd: string;
  repoRoot: string;
}): string {
  return [
    "Review the just-finished Claude response and decide whether Claude should be allowed to stop.",
    "Block only for concrete, high-confidence problems that require an immediate corrective follow-up turn.",
    "Do not block for style nits, optional improvements, or low-confidence concerns.",
    "Return exactly one JSON object with no prose wrapper and no code fences.",
    "",
    "Required output schema:",
    '{"decision":"ALLOW|BLOCK","confidence":"low|medium|high","summary":"string","issues":[{"title":"string","body":"string","severity":"low|medium|high"}]}',
    "",
    `Workspace cwd: ${input.cwd}`,
    `Repository root: ${input.repoRoot}`,
    "",
    "User request:",
    input.userRequest ?? "(unavailable from transcript)",
    "",
    "Claude response under review:",
    input.assistantMessage,
  ].join("\n");
}

function buildBlockReason(output: ReviewGateOutput): string {
  const issueLines = output.issues
    .slice(0, 5)
    .map((issue) => `- [${issue.severity}] ${issue.title}: ${issue.body}`);

  return [
    "Kimi review gate blocked stop. Revise the previous response before ending the turn.",
    `Summary: ${output.summary}`,
    ...(issueLines.length > 0 ? ["Issues:", ...issueLines] : []),
  ].join("\n");
}

function buildWarningMessage(error: unknown): string {
  if (error instanceof RuntimeError) {
    if (error.code === "TIMEOUT") {
      return "Kimi review gate timed out after 8s; allowing stop.";
    }

    if (
      error.code === "REVIEW_GATE_PARSE_FAILED" ||
      error.code === "MISSING_TURN_END" ||
      error.code === "TURN_INTERRUPTED"
    ) {
      return "Kimi review gate returned malformed output; allowing stop.";
    }

    if (
      error.code === "WIRE_SPAWN_FAILED" ||
      error.code === "WIRE_PROCESS_EXITED" ||
      error.code === "WIRE_REQUEST_FAILED"
    ) {
      return "Kimi review gate is unavailable in this environment; allowing stop.";
    }
  }

  const warning = summarizeKimiAvailabilityWarning(error, "review_gate");
  if (warning) {
    return warning;
  }

  return "Kimi review gate failed unexpectedly; allowing stop.";
}

async function extractLastUserMessage(transcriptPath?: string): Promise<string | null> {
  return scanTranscriptForLastRoleText(transcriptPath, "user");
}

async function extractLastAssistantMessage(transcriptPath?: string): Promise<string | null> {
  return scanTranscriptForLastRoleText(transcriptPath, "assistant");
}

async function scanTranscriptForLastRoleText(
  transcriptPath: string | undefined,
  role: "user" | "assistant",
): Promise<string | null> {
  if (!transcriptPath) {
    return null;
  }

  try {
    const raw = await readFile(expandHomeDir(transcriptPath), "utf8");
    let lastMatch: string | null = null;

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let entry: unknown;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const extracted = extractRoleText(entry, role);
      if (extracted) {
        lastMatch = extracted;
      }
    }

    return lastMatch;
  } catch {
    return null;
  }
}

function extractRoleText(entry: unknown, role: "user" | "assistant"): string | null {
  if (!isObject(entry)) {
    return null;
  }

  if (
    role === "user" &&
    entry.hook_event_name === "UserPromptSubmit" &&
    typeof entry.prompt === "string"
  ) {
    return entry.prompt.trim() || null;
  }

  if (entry.role === role) {
    return extractText(entry.content ?? entry.message ?? entry.text ?? entry.prompt);
  }

  if (entry.type === role) {
    return extractText(entry.content ?? entry.message ?? entry.text ?? entry.prompt);
  }

  if (isObject(entry.message) && entry.message.role === role) {
    return extractText(entry.message.content ?? entry.message.text);
  }

  return null;
}

function extractText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((part) => extractText(part))
      .filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join("\n") : null;
  }

  if (isObject(value)) {
    if (value.type === "text" && typeof value.text === "string") {
      return value.text.trim() || null;
    }

    return extractText(value.text ?? value.content ?? value.message);
  }

  return null;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandHomeDir(filePath: string): string {
  if (filePath === "~") {
    return os.homedir();
  }

  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  return filePath;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, stage: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(
        new RuntimeError(
          "TIMEOUT",
          `${stage} timed out after ${timeoutMs}ms.`,
          stage,
        ),
      );
    }, timeoutMs).unref();
  });

  return Promise.race([promise, timeout]);
}
