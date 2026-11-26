// Native-v2 stream-json mock for `kimi -p --output-format stream-json`.
//
// Emits the >= 2.8.0 wire contract:
//   - `--version` prints KIMI_PLUGIN_CC_MOCK_VERSION (default "2.8.0")
//   - stdout line 1: {"role":"meta","type":"system.version","version":"<ver>"}
//   - creates a v2 session store under <KIMI_CODE_HOME>/sessions/wd_mock/<id>/
//     on fresh invocations (unless KIMI_PLUGIN_CC_MOCK_NO_SESSION_STORE=1)
//   - stdout records for the selected scenario
//   - final stdout line: {"role":"meta","type":"session.resume_hint",...}
//
// Env knobs:
//   KIMI_PLUGIN_CC_MOCK_VERSION                default "2.8.0"
//   KIMI_PLUGIN_CC_MOCK_SCENARIO               ask-success / review-success / challenge-success / rescue-* / hook-escape-*
//   KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH        optional path where argv + env snapshot are logged
//   KIMI_PLUGIN_CC_MOCK_DELAY_MS               delay before emitting records (cancellation tests)
//   KIMI_PLUGIN_CC_MOCK_POST_OUTPUT_DELAY_MS   delay after prose before emitting session.resume_hint (budget timeout tests)
//   KIMI_PLUGIN_CC_MOCK_SESSION_ID             override session id
//   KIMI_PLUGIN_CC_MOCK_NO_SESSION_STORE       set "1" to skip writing state.json + wire.jsonl
//   KIMI_PLUGIN_CC_MOCK_JOURNAL_PROMPT_OVERRIDE override prompt text written into wire.jsonl
//   KIMI_PLUGIN_CC_MOCK_OMIT_SYSTEM_VERSION    set "1" to omit the system.version meta line

import { decideHookOutcome } from "../../runtime/hooks/approval-policy.js";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const scenario = process.env.KIMI_PLUGIN_CC_MOCK_SCENARIO ?? "ask-success";
const invocationPath = process.env.KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH;
const delayMs = Number(process.env.KIMI_PLUGIN_CC_MOCK_DELAY_MS ?? "0");
const mockVersion = process.env.KIMI_PLUGIN_CC_MOCK_VERSION ?? "2.8.0";

// Echo `-r <id>` on resume; otherwise mint a fresh native-v2 session id.
const sessionId = resolveAnnouncedSessionId();

function resolveAnnouncedSessionId(): string {
  const override = process.env.KIMI_PLUGIN_CC_MOCK_SESSION_ID;
  if (override) return override;
  const argv = process.argv.slice(2);
  const dashR = argv.indexOf("-r");
  if (dashR >= 0 && argv[dashR + 1]) {
    return argv[dashR + 1]!;
  }
  return `session_${randomUUID()}`;
}

interface AssistantContentRecord {
  role: "assistant";
  content: string;
}

async function main(): Promise<void> {
  // Execution-plan preflight probes `--version` before creating a job; keep
  // this branch side-effect free so invocation logs reflect the prompt spawn.
  if (process.argv.slice(2).includes("--version")) {
    process.stdout.write(`${mockVersion}\n`);
    process.exit(0);
  }

  if (invocationPath) {
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

  if (process.env.KIMI_PLUGIN_CC_MOCK_OMIT_SYSTEM_VERSION !== "1") {
    process.stdout.write(`${JSON.stringify({ role: "meta", type: "system.version", version: mockVersion })}\n`);
  }

  // A real v2 turn creates session state before work and announces the resume
  // hint at turn end. Never overwrite an existing journal on resume.
  const kimiHome = process.env.KIMI_CODE_HOME;
  if (kimiHome && !process.argv.includes("-r") && process.env.KIMI_PLUGIN_CC_MOCK_NO_SESSION_STORE !== "1") {
    const dir = path.join(kimiHome, "sessions/wd_mock", sessionId);
    await mkdir(path.join(dir, "agents/main"), { recursive: true });
    await writeFile(path.join(dir, "state.json"), JSON.stringify({
      id: sessionId,
      version: 2,
      cwd: process.cwd(),
      createdAt: Date.now(),
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

  if (scenario.startsWith("hook-escape-")) {
    const toolInput = { path: "/tmp/mock-hook-escape", content: "unsafe" };
    const toolName = process.env.KIMI_PLUGIN_CC_MOCK_HOOK_TOOL ?? "Write";
    const call = { id: "escape-1", type: "function", function: { name: toolName, arguments: JSON.stringify(toolInput) } };
    process.stdout.write(JSON.stringify({ role: "assistant", tool_calls: [call] }) + "\n");
    if (process.env.KIMI_PLUGIN_CC_MOCK_HOOK_PENDING_MS) await sleep(Number(process.env.KIMI_PLUGIN_CC_MOCK_HOOK_PENDING_MS));
    if (scenario !== "hook-escape-unresolved") {
      const decision = await decideHookOutcome({ tool_name: toolName, tool_input: toolInput }, {
        commandLabel: process.env.KIMI_PLUGIN_CC_CMD,
        operationKind: process.env.KIMI_PLUGIN_CC_OPERATION,
        trustedWorkspaceRoot: process.env.KIMI_PLUGIN_CC_WORKSPACE_ROOT,
        swarmPolicy: process.env.KIMI_PLUGIN_CC_SWARM_POLICY,
        swarmWaveSize: process.env.KIMI_PLUGIN_CC_SWARM_WAVE_SIZE,
        readRoots: process.env.KIMI_PLUGIN_CC_READ_ROOTS,
        network: process.env.KIMI_PLUGIN_CC_NETWORK,
      });
      process.stdout.write(JSON.stringify({
        role: "tool",
        tool_call_id: call.id,
        content: scenario === "hook-escape-denied" ? decision.reason : "ok: wrote file",
      }) + "\n");
    }
    if (scenario === "hook-escape-executed") {
      // The run continues after a mismatch (detection only); this sentinel proves it.
      await sleep(300);
      process.stdout.write(JSON.stringify({ role: "assistant", content: "UNTRUSTED AFTER ESCAPE" }) + "\n");
    }
    const prose = scenario === "hook-escape-denied"
      ? "The hook denied the attempted write."
      : scenario === "hook-escape-executed"
        ? "Finished after the mismatching tool result."
        : "Finished with no result for the denied call.";
    process.stdout.write(JSON.stringify({ role: "assistant", content: prose }) + "\n");
    process.stdout.write(`${JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: sessionId, command: `kimi -r ${sessionId}`, content: `To resume this session: kimi -r ${sessionId}` })}\n`);
    return;
  }

  const records = recordsForScenario(scenario);
  for (const record of records) {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }

  const postOutputDelay = Number(process.env.KIMI_PLUGIN_CC_MOCK_POST_OUTPUT_DELAY_MS ?? "0");
  if (postOutputDelay > 0) await sleep(postOutputDelay);
  process.stdout.write(`${JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: sessionId, command: `kimi -r ${sessionId}`, content: `To resume this session: kimi -r ${sessionId}` })}\n`);
  process.exit(0);
}

function recordsForScenario(name: string): AssistantContentRecord[] {
  switch (name) {
    case "ask-success":
      return [{ role: "assistant", content: "Ask answer from mock Kimi." }];

    case "review-success":
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
      return [
        {
          role: "assistant",
          content: JSON.stringify({
            decision: "approve",
            summary: "Looks fine, no findings.",
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
      return [{ role: "assistant", content: "   \n" }];

    case "rescue-cancel":
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
      process.stderr.write(`mock-kimi-cli: unknown scenario "${name}"\n`);
      process.exit(64);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  process.stderr.write(
    `mock-kimi-cli fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
