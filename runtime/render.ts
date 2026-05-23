import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { JobRecord } from "./job-store.js";
import { getManagedCommandConfig } from "./commands/registry.js";
import { RuntimeError } from "./errors.js";
import type { ReviewGateOutput } from "./schemas/review-gate-output.js";
import { parseReviewGateOutput } from "./schemas/review-gate-output.js";
import type { PluginPaths } from "./paths.js";
import type { JobError, ManagedCommandType } from "./types.js";

export type RenderedManagedOutput =
  | {
      output: string | ReviewGateOutput | null;
      rendered: string;
      summary: string;
      error: JobError | null;
    };

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

export function renderManagedJobOutput(job: JobRecord, finalText: string): RenderedManagedOutput {
  assertOutputModeConsistency(job.command_type, finalText);

  switch (job.command_type) {
    case "ask": {
      const trimmed = finalText.trim();
      if (!trimmed) {
        throw new RuntimeError("ASK_EMPTY_OUTPUT", "ask returned an empty final response.", "ask.prompt");
      }

      return {
        output: trimmed,
        rendered: renderAskArtifact(trimmed),
        summary: trimmed.slice(0, 160),
        error: null,
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
        error: null,
      };
    }
    case "review_gate": {
      const output = parseReviewGateOutput(finalText.trim());
      return {
        output,
        rendered: renderReviewGateArtifact(job, output),
        summary: output.summary,
        error: null,
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
        error: null,
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

export function renderAskArtifact(output: string): string {
  return output.trim();
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

export function renderTerminalJobArtifact(job: JobRecord): string {
  const lines = [
    `# ${capitalize(job.status)} Job`,
    "",
    `- Job: ${job.job_id}`,
    `- Command: ${job.command_type}`,
    `- Status: ${job.status}`,
    `- Summary: ${job.summary}`,
    ...(job.kimi_session_id ? [`- Kimi session: ${job.kimi_session_id}`] : []),
  ];

  if (job.error) {
    lines.push("", "## Error", `- Code: ${job.error.code}`, `- Stage: ${job.error.stage}`, job.error.message);
  }

  return lines.join("\n");
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function assertNever(value: never): never {
  throw new RuntimeError(
    "UNSUPPORTED_COMMAND_TYPE",
    `Unsupported command type for rendering: ${String(value)}`,
    "render",
  );
}
