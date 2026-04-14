const scenario = process.argv[2] ?? "success";

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
  if (scenario === "approval-request" && request.id === "approval-req-1" && request.result) {
    if (pendingPromptId) {
      sendEvent("TurnEnd", {});
      send({
        jsonrpc: "2.0",
        id: pendingPromptId,
        result: { status: "cancelled" },
      });
    }
    return;
  }

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

  if (request.method === "cancel" && request.id) {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {},
    });
    return;
  }

  if (request.method !== "prompt" || !request.id) {
    return;
  }

  switch (scenario) {
    case "success": {
      sendEvent("TurnBegin", { user_input: request.params?.user_input ?? "" });
      sendEvent("StepBegin", { n: 1 });
      sendEvent("ContentPart", { type: "text", text: "READY" });
      sendEvent("TurnEnd", {});
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { status: "finished" },
      });
      return;
    }
    case "approval-request": {
      pendingPromptId = request.id;
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
    case "missing-turn-end": {
      sendEvent("TurnBegin", { user_input: request.params?.user_input ?? "" });
      sendEvent("StepBegin", { n: 1 });
      sendEvent("ContentPart", { type: "text", text: "partial output" });
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { status: "finished" },
      });
      return;
    }
    case "cancelled": {
      sendEvent("TurnBegin", { user_input: request.params?.user_input ?? "" });
      sendEvent("StepBegin", { n: 1 });
      sendEvent("ContentPart", { type: "text", text: "partial output" });
      sendEvent("TurnEnd", {});
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { status: "cancelled" },
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
