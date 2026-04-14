import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { sweepStaleBackgroundJobs } from "../jobs.js";
import { JobStore } from "../job-store.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { parseJobLookupArgs } from "../parsing.js";
import { readArtifact, renderTerminalJobArtifact } from "../render.js";
import type { CommandContext } from "../types.js";

export async function runResult(argv: string[], context: CommandContext): Promise<string> {
  const parsed = parseJobLookupArgs(argv);
  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);
  const repoIdentity = await resolveRepoIdentity(context.cwd);
  const store = new JobStore(paths);

  try {
    await sweepStaleBackgroundJobs(store, paths);

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
      throw new RuntimeError("JOB_NOT_TERMINAL", `Job ${job.job_id} is still running.`, "result.lookup");
    }

    if (!job.final_output_path) {
      return `${renderTerminalJobArtifact(job)}\n`;
    }

    return readArtifact(job.final_output_path);
  } finally {
    store.close();
  }
}
