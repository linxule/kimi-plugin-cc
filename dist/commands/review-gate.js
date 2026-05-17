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
import { KIMI_REVIEW_GATE_TIMEOUT_MS, withTimeout } from "../kimi-timeouts.js";
import { writeInvocationLogHeader } from "../logging.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { renderManagedJobOutput, writeArtifact, } from "../render.js";
import { KIMI_PLUGIN_CC_VERSION } from "../version.js";
import { rejectAllApprovals } from "../wire/approval-dispatcher.js";
import { KIMI_WIRE_PROTOCOL_VERSION } from "../wire/types.js";
const DEFAULT_REVIEW_GATE_MODEL = "kimi-for-coding";
export async function runReviewGateStopHook(payload, context) {
    if (payload.hook_event_name !== "Stop") {
        throw new RuntimeError("INVALID_HOOK_EVENT", `review gate hook expected Stop input, received ${payload.hook_event_name}.`, "review_gate.hook");
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
    }
    catch (error) {
        return {
            systemMessage: buildWarningMessage(error),
        };
    }
}
async function executeReviewGate(payload, assistantMessage, context) {
    const paths = resolvePluginPaths(context.env);
    await ensurePluginPaths(paths);
    const repoIdentity = await resolveRepoIdentity(payload.cwd);
    // One try/finally for the store + client lifetime. Everything that can
    // throw — including JobStore construction itself (pragma/exec can fail
    // after the adapter is open), header write, createJob, buildWireClient,
    // the wire round-trip — must happen inside it; otherwise an early throw
    // leaks the SQLite handle. v0.2.3 ordered header-first to close an
    // orphan-row hole but reopened a store-leak hole. v0.2.4 wraps everything.
    let store;
    let client;
    try {
        store = new JobStore(paths);
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
        // Write the invocation log header BEFORE creating the job row. If the
        // header write fails (disk full, permission denied), we'd otherwise leave
        // a running job row with pid=null,kimi_pid=null that the sweeper can't
        // see (listRunningJobsWithProcessHints requires at least one non-null pid)
        // — orphan row. With the header first, a write failure throws before any
        // row is created. Both paths are now inside the outer try, so the store
        // handle is closed regardless.
        await writeInvocationLogHeader(logPath, {
            commandType: "review_gate",
            kimiSessionId,
            cwd: payload.cwd,
        });
        const job = store.createJob({
            job_id: jobId,
            repo_id: repoIdentity.repoId,
            command_type: "review_gate",
            cwd: payload.cwd,
            model: context.env.KIMI_PLUGIN_CC_REVIEW_GATE_MODEL ?? DEFAULT_REVIEW_GATE_MODEL,
            thinking: false,
            background: false,
            // review_gate runs inside Claude Code's Stop hook. Its companion lifecycle
            // is bounded by the hook itself, so recording pid here would let
            // signalJobProcesses() and sweepStaleJobs() SIGTERM the hook companion
            // mid-flight. kimi_pid is still recorded once the wire client starts, so
            // orphaned Kimi children remain reachable to the sweeper.
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
        client = buildWireClient({
            cwd: payload.cwd,
            env: context.env,
            sessionId: kimiSessionId,
            agentFile: agentProfile,
            model: context.env.KIMI_PLUGIN_CC_REVIEW_GATE_MODEL ?? DEFAULT_REVIEW_GATE_MODEL,
            thinking: false,
            logPath,
            approvalPolicy: rejectAllApprovals("review_gate is read-only; unexpected approval requests fail the command."),
        });
        try {
            const activeClient = client;
            const activeStore = store;
            const rendered = await withTimeout((async () => {
                await activeClient.start();
                activeStore.updateRunningJob(job.job_id, { kimi_pid: activeClient.getChildPid() });
                await activeClient.initialize({
                    protocol_version: KIMI_WIRE_PROTOCOL_VERSION,
                    client: { name: "kimi-plugin-cc", version: KIMI_PLUGIN_CC_VERSION },
                    capabilities: {
                        supports_question: false,
                        supports_plan_mode: false,
                    },
                });
                const completed = await activeClient.prompt(prompt, "review_gate");
                return renderManagedJobOutput(job, completed.finalText);
            })(), KIMI_REVIEW_GATE_TIMEOUT_MS, "review_gate.runtime");
            // Cancel-vs-completed race: /kimi:cancel pre-marks the row as
            // `cancelled` and SIGTERMs the kimi child. If the prompt managed to
            // return in the SIGTERM→exit window before our wire client picked
            // up the close, we'd overwrite the cancellation artifact and confuse
            // the hook's allow/block decision. Check the persisted status before
            // committing the success path. Mirrors the cancel-after-prompt
            // pattern already in ask/rescue/review.
            const persisted = activeStore.getJob(job.job_id);
            if (persisted && persisted.status !== "running") {
                throw new RuntimeError("REVIEW_GATE_CANCELLED", "review_gate cancelled before completion artifact was written.", "review_gate.runtime");
            }
            const artifactPath = await writeArtifact(paths, job, rendered.rendered);
            activeStore.markCompleted(job.job_id, {
                summary: rendered.summary,
                final_output_path: artifactPath,
                error: null,
            });
            return rendered.output;
        }
        catch (error) {
            const classified = classifyManagedCommandFailure(error, "review_gate", job.job_id);
            const summary = isTimeoutError(classified) ? "Review gate timed out." : "Review gate failed.";
            await markJobFailed(store, paths, job, classified, summary);
            throw classified;
        }
    }
    finally {
        await client?.close().catch(() => { });
        store?.close();
    }
}
function buildReviewGatePrompt(input) {
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
function buildBlockReason(output) {
    const issueLines = output.issues
        .slice(0, 5)
        .map((issue) => `- [${issue.severity}] ${issue.title}: ${issue.body}`);
    return [
        "Kimi review gate blocked stop. Revise the previous response before ending the turn.",
        `Summary: ${output.summary}`,
        ...(issueLines.length > 0 ? ["Issues:", ...issueLines] : []),
    ].join("\n");
}
function isTimeoutError(error) {
    return (error instanceof RuntimeError &&
        (error.code === "TIMEOUT" || error.code === "REVIEW_GATE_KIMI_TIMEOUT"));
}
function buildWarningMessage(error) {
    if (isTimeoutError(error)) {
        return "Kimi review gate timed out after 8s; allowing stop.";
    }
    if (error instanceof RuntimeError) {
        if (error.code === "REVIEW_GATE_PARSE_FAILED" ||
            error.code === "MISSING_TURN_END" ||
            error.code === "TURN_INTERRUPTED") {
            return "Kimi review gate returned malformed output; allowing stop.";
        }
        if (error.code === "WIRE_SPAWN_FAILED" ||
            error.code === "WIRE_PROCESS_EXITED" ||
            error.code === "WIRE_REQUEST_FAILED") {
            return "Kimi review gate is unavailable in this environment; allowing stop.";
        }
    }
    const warning = summarizeKimiAvailabilityWarning(error, "review_gate");
    if (warning) {
        return warning;
    }
    return "Kimi review gate failed unexpectedly; allowing stop.";
}
async function extractLastUserMessage(transcriptPath) {
    return scanTranscriptForLastRoleText(transcriptPath, "user");
}
async function extractLastAssistantMessage(transcriptPath) {
    return scanTranscriptForLastRoleText(transcriptPath, "assistant");
}
async function scanTranscriptForLastRoleText(transcriptPath, role) {
    if (!transcriptPath) {
        return null;
    }
    try {
        const raw = await readFile(expandHomeDir(transcriptPath), "utf8");
        let lastMatch = null;
        for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            let entry;
            try {
                entry = JSON.parse(trimmed);
            }
            catch {
                continue;
            }
            const extracted = extractRoleText(entry, role);
            if (extracted) {
                lastMatch = extracted;
            }
        }
        return lastMatch;
    }
    catch {
        return null;
    }
}
function extractRoleText(entry, role) {
    if (!isObject(entry)) {
        return null;
    }
    if (role === "user" &&
        entry.hook_event_name === "UserPromptSubmit" &&
        typeof entry.prompt === "string") {
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
function extractText(value) {
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (Array.isArray(value)) {
        const parts = value
            .map((part) => extractText(part))
            .filter((part) => Boolean(part));
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
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function expandHomeDir(filePath) {
    if (filePath === "~") {
        return os.homedir();
    }
    if (filePath.startsWith("~/")) {
        return path.join(os.homedir(), filePath.slice(2));
    }
    return filePath;
}
