#!/usr/bin/env node
// Entry script for the kimi-code PreToolUse hook.
//
// Installed by /kimi:setup as a managed block in ~/.kimi-code/config.toml:
//
//   [[hooks]]
//   event = "PreToolUse"
//   command = "'/abs/path/to/node' '/abs/path/to/dist/hooks/approval-hook.js'"
//   timeout = 15
//
// Hook protocol:
//
//   stdin:  full hook payload as JSON
//   stdout: optional structured JSON (only consulted when exit code is 0)
//   stderr: free-form reason
//   exit 0: allow (with optional structured override)
//   exit 2: deny — `stderr.trim()` becomes the reason surfaced to the model
//   any other exit code: fall through to allow (fail-open)
//
// Exit 2 + stderr avoids structured-output version-skew hazards, and the
// runner short-circuits it before reading structured output. Because any other
// exit fails open upstream, every code path here is wrapped so an unexpected
// error exits 2 with a "hook misconfigured" reason instead.
//
// kimi-code spawns the command with `shell: true`. The canonical command is two
// shell-quoted absolute tokens — the resolved Node binary and hook script — so
// `/bin/sh -c` does not depend on its working directory or PATH.
import { decideHookOutcome } from "./approval-policy.js";
import { HOOK_DECISION_DEADLINE_MS, HOOK_TEST_DELAY_ENV } from "./hook-timing.js";
import { NETWORK_ENV, READ_ROOTS_ENV } from "../read-scope.js";
import { evaluateRescueHookRequest } from "../rescue-approval.js";
import { SWARM_POLICY_ENV, SWARM_WAVE_SIZE_ENV } from "../swarm-policy.js";
const STDIN_TIMEOUT_MS = 5_000;
async function main() {
    armDecisionDeadline();
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
    await testOnlyDelay(process.env[HOOK_TEST_DELAY_ENV]);
    const decision = await decideHookOutcome(input, {
        commandLabel: process.env.KIMI_PLUGIN_CC_CMD,
        operationKind: process.env.KIMI_PLUGIN_CC_OPERATION,
        swarmPolicy: process.env[SWARM_POLICY_ENV],
        swarmWaveSize: process.env[SWARM_WAVE_SIZE_ENV],
        rescueEvaluator: evaluateRescueHookRequest,
        // Trusted root for rescue/pursue/swarm-write. Set by the plugin spawn; the
        // model inside kimi cannot forge it and hook payload cwd is not trusted.
        trustedWorkspaceRoot: process.env.KIMI_PLUGIN_CC_WORKSPACE_ROOT,
        // Per-call read scope, set or deleted by the plugin on every spawn.
        readRoots: process.env[READ_ROOTS_ENV],
        network: process.env[NETWORK_ENV],
    });
    if (decision.decision === "deny") {
        // stderr.trim() in runner.ts:118 becomes the model-visible reason.
        process.stderr.write(`${decision.reason ?? "denied"}\n`);
        process.exit(2);
        return;
    }
    process.exit(0);
}
/**
 * A timed-out hook is ALLOW upstream, so a labelled call that has not decided
 * within HOOK_DECISION_DEADLINE_MS (below the installed timeout) denies. The
 * timer is unref'd so it never keeps a decided process alive; a stall with
 * nothing pending would then drain the loop and exit 0, so `beforeExit`
 * denies too. Every decision path exits explicitly before either fires.
 * Unlabelled calls are out-of-plugin use and keep their exit-0 behaviour.
 */
function armDecisionDeadline() {
    const label = process.env.KIMI_PLUGIN_CC_CMD;
    if (label === undefined || label.length === 0)
        return;
    const reason = `kimi-plugin-cc safety hook: no decision within ${HOOK_DECISION_DEADLINE_MS / 1000}s; ` +
        "the tool call is denied because a hook that times out would be read as allow.";
    setTimeout(() => {
        process.stderr.write(`${reason}\n`);
        process.exit(2);
    }, HOOK_DECISION_DEADLINE_MS).unref();
    process.once("beforeExit", () => {
        process.stderr.write(`${reason}\n`);
        process.exit(2);
    });
}
async function testOnlyDelay(value) {
    if (value === undefined || value.length === 0)
        return;
    if (value === "hang") {
        await new Promise(() => { });
        return;
    }
    const ms = Number(value);
    if (Number.isSafeInteger(ms) && ms > 0)
        await new Promise((resolve) => setTimeout(resolve, ms));
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
