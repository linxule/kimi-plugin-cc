import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseJobWarnings } from "./job-store.js";
import { describeReadScope, parseJobReadScope } from "./read-scope.js";
import { getManagedCommandConfig } from "./commands/registry.js";
import { RuntimeError } from "./errors.js";
const EMPTY_SUMMARY_FALLBACK = "Rescue did not return a final message.";
export async function writeArtifact(paths, job, markdown) {
    const artifactPath = path.join(paths.artifactsDir, `${job.command_type}-${job.job_id}.md`);
    await writeFile(artifactPath, markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8");
    return artifactPath;
}
export async function readArtifact(artifactPath) {
    return readFile(artifactPath, "utf8");
}
/**
 * Prefix a "Warnings:" block when the job carries launch warnings. Wrapper
 * models read stdout and artifacts, never stderr, so this is the load-bearing
 * copy. Without warnings the text is returned unchanged, byte for byte.
 */
export function withWarningsBlock(job, text) {
    const warnings = parseJobWarnings(job.warnings);
    if (warnings.length === 0)
        return text;
    return `Warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}\n\n${text}`;
}
/** Prefix the non-default read scope so callers see what they asked for; unchanged otherwise. */
export function withScopeLine(job, text) {
    const line = describeReadScope(parseJobReadScope(job.read_scope));
    return line === undefined ? text : `${line}\n\n${text}`;
}
export function renderManagedJobOutput(job, finalText) {
    const rendered = renderManagedJobOutputBody(job, finalText);
    if (parseJobWarnings(job.warnings).length === 0 && !job.read_scope)
        return rendered;
    const decorate = (text) => withWarningsBlock(job, withScopeLine(job, text));
    return {
        ...rendered,
        output: typeof rendered.output === "string" ? decorate(rendered.output) : rendered.output,
        rendered: decorate(rendered.rendered),
    };
}
function renderManagedJobOutputBody(job, finalText) {
    // Historical v3.0 review_gate rows remain readable for replay/inspection
    // without re-registering review_gate as a live managed command.
    if (job.command_type === "review_gate") {
        const trimmed = finalText.trim();
        if (!trimmed) {
            throw new RuntimeError("REVIEW_GATE_EMPTY_OUTPUT", "Historical review_gate job returned empty output.", "render");
        }
        return {
            output: trimmed,
            rendered: `${trimmed}\n`,
            summary: firstMeaningfulLine(trimmed, "Historical review_gate output."),
        };
    }
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
                throw new RuntimeError(job.command_type === "challenge" ? "CHALLENGE_EMPTY_OUTPUT" : "REVIEW_EMPTY_OUTPUT", `${job.command_type} returned an empty final response.`, `${job.command_type}.prompt`);
            }
            return {
                output: trimmed,
                rendered: renderReviewArtifact(job, trimmed),
                summary: firstMeaningfulLine(trimmed),
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
export function assertOutputModeConsistency(commandType, finalText) {
    const { outputMode } = getManagedCommandConfig(commandType);
    switch (outputMode) {
        case "passthrough":
            return;
        default:
            return assertNever(outputMode);
    }
}
export function renderReviewArtifact(job, output) {
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
export function renderRescueArtifact(rawOutput) {
    return rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
}
export function firstMeaningfulLine(text, fallback = EMPTY_SUMMARY_FALLBACK) {
    const line = String(text ?? "")
        .split(/\r?\n/)
        .map((value) => value.trim())
        .find(Boolean);
    return line ?? fallback;
}
export function formatBudgetDuration(ms) {
    if (ms % 3_600_000 === 0)
        return `${ms / 3_600_000}h`;
    if (ms % 60_000 === 0)
        return `${ms / 60_000}m`;
    if (ms % 1_000 === 0)
        return `${ms / 1_000}s`;
    return `${ms}ms`;
}
export function renderTerminalJobArtifact(job, partialOutput) {
    const lines = [
        `# ${capitalize(job.status)} Job`,
        "",
        `- Job: ${job.job_id}`,
        `- Command: ${job.command_type}`,
        `- Status: ${job.status}`,
        `- Summary: ${job.summary}`,
        ...(job.kimi_session_id ? [`- Kimi session: ${job.kimi_session_id}`] : []),
        ...terminalScopeLine(job),
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
        lines.push("", `## Partial output (budget exhausted after ${formatBudgetDuration(partialOutput.budgetMs)} — NOT a final answer)`, "", partialOutput.text.trim()
            ? partialOutput.text
            : partialOutput.recordCount === 0
                ? "No stream records arrived before the budget expired (the model had not produced any output yet)."
                : partialOutput.toolCalls
                    ? "No assistant prose was emitted before the budget (tool calls only)."
                    : "No assistant prose was emitted before the budget.");
    }
    return lines.join("\n");
}
function terminalScopeLine(job) {
    try {
        const line = describeReadScope(parseJobReadScope(job.read_scope));
        return line === undefined ? [] : [`- ${line}`];
    }
    catch {
        return ["- Scope: unreadable stored scope"];
    }
}
export function capitalize(value) {
    return value.slice(0, 1).toUpperCase() + value.slice(1);
}
function assertNever(value) {
    throw new RuntimeError("UNSUPPORTED_COMMAND_TYPE", `Unsupported command type for rendering: ${String(value)}`, "render");
}
