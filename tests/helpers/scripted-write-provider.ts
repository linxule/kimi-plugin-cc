import * as http from "node:http";

export interface ScriptedProviderRequest {
  readonly index: number;
  readonly bodyJson: unknown;
}

export interface ScriptedWriteProvider {
  readonly baseUrl: string;
  readonly requests: ScriptedProviderRequest[];
  readonly receivedRequests: number;
  readonly rejectedRequests: number;
  readonly completedExchanges: number;
  readonly compactionResponses: number;
  close(): Promise<void>;
}

export interface ScriptedWriteProviderOptions {
  readonly fileNames?: readonly string[];
  readonly callIdPrefix?: string;
}

export async function startScriptedWriteProvider(options: ScriptedWriteProviderOptions = {}): Promise<ScriptedWriteProvider> {
  const fileNames = options.fileNames ?? ["SMOKE_SHOULD_NOT_EXIST.txt"];
  const callIdPrefix = options.callIdPrefix ?? "call_write_";
  if (fileNames.length === 0 || callIdPrefix.length === 0) throw new Error("scripted provider options must not be empty");
  const requests: ScriptedProviderRequest[] = [];
  let receivedRequests = 0;
  let rejectedRequests = 0;
  let completedExchanges = 0;
  let compactionResponses = 0;
  const server = http.createServer((req, res) => {
    receivedRequests += 1;
    res.on("finish", () => {
      if (res.statusCode !== 200) rejectedRequests += 1;
    });
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      if (req.headers.authorization !== "Bearer scripted-test-only") {
        res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
        res.end("unexpected authorization");
        return;
      }
      const chunks: Buffer[] = [];
      let bodyBytes = 0;
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bodyBytes += buffer.length;
        if (bodyBytes > 1024 * 1024) {
          res.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
          res.end("request too large");
          req.resume();
          return;
        }
        chunks.push(buffer);
      }
      let bodyJson: unknown = null;
      try {
        bodyJson = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("invalid JSON");
        return;
      }
      const body = bodyJson as {
        model?: string;
        stream?: boolean;
        tools?: Array<{ function?: { name?: string } }>;
        messages?: Array<{ role?: string; tool_call_id?: string; content?: unknown }>;
      };
      if (
        body.model !== "scripted-write-control" ||
        body.stream !== true ||
        !Array.isArray(body.tools) ||
        !body.tools.some((tool) => tool.function?.name === "Write") ||
        !Array.isArray(body.messages) ||
        body.messages.length === 0
      ) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("unexpected request shape");
        return;
      }
      const lastMessage = body.messages.at(-1);
      const lastRole = lastMessage?.role;
      if (lastRole !== "user" && lastRole !== "tool") {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("unexpected trailing message");
        return;
      }
      if (lastRole === "tool") {
        const expectedCallId = `${callIdPrefix}${requests.length - 1}`;
        if (
          lastMessage?.tool_call_id !== expectedCallId ||
          !JSON.stringify(lastMessage).includes("kimi-plugin-cc safety hook")
        ) {
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          res.end("unexpected tool result");
          return;
        }
      }
      const index = requests.length;
      requests.push({ index, bodyJson });
      const compaction = lastRole === "user" && JSON.stringify(lastMessage?.content).includes("Create a handoff summary");
      const finalResponse = lastRole === "tool" || compaction;
      const responseText = lastRole === "tool"
        ? "Managed denial recorded."
        : `The goal is to create ${fileNames.length} smoke file(s). Previous Write attempts were denied by the managed hook. Continue the next required Write attempt.`;
      const id = finalResponse ? "chatcmpl-final" : "chatcmpl-write";
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      const events = finalResponse
        ? [
            { id, object: "chat.completion.chunk", created: 1, model: "scripted-write-control", choices: [{ index: 0, delta: { role: "assistant", content: responseText }, finish_reason: null }] },
            { id, object: "chat.completion.chunk", created: 1, model: "scripted-write-control", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
          ]
        : [
            { id, object: "chat.completion.chunk", created: 1, model: "scripted-write-control", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `${callIdPrefix}${index}`, type: "function", function: { name: "Write", arguments: JSON.stringify({ path: fileNames[Math.floor(index / 2) % fileNames.length], content: "smoke" }) } }] }, finish_reason: null }] },
            { id, object: "chat.completion.chunk", created: 1, model: "scripted-write-control", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
          ];
      const lines = events.flatMap((event) => [`data: ${JSON.stringify(event)}`, ""]);
      lines.push("data: [DONE]", "", "");
      res.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
      });
      res.end(lines.join("\n"), () => {
        completedExchanges += 1;
        if (compaction) compactionResponses += 1;
      });
    })().catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("scripted provider did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    get receivedRequests() {
      return receivedRequests;
    },
    get rejectedRequests() {
      return rejectedRequests;
    },
    get completedExchanges() {
      return completedExchanges;
    },
    get compactionResponses() {
      return compactionResponses;
    },
    close: () => new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        server.closeAllConnections();
        finish(new Error("scripted provider close timed out"));
      }, 2_000);
      timer.unref();
      server.close((error) => finish(error));
      server.closeAllConnections();
    }),
  };
}
