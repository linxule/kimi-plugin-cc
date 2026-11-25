import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseJobWarnings, type JobRecord } from "./job-store.js";
import { getManagedCommandConfig } from "./commands/registry.js";
import { RuntimeError } from "./errors.js";
import type { ReviewGateOutput } from "./schemas/review-gate-output.js";
import { parseReviewGateOutput } from "./schemas/review-gate-output.js";
import type { PluginPaths } from "./paths.js";
import type { ManagedCommandType } from "./types.js";

export interface RenderedManagedOutput {
  output: string | ReviewGateOutput | null;
  rendered: string;
  summary: string;
}

const EMPTY_SUMMARY_FALLBACK = "Rescue did not return a final message.";

export async function writeArtifact(
  paths: PluginPaths,
  job: JobRecord,
  markdown: string,
): Promise<string> {
  const artifactPath = path.join(paths.artifactsDir, `${job.command_type}-${job.job_id}.md`);
  await writeFile(artifactPath, markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8");
  return artifactPath;
}

export async function readArtifact(artifactPath: string): Promise<string> {
  return readFile(artifactPath, "utf8");
}

/**
 * Prefix a "Warnings:" block when the job carries launch warnings. Wrapper
 * models read stdout and artifacts, never stderr, so this is the load-bearing
 * copy. Without warnings the text is returned unchanged, byte for byte.
 */
export function withWarningsBlock(job: Pick<JobRecord, "warnings">, text: string): string {
  const warnings = parseJobWarnings(job.warnings);
  if (warnings.length === 0) return text;
  return `Warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}\n\n${text}`;
}

export function renderManagedJobOutput(job: JobRecord, finalText: string): RenderedManagedOutput {
  const rendered = renderManagedJobOutputBody(job, finalText);
  if (parseJobWarnings(job.warnings).length === 0) return rendered;
  return {
    ...rendered,
    // review_gate's output is the parsed decision object; its warnings live in the artifact only.
    output: typeof rendered.output === "string" ? withWarningsBlock(job, rendered.output) : rendered.output,
    rendered: withWarningsBlock(job, rendered.rendered),
  };
}

function renderManagedJobOutputBody(job: JobRecord, finalText: string): RenderedManagedOutput {
  assertOutputModeConsistency(job.command_type, finalText);

  switch (job.command_type) {
    case "ask": {
      const trimmed = finalText.trim();
      if (!trimmed) {
        throw new RuntimeError("ASK_EMPTY_OUTPUT", "ask returned an empty final response.", "ask.prompt");
      }

      return {
        output: trimmed,
        rendered: trimmed,
        summary: trimmed.slice(0, 160),
      };
    }
    case "review":
    case "challenge": {
      const trimmed = finalText.trim();
      if (!trimmed) {
        throw new RuntimeError(
          job.command_type === "challenge" ? "CHALLENGE_EMPTY_OUTPUT" : "REVIEW_EMPTY_OUTPUT",
          `${job.command_type} returned an empty final response.`,
          `${job.command_type}.prompt`,
        );
      }
      return {
        output: trimmed,
        rendered: renderReviewArtifact(job, trimmed),
        summary: firstMeaningfulLine(trimmed),
      };
    }
    case "review_gate": {
      const output = parseReviewGateOutput(finalText.trim());
      return {
        output,
        rendered: renderReviewGateArtifact(job, output),
        summary: output.summary,
      };
    }
    case "rescue": {
      const trimmed = finalText.trim();
      if (!trimmed) {
        throw new RuntimeError("RESCUE_EMPTY_OUTPUT", "Rescue returned empty output.", "rescue.runtime");
      }

      return {
        output: finalText,
        rendered: renderRescueArtifact(finalText),
        summary: firstMeaningfulLine(finalText),
      };
    }
    default:
      return assertNever(job.command_type);
  }
}

export function assertOutputModeConsistency(commandType: ManagedCommandType, finalText: string): void {
  const { outputMode } = getManagedCommandConfig(commandType);

  switch (outputMode) {
    case "passthrough":
      return;
    case "parsed":
      try {
        JSON.parse(finalText);
      } catch (error) {
        throw new RuntimeError(
          `${commandType.toUpperCase()}_PARSE_FAILED`,
          `${commandType} is configured for parsed output but returned malformed JSON: ${(error as Error).message}`,
          `${commandType}.parse`,
          error instanceof Error ? { cause: error } : undefined,
        );
      }
      return;
    default:
      return assertNever(outputMode);
  }
}

export function renderReviewArtifact(job: JobRecord, output: string): string {
  const header = [
    `# ${job.command_type === "challenge" ? "Challenge" : "Review"} Result`,
    "",
    `- Job: ${job.job_id}`,
    ...(job.kimi_session_id ? [`- Kimi session: ${job.kimi_session_id}`] : []),
  ].join("\n");
  // Blank line between header and body, plus trailing newline so the rendered
  // string is well-formed even before writeArtifact's newline normalization.
  return `${header}\n\n${output.trim()}\n`;
}

export function renderRescueArtifact(rawOutput: string): string {
  return rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
}

export function firstMeaningfulLine(text: string, fallback: string = EMPTY_SUMMARY_FALLBACK): string {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

export function renderReviewGateArtifact(job: JobRecord, output: ReviewGateOutput): string {
  const lines = [
    "# Review Gate Result",
    "",
    `- Job: ${job.job_id}`,
    `- Decision: ${output.decision}`,
    `- Confidence: ${output.confidence}`,
    `- Summary: ${output.summary}`,
    ...(job.kimi_session_id ? [`- Kimi session: ${job.kimi_session_id}`] : []),
  ];

  if (output.issues.length === 0) {
    lines.push("", "No issues.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("", "## Issues");
  for (const issue of output.issues) {
    lines.push("", `### ${issue.title}`, `- Severity: ${issue.severity}`, issue.body);
  }

  return `${lines.join("\n")}\n`;
}

export interface PartialJobOutput {
  text: string;
  recordCount: number;
  /** True when at least one tool call or tool result record arrived. */
  toolCalls: boolean;
  budgetMs: number;
}

export function formatBudgetDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

export function renderTerminalJobArtifact(job: JobRecord, partialOutput?: PartialJobOutput): string {
  const lines = [
    `# ${capitalize(job.status)} Job`,
    "",
    `- Job: ${job.job_id}`,
    `- Command: ${job.command_type}`,
    `- Status: ${job.status}`,
    `- Summary: ${job.summary}`,
    ...(job.kimi_session_id ? [`- Kimi session: ${job.kimi_session_id}`] : []),
  ];
  const warnings = parseJobWarnings(job.warnings);
  if (warnings.length > 0) {
    lines.push("", "Warnings:", ...warnings.map((warning) => `- ${warning}`));
  }

  if (job.error) {
    lines.push("", "## Error", `- Code: ${job.error.code}`, `- Stage: ${job.error.stage}`, job.error.message);
    // Structured context (e.g. `drift_axis` / `retryable_after_setup`) so a
    // caller reading the rendered artifact — not just `result --json` — can
    // branch on it. Deterministic key order keeps artifacts stable.
    const details = job.error.details;
    if (details !== undefined && Object.keys(details).length > 0) {
      lines.push("", "### Details");
      for (const key of Object.keys(details).sort()) {
        lines.push(`- ${key}: ${JSON.stringify(details[key])}`);
      }
    }
  }

  if (partialOutput) {
    lines.push("", `## Partial output (budget exhausted after ${formatBudgetDuration(partialOutput.budgetMs)} — NOT a final answer)`, "",
      partialOutput.text.trim()
        ? partialOutput.text
        : partialOutput.recordCount === 0
          ? "No stream records arrived before the budget expired (the model had not produced any output yet)."
          : partialOutput.toolCalls
            ? "No assistant prose was emitted before the budget (tool calls only)."
            : "No assistant prose was emitted before the budget.");
  }

  return lines.join("\n");
}

export function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function assertNever(value: never): never {
  throw new RuntimeError(
    "UNSUPPORTED_COMMAND_TYPE",
    `Unsupported command type for rendering: ${String(value)}`,
    "render",
  );
}
