import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { sweepStaleJobs } from "../jobs.js";
import { reconcileHistoricalJobProvenance } from "../kimi-engine.js";
import { withJobStore } from "../job-store.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { parseJobLookupArgs } from "../parsing.js";
import { readArtifact, renderTerminalJobArtifact } from "../render.js";
export async function runResult(argv, context) {
    const parsed = parseJobLookupArgs(argv);
    const paths = resolvePluginPaths(context.env);
    await ensurePluginPaths(paths);
    const repoIdentity = await resolveRepoIdentity(context.cwd);
    return withJobStore(paths, async (store) => {
        await sweepStaleJobs(store, paths);
        const found = parsed.jobId
            ? store.getJob(parsed.jobId)
            : store.findLatestJob({
                repoId: repoIdentity.repoId,
                commandType: parsed.type,
                terminalOnly: true,
            });
        if (!found) {
            throw new RuntimeError("JOB_NOT_FOUND", "No matching terminal job was found for result.", "result.lookup");
        }
        const job = await reconcileHistoricalJobProvenance(store, found);
        if (job.status === "running") {
            // `result --json` preserves the existing result contract: callers only
            // receive terminal artifacts, never a partial/running envelope.
            throw new RuntimeError("JOB_NOT_TERMINAL", `Job ${job.job_id} is still running.`, "result.lookup");
        }
        if (!job.final_output_path) {
            const fallbackBody = `${renderTerminalJobArtifact(job)}\n`;
            return parsed.json ? renderResultEnvelope(job, null, fallbackBody) : fallbackBody;
        }
        const body = await readArtifact(job.final_output_path);
        return parsed.json ? renderResultEnvelope(job, job.final_output_path, body) : body;
    });
}
function renderResultEnvelope(job, artifactPath, body) {
    return `${JSON.stringify({
        job_id: job.job_id,
        kind: job.command_type,
        status: job.status,
        summary: job.summary,
        error: job.error,
        artifact_path: artifactPath,
        body,
        created_at: job.created_at,
        completed_at: job.updated_at,
        operation_kind: job.operation_kind,
        intended_engine: job.intended_engine,
        observed_engine: job.observed_engine,
        kimi_version: job.kimi_version,
        system_version: job.system_version,
        resumed_from_job_id: job.resumed_from_job_id,
    }, null, 2)}\n`;
}
