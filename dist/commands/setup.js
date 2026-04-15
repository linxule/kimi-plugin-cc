import path from "node:path";
import { readPluginConfig, writePluginConfig } from "../config.js";
import { RuntimeError } from "../errors.js";
import { classifySetupFailure } from "../kimi-errors.js";
import { resolveKimiWireCommand } from "../kimi-launch.js";
import { KIMI_SETUP_INITIALIZE_TIMEOUT_MS, KIMI_SETUP_PROMPT_TIMEOUT_MS, withTimeout, } from "../kimi-timeouts.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { KIMI_PLUGIN_CC_VERSION } from "../version.js";
import { ApprovalDispatcher, rejectAllApprovals } from "../wire/approval-dispatcher.js";
import { WireClient } from "../wire/client.js";
export async function runSetup(argv, context) {
    const enableReviewGate = argv.includes("--enable-review-gate");
    const disableReviewGate = argv.includes("--disable-review-gate");
    if (enableReviewGate && disableReviewGate) {
        throw new RuntimeError("INVALID_FLAGS", "setup accepts either --enable-review-gate or --disable-review-gate, not both.", "setup");
    }
    const paths = resolvePluginPaths(context.env);
    await ensurePluginPaths(paths);
    const existingConfig = await readPluginConfig(paths);
    const reviewGateEnabled = enableReviewGate ? true : disableReviewGate ? false : existingConfig.reviewGateEnabled;
    if (reviewGateEnabled !== existingConfig.reviewGateEnabled) {
        await writePluginConfig(paths, { reviewGateEnabled });
    }
    const logPath = path.join(paths.logsDir, `setup-${Date.now()}.jsonl`);
    // Resolve the same kimi binary + prefix args that the managed commands honor, so setup
    // validates the exact launch path /kimi:ask and /kimi:rescue will use. Otherwise an
    // installed plugin could probe an ambient `kimi` while the real commands miss the
    // configured binary.
    const { command: kimiCommand, prefixArgs: kimiPrefixArgs } = resolveKimiWireCommand(context.env);
    const wireClient = new WireClient({
        cwd: context.cwd,
        env: context.env,
        command: kimiCommand,
        args: [...kimiPrefixArgs, "--wire"],
        logPath,
        approvalDispatcher: new ApprovalDispatcher(rejectAllApprovals("setup does not permit tool approvals; runtime probe failed.")),
    });
    try {
        await wireClient.start();
        const initializeResult = await withTimeout(wireClient.initialize({
            protocol_version: "1.9",
            client: {
                name: "kimi-plugin-cc",
                version: KIMI_PLUGIN_CC_VERSION,
            },
            capabilities: {
                supports_question: false,
                supports_plan_mode: false,
            },
        }), KIMI_SETUP_INITIALIZE_TIMEOUT_MS, "setup.initialize");
        const completedTurn = await withTimeout(wireClient.prompt("Reply with the single word READY. Do not use tools.", "setup"), KIMI_SETUP_PROMPT_TIMEOUT_MS, "setup.prompt");
        const reply = completedTurn.finalText.trim();
        if (!reply) {
            throw new RuntimeError("EMPTY_SETUP_REPLY", "Kimi runtime returned an empty final reply during setup probe.", "setup.prompt");
        }
        return {
            summary: "Kimi runtime is ready.",
            runtimeProbe: "ok",
            authProbe: "ok",
            reviewGateEnabled,
            nextStep: "Proceed to /kimi:review, /kimi:ask, or /kimi:rescue. Enable the review gate with /kimi:setup --enable-review-gate.",
            details: [
                `Companion runtime: Node ${process.version}`,
                `Wire server: ${initializeResult.server.name} ${initializeResult.server.version}`,
                `Wire protocol: ${initializeResult.protocol_version}`,
                `Setup probe reply: ${JSON.stringify(reply)}`,
                `Review gate: ${reviewGateEnabled ? "enabled" : "disabled"}`,
                `Wire log: ${logPath}`,
            ],
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const details = [
            `Review gate: ${reviewGateEnabled ? "enabled" : "disabled"}`,
            `Wire log: ${logPath}`,
            `Probe error: ${message}`,
        ];
        const classified = classifySetupFailure(error);
        if (classified) {
            return {
                summary: classified.kind === "auth_unavailable"
                    ? "Kimi is installed, but the authentication or model configuration is not usable yet."
                    : classified.kind === "binary_unavailable"
                        ? "Kimi is not installed or not executable from this environment."
                        : classified.kind === "timeout"
                            ? "Kimi is installed, but the setup probe did not complete within the expected time budget."
                            : "Kimi could not start a usable Wire session from this environment.",
                runtimeProbe: classified.runtimeProbe,
                authProbe: classified.authProbe,
                reviewGateEnabled,
                nextStep: classified.nextStep,
                details,
            };
        }
        throw error;
    }
    finally {
        await wireClient.close();
    }
}
export function renderSetupResult(result) {
    return [
        result.summary,
        "",
        `Runtime probe: ${result.runtimeProbe}`,
        `Auth probe: ${result.authProbe}`,
        `Review gate: ${result.reviewGateEnabled ? "enabled" : "disabled"}`,
        "",
        "Details:",
        ...result.details.map((detail) => `- ${detail}`),
        "",
        `Next step: ${result.nextStep}`,
    ].join("\n");
}
