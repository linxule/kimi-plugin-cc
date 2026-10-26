import { RuntimeError } from "../errors.js";
import { resolveRepoIdentity } from "../git.js";
import { sweepStaleJobs } from "../jobs.js";
import { reconcileHistoricalJobProvenance } from "../kimi-engine.js";
import { parseHookEscapes, renderBudgetSource, withJobStore } from "../job-store.js";
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

    const found = parsed.jobId
      ? store.getJob(parsed.jobId)
      : store.findLatestJob({
          repoId: repoIdentity.repoId,
          commandType: parsed.type,
        });

    if (!found) {
      throw new RuntimeError("JOB_NOT_FOUND", "No matching job was found for status.", "status.lookup");
    }

    const job = await reconcileHistoricalJobProvenance(store, found);

    return `${JSON.stringify({ ...job, swarm_recovery: store.getSwarmRecovery(job.job_id)?.record ?? null, thinking_effort_requested: job.thinking_effort ?? null, hook_escapes: parseHookEscapes(job.hook_escapes), budget_source: renderBudgetSource(job) }, null, 2)}\n`;
  });
}
