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

import { fileURLToPath } from "node:url";

import { decideHookOutcome, type HookInput } from "./approval-policy.js";
import { hookAbstainsForJob, JOB_HOST_ENV, ownHookHostIds } from "./job-host.js";
import { NETWORK_ENV, READ_ROOTS_ENV } from "../read-scope.js";
import { evaluateRescueHookRequest } from "../rescue-approval.js";
import { SWARM_POLICY_ENV, SWARM_WAVE_SIZE_ENV } from "../swarm-policy.js";

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

  // Another host launched this job: emit no decision, exactly like a call with
  // no plugin label. This adds no unguarded case. The launching runtime exports
  // KIMI_PLUGIN_CC_JOB_HOST on the same spawn that sets the labels, and only
  // after `verifyHookInstalled` proved its own host's block installed,
  // enforcing and byte-exact, so that hook (whose id matches) still decides.
  // Under KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1 the runtime deletes the variable and
  // every hook enforces as before. An unknown own identity enforces.
  if (hookAbstainsForJob(process.env[JOB_HOST_ENV], ownIdentity())) {
    process.exit(0);
    return;
  }

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

function ownIdentity(): string[] {
  try {
    return ownHookHostIds([process.argv[1], fileURLToPath(import.meta.url)]);
  } catch {
    return [];
  }
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
