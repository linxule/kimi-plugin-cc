import { writeFile } from "node:fs/promises";

const scenario = process.env.KIMI_PLUGIN_CC_MOCK_SCENARIO ?? "ask-success";
const invocationPath = process.env.KIMI_PLUGIN_CC_MOCK_INVOCATION_PATH;
const approvalMode = process.env.KIMI_PLUGIN_CC_MOCK_APPROVAL_MODE ?? "none";
const approvalTarget = process.env.KIMI_PLUGIN_CC_MOCK_APPROVAL_TARGET ?? "";
const delayMs = Number(process.env.KIMI_PLUGIN_CC_MOCK_DELAY_MS ?? "0");

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method?: string;
  id?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

process.stdin.setEncoding("utf8");

let buffer = "";
let pendingPromptId: string | null = null;
let pendingApprovalId: string | null = null;

if (invocationPath) {
  await writeFile(invocationPath, `${JSON.stringify({ argv: process.argv.slice(2) })}\n`, "utf8");
}

process.stdin.on("data", (chunk) => {
  buffer += chunk;

  while (buffer.includes("\n")) {
    const newline = buffer.indexOf("\n");
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);

    if (!line) {
      continue;
    }

    void handleMessage(JSON.parse(line) as JsonRpcRequest);
  }
});

async function handleMessage(request: JsonRpcRequest): Promise<void> {
  if (request.method === "initialize" && request.id) {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocol_version: "1.9",
        server: {
          name: "Mock Kimi",
          version: "1.34.0",
        },
      },
    });
    return;
  }

  if (request.id && request.result && pendingApprovalId && request.id === pendingApprovalId) {
    pendingApprovalId = null;
    const response = String(request.result.response ?? "reject");

    if (response !== "approve") {
      await finishPrompt("cancelled");
      return;
    }

    await emitRescueFinal();
    return;
  }

  if (request.method === "cancel" && request.id) {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {},
    });
    await finishPrompt("cancelled");
    return;
  }

  if (request.method !== "prompt" || !request.id) {
    return;
  }

  switch (scenario) {
    case "ask-success": {
      sendEvent("TurnBegin", { user_input: request.params?.user_input ?? "" });
      sendEvent("StepBegin", { n: 1 });
      sendEvent("ContentPart", { type: "text", text: "Ask answer from mock Kimi." });
      sendEvent("TurnEnd", {});
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { status: "finished" },
      });
      return;
    }
    case "review-success": {
      sendEvent("TurnBegin", { user_input: request.params?.user_input ?? "" });
      sendEvent("StepBegin", { n: 1 });
      sendEvent("ContentPart", { type: "text", text: "intermediate reviewer commentary" });
      sendEvent("ToolResult", {
        tool_call_id: "read-1",
        return_value: { is_error: false, output: "", message: "", display: [] },
      });
      sendEvent("StepBegin", { n: 2 });
      sendEvent("ContentPart", {
        type: "text",
        text: JSON.stringify({
          summary: "One correctness issue found.",
          verdict: "concern",
          findings: [
            {
              severity: "medium",
              confidence: "high",
              title: "Incorrect answer constant",
              file: "src.ts",
              start_line: 1,
              body: "The exported answer changed from 41 to 42 without corresponding test updates.",
              suggested_fix: null,
            },
          ],
        }),
      });
      sendEvent("TurnEnd", {});
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { status: "finished" },
      });
      return;
    }
    case "review-missing-confidence": {
      sendEvent("TurnBegin", { user_input: request.params?.user_input ?? "" });
      sendEvent("StepBegin", { n: 1 });
      sendEvent("ContentPart", {
        type: "text",
        text: JSON.stringify({
          summary: "Malformed finding.",
          verdict: "concern",
          findings: [
            {
              severity: "medium",
              title: "Missing confidence",
              file: "src.ts",
              start_line: 1,
              body: "confidence is absent",
            },
          ],
        }),
      });
      sendEvent("TurnEnd", {});
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { status: "finished" },
      });
      return;
    }
    case "review-gate-allow": {
      await emitJsonFinal(
        request.id,
        JSON.stringify({
          decision: "ALLOW",
          confidence: "medium",
          summary: "No blocking issue found in the assistant response.",
          issues: [],
        }),
      );
      return;
    }
    case "review-gate-block": {
      await emitJsonFinal(
        request.id,
        JSON.stringify({
          decision: "BLOCK",
          confidence: "high",
          summary: "The assistant claimed the requested work was complete without addressing the core fix.",
          issues: [
            {
              title: "Requested fix still missing",
              body: "The response says the task is done, but it does not address the user’s explicit request to fix the failing path.",
              severity: "high",
            },
          ],
        }),
      );
      return;
    }
    case "review-gate-block-medium": {
      await emitJsonFinal(
        request.id,
        JSON.stringify({
          decision: "BLOCK",
          confidence: "medium",
          summary: "There is a concern, but it is not high confidence.",
          issues: [
            {
              title: "Possibly incomplete response",
              body: "The response may have skipped an edge case, but the evidence is not conclusive.",
              severity: "medium",
            },
          ],
        }),
      );
      return;
    }
    case "review-gate-malformed": {
      await emitJsonFinal(request.id, "{\"decision\":\"BLOCK\"");
      return;
    }
    case "rescue-success":
    case "rescue-malformed":
    case "rescue-cancel": {
      pendingPromptId = request.id;
      sendEvent("TurnBegin", { user_input: request.params?.user_input ?? "" });
      sendEvent("StepBegin", { n: 1 });

      if (scenario === "rescue-cancel") {
        sendEvent("ContentPart", { type: "text", text: "still working" });
        return;
      }

      if (approvalMode !== "none") {
        pendingApprovalId = "approval-req-1";
        send(buildApprovalRequest(approvalMode, approvalTarget));
        return;
      }

      await emitRescueFinal();
      return;
    }
    case "approval-request": {
      pendingPromptId = request.id;
      pendingApprovalId = "approval-req-1";
      sendEvent("TurnBegin", { user_input: request.params?.user_input ?? "" });
      send({
        jsonrpc: "2.0",
        method: "request",
        id: "approval-req-1",
        params: {
          type: "ApprovalRequest",
          payload: {
            id: "approval-1",
            sender: "Shell",
            action: "run shell command",
            description: "Run command `ls`",
            display: [],
          },
        },
      });
      return;
    }
    default:
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32602,
          message: `Unknown scenario: ${scenario}`,
        },
      });
  }
}

function sendEvent(type: string, payload: Record<string, unknown>): void {
  send({
    jsonrpc: "2.0",
    method: "event",
    params: {
      type,
      payload,
    },
  });
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function emitRescueFinal(): Promise<void> {
  if (delayMs > 0) {
    await sleep(delayMs);
  }

  sendEvent("StepBegin", { n: 2 });
  sendEvent("ContentPart", {
    type: "text",
    text:
      scenario === "rescue-malformed"
        ? "{\"summary\":\"oops\""
        : JSON.stringify({
            status: "success",
            summary: "Applied the requested change.",
            changes: [
              {
                file: "note.txt",
                action: "edit",
                description: "Updated the file requested by the task.",
              },
            ],
            commands_run: [
              {
                command: approvalMode === "shell" ? approvalTarget : "pwd",
                exit_code: 0,
                note: "Inspection completed.",
              },
            ],
            tests: [
              {
                name: "mock-check",
                status: "passed",
                details: "Mock verification passed.",
              },
            ],
            followups: [],
          }),
  });
  await finishPrompt("finished");
}

async function emitJsonFinal(promptId: string, text: string): Promise<void> {
  if (delayMs > 0) {
    await sleep(delayMs);
  }

  pendingPromptId = promptId;
  sendEvent("TurnBegin", {});
  sendEvent("StepBegin", { n: 1 });
  sendEvent("ContentPart", {
    type: "text",
    text,
  });
  await finishPrompt("finished");
}

async function finishPrompt(status: "finished" | "cancelled"): Promise<void> {
  if (!pendingPromptId) {
    return;
  }

  sendEvent("TurnEnd", {});
  send({
    jsonrpc: "2.0",
    id: pendingPromptId,
    result: { status },
  });
  pendingPromptId = null;
}

function buildApprovalRequest(mode: string, target: string): Record<string, unknown> {
  if (mode === "file") {
    return {
      jsonrpc: "2.0",
      method: "request",
      id: "approval-req-1",
      params: {
        type: "ApprovalRequest",
        payload: {
          id: "approval-1",
          sender: "WriteFile",
          action: "edit file",
          description: `Write file \`${target}\``,
          display: [
            {
              type: "diff",
              path: target,
              old_text: "",
              new_text: "updated",
              old_start: 1,
              new_start: 1,
              is_summary: false,
            },
          ],
        },
      },
    };
  }

  return {
    jsonrpc: "2.0",
    method: "request",
    id: "approval-req-1",
    params: {
      type: "ApprovalRequest",
      payload: {
        id: "approval-1",
        sender: "Shell",
        action: "run command",
        description: `Run command \`${target}\``,
        display: [
          {
            type: "shell",
            language: "bash",
            command: target,
          },
        ],
      },
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
