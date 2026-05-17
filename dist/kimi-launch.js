import { fileURLToPath } from "node:url";
import path from "node:path";
import { ApprovalDispatcher } from "./wire/approval-dispatcher.js";
import { WireClient } from "./wire/client.js";
import { RuntimeError } from "./errors.js";
import { withTimeout } from "./kimi-timeouts.js";
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
        thinkStallMs: resolveThinkStallMs(options.env),
    });
}
/**
 * Resolve the think-stall watchdog threshold from env. Accepts
 * `KIMI_PLUGIN_CC_THINK_STALL_MS` (positive integer, 0 to disable, falls
 * back to the WireClient default of 120s when unset or unparseable).
 */
function resolveThinkStallMs(env) {
    const raw = env.KIMI_PLUGIN_CC_THINK_STALL_MS;
    if (!raw) {
        return undefined;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return undefined;
    }
    return Math.floor(parsed);
}
/**
 * Build a WireClient and start it, with one automatic retry on start-timeout.
 *
 * On attempt 1: builds a new WireClient, calls client.start() wrapped with
 * withTimeout(). If that succeeds, returns the client.
 *
 * On a TIMEOUT RuntimeError whose stage matches `stage`: closes the first
 * client (awaited, errors swallowed) and retries exactly once (attempt 2).
 * If attempt 2 also fails — for any reason — the error is re-thrown.
 *
 * Non-timeout errors (spawn failures, auth errors, etc.) are re-thrown
 * immediately after attempt 1 without retrying.
 *
 * Signal handling: SIGTERM/SIGINT handlers SHOULD be registered by the caller
 * BEFORE calling this helper. Pass `shouldRetry: () => !cancelling` so the
 * helper skips its retry window if the user has cancelled during startup.
 * Callers must also check their cancellation flag after this helper returns
 * successfully, because a signal can fire during the brief window between the
 * first attempt succeeding and the caller regaining control.
 *
 * Escape hatch: set KIMI_PLUGIN_CC_DISABLE_START_RETRY=1 in the environment
 * to disable the retry entirely (useful for tests that need strict
 * single-attempt behavior or for users who want deterministic failure).
 */
export async function buildAndStartWireClient(options, startTimeoutMs, stage, retryOptions) {
    return buildAndStartWithFactory(() => buildWireClient(options), options.env, startTimeoutMs, stage, retryOptions);
}
/**
 * Internal implementation that accepts a client factory.
 * Exported for unit testing only — production code should use buildAndStartWireClient.
 */
export async function buildAndStartWithFactory(factory, env, startTimeoutMs, stage, retryOptions) {
    const retryDisabled = env.KIMI_PLUGIN_CC_DISABLE_START_RETRY === "1";
    // Attempt 1
    const client1 = factory();
    try {
        await withTimeout(client1.start(), startTimeoutMs, stage, "startup");
        return client1;
    }
    catch (err) {
        // Always clean up the first process regardless of error type. The
        // WireClient.closed flag ensures any in-flight spawn will be killed even
        // if close() returns before this.child is assigned.
        await client1.close().catch(() => { });
        // Only retry on startup timeouts from this specific stage; re-throw everything else.
        // v0.3.0 changed the code from generic TIMEOUT to STARTUP_TIMEOUT; accept both
        // so a stale Kimi binary that still emits the legacy code keeps working.
        if (retryDisabled ||
            !(err instanceof RuntimeError) ||
            (err.code !== "STARTUP_TIMEOUT" && err.code !== "TIMEOUT") ||
            err.stage !== stage) {
            throw err;
        }
        // Caller-controlled retry gate: e.g., skip the retry if the user has
        // cancelled during the first attempt. Preserves the original timeout
        // error for downstream classification.
        if (retryOptions?.shouldRetry && !retryOptions.shouldRetry()) {
            throw err;
        }
    }
    // Attempt 2 (timeout retry only)
    const client2 = factory();
    try {
        await withTimeout(client2.start(), startTimeoutMs, stage, "startup");
        return client2;
    }
    catch (err) {
        await client2.close().catch(() => { });
        throw err;
    }
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
