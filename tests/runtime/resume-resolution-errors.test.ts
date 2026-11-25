import { describe, expect, test } from "bun:test";
import path from "node:path";

import { runAsk } from "../../runtime/commands/ask.js";
import { runRescue } from "../../runtime/commands/rescue.js";
import { resolveRepoIdentity } from "../../runtime/git.js";
import { JobStore } from "../../runtime/job-store.js";
import { ensurePluginPaths, resolvePluginPaths } from "../../runtime/paths.js";
import type { CommandContext } from "../../runtime/types.js";
import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";

const mockCliPath = path.join(process.cwd(), "tests/helpers/mock-kimi-cli-v1.ts");

const KINDS = [
  ["ask", "Ask", (argv: string[], context: CommandContext) => runAsk(argv, context)],
  ["rescue", "Rescue", (argv: string[], context: CommandContext) => runRescue(argv, context)],
] as const;

async function setup(label: string) {
  const pluginDataRoot = await createTestPluginDataRoot(label);
  const repoRoot = await createGitRepoFixture(`${label}-repo`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginDataRoot,
    KIMI_PLUGIN_CC_KIMI_BIN: "bun",
    KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["run", mockCliPath]),
    KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH: path.join(pluginDataRoot, "invocation.jsonl"),
    KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
  };
  const paths = resolvePluginPaths(env);
  await ensurePluginPaths(paths);
  const repoId = (await resolveRepoIdentity(repoRoot)).repoId;
  const context: CommandContext = { cwd: repoRoot, env, stdout: process.stdout, stderr: process.stderr };
  const seed = (kind: "ask" | "rescue", jobId: string, status: "running" | "completed", sessionId: string | null, updatedOrder: number) => {
    const store = new JobStore(paths);
    try {
      store.createJob({
        job_id: jobId, repo_id: repoId, command_type: kind, cwd: repoRoot, model: null, thinking: null,
        background: false, pid: null, kimi_pid: null, status, kimi_session_id: sessionId,
        operation_kind: kind, observed_engine: "legacy-v1", agent_profile: "<cli-client>", prompt_digest: "d",
        summary: `seed ${updatedOrder}`, final_output_path: null,
        stream_log_path: path.join(pluginDataRoot, `missing-${jobId}.jsonl`), error: null,
      });
    } finally {
      store.close();
    }
  };
  const cleanup = async () => {
    await cleanupTestPath(pluginDataRoot);
    await cleanupTestPath(repoRoot);
  };
  return { context, seed, cleanup };
}

describe("resume resolution errors", () => {
  test.each(KINDS)("%s pins codes, messages and stages", async (kind, label, run) => {
    const STEM = kind.toUpperCase();
    const { context, seed, cleanup } = await setup(`resume-errors-${kind}`);
    try {
      await expect(run(["-r"], context)).rejects.toMatchObject({
        code: `${STEM}_RESUME_NOT_FOUND`,
        message: `No prior ${kind} session exists for this repository.`,
        stage: `${kind}.resume`,
      });
      await expect(run(["--resume", "bogus-id"], context)).rejects.toMatchObject({
        code: `${STEM}_RESUME_NOT_FOUND`,
        message: `No ${kind} job or session matched bogus-id.`,
        stage: `${kind}.resume`,
      });

      // A terminal row without a session id is "not found" on both paths.
      seed(kind, `${kind}-nosession`, "completed", null, 1);
      await expect(run(["--resume", `${kind}-nosession`], context)).rejects.toMatchObject({
        code: `${STEM}_RESUME_NOT_FOUND`,
        message: `No ${kind} job or session matched ${kind}-nosession.`,
        stage: `${kind}.resume`,
      });
      await expect(run(["-r"], context)).rejects.toMatchObject({
        code: `${STEM}_RESUME_NOT_FOUND`,
        message: `No prior ${kind} session exists for this repository.`,
        stage: `${kind}.resume`,
      });

      // A job id of the other kind does not match.
      const other = kind === "ask" ? "rescue" : "ask";
      seed(other, `${other}-done`, "completed", `sess-${other}`, 2);
      await expect(run(["--resume", `${other}-done`], context)).rejects.toMatchObject({
        code: `${STEM}_RESUME_NOT_FOUND`,
        message: `No ${kind} job or session matched ${other}-done.`,
      });

      // Running rows report ALREADY_RUNNING before the session-id check, by job id, session id and -r.
      seed(kind, `${kind}-running`, "running", `sess-${kind}`, 3);
      for (const argv of [["--resume", `${kind}-running`], ["--resume", `sess-${kind}`], ["-r"]]) {
        await expect(run(argv, context)).rejects.toMatchObject({
          code: `${STEM}_ALREADY_RUNNING`,
          message: `${label} session sess-${kind} is already active under job ${kind}-running.`,
          stage: `${kind}.resume`,
        });
      }
      seed(kind, `${kind}-running-nosession`, "running", null, 4);
      await expect(run(["--resume", `${kind}-running-nosession`], context)).rejects.toMatchObject({
        code: `${STEM}_ALREADY_RUNNING`,
        message: `${label} session <unknown> is already active under job ${kind}-running-nosession.`,
        stage: `${kind}.resume`,
      });
    } finally {
      await cleanup();
    }
  });
});
