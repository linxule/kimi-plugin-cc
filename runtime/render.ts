import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { JobRecord } from "./job-store.js";
import type { ReviewOutput } from "./schemas/review-output.js";
import type { RescueOutput } from "./schemas/rescue-output.js";
import type { PluginPaths } from "./paths.js";

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

export function renderAskArtifact(output: string): string {
  return output.trim();
}

export function renderReviewArtifact(job: JobRecord, output: ReviewOutput): string {
  const lines = [
    `# ${job.command_type === "adversarial_review" ? "Adversarial Review" : "Review"} Result`,
    "",
    `- Job: ${job.job_id}`,
    `- Verdict: ${output.verdict}`,
    `- Summary: ${output.summary}`,
    ...(job.kimi_session_id ? [`- Kimi session: ${job.kimi_session_id}`] : []),
  ];

  if (output.findings.length === 0) {
    lines.push("", "No findings.");
    return lines.join("\n");
  }

  lines.push("", "## Findings");
  for (const finding of output.findings) {
    lines.push(
      "",
      `### ${finding.title}`,
      `- Severity: ${finding.severity}`,
      `- Confidence: ${finding.confidence}`,
      `- File: ${finding.file}:${finding.start_line}-${finding.end_line}`,
      finding.body,
    );

    if (finding.suggested_fix) {
      lines.push("", `Suggested fix: ${finding.suggested_fix}`);
    }
  }

  return lines.join("\n");
}

export function renderRescueArtifact(
  job: JobRecord,
  output: RescueOutput | null,
  rawFinalText: string,
  parseError?: { message: string; stage: string },
): string {
  const lines = [
    "# Rescue Result",
    "",
    `- Job: ${job.job_id}`,
    `- Status: ${output?.status ?? "partial"}`,
    `- Summary: ${output?.summary ?? "Rescue completed with an unparsed final response."}`,
    ...(job.kimi_session_id ? [`- Kimi session: ${job.kimi_session_id}`] : []),
  ];

  if (output) {
    if (output.changes.length > 0) {
      lines.push("", "## Changes");
      for (const change of output.changes) {
        lines.push(`- ${change.action}: ${change.file} — ${change.description}`);
      }
    }

    if (output.commands_run.length > 0) {
      lines.push("", "## Commands");
      for (const command of output.commands_run) {
        lines.push(`- \`${command.command}\` (exit ${command.exit_code}) — ${command.note}`);
      }
    }

    if (output.tests.length > 0) {
      lines.push("", "## Tests");
      for (const test of output.tests) {
        lines.push(`- ${test.name}: ${test.status} — ${test.details}`);
      }
    }

    if (output.followups.length > 0) {
      lines.push("", "## Followups");
      for (const followup of output.followups) {
        lines.push(`- ${followup}`);
      }
    }
  }

  if (parseError) {
    lines.push(
      "",
      "## Parse Warning",
      `- Stage: ${parseError.stage}`,
      `- Message: ${parseError.message}`,
    );
  }

  if (rawFinalText.trim()) {
    lines.push("", "## Raw Final Output", "```json", rawFinalText.trim(), "```");
  }

  return lines.join("\n");
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
