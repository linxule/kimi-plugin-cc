import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveRepoIdentity } from "../git.js";
import { digestPrompt, markJobFailed } from "../jobs.js";
import { JobStore } from "../job-store.js";
import { buildWireClient, resolveAgentFile } from "../kimi-launch.js";
import { KIMI_ASK_PROMPT_TIMEOUT_MS, KIMI_INITIALIZE_TIMEOUT_MS, KIMI_START_TIMEOUT_MS, withTimeout, } from "../kimi-timeouts.js";
import { writeInvocationLogHeader } from "../logging.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { parseAskArgs } from "../parsing.js";
import { renderManagedJobOutput, writeArtifact } from "../render.js";
import { KIMI_PLUGIN_CC_VERSION } from "../version.js";
import { rejectAllApprovals } from "../wire/approval-dispatcher.js";
import { classifyManagedCommandFailure } from "../kimi-errors.js";
export async function runAsk(argv, context) {
    const parsed = parseAskArgs(argv);
    const paths = resolvePluginPaths(context.env);
    await ensurePluginPaths(paths);
    const repoIdentity = await resolveRepoIdentity(context.cwd);
    const store = new JobStore(paths);
    const jobId = randomUUID();
    const kimiSessionId = randomUUID();
    const logPath = path.join(paths.logsDir, `ask-${jobId}.jsonl`);
    const agentProfile = resolveAgentFile("runtime/agents/ask.yaml");
    const job = store.createJob({
        job_id: jobId,
        repo_id: repoIdentity.repoId,
        command_type: "ask",
        cwd: context.cwd,
        model: parsed.model ?? null,
        thinking: parsed.thinking ?? null,
        background: false,
        pid: null,
        kimi_pid: null,
        status: "running",
        kimi_session_id: kimiSessionId,
        agent_profile: agentProfile,
        prompt_digest: digestPrompt(parsed.prompt),
        summary: "Running ask.",
        final_output_path: null,
        stream_log_path: logPath,
        error: null,
    });
    await writeInvocationLogHeader(logPath, {
        commandType: "ask",
        kimiSessionId,
        cwd: context.cwd,
    });
    const client = buildWireClient({
        cwd: context.cwd,
        env: context.env,
        sessionId: kimiSessionId,
        agentFile: agentProfile,
        model: parsed.model,
        thinking: parsed.thinking,
        logPath,
        approvalPolicy: rejectAllApprovals("ask is read-only; approval requests fail the command."),
    });
    try {
        await withTimeout(client.start(), KIMI_START_TIMEOUT_MS, "ask.start");
        store.updateRunningJob(job.job_id, { kimi_pid: client.getChildPid() });
        await withTimeout(client.initialize({
            protocol_version: "1.9",
            client: { name: "kimi-plugin-cc", version: KIMI_PLUGIN_CC_VERSION },
            capabilities: {
                supports_question: false,
                supports_plan_mode: false,
            },
        }), KIMI_INITIALIZE_TIMEOUT_MS, "ask.initialize");
        const completed = await withTimeout(client.prompt(buildAskPrompt(parsed.prompt), "ask"), KIMI_ASK_PROMPT_TIMEOUT_MS, "ask.prompt");
        const rendered = renderManagedJobOutput(job, completed.finalText);
        const artifactPath = await writeArtifact(paths, job, rendered.rendered);
        store.markCompleted(job.job_id, {
            summary: rendered.summary,
            final_output_path: artifactPath,
            error: null,
        });
        return rendered.output;
    }
    catch (error) {
        const classified = classifyManagedCommandFailure(error, "ask", job.job_id);
        await markJobFailed(store, paths, job, classified, "Ask failed.");
        throw classified;
    }
    finally {
        await client.close();
        store.close();
    }
}
function buildAskPrompt(question) {
    return [
        "Answer the user's question directly in free-form prose.",
        "Stay read-only.",
        "Do not emit JSON unless the user explicitly asks for it.",
        "",
        "User question:",
        question,
    ].join("\n");
}
