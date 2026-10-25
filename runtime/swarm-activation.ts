import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import {
  buildKimiCliEnvironment,
  type CliClientEnvironmentOptions,
} from "./cli-client.js";
import { RuntimeError } from "./errors.js";
import { assertPrefixArgsSafe } from "./kimi-command.js";
import {
  assertExecutionPlanMatchesSpawn,
  assertNoUnsafeExperimentalSelector,
} from "./kimi-engine.js";
import { resolveKimiHome } from "./kimi-home.js";
import { assertNativeV2Preflight } from "./native-v2-preflight.js";
import {
  collectDescendantIdentities,
  collectProcessGroupsIdentities,
  probeProcessIdentity,
  revalidateProcessIdentities,
  waitForProcessTreeExit,
  type ProcessIdentity,
} from "./process-tree.js";

const PREACTIVATION_VERSION = "2.3.2";
const READY_TIMEOUT_MS = 10_000;
const REST_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const JOURNAL_TIMEOUT_MS = 2_000;
const JOURNAL_POLL_MS = 50;
const READY_LINE_MAX_CHARS = 65_536;
const REST_RESPONSE_MAX_BYTES = 1024 * 1024;
const JOURNAL_MAX_BYTES = 64 * 1024 * 1024;
const DESCENDANT_SNAPSHOT_TIMEOUT_MS = 2_000;
const DESCENDANT_TRACK_INTERVAL_MS = 50;
const IDENTITY_REVALIDATION_TIMEOUT_MS = 250;
const ESCALATION_MS = 1_500;
const POST_KILL_QUIESCENCE_MS = 500;
const ENV_MODEL_ALIAS = "__kimi_env_model__";

export interface SwarmActivationOptions extends CliClientEnvironmentOptions {
  readonly command: string;
  readonly prefixArgs?: readonly string[];
  readonly commandLabel: "swarm" | "swarm-write";
  readonly model?: string;
  readonly signal?: AbortSignal;
  readonly expectedVersion?: string;
}

export interface SwarmSessionIdentity {
  readonly sessionId: string;
  readonly workspaceId: string;
}

interface PreparedSpawn {
  readonly expectedVersion: string;
  readonly env: NodeJS.ProcessEnv;
  readonly kimiHome: string;
}

interface ChildSettlement {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface OwnedWebChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closePromise: Promise<ChildSettlement>;
  readonly descendants: ProcessIdentity[];
  exited: boolean;
  processError: boolean;
  trackingStopped: boolean;
  trackerPromise?: Promise<void>;
  refreshPromise?: Promise<void>;
  lastSnapshotComplete: boolean;
  snapshotIncomplete: boolean;
  rootIdentity?: ProcessIdentity;
  cleanupSummary?: string;
}

interface ReadyWebChild extends OwnedWebChild {
  readonly origin: string;
  readonly token: string;
}

type FailureCode = "SWARM_ACTIVATION_FAILED" | "SWARM_SESSION_CLEANUP_FAILED";
type SwarmJournalState = "missing" | "unreadable" | "enter" | "exit" | "other";

export function requiresSwarmPreactivation(version: string | null): boolean {
  return version === PREACTIVATION_VERSION;
}

export async function preactivateSwarmSession(
  options: SwarmActivationOptions,
): Promise<SwarmSessionIdentity> {
  const failureCode: FailureCode = "SWARM_ACTIVATION_FAILED";
  let web: ReadyWebChild | undefined;
  let identity: SwarmSessionIdentity | undefined;
  let profileMutationAttempted = false;

  try {
    const prepared = await prepareWebSpawn(options, failureCode);
    throwIfAborted(options.signal, failureCode, "swarm-activation.pre-spawn");
    web = await startWebChild(options, prepared.env, failureCode);
    await verifyMeta(web, prepared.expectedVersion, options.signal, failureCode);
    const model = await resolveProfileModel(web, options, failureCode);
    identity = await createSession(web, options, failureCode);
    profileMutationAttempted = true;
    await postSwarmProfile(web, identity, true, model, options.signal, failureCode);
    await verifySwarmStatus(web, identity, true, model, options.signal, failureCode);
    await shutdownWeb(web, options.signal, failureCode);
    await requireSwarmJournal(
      prepared.kimiHome,
      identity,
      "enter",
      options.signal,
      failureCode,
    );
    throwIfAborted(options.signal, failureCode, "swarm-activation.complete");
    return identity;
  } catch (error) {
    const primary = asSafeFailure(error, failureCode, "swarm-activation");
    if (web !== undefined && !(await teardownOwnedChild(web))) {
      const cleanupError = failure(
        "SWARM_SESSION_CLEANUP_FAILED",
        "swarm-activation.process-cleanup",
        "The Kimi web process tree did not become quiescent after activation failed.",
      );
      throw failure(
        "SWARM_SESSION_CLEANUP_FAILED",
        "swarm-activation.process-cleanup",
        "Swarm preactivation failed and its web process tree could not be verified quiescent.",
        {
          activation_error: errorReference(primary),
          cleanup_error: errorReference(cleanupError),
          process_cleanup_unverified: true,
          cancelled: primary.details.cancelled === true,
          ...(profileMutationAttempted && identity !== undefined
            ? { session_id: identity.sessionId, workspace_id: identity.workspaceId }
            : {}),
        },
      );
    }
    if (profileMutationAttempted && identity !== undefined) {
      throw new RuntimeError(primary.code, primary.message, primary.stage, {
        details: {
          ...primary.details,
          cleanup_unverified: true,
          session_id: identity.sessionId,
          workspace_id: identity.workspaceId,
        },
      });
    }
    throw primary;
  }
}

export async function deactivateSwarmSession(
  options: SwarmActivationOptions & SwarmSessionIdentity,
): Promise<void> {
  const failureCode: FailureCode = "SWARM_SESSION_CLEANUP_FAILED";
  let web: ReadyWebChild | undefined;
  try {
    // Cleanup must still run when activation left no journal or the print run tainted it;
    // the print spawn owns resume plan-taint refusal.
    const prepared = await prepareWebSpawn(options, failureCode);
    throwIfAborted(options.signal, failureCode, "swarm-deactivation.pre-spawn");
    web = await startWebChild(options, prepared.env, failureCode);
    await verifyMeta(web, prepared.expectedVersion, options.signal, failureCode);
    await postSwarmProfile(
      web,
      options,
      false,
      undefined,
      options.signal,
      failureCode,
    );
    await verifySwarmStatus(
      web,
      options,
      false,
      undefined,
      options.signal,
      failureCode,
    );
    await shutdownWeb(web, options.signal, failureCode);
    await requireSwarmJournal(
      prepared.kimiHome,
      options,
      "exit",
      options.signal,
      failureCode,
    );
    throwIfAborted(options.signal, failureCode, "swarm-deactivation.complete");
  } catch (error) {
    const primary = asSafeFailure(error, failureCode, "swarm-deactivation");
    if (web !== undefined && !(await teardownOwnedChild(web))) {
      throw failure(
        "SWARM_SESSION_CLEANUP_FAILED",
        "swarm-deactivation.process-cleanup",
        `Swarm deactivation failed and the Kimi web process tree did not become quiescent (${web.cleanupSummary ?? "summary unavailable"}).`,
        { cleanup_error: errorReference(primary) },
      );
    }
    throw primary;
  }
}

async function prepareWebSpawn(
  options: SwarmActivationOptions,
  failureCode: FailureCode,
): Promise<PreparedSpawn> {
  throwIfAborted(options.signal, failureCode, "swarm-activation.pre-spawn");
  const prefixArgs = options.prefixArgs ?? [];
  assertExecutionPlanMatchesSpawn(
    options.executionPlan,
    options.command,
    prefixArgs,
    options.env,
  );
  if (options.commandLabel === "swarm-write" && !options.trustedWorkspaceRoot) {
    throw new RuntimeError(
      "CLI_TRUSTED_WORKSPACE_ROOT_MISSING",
      "Refusing swarm-write: write-capable plugin launches require a plugin-owned trusted workspace root.",
      "swarm-activation.pre-spawn",
      { details: { command_label: options.commandLabel } },
    );
  }
  assertNoUnsafeExperimentalSelector(options.env, "swarm-activation.pre-spawn");
  assertPrefixArgsSafe(prefixArgs);

  if (
    options.expectedVersion !== undefined &&
    options.executionPlan.kimiVersion !== null &&
    options.expectedVersion !== options.executionPlan.kimiVersion
  ) {
    throw failure(
      failureCode,
      "swarm-activation.version",
      "expectedVersion must match the execution plan version when that version is known.",
    );
  }
  const expectedVersion = options.expectedVersion ?? options.executionPlan.kimiVersion;
  if (expectedVersion === null || !requiresSwarmPreactivation(expectedVersion)) {
    throw failure(
      failureCode,
      "swarm-activation.version",
      `Swarm web preactivation requires exact kimi-code ${PREACTIVATION_VERSION}.`,
    );
  }

  const kimiHome = resolveKimiHome(options.env, options.cwd);
  if (options.executionPlan.intendedEngine === "native-v2") {
    await assertNativeV2Preflight({
      kimiHome,
      env: options.env,
      stage: "swarm-activation.pre-spawn",
    });
  }
  throwIfAborted(options.signal, failureCode, "swarm-activation.pre-spawn");
  return {
    expectedVersion,
    env: buildKimiCliEnvironment(options),
    kimiHome,
  };
}

async function startWebChild(
  options: SwarmActivationOptions,
  env: NodeJS.ProcessEnv,
  failureCode: FailureCode,
): Promise<ReadyWebChild> {
  const args = [
    ...(options.prefixArgs ?? []),
    "web",
    "--no-open",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--log-level",
    "error",
  ];
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.command, args, {
      cwd: options.cwd,
      env,
      stdio: "pipe",
      detached: process.platform !== "win32",
    });
  } catch {
    throw failure(
      failureCode,
      "swarm-activation.spawn",
      "Failed to spawn the Kimi web lifecycle process.",
    );
  }

  let exited = false;
  let processError = false;
  let settleClose!: (settlement: ChildSettlement) => void;
  const closePromise = new Promise<ChildSettlement>((resolve) => {
    settleClose = resolve;
  });
  child.once("exit", () => {
    exited = true;
  });
  child.once("close", (exitCode, signal) => {
    exited = true;
    settleClose({ exitCode, signal });
  });
  child.on("error", () => {
    processError = true;
  });
  child.stdout.on("data", () => undefined);
  child.stderr.on("data", () => undefined);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  try {
    child.stdin.end();
  } catch {
  }

  const owned: OwnedWebChild = {
    child,
    closePromise,
    descendants: [],
    trackingStopped: false,
    lastSnapshotComplete: false,
    snapshotIncomplete: false,
    get exited() {
      return exited;
    },
    get processError() {
      return processError;
    },
  };
  startDescendantTracking(owned);

  try {
    const ready = await waitForReadyLine(owned, options.signal, failureCode);
    await refreshOwnedDescendants(owned);
    return Object.assign(owned, ready);
  } catch (error) {
    const primary = asSafeFailure(error, failureCode, "swarm-activation.ready");
    if (!(await teardownOwnedChild(owned))) {
      throw failure(
        "SWARM_SESSION_CLEANUP_FAILED",
        "swarm-activation.ready-cleanup",
        "The Kimi web process tree did not become quiescent after startup failed.",
        { activation_error: errorReference(primary), process_cleanup_unverified: true },
      );
    }
    throw primary;
  }
}

async function waitForReadyLine(
  owned: OwnedWebChild,
  signal: AbortSignal | undefined,
  failureCode: FailureCode,
): Promise<{ origin: string; token: string }> {
  throwIfAborted(signal, failureCode, "swarm-activation.ready");
  return await new Promise((resolve, reject) => {
    let buffered = "";
    let settled = false;
    const timer = setTimeout(() => {
      settle(failure(
        failureCode,
        "swarm-activation.ready",
        "Timed out waiting for the Kimi web ready line.",
        { timeout_ms: READY_TIMEOUT_MS },
      ));
    }, READY_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      owned.child.stdout.off("data", onStdout);
      owned.child.off("error", onError);
      owned.child.off("close", onClose);
    };
    const settle = (result: { origin: string; token: string } | RuntimeError) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (result instanceof RuntimeError) reject(result);
      else resolve(result);
    };
    const onAbort = () => {
      settle(cancelledFailure(failureCode, "swarm-activation.ready"));
    };
    const onError = () => {
      settle(failure(
        failureCode,
        "swarm-activation.process",
        "The Kimi web process failed before becoming ready.",
      ));
    };
    const onClose = () => {
      settle(failure(
        failureCode,
        "swarm-activation.process",
        "The Kimi web process exited before becoming ready.",
      ));
    };
    const onStdout = (chunk: string) => {
      buffered += chunk;
      if (buffered.length > READY_LINE_MAX_CHARS) {
        settle(failure(
          failureCode,
          "swarm-activation.ready",
          "The Kimi web ready line exceeded the bounded parser limit.",
        ));
        return;
      }
      while (buffered.includes("\n")) {
        const newline = buffered.indexOf("\n");
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        if (!line.startsWith("Kimi server: ")) continue;
        try {
          settle(parseReadyLine(line));
        } catch {
          settle(failure(
            failureCode,
            "swarm-activation.ready",
            "The Kimi web ready line was not an authenticated loopback URL in the expected format.",
          ));
        }
        return;
      }
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    owned.child.stdout.on("data", onStdout);
    owned.child.on("error", onError);
    owned.child.on("close", onClose);
    if (signal?.aborted === true) onAbort();
  });
}

function parseReadyLine(line: string): { origin: string; token: string } {
  const candidate = line.slice("Kimi server: ".length);
  const parsed = new URL(candidate);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port.length === 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new Error("invalid ready URL");
  }
  if (!parsed.hash.startsWith("#token=") || parsed.hash.length === "#token=".length) {
    throw new Error("invalid ready token");
  }
  return {
    origin: parsed.origin,
    token: parsed.hash.slice("#token=".length),
  };
}

async function verifyMeta(
  web: ReadyWebChild,
  expectedVersion: string,
  signal: AbortSignal | undefined,
  failureCode: FailureCode,
): Promise<void> {
  const data = await restData(web, "GET", "/api/v1/meta", undefined, signal, failureCode);
  if (!isRecord(data)) {
    throw failure(failureCode, "swarm-activation.meta", "Kimi web /meta returned an invalid payload.");
  }
  if (data.backend !== "v2") {
    throw failure(failureCode, "swarm-activation.meta", "Kimi web /meta did not confirm the v2 backend.");
  }
  if (data.dangerous_bypass_auth !== false) {
    throw failure(failureCode, "swarm-activation.meta", "Refusing a Kimi web server with authentication bypass enabled.");
  }
  if (data.server_version !== expectedVersion) {
    throw failure(failureCode, "swarm-activation.meta", "Kimi web /meta server_version did not exactly match the execution plan.");
  }
}

async function resolveProfileModel(
  web: ReadyWebChild,
  options: SwarmActivationOptions,
  failureCode: FailureCode,
): Promise<string> {
  if (options.model !== undefined) {
    if (options.model.length === 0) {
      throw failure(failureCode, "swarm-activation.model", "The explicit swarm model alias is empty.");
    }
    return options.model;
  }
  if (options.env.KIMI_MODEL_NAME?.trim()) return ENV_MODEL_ALIAS;
  const data = await restData(
    web,
    "GET",
    "/api/v1/config",
    undefined,
    options.signal,
    failureCode,
  );
  if (!isRecord(data) || typeof data.default_model !== "string" || data.default_model.trim().length === 0) {
    throw failure(failureCode, "swarm-activation.model", "Kimi web /config did not provide a usable default_model.");
  }
  return data.default_model;
}

async function createSession(
  web: ReadyWebChild,
  options: SwarmActivationOptions,
  failureCode: FailureCode,
): Promise<SwarmSessionIdentity> {
  const data = await restData(
    web,
    "POST",
    "/api/v1/sessions",
    { metadata: { cwd: options.cwd } },
    options.signal,
    failureCode,
  );
  if (!isRecord(data) || !validPathId(data.id) || !validPathId(data.workspace_id)) {
    throw failure(failureCode, "swarm-activation.create-session", "Kimi web returned an invalid session identity.");
  }
  return { sessionId: data.id, workspaceId: data.workspace_id };
}

async function postSwarmProfile(
  web: ReadyWebChild,
  identity: SwarmSessionIdentity,
  active: boolean,
  model: string | undefined,
  signal: AbortSignal | undefined,
  failureCode: FailureCode,
): Promise<void> {
  const agentConfig: Record<string, unknown> = {
    swarm_mode: active,
    permission_mode: "auto",
  };
  if (active) agentConfig.model = model;
  await restData(
    web,
    "POST",
    `/api/v1/sessions/${encodeURIComponent(identity.sessionId)}/profile`,
    { agent_config: agentConfig },
    signal,
    failureCode,
  );
}

async function verifySwarmStatus(
  web: ReadyWebChild,
  identity: SwarmSessionIdentity,
  active: boolean,
  model: string | undefined,
  signal: AbortSignal | undefined,
  failureCode: FailureCode,
): Promise<void> {
  const data = await restData(
    web,
    "GET",
    `/api/v1/sessions/${encodeURIComponent(identity.sessionId)}/status`,
    undefined,
    signal,
    failureCode,
  );
  if (!isRecord(data)) {
    throw failure(failureCode, "swarm-activation.status", "Kimi web /status returned an invalid payload.");
  }
  if (data.swarm_mode !== active) {
    throw failure(
      failureCode,
      "swarm-activation.status",
      `Kimi web /status did not confirm swarm_mode=${active}.`,
      { expected_swarm_mode: active },
    );
  }
  if (data.plan_mode !== false) {
    throw failure(failureCode, "swarm-activation.status", "Kimi web /status did not confirm plan mode is off.");
  }
  if (data.permission !== "auto") {
    throw failure(failureCode, "swarm-activation.status", "Kimi web /status did not confirm auto permission mode.");
  }
  if (active && data.model !== model) {
    throw failure(failureCode, "swarm-activation.status", "Kimi web /status did not confirm the selected model alias.");
  }
}

async function shutdownWeb(
  web: ReadyWebChild,
  signal: AbortSignal | undefined,
  failureCode: FailureCode,
): Promise<void> {
  await restData(web, "POST", "/api/v1/shutdown", undefined, signal, failureCode);
  const settlement = await waitForChildClose(web, signal, failureCode);
  if (!(await teardownOwnedChild(web))) {
    throw failure(
      failureCode,
      "swarm-activation.shutdown",
      "The Kimi web process tree did not become quiescent after shutdown.",
      { exit_code: settlement.exitCode, signal: settlement.signal },
    );
  }
  if (web.processError || settlement.exitCode !== 0) {
    throw failure(
      failureCode,
      "swarm-activation.shutdown",
      "The Kimi web process did not exit cleanly after shutdown.",
      { exit_code: settlement.exitCode, signal: settlement.signal },
    );
  }
}

async function waitForChildClose(
  web: ReadyWebChild,
  signal: AbortSignal | undefined,
  failureCode: FailureCode,
): Promise<ChildSettlement> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      web.closePromise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(failure(
            failureCode,
            "swarm-activation.shutdown",
            "Timed out waiting for the Kimi web process to shut down.",
            { timeout_ms: SHUTDOWN_TIMEOUT_MS },
          ));
        }, SHUTDOWN_TIMEOUT_MS);
        onAbort = () => reject(cancelledFailure(failureCode, "swarm-activation.shutdown"));
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted === true) onAbort();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

async function restData(
  web: ReadyWebChild,
  method: "GET" | "POST",
  route: string,
  body: unknown,
  signal: AbortSignal | undefined,
  failureCode: FailureCode,
): Promise<unknown> {
  throwIfAborted(signal, failureCode, "swarm-activation.rest");
  await refreshOwnedDescendants(web);
  throwIfAborted(signal, failureCode, "swarm-activation.rest");
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REST_TIMEOUT_MS);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted === true) onAbort();

  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (web.token !== undefined) headers.authorization = `Bearer ${web.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${web.origin}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: controller.signal,
    });
    await refreshOwnedDescendants(web);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw failure(
        failureCode,
        "swarm-activation.rest",
        "Kimi web REST returned an unsuccessful HTTP status.",
        { route, http_status: response.status },
      );
    }
    const text = await readBoundedResponse(response, failureCode, route);
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw failure(
        failureCode,
        "swarm-activation.rest",
        "Kimi web REST returned malformed JSON.",
        { route },
      );
    }
    if (!isRecord(envelope) || !("data" in envelope)) {
      throw failure(
        failureCode,
        "swarm-activation.rest",
        "Kimi web REST returned an invalid response envelope.",
        { route },
      );
    }
    if (envelope.code !== 0) {
      throw failure(
        failureCode,
        "swarm-activation.rest",
        "Kimi web REST returned an unsuccessful business response.",
        {
          route,
          business_code: typeof envelope.code === "number" ? envelope.code : null,
        },
      );
    }
    return envelope.data;
  } catch (error) {
    if (signal?.aborted === true) throw cancelledFailure(failureCode, "swarm-activation.rest");
    if (timedOut) {
      throw failure(
        failureCode,
        "swarm-activation.rest",
        "Kimi web REST timed out.",
        { route, timeout_ms: REST_TIMEOUT_MS },
      );
    }
    if (error instanceof RuntimeError) throw error;
    throw failure(
      failureCode,
      "swarm-activation.rest",
      "Kimi web REST failed before a valid response was received.",
      { route },
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function readBoundedResponse(
  response: Response,
  failureCode: FailureCode,
  route: string,
): Promise<string> {
  if (response.body === null) {
    throw failure(failureCode, "swarm-activation.rest", "Kimi web REST returned an empty response.", { route });
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    size += value.byteLength;
    if (size > REST_RESPONSE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw failure(
        failureCode,
        "swarm-activation.rest",
        "Kimi web REST response exceeded the bounded size limit.",
        { route, max_bytes: REST_RESPONSE_MAX_BYTES },
      );
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

async function requireSwarmJournal(
  kimiHome: string,
  identity: SwarmSessionIdentity,
  expected: "enter" | "exit",
  signal: AbortSignal | undefined,
  failureCode: FailureCode,
): Promise<void> {
  const stage = expected === "enter" ? "swarm-activation.journal" : "swarm-deactivation.journal";
  const journalPath = path.join(
    kimiHome,
    "sessions",
    identity.workspaceId,
    identity.sessionId,
    "agents",
    "main",
    "wire.jsonl",
  );
  const deadline = Date.now() + JOURNAL_TIMEOUT_MS;
  let observed: SwarmJournalState = "missing";
  while (true) {
    throwIfAborted(signal, failureCode, stage);
    observed = await readSwarmJournalState(journalPath);
    if (observed === expected) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw failure(
        failureCode,
        stage,
        `The main-agent journal did not confirm swarm_mode.${expected === "enter" ? "enter with manual trigger" : "exit"}.`,
        { journal_state: observed, timeout_ms: JOURNAL_TIMEOUT_MS },
      );
    }
    await delay(Math.min(JOURNAL_POLL_MS, remaining), signal, failureCode, stage);
  }
}

async function readSwarmJournalState(journalPath: string): Promise<SwarmJournalState> {
  let handle;
  try {
    handle = await open(
      journalPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable";
  }
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile() || stats.size > BigInt(JOURNAL_MAX_BYTES)) return "unreadable";
    const size = Number(stats.size);
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    let state: SwarmJournalState = "missing";
    for (const rawLine of buffer.subarray(0, offset).toString("utf8").split("\n")) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        if (line.includes("swarm_mode.")) return "unreadable";
        continue;
      }
      if (!isRecord(record)) continue;
      if (record.type === "swarm_mode.enter") {
        state = record.trigger === "manual" ? "enter" : "other";
      } else if (record.type === "swarm_mode.exit") {
        state = "exit";
      }
    }
    return state;
  } catch {
    return "unreadable";
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function startDescendantTracking(owned: OwnedWebChild): void {
  if (process.platform === "win32") return;
  owned.trackerPromise = (async () => {
    while (!owned.trackingStopped && !owned.exited) {
      await refreshOwnedDescendants(owned);
      if (owned.trackingStopped || owned.exited) break;
      await new Promise<void>((resolve) => setTimeout(resolve, DESCENDANT_TRACK_INTERVAL_MS));
    }
  })();
}

async function stopDescendantTracking(owned: OwnedWebChild): Promise<void> {
  owned.trackingStopped = true;
  await owned.trackerPromise;
  await owned.refreshPromise;
}

async function refreshOwnedDescendants(owned: OwnedWebChild): Promise<void> {
  if (process.platform === "win32" || owned.exited) return;
  if (owned.refreshPromise !== undefined) return await owned.refreshPromise;
  const childPid = owned.child.pid;
  if (childPid === undefined) {
    owned.lastSnapshotComplete = true;
    return;
  }
  owned.refreshPromise = (async () => {
    const snapshot = await captureDescendantIdentities(childPid);
    const previousRoot = owned.rootIdentity;
    if (snapshot.root !== undefined) {
      if (previousRoot === undefined) {
        owned.rootIdentity = snapshot.root;
      } else if (previousRoot.startToken !== snapshot.root.startToken) {
        owned.snapshotIncomplete = true;
        owned.lastSnapshotComplete = false;
        return;
      }
    }
    const seen = new Set(owned.descendants.map(identityKey));
    for (const identity of snapshot.identities) {
      const key = identityKey(identity);
      if (seen.has(key)) continue;
      seen.add(key);
      owned.descendants.push(identity);
    }
    if (snapshot.complete && (snapshot.root !== undefined || previousRoot !== undefined)) {
      if (!owned.snapshotIncomplete) owned.lastSnapshotComplete = true;
    } else {
      owned.snapshotIncomplete = true;
      owned.lastSnapshotComplete = false;
    }
  })().finally(() => {
    owned.refreshPromise = undefined;
  });
  return await owned.refreshPromise;
}

async function teardownOwnedChild(owned: OwnedWebChild): Promise<boolean> {
  await stopDescendantTracking(owned);
  const childPid = owned.child.pid;
  if (childPid === undefined) return true;
  try {
    if (process.platform === "win32") {
      if (!owned.exited) {
        try {
          owned.child.kill("SIGTERM");
        } catch {
        }
      }
      const exited = await waitForProcessTreeExit([], ESCALATION_MS, {
        isRootAlive: () => !owned.exited,
      });
      if (!exited) {
        try {
          owned.child.kill("SIGKILL");
        } catch {
        }
        return await waitForProcessTreeExit([], POST_KILL_QUIESCENCE_MS, {
          isRootAlive: () => !owned.exited,
        });
      }
      return true;
    }

    if (!owned.exited) await refreshOwnedDescendants(owned);
    const identities = owned.descendants;
    await signalCapturedTree(owned, childPid, identities, "SIGTERM");
    const exited = await waitForProcessTreeExit(identities, ESCALATION_MS, {
      isRootAlive: () => !owned.exited,
    });
    let quiescent = exited && await processGroupsQuiescent(owned, childPid);
    let killWaitExited: boolean | undefined;
    if (!quiescent) {
      await signalCapturedTree(owned, childPid, identities, "SIGKILL");
      killWaitExited = await waitForProcessTreeExit(identities, POST_KILL_QUIESCENCE_MS, {
        isRootAlive: () => !owned.exited,
      });
      quiescent = killWaitExited && await processGroupsQuiescent(owned, childPid);
    }
    owned.cleanupSummary = [
      `root_exited=${owned.exited}`,
      `first_wait_exited=${exited}`,
      `kill_wait_exited=${killWaitExited ?? "not-run"}`,
      `groups_quiescent=${quiescent}`,
      `last_snapshot_complete=${owned.lastSnapshotComplete}`,
      `descendants=${identities.length}`,
    ].join(", ");
    return quiescent && owned.lastSnapshotComplete;
  } catch {
    if (!owned.exited) {
      if (process.platform !== "win32") trySignalPid(-childPid, "SIGKILL");
      try {
        owned.child.kill("SIGKILL");
      } catch {
      }
    }
    return false;
  }
}

async function processGroupsQuiescent(owned: OwnedWebChild, childPid: number): Promise<boolean> {
  const groupIds = new Set<number>([childPid]);
  for (const identity of owned.descendants) groupIds.add(identity.processGroupId);
  const members = await collectProcessGroupsIdentities([...groupIds]);
  return members !== undefined && members.every((identity) => /^[ZX]/i.test(identity.state.trim()));
}

async function captureDescendantIdentities(
  childPid: number,
): Promise<{ identities: ProcessIdentity[]; complete: boolean; root?: ProcessIdentity }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const snapshot = await Promise.race([
      Promise.all([
        collectDescendantIdentities(childPid),
        probeProcessIdentity(childPid),
      ]),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), DESCENDANT_SNAPSHOT_TIMEOUT_MS);
      }),
    ]);
    if (snapshot === null) return { identities: [], complete: false };
    const [collected, rootProbe] = snapshot;
    const identities: ProcessIdentity[] = [];
    const seen = new Set<string>();
    for (const identity of collected) {
      const key = identityKey(identity);
      if (
        Number.isInteger(identity.pid) &&
        identity.pid > 0 &&
        identity.pid !== childPid &&
        Number.isInteger(identity.processGroupId) &&
        identity.processGroupId > 0 &&
        identity.startToken.length > 0 &&
        !seen.has(key)
      ) {
        seen.add(key);
        identities.push({ ...identity });
      }
    }
    return { identities, complete: rootProbe.complete, root: rootProbe.identity };
  } catch {
    return { identities: [], complete: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function identityKey(identity: ProcessIdentity): string {
  return `${identity.pid}:${identity.startToken}:${identity.processGroupId}`;
}

async function signalCapturedTree(
  owned: OwnedWebChild,
  childPid: number,
  identities: readonly ProcessIdentity[],
  signal: NodeJS.Signals,
): Promise<void> {
  if (!owned.exited) {
    trySignalPid(-childPid, signal);
    try {
      owned.child.kill(signal);
    } catch {
    }
  }
  const pidValidation = await revalidateProcessIdentities(identities, {
    timeoutMs: IDENTITY_REVALIDATION_TIMEOUT_MS,
  });
  for (const identity of pidValidation.identities) trySignalPid(identity.pid, signal);

  const activeGroupIds = new Set(
    pidValidation.identities.map((identity) => identity.processGroupId),
  );
  if (owned.exited) {
    if (!pidValidation.identities.some((identity) => identity.processGroupId === childPid)) {
      activeGroupIds.delete(childPid);
    }
  } else {
    activeGroupIds.delete(childPid);
  }
  for (const processGroupId of activeGroupIds) trySignalPid(-processGroupId, signal);
}

function trySignalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
  }
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  code: FailureCode,
  stage: string,
): void {
  if (signal?.aborted === true) throw cancelledFailure(code, stage);
}

function cancelledFailure(code: FailureCode, stage: string): RuntimeError {
  return failure(code, stage, "Swarm web lifecycle cancelled by the caller.", { cancelled: true });
}

function failure(
  code: FailureCode,
  stage: string,
  message: string,
  details: Record<string, unknown> = {},
): RuntimeError {
  return new RuntimeError(code, message, stage, { details });
}

function asSafeFailure(error: unknown, code: FailureCode, stage: string): RuntimeError {
  if (error instanceof RuntimeError) return error;
  return failure(code, stage, "The swarm web lifecycle failed without a safe diagnostic payload.");
}

function errorReference(error: RuntimeError): Record<string, unknown> {
  return {
    code: error.code,
    stage: error.stage,
    cancelled: error.details.cancelled === true,
  };
}

function validPathId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function delay(
  ms: number,
  signal: AbortSignal | undefined,
  code: FailureCode,
  stage: string,
): Promise<void> {
  throwIfAborted(signal, code, stage);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledFailure(code, stage));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
}
