import { RuntimeError } from "../errors.js";
import type { CommandContext } from "../types.js";
import { executeRescueJob } from "./rescue.js";
import { executeAskJob } from "./ask.js";

export async function runWorker(argv: string[], context: CommandContext): Promise<void> {
  const [kind, jobId] = argv;

  if (!jobId || (kind !== "rescue" && kind !== "ask")) {
    throw new RuntimeError(
      "INVALID_COMMAND",
      "worker expects the form: worker rescue <job-id> or worker ask <job-id>.",
      "worker",
    );
  }

  if (kind === "rescue") {
    const encodedPrompt = context.env.KIMI_PLUGIN_CC_RESCUE_PROMPT_B64;
    if (!encodedPrompt) {
      throw new RuntimeError("MISSING_RESCUE_PROMPT", "Background rescue prompt is missing.", "worker");
    }
    const prompt = Buffer.from(encodedPrompt, "base64").toString("utf8");
    const reusedSession = context.env.KIMI_PLUGIN_CC_RESCUE_REUSED_SESSION === "1";
    await executeRescueJob(jobId, prompt, context, { workerPid: process.pid, reusedSession });
    return;
  }

  // kind === "ask"
  //
  // v1.0 note: the ask worker no longer threads `reusedSession` or
  // `rawPrompt` into executeAskJob — both were inputs to v0.4's
  // `announceSessionTitle`, which is gone (kimi-web has no PATCH
  // endpoint). The base64-encoded prompt + job id are sufficient.
  const encodedPrompt = context.env.KIMI_PLUGIN_CC_ASK_PROMPT_B64;
  if (!encodedPrompt) {
    throw new RuntimeError("MISSING_ASK_PROMPT", "Background ask prompt is missing.", "worker");
  }
  const prompt = Buffer.from(encodedPrompt, "base64").toString("utf8");
  await executeAskJob(jobId, prompt, context, { workerPid: process.pid });
}
