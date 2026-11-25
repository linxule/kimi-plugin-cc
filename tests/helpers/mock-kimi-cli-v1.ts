// v1.0 cli-client mock — drop-in replacement for tests/helpers/mock-kimi-cli.ts
// that emits `kimi -p --output-format stream-json` output instead of v0.4
// wire JSON-RPC. Used by ported tests for ask / review / challenge /
// review_gate. Rescue (PR 3) still uses the v0.4 mock until rescue is ported.
//
// Scenario surface mirrors mock-kimi-cli.ts so test files migrate by
// pointing `KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS` at this file instead.
// Scenarios that don't map cleanly (e.g. rescue-approval flows) are
// stubbed with a clear error so we catch test drift loudly.
//
// Output protocol per stream-json (kimi-code apps/kimi-code/src/cli/run-prompt.ts):
//   - stdout: one JSON object per line
//   - stderr (final line, before exit): "To resume this session: kimi -r <uuid>\n"
//   - exit 0 on success
//
// The mock honors the same scenario env vars as the v0.4 mock so tests
// can switch transports by changing one path:
//
//   KIMI_PLUGIN_CC_MOCK_SCENARIO      ask-success / review-success / review-gate-* / etc.
//   KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH  optional path where argv is logged
//   KIMI_PLUGIN_CC_MOCK_DELAY_MS      delay before emitting records (cancellation tests)
//   KIMI_PLUGIN_CC_MOCK_SESSION_ID    override session id announced in stderr

import { decideHookOutcome } from "../../runtime/hooks/approval-policy.js";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const scenario = process.env.KIMI_PLUGIN_CC_MOCK_SCENARIO ?? "ask-success";
const invocationPath = process.env.KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH;
const delayMs = Number(process.env.KIMI_PLUGIN_CC_MOCK_DELAY_MS ?? "0");

// Session id resolution mirrors kimi-code: if the caller passes `-r <id>`,
// echo that id back (the resume target persists across the call). Otherwise
// mint a fresh uuid per invocation so concurrent fresh runs don't collide.
// KIMI_PLUGIN_CC_MOCK_SESSION_ID can override the fresh path for tests that
// need predictable ids without piping through -r.
const sessionId = resolveAnnouncedSessionId();

function resolveAnnouncedSessionId(): string {
  const override = process.env.KIMI_PLUGIN_CC_MOCK_SESSION_ID;
  if (override) return override;
  const argv = process.argv.slice(2);
  const dashR = argv.indexOf("-r");
  if (dashR >= 0 && argv[dashR + 1]) {
    return argv[dashR + 1]!;
  }
  return randomUUID();
}

interface AssistantContentRecord {
  role: "assistant";
  content: string;
}

async function main(): Promise<void> {
  // Execution-plan preflight probes the exact command tuple before creating a
  // job. Keep this branch side-effect free so invocation assertions still
  // describe the real prompt spawn rather than the probe.
  if (process.argv.slice(2).includes("--version")) {
    process.stdout.write(`${process.env.KIMI_PLUGIN_CC_MOCK_VERSION ?? "0.39.0"}\n`);
    process.exit(0);
  }

  if (invocationPath) {
    // Capture argv (and the env state that decides scenario routing) so
    // tests can assert what flags were forwarded to "kimi".
    await writeFile(
      invocationPath,
      `${JSON.stringify({
        argv: process.argv.slice(2),
        scenario,
        env: {
          KIMI_MODEL_THINKING_EFFORT: process.env.KIMI_MODEL_THINKING_EFFORT ?? null,
          KIMI_PLUGIN_CC_CMD: process.env.KIMI_PLUGIN_CC_CMD ?? null,
          KIMI_PLUGIN_CC_WORKSPACE_ROOT:
            process.env.KIMI_PLUGIN_CC_WORKSPACE_ROOT ?? null,
          KIMI_CODE_HOME: process.env.KIMI_CODE_HOME ?? null,
          ...(process.env.KIMI_PLUGIN_CC_READ_ROOTS === undefined ? {} : { KIMI_PLUGIN_CC_READ_ROOTS: process.env.KIMI_PLUGIN_CC_READ_ROOTS }),
          ...(process.env.KIMI_PLUGIN_CC_NETWORK === undefined ? {} : { KIMI_PLUGIN_CC_NETWORK: process.env.KIMI_PLUGIN_CC_NETWORK }),
        },
      })}\n`,
      "utf8",
    );
  }

  if (delayMs > 0) {
    await sleep(delayMs);
  }

  const recoverableV2 = process.env.KIMI_PLUGIN_CC_MOCK_RECOVERABLE_V2 === "1";
  if (recoverableV2) {
    process.stdout.write(`${JSON.stringify({ role: "meta", type: "system.version", version: process.env.KIMI_PLUGIN_CC_MOCK_VERSION })}\n`);
    // A real v2 turn creates state before work, but announces only at turn end.
    // Never overwrite an existing journal on resume (the preflight reads it).
    if (!process.argv.includes("-r") && process.env.KIMI_PLUGIN_CC_MOCK_NO_SESSION_STORE !== "1") {
      const dir = path.join(process.env.KIMI_CODE_HOME!, "sessions/wd_mock", sessionId);
      await mkdir(path.join(dir, "agents/main"), { recursive: true });
      await writeFile(path.join(dir, "state.json"), JSON.stringify({
        id: sessionId, version: 2, cwd: process.cwd(), createdAt: Date.now(),
      }));
      const argv = process.argv.slice(2);
      const promptArg = argv.indexOf("-p");
      const prompt = promptArg >= 0 ? argv[promptArg + 1] ?? "" : "";
      const text = process.env.KIMI_PLUGIN_CC_MOCK_JOURNAL_PROMPT_OVERRIDE ?? prompt;
      await writeFile(path.join(dir, "agents/main/wire.jsonl"), [
        JSON.stringify({ type: "metadata", protocol_version: "1.5", created_at: Date.now() }),
        JSON.stringify({ type: "turn.prompt", agentId: "main", input: [{ type: "text", text }], origin: { kind: "user" } }),
        JSON.stringify({ type: "context.append_message", agentId: "main", message: { role: "user", content: [{ type: "text", text }] }, time: Date.now() }),
      ].map((line) => `${line}\n`).join(""));
    }
  }
  if (scenario.startsWith("hook-escape-")) {
    const toolInput = { path: "/tmp/mock-hook-escape", content: "unsafe" };
    const toolName = process.env.KIMI_PLUGIN_CC_MOCK_HOOK_TOOL ?? "Write";
    const call = { id: "escape-1", type: "function", function: { name: toolName, arguments: JSON.stringify(toolInput) } };
    process.stdout.write(JSON.stringify({ role: "assistant", tool_calls: [call] }) + "\n");
    if (process.env.KIMI_PLUGIN_CC_MOCK_HOOK_PENDING_MS) await sleep(Number(process.env.KIMI_PLUGIN_CC_MOCK_HOOK_PENDING_MS));
    if (scenario !== "hook-escape-unresolved") {
      const decision = await decideHookOutcome({ tool_name: toolName, tool_input: toolInput }, {
        commandLabel: process.env.KIMI_PLUGIN_CC_CMD, operationKind: process.env.KIMI_PLUGIN_CC_OPERATION,
        trustedWorkspaceRoot: process.env.KIMI_PLUGIN_CC_WORKSPACE_ROOT,
      });
      process.stdout.write(JSON.stringify({ role: "tool", tool_call_id: call.id,
        content: scenario === "hook-escape-denied" ? decision.reason : "ok: wrote file" }) + "\n");
    }
    // The run always finishes with prose (or, under the review gate, its JSON verdict):
    // the monitor is detection evidence, so the job must complete normally.
    const gate = process.env.KIMI_PLUGIN_CC_CMD === "review_gate";
    if (scenario === "hook-escape-executed") {
      // The run continues after a mismatch (detection only); this sentinel proves it.
      await sleep(300);
      if (!gate) process.stdout.write(JSON.stringify({ role: "assistant", content: "UNTRUSTED AFTER ESCAPE" }) + "\n");
    }
    const prose = scenario === "hook-escape-denied" ? "The hook denied the attempted write."
      : scenario === "hook-escape-executed" ? "Finished after the mismatching tool result." : "Finished with no result for the denied call.";
    process.stdout.write(JSON.stringify({ role: "assistant", content: gate
      ? JSON.stringify({ decision: "ALLOW", confidence: "high", summary: prose, issues: [] }) : prose }) + "\n");
    return;
  }
  const records = recordsForScenario(scenario);
  for (const record of records) {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }

  // Match kimi-code's stderr session announce so cli-client's regex
  // (extractSessionIdFromStderr) captures the id.
  if (!recoverableV2) process.stderr.write(`To resume this session: kimi -r ${sessionId}\n`);
  // Emit work and the resume hint before holding, to exercise budget capture.
  const postOutputDelay = Number(process.env.KIMI_PLUGIN_CC_MOCK_POST_OUTPUT_DELAY_MS ?? "0");
  if (postOutputDelay > 0) await sleep(postOutputDelay);
  if (recoverableV2) process.stdout.write(`${JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: sessionId, command: `kimi -r ${sessionId}`, content: `To resume this session: kimi -r ${sessionId}` })}\n`);
  process.exit(0);
}

function recordsForScenario(name: string): AssistantContentRecord[] {
  switch (name) {
    case "ask-success":
      return [{ role: "assistant", content: "Ask answer from mock Kimi." }];

    case "review-success":
      // Match the v0.4 mock byte-for-byte so output-mode tests can keep
      // their hardcoded rawReviewOutput expectation. Prose-content
      // assertions in read-only-commands.test.ts still hit (the JSON
      // includes "concern" and "Incorrect answer constant" verbatim).
      return [
        {
          role: "assistant",
          content: JSON.stringify({
            summary: "One correctness issue found.",
            verdict: "concern",
            findings: [
              {
                severity: "medium",
                confidence: "high",
                title: "Incorrect answer constant",
                file: "src.ts",
                start_line: 1,
                body:
                  "The exported answer changed from 41 to 42 without corresponding test updates.",
                suggested_fix: null,
              },
            ],
          }),
        },
      ];

    case "review-missing-confidence":
      // v0.4 used this to verify the schema parser accepted output that
      // lacked a confidence field. v0.2.3 dropped the schema; the test
      // now just verifies a non-empty response passes through.
      return [
        {
          role: "assistant",
          content: JSON.stringify({
            decision: "approve",
            summary: "Looks fine, no findings.",
            // intentionally missing `confidence`
          }),
        },
      ];

    case "challenge-success":
      return [
        {
          role: "assistant",
          content: [
            "concern",
            "",
            "## Summary",
            "Mock Kimi challenge — surfacing assumptions.",
            "",
            "## Findings",
            "- assumption: the test harness is single-threaded.",
          ].join("\n"),
        },
      ];

    case "review-gate-allow":
      return [
        {
          role: "assistant",
          content: JSON.stringify({
            decision: "ALLOW",
            confidence: "high",
            summary: "Mock allow.",
            issues: [],
          }),
        },
      ];

    case "review-gate-block":
      return [
        {
          role: "assistant",
          content: JSON.stringify({
            decision: "BLOCK",
            confidence: "high",
            summary: "The assistant claimed the requested work was complete without addressing the core fix.",
            issues: [
              {
                title: "Requested fix still missing",
                body:
                  "The response says the task is done, but it does not address the user’s explicit request to fix the failing path.",
                severity: "high",
              },
            ],
          }),
        },
      ];

    case "review-gate-block-medium":
      return [
        {
          role: "assistant",
          content: JSON.stringify({
            decision: "BLOCK",
            confidence: "medium",
            summary: "There is a concern, but it is not high confidence.",
            issues: [
              {
                title: "Possibly incomplete response",
                body:
                  "The response may have skipped an edge case, but the evidence is not conclusive.",
                severity: "medium",
              },
            ],
          }),
        },
      ];

    case "review-gate-malformed":
      // Emit truncated JSON that fails JSON.parse — mirrors v0.4 mock.
      return [{ role: "assistant", content: "{\"decision\":\"BLOCK\"" }];

    case "rescue-success":
      return [
        {
          role: "assistant",
          content: [
            "Applied the requested change.",
            "",
            "- Updated note.txt with the requested fix.",
            "- Ran pwd to verify the workspace context.",
            "- Mock verification passed.",
            "",
          ].join("\n"),
        },
      ];

    case "rescue-empty":
      // Emit a single whitespace-only assistant record — render.ts trims
      // to empty and throws RESCUE_EMPTY_OUTPUT. Mirrors the v0.4 mock's
      // empty-final-text scenario.
      return [{ role: "assistant", content: "   \n" }];

    case "rescue-cancel":
      // Long-form rescue prose used by cancel tests. The delay env var
      // (KIMI_PLUGIN_CC_MOCK_DELAY_MS) decides whether the mock finishes
      // before SIGTERM lands. Without a delay the call completes
      // normally, which doubles as a positive smoke test.
      return [
        {
          role: "assistant",
          content: [
            "Working on the requested rescue task.",
            "",
            "Step 1: inspect repository structure.",
            "Step 2: apply the suggested fix.",
            "",
          ].join("\n"),
        },
      ];

    default:
      // Bail loudly so the test surfaces the missing scenario rather
      // than silently exiting with empty records. CLI_NONZERO_EXIT
      // surfaces in the test result.
      process.stderr.write(`mock-kimi-cli-v1: unknown scenario "${name}"\n`);
      process.exit(64);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  process.stderr.write(
    `mock-kimi-cli-v1 fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
