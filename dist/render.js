import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RuntimeError } from "./errors.js";
import { parseReviewGateOutput } from "./schemas/review-gate-output.js";
import { parseReviewOutput } from "./schemas/review-output.js";
import { parseRescueOutput } from "./schemas/rescue-output.js";
export async function writeArtifact(paths, job, markdown) {
    const artifactPath = path.join(paths.artifactsDir, `${job.command_type}-${job.job_id}.md`);
    await writeFile(artifactPath, markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8");
    return artifactPath;
}
export async function readArtifact(artifactPath) {
    return readFile(artifactPath, "utf8");
}
export function renderManagedJobOutput(job, finalText) {
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
        case "adversarial_review": {
            const output = parseReviewOutput(finalText);
            return {
                output,
                rendered: renderReviewArtifact(job, output),
                summary: output.summary,
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
            const rawFinalText = finalText.trim();
            try {
                const output = parseRescueOutput(rawFinalText);
                return {
                    output,
                    rendered: renderRescueArtifact(job, output, rawFinalText),
                    summary: output.summary,
                    error: null,
                };
            }
            catch (error) {
                const parseError = normalizeRenderError(error);
                return {
                    output: null,
                    rendered: renderRescueArtifact(job, null, rawFinalText, {
                        message: parseError.message,
                        stage: parseError.stage,
                    }),
                    summary: "Rescue completed with partial or malformed final output.",
                    error: parseError,
                };
            }
        }
        default:
            return assertNever(job.command_type);
    }
}
export function renderAskArtifact(output) {
    return output.trim();
}
export function renderReviewArtifact(job, output) {
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
        lines.push("", `### ${finding.title}`, `- Severity: ${finding.severity}`, `- Confidence: ${finding.confidence}`, `- File: ${finding.file}:${finding.start_line}-${finding.end_line}`, finding.body);
        if (finding.suggested_fix) {
            lines.push("", `Suggested fix: ${finding.suggested_fix}`);
        }
    }
    return lines.join("\n");
}
export function renderRescueArtifact(job, output, rawFinalText, parseError) {
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
        lines.push("", "## Parse Warning", `- Stage: ${parseError.stage}`, `- Message: ${parseError.message}`);
    }
    if (rawFinalText.trim()) {
        lines.push("", "## Raw Final Output", "```json", rawFinalText.trim(), "```");
    }
    return lines.join("\n");
}
export function renderReviewGateArtifact(job, output) {
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
        return lines.join("\n");
    }
    lines.push("", "## Issues");
    for (const issue of output.issues) {
        lines.push("", `### ${issue.title}`, `- Severity: ${issue.severity}`, issue.body);
    }
    return lines.join("\n");
}
export function renderTerminalJobArtifact(job) {
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
function capitalize(value) {
    return value.slice(0, 1).toUpperCase() + value.slice(1);
}
function normalizeRenderError(error) {
    if (error instanceof RuntimeError) {
        return {
            code: error.code,
            message: error.message,
            stage: error.stage,
        };
    }
    if (error instanceof Error) {
        return {
            code: "UNEXPECTED_ERROR",
            message: error.message,
            stage: "runtime",
        };
    }
    return {
        code: "UNEXPECTED_ERROR",
        message: String(error),
        stage: "runtime",
    };
}
function assertNever(value) {
    throw new RuntimeError("UNSUPPORTED_COMMAND_TYPE", `Unsupported command type for rendering: ${String(value)}`, "render");
}
