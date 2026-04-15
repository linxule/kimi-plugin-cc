import { fileURLToPath } from "node:url";
import path from "node:path";
import { ApprovalDispatcher } from "./wire/approval-dispatcher.js";
import { WireClient } from "./wire/client.js";
export function buildWireClient(options) {
    const { command, prefixArgs } = resolveKimiWireCommand(options.env);
    const args = [
        ...prefixArgs,
        "--wire",
        "--session",
        options.sessionId,
        "--agent-file",
        options.agentFile,
        ...(options.model ? ["--model", options.model] : []),
        ...(options.thinking === undefined ? [] : [options.thinking ? "--thinking" : "--no-thinking"]),
    ];
    return new WireClient({
        cwd: options.cwd,
        env: options.env,
        command,
        args,
        logPath: options.logPath,
        approvalDispatcher: new ApprovalDispatcher(options.approvalPolicy),
    });
}
const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function resolveAgentFile(relativePath) {
    return path.join(runtimeRoot, relativePath);
}
export function resolveKimiWireCommand(env) {
    const command = env.KIMI_PLUGIN_CC_KIMI_BIN || "kimi";
    const rawPrefixArgs = env.KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS;
    if (!rawPrefixArgs) {
        return { command, prefixArgs: [] };
    }
    try {
        const parsed = JSON.parse(rawPrefixArgs);
        if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
            return { command, prefixArgs: parsed };
        }
    }
    catch {
        return { command, prefixArgs: rawPrefixArgs.split(" ").filter(Boolean) };
    }
    return { command, prefixArgs: [] };
}
