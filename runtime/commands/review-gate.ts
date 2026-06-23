import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCliPromptWithBudget } from "../cli-client.js";
import { resolveKimiCliCommand } from "../kimi-command.js";
import { readPluginConfig } from "../config.js";
import { getManagedCommandConfig } from "./registry.js";
import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { digestPrompt, markJobFailed } from "../jobs.js";
import { JobStore } from "../job-store.js";
import { classifyManagedCommandFailure, summarizeKimiAvailabilityWarning } from "../kimi-errors.js";
import { KIMI_REVIEW_GATE_TIMEOUT_MS, isTimeoutCode } from "../kimi-timeouts.js";
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
import { maybeWarnHookMissing, verifyHookInstalled } from "../hooks/install.js";
import { assertCliResultSuccess, reassembleProseFromRecords } from "./cli-helpers.js";

const DEFAULT_REVIEW_GATE_MODEL = "kimi-for-coding";
const REVIEW_GATE_AGENT_PROFILE_PLACEHOLDER = "<cli-client>";

export interface StopHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name: "Stop";
  stop_hook_active?: boolean;
  last_assistant_message?: unknown;
  last_user_message?: unknown;
  user_request?: unknown;
  prompt?: unknown;
}

export interface StopHookOutput {
  decision?: "block";
  reason?: string;
  systemMessage?: string;
}

// v1.0 cutover note (PR 2):
//
//   review_gate is the only command that still parses Kimi's stdout
//   (JSON allow/block decision). The transport switched from
//   `kimi --wire` to `kimi -p --output-format stream-json`; the parser
//   stayed.
//
//   No cancellation handler — the 8s timeout is the only governor.
//   review_gate is invoked from Claude Code's Stop hook and runs
//   strictly foreground-synchronous.

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

  if (!config.reviewGateEnabled) {
    return reviewGateSkipped("disabled");
  }

  if (payload.stop_hook_active) {
    return reviewGateSkipped("stop hook already active");
  }

  const cwd = payload.cwd || context.cwd;
  const assistantMessage =
    extractText(payload.last_assistant_message) ??
    (await extractLastAssistantMessage(payload.transcript_path));
  if (!assistantMessage) {
    return reviewGateSkipped("no assistant message");
  }

  if (context.env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK !== "1") {
    const installStatus = await verifyHookInstalled(context.env);
    maybeWarnHookMissing(installStatus, "review_gate", context.stderr);
  }

  try {
    const output = await executeReviewGate(
      {
        ...payload,
        cwd,
      },
      assistantMessage,
      context,
    );

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

function reviewGateSkipped(reason: string): StopHookOutput {
  return { systemMessage: `review-gate skipped: ${reason}` };
}

async function executeReviewGate(
  payload: StopHookInput & { cwd: string },
  assistantMessage: string,
  context: CommandContext,
): Promise<ReviewGateOutput> {
  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);
  const repoIdentity = await resolveRepoIdentity(payload.cwd);
  let store: JobStore | undefined;
  try {
    store = new JobStore(paths);
    const userRequest =
      extractText(payload.last_user_message ?? payload.user_request ?? payload.prompt) ??
      (await extractLastUserMessage(payload.transcript_path));

    const jobId = randomUUID();
    const logPath = path.join(paths.logsDir, `review-gate-${jobId}.jsonl`);
    const prompt = buildReviewGatePrompt({
      assistantMessage,
      userRequest,
      cwd: payload.cwd,
      repoRoot: repoIdentity.repoRoot,
    });
    const model =
      context.env.KIMI_PLUGIN_CC_REVIEW_GATE_MODEL ?? DEFAULT_REVIEW_GATE_MODEL;

    // Header-before-job-row mirrors v0.4's reordering (the comment
    // chain there explains why). If the disk-bound writeInvocationLogHeader
    // throws (full disk, permission), we'd otherwise leave an orphan
    // running row with pid=null,kimi_pid=null that the sweeper can't
    // see. Keep the header first.
    await writeInvocationLogHeader(logPath, {
      commandType: "review_gate",
      // kimi-code assigns the session id; we don't know it until the
      // call returns. The header carries a "(pending)" placeholder so
      // post-mortem log diffing still finds the right row.
      kimiSessionId: "(pending)",
      cwd: payload.cwd,
    });
    const job = store.createJob({
      job_id: jobId,
      repo_id: repoIdentity.repoId,
      command_type: "review_gate",
      cwd: payload.cwd,
      model,
      thinking: false,
      background: false,
      pid: null,
      kimi_pid: null,
      status: "running",
      kimi_session_id: null,
      agent_profile: REVIEW_GATE_AGENT_PROFILE_PLACEHOLDER,
      prompt_digest: digestPrompt(prompt),
      summary: "Running review gate.",
      final_output_path: null,
      stream_log_path: logPath,
      error: null,
    });

    const kimi = resolveKimiCliCommand(context.env);

    try {
      const activeStore = store;
      // runCliPromptWithBudget ties the 8 s timeout to an AbortController
      // that kills the kimi child on expiry — review_gate runs inside
      // Claude Code's Stop hook, so a runaway kimi after timeout would
      // hold model tokens with no way for /kimi:cancel to reach it
      // (the SQLite row's kimi_pid is null). See reports/17 and 18.
      const result = await runCliPromptWithBudget(
        {
          cwd: payload.cwd,
          env: context.env,
          command: kimi.command,
          prefixArgs: kimi.prefixArgs,
          prompt,
          commandLabel: "review_gate",
          model,
          // Intent: thinking-off so the 8s Stop-hook budget is achievable.
          // Mechanism: currently advisory — kimi-code 0.1.1 has no CLI
          // flag for this; control is config-based (default_thinking /
          // [thinking].mode). The field carries intent through the
          // contract; when upstream adds a per-spawn flag, buildArgs will
          // translate it. (Round 2 Codex finding.)
          thinking: false,
          logPath,
        },
        KIMI_REVIEW_GATE_TIMEOUT_MS,
        "review_gate.runtime",
      );
      assertCliResultSuccess(result, "review_gate.runtime");
      if (result.sessionId !== undefined && result.sessionId.length > 0) {
        // length>0 guard matches the other commands (Kimi alpha.4
        // challenge finding #3 — defense-in-depth, since
        // extractSessionIdFromStderr returns undefined on no-match and
        // can't synthesize empty strings today, but the guard locks the
        // SQLite contract independent of upstream behavior).
        activeStore.updateRunningJob(job.job_id, {
          kimi_session_id: result.sessionId,
        });
      }
      const finalText = reassembleProseFromRecords(result.records);
      const rendered = renderManagedJobOutput(job, finalText);

      // Cancel-vs-completed race: /kimi:cancel pre-marks the row as
      // `cancelled` and SIGTERMs the worker. If kimi managed to return
      // in the SIGTERM→exit window before our wire-equivalent picked
      // up the close, we'd overwrite the cancellation artifact and
      // confuse the hook's allow/block decision. Check the persisted
      // status before committing the success path.
      const persisted = activeStore.getJob(job.job_id);
      if (persisted && persisted.status !== "running") {
        throw new RuntimeError(
          getManagedCommandConfig("review_gate").cancellation.errorCodes.cancelled,
          "review_gate cancelled before completion artifact was written.",
          "review_gate.runtime",
        );
      }

      const artifactPath = await writeArtifact(paths, job, rendered.rendered);
      activeStore.markCompleted(job.job_id, {
        summary: rendered.summary,
        final_output_path: artifactPath,
        error: null,
      });
      return rendered.output as ReviewGateOutput;
    } catch (error) {
      const classified = classifyManagedCommandFailure(error, "review_gate", job.job_id);
      const summary = isTimeoutError(classified) ? "Review gate timed out." : "Review gate failed.";
      await markJobFailed(store, paths, job, classified, summary);
      throw classified;
    }
  } finally {
    store?.close();
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

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof RuntimeError)) {
    return false;
  }
  return (
    isTimeoutCode(error.code) ||
    error.code === "REVIEW_GATE_KIMI_TIMEOUT" ||
    error.code === "REVIEW_GATE_KIMI_STARTUP_TIMEOUT" ||
    error.code === "REVIEW_GATE_KIMI_INITIALIZE_TIMEOUT" ||
    error.code === "REVIEW_GATE_KIMI_RESPONSE_TIMEOUT"
  );
}

function buildWarningMessage(error: unknown): string {
  if (isTimeoutError(error)) {
    return "Kimi review gate timed out after 8s; allowing stop.";
  }

  if (error instanceof RuntimeError) {
    if (
      error.code === "REVIEW_GATE_PARSE_FAILED" ||
      error.code === "MISSING_TURN_END" ||
      error.code === "TURN_INTERRUPTED"
    ) {
      return "Kimi review gate returned malformed output; allowing stop.";
    }

    if (error.code === "MAX_STEPS_REACHED") {
      return "Kimi review gate exhausted its step budget; allowing stop.";
    }

    // v0.4 codes from the deleted wire/* path. Kept here so a stale
    // job row or in-flight test that still produces them maps to the
    // same allowing-stop language. The v1.0 equivalents
    // (CLI_NONZERO_EXIT, CLI_PROCESS_ERROR, CLI_ABORTED) get the same
    // user-visible warning.
    if (
      error.code === "WIRE_SPAWN_FAILED" ||
      error.code === "WIRE_PROCESS_EXITED" ||
      error.code === "WIRE_REQUEST_FAILED" ||
      error.code === "CLI_SPAWN_FAILED" ||
      error.code === "CLI_PROCESS_ERROR" ||
      error.code === "CLI_NONZERO_EXIT" ||
      error.code === "CLI_ABORTED" ||
      error.code === "CLI_NO_SESSION_ID"
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
