import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { sweepStaleJobs } from "../jobs.js";
import { withJobStore, type JobRecord } from "../job-store.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { parseJobLookupArgs } from "../parsing.js";
import { readArtifact, renderTerminalJobArtifact } from "../render.js";
import type { CommandContext } from "../types.js";

export async function runResult(argv: string[], context: CommandContext): Promise<string> {
  const parsed = parseJobLookupArgs(argv);
  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);
  const repoIdentity = await resolveRepoIdentity(context.cwd);

  return withJobStore(paths, async (store) => {
    await sweepStaleJobs(store, paths);

    const job = parsed.jobId
      ? store.getJob(parsed.jobId)
      : store.findLatestJob({
          repoId: repoIdentity.repoId,
          commandType: parsed.type,
          terminalOnly: true,
        });

    if (!job) {
      throw new RuntimeError("JOB_NOT_FOUND", "No matching terminal job was found for result.", "result.lookup");
    }

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

function renderResultEnvelope(
  job: JobRecord,
  artifactPath: string | null,
  body: string,
): string {
  return `${JSON.stringify(
    {
      job_id: job.job_id,
      kind: job.command_type,
      status: job.status,
      summary: job.summary,
      error: job.error,
      artifact_path: artifactPath,
      body,
      created_at: job.created_at,
      completed_at: job.updated_at,
    },
    null,
    2,
  )}\n`;
}
