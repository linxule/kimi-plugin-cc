#!/usr/bin/env node
// Entry script for the kimi-code PreToolUse hook.
//
// Installed by /kimi:setup as a managed block in ~/.kimi-code/config.toml:
//
//   [[hooks]]
//   event = "PreToolUse"
//   command = "node /abs/path/to/dist/hooks/approval-hook.js"
//   timeout = 15
//
// Hook protocol (kimi-code agent-core/src/session/hooks/runner.ts —
// path was agent/hooks/ in 0.4.0 and earlier; relocated to session/hooks/
// in 0.5.0 with byte-identical file contents):
//
//   stdin:  full hook payload as JSON
//   stdout: optional structured JSON (only consulted when exit code is 0)
//   stderr: free-form reason
//   exit 0: allow (with optional structured override)
//   exit 2: deny — `stderr.trim()` becomes the reason surfaced to the model
//   any other exit code: fall through to allow (fail-open)
//
// We use exit-code signaling rather than structured JSON because:
//
//   1. Exit 2 + stderr is the simpler contract — fewer surfaces for a
//      version skew between us and kimi-code to break safety.
//   2. The runner short-circuits exit-2 before structuredOutput() is
//      called, so emitting both would be redundant.
//   3. A crash in our hook would normally exit non-zero and silently
//      allow (fail-open). We compensate by wrapping every code path in
//      try/catch and exiting 2 with a "hook misconfigured" reason on
//      any unexpected error.
//
// Process boundary:
//
//   kimi-code spawns this hook with `shell: true` (see runner.ts:46-53,
//   where `spawn(command, { shell: true, ... })` is invoked).
//   The TOML command is parsed by `/bin/sh -c "..."` so the resolved
//   `node /abs/path/...` works regardless of where it's invoked from.
import { decideHookOutcome } from "./approval-policy.js";
import { evaluateRescueHookRequest } from "../rescue-approval.js";
const STDIN_TIMEOUT_MS = 5_000;
async function main() {
    const stdinText = await readStdinWithTimeout(STDIN_TIMEOUT_MS);
    let input;
    try {
        const parsed = JSON.parse(stdinText);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("hook payload must be a JSON object");
        }
        input = parsed;
    }
    catch (err) {
        failClosed(`stdin was not a JSON object: ${formatErr(err)}`);
        return;
    }
    const decision = await decideHookOutcome(input, {
        commandLabel: process.env.KIMI_PLUGIN_CC_CMD,
        rescueEvaluator: evaluateRescueHookRequest,
        // Trusted worktree root for the swarm-write label (v1.4). Set by the plugin
        // spawn; the model inside kimi cannot forge it. Unused by other labels.
        swarmWriteWorkspaceRoot: process.env.KIMI_PLUGIN_CC_WORKSPACE_ROOT,
    });
    if (decision.decision === "deny") {
        // stderr.trim() in runner.ts:118 becomes the model-visible reason.
        process.stderr.write(`${decision.reason ?? "denied"}\n`);
        process.exit(2);
        return;
    }
    process.exit(0);
}
function failClosed(reason) {
    process.stderr.write(`kimi-plugin-cc safety hook misconfigured: ${reason}\n`);
    process.exit(2);
}
function formatErr(err) {
    return err instanceof Error ? err.message : String(err);
}
function readStdinWithTimeout(timeoutMs) {
    return new Promise((resolve, reject) => {
        let buf = "";
        let settled = false;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (value instanceof Error)
                reject(value);
            else
                resolve(value);
        };
        const timer = setTimeout(() => {
            finish(new Error(`stdin did not close within ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref();
        try {
            process.stdin.setEncoding("utf8");
        }
        catch {
            // some test harnesses pre-encode; fine to ignore
        }
        process.stdin.on("data", (chunk) => {
            buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        });
        process.stdin.on("end", () => finish(buf));
        process.stdin.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
    });
}
main().catch((err) => {
    failClosed(`uncaught error: ${formatErr(err)}`);
});
