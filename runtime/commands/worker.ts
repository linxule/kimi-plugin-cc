import { RuntimeError } from "../errors.js";
import type { CommandContext } from "../types.js";
import { executeRescueJob } from "./rescue.js";

export async function runWorker(argv: string[], context: CommandContext): Promise<void> {
  const [kind, jobId] = argv;

  if (kind !== "rescue" || !jobId) {
    throw new RuntimeError(
      "INVALID_COMMAND",
      "worker expects the form: worker rescue <job-id>.",
      "worker",
    );
  }

  const encodedPrompt = context.env.KIMI_PLUGIN_CC_RESCUE_PROMPT_B64;
  if (!encodedPrompt) {
    throw new RuntimeError("MISSING_RESCUE_PROMPT", "Background rescue prompt is missing.", "worker");
  }

  const prompt = Buffer.from(encodedPrompt, "base64").toString("utf8");
  const reusedSession = context.env.KIMI_PLUGIN_CC_RESCUE_REUSED_SESSION === "1";
  await executeRescueJob(jobId, prompt, context, { workerPid: process.pid, reusedSession });
}
