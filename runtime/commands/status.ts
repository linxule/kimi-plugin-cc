import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { sweepStaleJobs } from "../jobs.js";
import { withJobStore } from "../job-store.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { parseJobLookupArgs } from "../parsing.js";
import type { CommandContext } from "../types.js";

export async function runStatus(argv: string[], context: CommandContext): Promise<string> {
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
        });

    if (!job) {
      throw new RuntimeError("JOB_NOT_FOUND", "No matching job was found for status.", "status.lookup");
    }

    return `${JSON.stringify(job, null, 2)}\n`;
  });
}
