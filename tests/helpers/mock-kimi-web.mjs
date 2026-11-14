#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const home = process.env.KIMI_CODE_HOME;
if (!home || !path.isAbsolute(home)) {
  process.stderr.write("mock-kimi-web requires an absolute KIMI_CODE_HOME\n");
  process.exit(2);
}

const token = process.env.MOCK_KIMI_WEB_TOKEN ?? "mock-ready-token";
const configCanary = process.env.MOCK_KIMI_WEB_CONFIG_CANARY ?? "mock-config-canary";
const scenario = process.env.MOCK_KIMI_WEB_SCENARIO ?? "success";
const version = process.env.MOCK_KIMI_WEB_VERSION ?? "2.3.2";
const defaultModel = process.env.MOCK_KIMI_WEB_DEFAULT_MODEL ?? "configured-default";
const readyDelayMs = Number.parseInt(process.env.MOCK_KIMI_WEB_READY_DELAY_MS ?? "0", 10);
const statusDelayMs = Number.parseInt(process.env.MOCK_KIMI_WEB_STATUS_DELAY_MS ?? "0", 10);
const deactivateStatusDelayMs = Number.parseInt(process.env.MOCK_KIMI_WEB_DEACTIVATE_STATUS_DELAY_MS ?? "0", 10);
const createSessionDelayMs = Number.parseInt(process.env.MOCK_KIMI_WEB_CREATE_SESSION_DELAY_MS ?? "0", 10);
const printDelayMs = Number.parseInt(process.env.MOCK_KIMI_WEB_PRINT_DELAY_MS ?? "0", 10);
const shutdownDelayMs = Number.parseInt(process.env.MOCK_KIMI_WEB_SHUTDOWN_DELAY_MS ?? "10", 10);
const logPath = process.env.MOCK_KIMI_WEB_LOG;
const sessionId = "session_mock";
const workspaceId = "wd_mock";
const journalPath = path.join(home, "sessions", workspaceId, sessionId, "agents", "main", "wire.jsonl");
let swarmMode = process.env.MOCK_KIMI_WEB_INITIAL_SWARM === "1";
let permission = "auto";
let model = defaultModel;
let logChain = Promise.resolve();

function record(entry) {
  if (!logPath) return Promise.resolve();
  const line = `${JSON.stringify({ pid: process.pid, ...entry })}\n`;
  logChain = logChain.then(() => appendFile(logPath, line, "utf8"));
  return logChain;
}

function safeEnvironment() {
  return {
    KIMI_CODE_HOME: process.env.KIMI_CODE_HOME ?? null,
    KIMI_CODE_NO_AUTO_UPDATE: process.env.KIMI_CODE_NO_AUTO_UPDATE ?? null,
    KIMI_CODE_TRUST_WORKSPACE: process.env.KIMI_CODE_TRUST_WORKSPACE ?? null,
    KIMI_MODEL_THINKING_EFFORT: process.env.KIMI_MODEL_THINKING_EFFORT ?? null,
    KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: process.env.KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY ?? null,
    KIMI_PLUGIN_CC_OPERATION: process.env.KIMI_PLUGIN_CC_OPERATION ?? null,
    KIMI_PLUGIN_CC_CMD: process.env.KIMI_PLUGIN_CC_CMD ?? null,
    KIMI_PLUGIN_CC_WORKSPACE_ROOT: process.env.KIMI_PLUGIN_CC_WORKSPACE_ROOT ?? null,
  };
}

function envelope(code, data, msg) {
  return { code, msg: msg ?? (code === 0 ? "success" : "failed"), data, request_id: "mock-request" };
}

function send(res, data, options = {}) {
  const status = options.status ?? 200;
  const code = options.code ?? 0;
  const msg = options.msg;
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify(envelope(code, data, msg)));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > 1024 * 1024) throw new Error("request too large");
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function appendJournal(recordValue) {
  await mkdir(path.dirname(journalPath), { recursive: true });
  await appendFile(journalPath, `${JSON.stringify(recordValue)}\n`, "utf8");
}

async function appendRawJournal(line) {
  await mkdir(path.dirname(journalPath), { recursive: true });
  await appendFile(journalPath, line, "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handle(req, res) {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const body = method === "POST" ? await readBody(req) : undefined;
  await record({ kind: "request", method, path: url.pathname, body: body ?? null });

  if (req.headers.authorization !== `Bearer ${token}`) {
    send(res, null, { status: 401, code: 40101, msg: `unauthorized ${token} ${configCanary}` });
    return;
  }

  if (method === "GET" && url.pathname === "/api/v1/meta") {
    send(res, {
      server_version: scenario === "meta-version-mismatch" ? "2.3.1" : version,
      backend: scenario === "meta-backend-mismatch" ? "v1" : "v2",
      dangerous_bypass_auth: scenario === "dangerous-auth",
      capabilities: {},
      server_id: "mock-server",
      started_at: new Date().toISOString(),
      open_in_apps: [],
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/v1/config") {
    send(res, {
      default_model: defaultModel,
      providers: { private: { api_key: configCanary } },
      raw: { private_note: configCanary },
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/v1/sessions") {
    if (createSessionDelayMs > 0) await sleep(createSessionDelayMs);
    if (body?.metadata?.cwd !== process.cwd()) {
      send(res, null, { code: 40001, msg: `cwd mismatch ${token}` });
      return;
    }
    if (["2.5.0", "2.5.1", "2.5.2", "2.5.3", "2.6.0", "2.6.2"].includes(version) && (body?.environment_id !== "local" || body?.environment_cwd !== process.cwd())) {
      send(res, null, { code: 40001, msg: "missing local environment binding" });
      return;
    }
    send(res, {
      id: sessionId,
      workspace_id: workspaceId,
      metadata: { cwd: process.cwd() },
      agent_config: { model: "" },
    });
    return;
  }

  const profileMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/profile$/);
  if (method === "POST" && profileMatch) {
    if (decodeURIComponent(profileMatch[1]) !== sessionId) {
      send(res, null, { code: 40401, msg: `missing session ${token}` });
      return;
    }
    const active = body?.agent_config?.swarm_mode;
    if (typeof active !== "boolean") {
      send(res, null, { code: 40001, msg: `invalid profile ${token}` });
      return;
    }
    if ((scenario === "rest-failure" && active) ||
        ((scenario === "deactivate-rest-failure" || scenario === "composite-failure") && !active)) {
      send(res, null, { code: 50001, msg: `forced failure ${token} ${configCanary}` });
      return;
    }
    swarmMode = active;
    permission = body.agent_config.permission_mode;
    if (typeof body.agent_config.model === "string") model = body.agent_config.model;
    if (scenario === "malformed-swarm-journal" && active) {
      await appendRawJournal('{"type":"swarm_mode.enter"\n');
    } else if (!(scenario === "missing-activation-journal" && active) &&
        !(scenario === "missing-deactivation-journal" && !active)) {
      await appendJournal(active
        ? { type: "swarm_mode.enter", agentId: "main", trigger: scenario === "nonmanual-activation-journal" ? "task" : "manual" }
        : { type: "swarm_mode.exit", agentId: "main" });
    }
    send(res, {
      id: sessionId,
      workspace_id: workspaceId,
      metadata: { cwd: process.cwd() },
      agent_config: { model },
    });
    return;
  }

  const environmentMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/environment$/);
  if (method === "GET" && environmentMatch) {
    if (decodeURIComponent(environmentMatch[1]) !== sessionId) {
      send(res, null, { code: 40401, msg: `missing session ${token}` });
      return;
    }
    send(res, {
      workspace_id: scenario === "ws-environment-workspace" ? "wd_other" : workspaceId,
      environment_id: scenario === "ws-environment-remote" ? "build" : "local",
      cwd: scenario === "ws-environment-cwd" ? "/other" : process.cwd(),
    });
    return;
  }

  const statusMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/status$/);
  if (method === "GET" && statusMatch) {
    if (decodeURIComponent(statusMatch[1]) !== sessionId) {
      send(res, null, { code: 40401, msg: `missing session ${token}` });
      return;
    }
    const effectiveStatusDelayMs = swarmMode ? statusDelayMs : deactivateStatusDelayMs;
    if (effectiveStatusDelayMs > 0) await sleep(effectiveStatusDelayMs);
    const reportedSwarm = scenario === "status-swarm-mismatch" && swarmMode ? false : swarmMode;
    const planMode = ((scenario === "status-plan-mismatch" || scenario === "composite-failure") && swarmMode) ||
      scenario === "deactivation-plan-mismatch";
    send(res, {
      busy: false,
      model: scenario === "status-model-mismatch" && swarmMode ? "wrong-model" : model,
      thinking_level: "medium",
      permission,
      plan_mode: planMode,
      swarm_mode: reportedSwarm,
      context_tokens: 0,
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/v1/shutdown") {
    send(res, { ok: true });
    setTimeout(() => shutdown(0), shutdownDelayMs);
    return;
  }

  send(res, null, { code: 40401, msg: `unknown route ${token} ${configCanary}` });
}

async function runPrint(args) {
  const resumeIndex = args.indexOf("-r");
  const resumedSession = resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;
  const announcedSession = scenario === "session-mismatch"
    ? "session_other"
    : resumedSession ?? "session_print";
  await record({ kind: "print", argv: args, cwd: process.cwd(), env: safeEnvironment() });
  if (printDelayMs > 0) await sleep(printDelayMs);
  process.stdout.write(`${JSON.stringify({ role: "meta", type: "system.version", version })}\n`);
  if (scenario === "deactivate-rest-failure" || scenario === "hook-evidence") {
    const call = {
      id: "print-plan-1",
      type: "function",
      function: { name: "EnterPlanMode", arguments: "{}" },
    };
    process.stdout.write(`${JSON.stringify({ role: "assistant", tool_calls: [call] })}\n`);
    process.stdout.write(`${JSON.stringify({ role: "tool", tool_call_id: call.id, content: "not the managed denial" })}\n`);
  }
  const prose = process.env.MOCK_KIMI_WEB_PRINT_PROSE ?? "Swarm command prose sentinel.";
  process.stdout.write(`${JSON.stringify({ role: "assistant", content: prose })}\n`);
  process.stdout.write(`${JSON.stringify({
    role: "meta",
    type: "session.resume_hint",
    session_id: announcedSession,
    command: `kimi -r ${announcedSession}`,
    content: `To resume this session: kimi -r ${announcedSession}`,
  })}\n`);
  const diagnostic = process.env.MOCK_KIMI_WEB_PRINT_STDERR;
  if (diagnostic) process.stderr.write(`${diagnostic}\n`);
  return Number.parseInt(process.env.MOCK_KIMI_WEB_PRINT_EXIT_CODE ?? "0", 10);
}

async function runMockDescendant() {
  await record({ kind: "descendant", parent_pid: process.ppid, scenario });
  process.on("SIGTERM", async () => {
    await record({ kind: "descendant-signal", signal: "SIGTERM" });
    if (scenario !== "shutdown-survivor-ignore-term") process.exit(0);
  });
  process.on("SIGINT", () => process.exit(0));
  setInterval(() => undefined, 1_000);
  await new Promise(() => undefined);
}

function maybeSpawnDescendant() {
  if (scenario !== "early-parent-exit" &&
      scenario !== "shutdown-survivor" &&
      scenario !== "shutdown-survivor-ignore-term") return undefined;
  return spawn(process.execPath, [fileURLToPath(import.meta.url), "mock-descendant"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore",
  });
}

function sendWsFrame(socket, value) {
  const payload = Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8");
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function readWsFrame(buffer) {
  if (buffer.length < 2) return undefined;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let payloadLength = buffer[1] & 0x7f;
  let offset = 2;
  if (payloadLength === 126) {
    if (buffer.length < 4) return undefined;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return undefined;
    const wide = buffer.readBigUInt64BE(2);
    if (wide > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("oversized mock frame");
    payloadLength = Number(wide);
    offset = 10;
  }
  const maskOffset = offset;
  if (masked) offset += 4;
  const end = offset + payloadLength;
  if (buffer.length < end) return undefined;
  const payload = Buffer.from(buffer.subarray(offset, end));
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  }
  return { opcode, text: payload.toString("utf8"), consumed: end };
}

function handleWsMessage(socket, frame) {
  void record({ kind: "ws-message", frame });
  if (["2.6.0", "2.6.2"].includes(version)) {
    handleWsMessageV26(socket, frame);
    return;
  }
  if (frame.type === "client_hello") {
    sendWsFrame(socket, {
      type: "ack",
      id: scenario === "ws-wrong-hello-id" ? "wrong-hello-id" : frame.id,
      code: scenario === "ws-hello-reject" ? 40112 : 0,
      msg: scenario === "ws-hello-reject" ? "unauthorized" : "success",
      payload: {},
    });
    return;
  }
  if (frame.type !== "subscribe_v2") return;
  if (scenario === "ws-malformed-json") {
    sendWsFrame(socket, "{not-json");
    return;
  }
  if (scenario === "ws-oversize-frame") {
    sendWsFrame(socket, "x".repeat(1024 * 1024));
  }
  if (scenario !== "ws-no-state") {
    const reportedSwarm = scenario === "ws-swarm-mismatch" && swarmMode ? false : swarmMode;
    const planMode = (scenario === "ws-plan-mismatch" && swarmMode) ||
      scenario === "ws-deactivation-plan-mismatch";
    const agentFrame = {
      type: "agent",
      session_id: scenario === "ws-wrong-session" ? "session_other" : sessionId,
      agent_id: scenario === "ws-wrong-agent" ? "agent-0" : "main",
      event_created_at: new Date().toISOString(),
      status: "idle",
      model: scenario === "ws-missing-model" ? undefined : scenario === "ws-model-mismatch" && swarmMode ? "wrong-model" : model,
      thinking: "medium",
      permission_mode: scenario === "ws-missing-permission" ? undefined : scenario === "ws-permission-mismatch" ? "manual" : permission,
      plan_mode: scenario === "ws-malformed-state" ? "false" : planMode,
      swarm_mode: reportedSwarm,
      tower_mode: scenario === "ws-tower-mismatch",
    };
    sendWsFrame(socket, agentFrame);
    if (scenario === "ws-contradictory-state") {
      sendWsFrame(socket, { ...agentFrame, swarm_mode: !reportedSwarm });
    }
  }
  if (scenario === "ws-close-before-ack") {
    socket.end();
    return;
  }
  if (scenario === "ws-missing-ack") return;
  const rejected = scenario === "ws-subscription-reject" || scenario === "ws-unacknowledged-state";
  sendWsFrame(socket, {
    type: "ack",
    id: scenario === "ws-wrong-subscribe-id" ? "wrong-subscribe-id" : frame.id,
    code: rejected ? 40401 : 0,
    msg: rejected ? "not found" : "success",
    payload: { accepted: rejected ? [] : [sessionId], not_found: rejected ? [sessionId] : [] },
  });
}

function handleWsMessageV26(socket, frame) {
  if (frame.type !== "subscribe") return;
  if (scenario === "ws-malformed-json") {
    sendWsFrame(socket, "{not-json");
    return;
  }
  if (scenario === "ws-oversize-frame") {
    sendWsFrame(socket, "x".repeat(1024 * 1024));
  }
  if (scenario === "ws-close-before-ack") {
    socket.end();
    return;
  }
  if (scenario === "ws-missing-ack") return;
  const rejected = scenario === "ws-subscription-reject";
  if (scenario !== "ws-unacknowledged-state") {
    sendWsFrame(socket, {
      type: "response",
      request_id: scenario === "ws-wrong-subscribe-id" ? "wrong-subscribe-id" : frame.request_id,
      code: rejected ? 40401 : 0,
      msg: rejected ? "not found" : "success",
    });
  }
  if (rejected || scenario === "ws-no-state") return;
  const reportedSwarm = scenario === "ws-swarm-mismatch" && swarmMode ? false : swarmMode;
  const planMode = (scenario === "ws-plan-mismatch" && swarmMode) ||
    scenario === "ws-deactivation-plan-mismatch";
  const agentFrame = {
    type: "agent",
    session_id: scenario === "ws-wrong-session" ? "session_other" : sessionId,
    agent_id: scenario === "ws-wrong-agent" ? "agent-0" : "main",
    event_created_at: new Date().toISOString(),
    status: "idle",
    compacting: false,
    model: scenario === "ws-missing-model" ? undefined : scenario === "ws-model-mismatch" && swarmMode ? "wrong-model" : model,
    thinking: "medium",
    permission_mode: scenario === "ws-missing-permission" ? undefined : scenario === "ws-permission-mismatch" ? "manual" : permission,
    plan_mode: scenario === "ws-malformed-state" ? "false" : planMode,
    swarm_mode: reportedSwarm,
    tower_mode: scenario === "ws-tower-mismatch",
  };
  sendWsFrame(socket, agentFrame);
  if (scenario === "ws-contradictory-state") {
    sendWsFrame(socket, { ...agentFrame, swarm_mode: !reportedSwarm });
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch(() => {
    if (!res.headersSent) send(res, null, { status: 500, code: 50001, msg: `internal ${token} ${configCanary}` });
    else res.destroy();
  });
});

server.on("upgrade", (req, socket, head) => {
  const expectedProtocol = `kimi-code.bearer.${token}`;
  const protocols = (req.headers["sec-websocket-protocol"] ?? "").split(",").map((value) => value.trim());
  if (req.url !== "/api/v1/ws" || scenario === "ws-auth-reject" || !protocols.includes(expectedProtocol)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    `Sec-WebSocket-Protocol: ${expectedProtocol}`,
    "\r\n",
  ].join("\r\n"));
  void record({ kind: "ws-open", path: req.url });
  let buffered = Buffer.from(head);
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    try {
      while (true) {
        const next = readWsFrame(buffered);
        if (next === undefined) break;
        buffered = buffered.subarray(next.consumed);
        if (next.opcode === 8) {
          if (scenario !== "ws-close-timeout") socket.end(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
          return;
        }
        if (next.opcode !== 1) continue;
        handleWsMessage(socket, JSON.parse(next.text));
      }
    } catch {
      socket.destroy();
    }
  });
  if (!["2.6.0", "2.6.2"].includes(version) && scenario !== "ws-no-server-hello") {
    sendWsFrame(socket, {
      type: "server_hello",
      timestamp: new Date().toISOString(),
      payload: {
        ws_connection_id: "mock-ws-connection",
        protocol_version: scenario === "ws-server-version" ? 1 : 2,
        heartbeat_ms: 10_000,
        capabilities: { event_batching: false, compression: false },
      },
    });
  }
});

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeAllConnections();
  setTimeout(() => process.exit(code), 0);
}

server.on("error", () => shutdown(1));

await mkdir(path.dirname(logPath ?? path.join(home, "mock")), { recursive: true });
const args = process.argv.slice(2);
if (args[0] === "mock-descendant") {
  await runMockDescendant();
} else if (args.includes("--version")) {
  process.stdout.write(`${version}\n`);
  process.exit(0);
} else if (args.includes("-p")) {
  process.exit(await runPrint(args));
}

process.on("SIGTERM", async () => {
  if (scenario === "ignore-sigterm" || scenario === "late-fork-after-parent-exit") {
    await record({ kind: "parent-signal", signal: "SIGTERM" });
    return;
  }
  shutdown(0);
});
process.on("SIGINT", () => shutdown(0));
process.on("exit", () => {
  if (scenario !== "late-fork-after-parent-exit") return;
  spawn(process.execPath, [fileURLToPath(import.meta.url), "mock-descendant"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore",
  });
});

const descendant = maybeSpawnDescendant();
await record({
  kind: "spawn",
  argv: args,
  env: safeEnvironment(),
  descendant_pid: descendant?.pid ?? null,
});
server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    shutdown(1);
    return;
  }
  if (scenario === "early-parent-exit") {
    setTimeout(() => process.exit(1), 300);
    return;
  }
  if (readyDelayMs > 0) await sleep(readyDelayMs);
  if (stopping) return;
  if (scenario === "rest-failure") {
    process.stdout.write(`diagnostic ${token} ${configCanary}\n`);
    process.stderr.write(`diagnostic ${token} ${configCanary}\n`);
  }
  const tokenless = scenario === "tokenless-ready" || scenario === "late-fork-after-parent-exit";
  process.stdout.write(`Kimi server: http://127.0.0.1:${address.port}/${tokenless ? "" : `#token=${token}`}\n`);
  if (scenario === "late-fork-after-parent-exit") {
    setTimeout(() => process.exit(1), 200);
  }
});
