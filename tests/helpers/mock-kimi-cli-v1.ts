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

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

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
  if (invocationPath) {
    // Capture argv (and the env state that decides scenario routing) so
    // tests can assert what flags were forwarded to "kimi".
    await writeFile(
      invocationPath,
      `${JSON.stringify({
        argv: process.argv.slice(2),
        scenario,
        env: {
          KIMI_PLUGIN_CC_CMD: process.env.KIMI_PLUGIN_CC_CMD ?? null,
        },
      })}\n`,
      "utf8",
    );
  }

  if (delayMs > 0) {
    await sleep(delayMs);
  }

  const records = recordsForScenario(scenario);
  for (const record of records) {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }

  // Match kimi-code's stderr session announce so cli-client's regex
  // (extractSessionIdFromStderr) captures the id.
  process.stderr.write(`To resume this session: kimi -r ${sessionId}\n`);
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
