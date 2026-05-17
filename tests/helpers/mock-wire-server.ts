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
let pendingApprovalId: string | null = null;

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
  if (
    (scenario === "approval-request" || scenario === "approval-cancel") &&
    pendingApprovalId &&
    request.id === pendingApprovalId &&
    request.result
  ) {
    pendingApprovalId = null;
    if (pendingPromptId) {
      sendEvent("TurnEnd", {});
      send({
        jsonrpc: "2.0",
        id: pendingPromptId,
        result: { status: "cancelled" },
      });
      pendingPromptId = null;
    }
    return;
  }

  if (request.method === "initialize" && request.id) {
    if (scenario === "slow-initialize") {
      return;
    }

    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocol_version: "1.10",
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

    if (
      (scenario === "rescue-cancel-turn" ||
        scenario === "think-stall" ||
        scenario === "think-loop") &&
      pendingPromptId
    ) {
      sendEvent("TurnEnd", {});
      send({
        jsonrpc: "2.0",
        id: pendingPromptId,
        result: { status: "cancelled" },
      });
      pendingPromptId = null;
      return;
    }
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
    case "approval-cancel": {
      pendingPromptId = request.id;
      pendingApprovalId = "approval-req-1";
      sendEvent("TurnBegin", { user_input: request.params?.user_input ?? "" });
      send({
        jsonrpc: "2.0",
        method: "request",
        id: pendingApprovalId,
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
    case "think-stall": {
      // Emit ContentPart{type:"think"} events forever and never send
      // PromptResult. Payloads are DIVERSIFIED (`chunk-${n++}`) so the
      // duplicate-content detector cannot win the race against the
      // time-based stall watchdog — this scenario exercises ONLY the
      // time-based watchdog. (See the `think-loop` scenario below for
      // the duplicate-detector test.)
      pendingPromptId = request.id;
      sendEvent("TurnBegin", { user_input: request.params?.user_input ?? "" });
      sendEvent("StepBegin", { n: 1 });
      let chunkCount = 0;
      const interval = setInterval(() => {
        if (pendingPromptId === null) {
          clearInterval(interval);
          return;
        }
        sendEvent("ContentPart", { type: "think", text: `chunk-${chunkCount++}` });
      }, 5);
      interval.unref();
      return;
    }
    case "think-loop": {
      // Emit IDENTICAL ContentPart{type:"think"} events. The duplicate
      // detector should fire KIMI_THINK_LOOP_DETECTED after N matching
      // payload hashes (default 8) regardless of the time-based
      // watchdog deadline.
      pendingPromptId = request.id;
      sendEvent("TurnBegin", { user_input: request.params?.user_input ?? "" });
      sendEvent("StepBegin", { n: 1 });
      const interval = setInterval(() => {
        if (pendingPromptId === null) {
          clearInterval(interval);
          return;
        }
        sendEvent("ContentPart", { type: "think", text: "stuck-payload" });
      }, 5);
      interval.unref();
      return;
    }
    case "unknown-think-shape": {
      // Emits two `ContentPart{type:"think"}` events whose payload
      // shape lacks the recognized `text` field — exercising the
      // unknown-shape callback path in ThinkStallGuard. Followed by a
      // text part and TurnEnd so the prompt completes cleanly.
      sendEvent("TurnBegin", { user_input: request.params?.user_input ?? "" });
      sendEvent("StepBegin", { n: 1 });
      sendEvent("ContentPart", { type: "think", delta: "no-text-field-1" });
      sendEvent("ContentPart", { type: "think", delta: "no-text-field-2" });
      sendEvent("ContentPart", { type: "text", text: "done" });
      sendEvent("TurnEnd", {});
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { status: "finished" },
      });
      return;
    }
    case "text-loop": {
      // Emit MANY identical `ContentPart{type:"text"}` payloads, then
      // finish cleanly. The handleLine seam in WireClient must route
      // these to `observeForwardProgress` (which clears the hash window)
      // rather than `observeThinkPart` — otherwise N identical text
      // payloads would spuriously trip the loop detector. This is the
      // routing-policy test that the per-guard unit tests cannot reach.
      sendEvent("TurnBegin", { user_input: request.params?.user_input ?? "" });
      sendEvent("StepBegin", { n: 1 });
      for (let i = 0; i < 20; i += 1) {
        sendEvent("ContentPart", { type: "text", text: "identical-text" });
      }
      sendEvent("TurnEnd", {});
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { status: "finished" },
      });
      return;
    }
    case "unknown-subtype": {
      // Emits a single ContentPart with an unrecognized subtype, then
      // finishes cleanly. Used to verify the forward-compat warning
      // fires exactly once per subtype.
      sendEvent("TurnBegin", { user_input: request.params?.user_input ?? "" });
      sendEvent("StepBegin", { n: 1 });
      sendEvent("ContentPart", { type: "speculation", text: "future-event" });
      sendEvent("ContentPart", { type: "speculation", text: "future-event-2" });
      sendEvent("ContentPart", { type: "text", text: "done" });
      sendEvent("TurnEnd", {});
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { status: "finished" },
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
    case "rescue-cancel-turn": {
      pendingPromptId = request.id;
      sendEvent("TurnBegin", { user_input: request.params?.user_input ?? "" });
      sendEvent("StepBegin", { n: 1 });
      sendEvent("ContentPart", { type: "text", text: "still working" });
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
