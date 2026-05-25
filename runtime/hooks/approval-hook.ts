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
// Hook protocol (kimi-code agent-core/src/agent/hooks/runner.ts):
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
//   kimi-code spawns this hook with `shell: true` (see runner.ts:48).
//   The TOML command is parsed by `/bin/sh -c "..."` so the resolved
//   `node /abs/path/...` works regardless of where it's invoked from.

import { decideHookOutcome, type HookInput } from "./approval-policy.js";
import { evaluateRescueHookRequest } from "../rescue-approval.js";

const STDIN_TIMEOUT_MS = 5_000;

async function main(): Promise<void> {
  const stdinText = await readStdinWithTimeout(STDIN_TIMEOUT_MS);

  let input: HookInput;
  try {
    const parsed = JSON.parse(stdinText);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("hook payload must be a JSON object");
    }
    input = parsed as HookInput;
  } catch (err) {
    failClosed(`stdin was not a JSON object: ${formatErr(err)}`);
    return;
  }

  const decision = await decideHookOutcome(input, {
    commandLabel: process.env.KIMI_PLUGIN_CC_CMD,
    rescueEvaluator: evaluateRescueHookRequest,
  });

  if (decision.decision === "deny") {
    // stderr.trim() in runner.ts:118 becomes the model-visible reason.
    process.stderr.write(`${decision.reason ?? "denied"}\n`);
    process.exit(2);
    return;
  }

  process.exit(0);
}

function failClosed(reason: string): void {
  process.stderr.write(`kimi-plugin-cc safety hook misconfigured: ${reason}\n`);
  process.exit(2);
}

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readStdinWithTimeout(timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buf = "";
    let settled = false;

    const finish = (value: string | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (value instanceof Error) reject(value);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      finish(new Error(`stdin did not close within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();

    try {
      process.stdin.setEncoding("utf8");
    } catch {
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
