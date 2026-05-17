import { access, stat, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { withJobStore } from "../job-store.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { renderManagedJobOutput } from "../render.js";
import { sweepStaleJobs } from "../jobs.js";
import { createTurnCapture, finalizeTurnCapture, observeTurnEvent, } from "../wire/turn-capture.js";
const MAX_REPLAY_LOG_BYTES = 32 * 1024 * 1024;
export async function runReplay(argv, context) {
    const [jobId, ...rest] = argv;
    if (!jobId || rest.length > 0) {
        throw new RuntimeError("INVALID_ARGS", "replay expects exactly one job id: replay <job-id>.", "replay.parse");
    }
    const paths = resolvePluginPaths(context.env);
    await ensurePluginPaths(paths);
    const repoIdentity = await resolveRepoIdentity(context.cwd);
    return withJobStore(paths, async (store) => {
        await sweepStaleJobs(store, paths);
        const job = store.getJob(jobId);
        if (!job || job.repo_id !== repoIdentity.repoId) {
            throw new RuntimeError("JOB_NOT_FOUND", `No job matched ${jobId} for replay.`, "replay.lookup");
        }
        const replayed = await replayJob(job);
        return `${replayed.rendered}${replayed.rendered.endsWith("\n") ? "" : "\n"}`;
    });
}
export async function replayJob(job) {
    if (!job.stream_log_path) {
        throw new RuntimeError("REPLAY_LOG_MISSING", `Job ${job.job_id} does not have a stored stream log path to replay.`, "replay.lookup");
    }
    try {
        await access(job.stream_log_path, fsConstants.R_OK);
    }
    catch {
        throw new RuntimeError("REPLAY_LOG_MISSING", `Job ${job.job_id} cannot be replayed because ${job.stream_log_path} is missing.`, "replay.lookup");
    }
    const stats = await stat(job.stream_log_path);
    if (stats.size > MAX_REPLAY_LOG_BYTES) {
        throw new RuntimeError("REPLAY_LOG_TOO_LARGE", `Job ${job.job_id} stream log is ${stats.size} bytes, which exceeds the ${MAX_REPLAY_LOG_BYTES}-byte replay ceiling.`, "replay.lookup");
    }
    const completedTurn = await replayCompletedTurn(job.stream_log_path);
    const rendered = renderManagedJobOutput(job, completedTurn.finalText);
    return {
        rendered: rendered.rendered,
        output: rendered.output,
        summary: rendered.summary,
    };
}
async function replayCompletedTurn(logPath) {
    const contents = await readFile(logPath, "utf8");
    const rawLines = contents.split("\n");
    const turn = createTurnCapture();
    let promptRequestId = null;
    let promptResult = null;
    for (let lineNumber = 0; lineNumber < rawLines.length; lineNumber += 1) {
        const line = rawLines[lineNumber].trim();
        if (!line) {
            continue;
        }
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch (error) {
            // A truncated final line is the expected shape when a worker was SIGKILL'd mid-write.
            // Silently drop it so replay still works on the preceding, consistent prefix.
            if (lineNumber === rawLines.length - 1) {
                continue;
            }
            throw new RuntimeError("REPLAY_LOG_INVALID", `Wire log ${logPath}:${lineNumber + 1} is malformed JSON: ${error.message}`, "replay.log", { cause: error });
        }
        if (entry.direction === "out") {
            const message = coerceWireObject(entry.message, logPath, lineNumber + 1);
            if (message.method === "prompt" && typeof message.id === "string") {
                promptRequestId = message.id;
            }
            continue;
        }
        if (entry.direction !== "in") {
            continue;
        }
        const message = coerceWireObject(entry.message, logPath, lineNumber + 1);
        if ("method" in message) {
            if (message.method === "event" && isEventPayload(message.params)) {
                observeTurnEvent(turn, message.params.type, message.params.payload);
            }
            continue;
        }
        if (promptRequestId &&
            message.id === promptRequestId &&
            isPromptResult(message.result)) {
            promptResult = message.result;
        }
    }
    if (!promptRequestId || !promptResult) {
        throw new RuntimeError("REPLAY_LOG_INVALID", `Wire log ${logPath} does not contain a replayable prompt result.`, "replay.log");
    }
    return finalizeTurnCapture(turn, promptResult);
}
function coerceWireObject(value, logPath, lineNumber) {
    let parsed;
    try {
        parsed = typeof value === "string" ? JSON.parse(value) : value;
    }
    catch (error) {
        throw new RuntimeError("REPLAY_LOG_INVALID", `Wire log ${logPath}:${lineNumber} message field is malformed JSON: ${error.message}`, "replay.log", { cause: error });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new RuntimeError("REPLAY_LOG_INVALID", `Wire log ${logPath}:${lineNumber} entry is not a JSON object.`, "replay.log");
    }
    return parsed;
}
function isEventPayload(value) {
    return (typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof value.type === "string" &&
        typeof value.payload === "object" &&
        value.payload !== null &&
        !Array.isArray(value.payload));
}
function isPromptResult(value) {
    return (typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof value.status === "string");
}
