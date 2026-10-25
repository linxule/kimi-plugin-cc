#!/usr/bin/env node

import { spawn } from "node:child_process";
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
const defaultModel = process.env.MOCK_KIMI_WEB_DEFAULT_MODEL ?? "configured-default";
const readyDelayMs = Number.parseInt(process.env.MOCK_KIMI_WEB_READY_DELAY_MS ?? "0", 10);
const statusDelayMs = Number.parseInt(process.env.MOCK_KIMI_WEB_STATUS_DELAY_MS ?? "0", 10);
const deactivateStatusDelayMs = Number.parseInt(process.env.MOCK_KIMI_WEB_DEACTIVATE_STATUS_DELAY_MS ?? "0", 10);
const createSessionDelayMs = Number.parseInt(process.env.MOCK_KIMI_WEB_CREATE_SESSION_DELAY_MS ?? "0", 10);
const printDelayMs = Number.parseInt(process.env.MOCK_KIMI_WEB_PRINT_DELAY_MS ?? "0", 10);
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
      server_version: scenario === "meta-version-mismatch" ? "2.3.1" : "2.3.2",
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
    setTimeout(() => shutdown(0), 10);
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
  process.stdout.write(`${JSON.stringify({ role: "meta", type: "system.version", version: "2.3.2" })}\n`);
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

const server = createServer((req, res) => {
  handle(req, res).catch(() => {
    if (!res.headersSent) send(res, null, { status: 500, code: 50001, msg: `internal ${token} ${configCanary}` });
    else res.destroy();
  });
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
  process.stdout.write("2.3.2\n");
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
