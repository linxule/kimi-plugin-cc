import { RuntimeError } from "../errors.js";
import { executeRescueJob } from "./rescue.js";
import { executeAskJob } from "./ask.js";
export async function runWorker(argv, context) {
    const [kind, jobId] = argv;
    if (!jobId || (kind !== "rescue" && kind !== "ask")) {
        throw new RuntimeError("INVALID_COMMAND", "worker expects the form: worker rescue <job-id> or worker ask <job-id>.", "worker");
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
    const encodedPrompt = context.env.KIMI_PLUGIN_CC_ASK_PROMPT_B64;
    if (!encodedPrompt) {
        throw new RuntimeError("MISSING_ASK_PROMPT", "Background ask prompt is missing.", "worker");
    }
    const prompt = Buffer.from(encodedPrompt, "base64").toString("utf8");
    const reusedSession = context.env.KIMI_PLUGIN_CC_ASK_REUSED_SESSION === "1";
    const encodedRawQuestion = context.env.KIMI_PLUGIN_CC_ASK_RAW_QUESTION_B64;
    const rawPrompt = encodedRawQuestion
        ? Buffer.from(encodedRawQuestion, "base64").toString("utf8")
        : undefined;
    await executeAskJob(jobId, prompt, context, { workerPid: process.pid, reusedSession, rawPrompt });
}
