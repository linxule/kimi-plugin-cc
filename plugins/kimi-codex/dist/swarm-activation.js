import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { assertWorkspaceSpellable, buildKimiCliEnvironment, } from "./cli-client.js";
import { RuntimeError } from "./errors.js";
import { assertPrefixArgsSafe } from "./kimi-command.js";
import { assertExecutionPlanMatchesSpawn, assertNoUnsafeExperimentalSelector, } from "./kimi-engine.js";
import { resolveKimiHome } from "./kimi-home.js";
import { kimiJournalRecords, UNPARSEABLE_JOURNAL_LINE } from "./kimi-journal.js";
import { kimiReleaseHas, kimiVersionsWith } from "./kimi-releases.js";
import { assertNativeV2Preflight } from "./native-v2-preflight.js";
import { usesBoundedSwarmPolicy } from "./swarm-policy.js";
import { installBoundedSwarmToolPolicy } from "./swarm-tool-policy.js";
import { sleep } from "./util.js";
import { collectDescendantIdentities, collectProcessGroupsIdentities, probeProcessIdentity, retryIncompleteCapture, revalidateProcessIdentities, waitForProcessTreeExit, } from "./process-tree.js";
// Exact 2.8.0+ preactivation releases; production scope is enforced per operation.
const PREACTIVATION_VERSIONS = kimiVersionsWith("web-preactivation");
const KIMI_AGENT_PROTOCOL_VERSION = "1.0.0";
const READY_TIMEOUT_MS = 10_000;
const REST_TIMEOUT_MS = 5_000;
// Exact 2.4.0 can take longer than 5s to drain session/workspace lifecycle work.
const SHUTDOWN_TIMEOUT_MS = 15_000;
const JOURNAL_TIMEOUT_MS = 2_000;
const JOURNAL_POLL_MS = 50;
const READY_LINE_MAX_CHARS = 65_536;
const REST_RESPONSE_MAX_BYTES = 1024 * 1024;
const WEBSOCKET_MAX_FRAMES = 64;
const WEBSOCKET_RESPONSE_MAX_CHARS = 1024 * 1024;
const JOURNAL_MAX_BYTES = 64 * 1024 * 1024;
const DESCENDANT_SNAPSHOT_TIMEOUT_MS = 2_000;
const DESCENDANT_TRACK_INTERVAL_MS = 50;
const IDENTITY_REVALIDATION_TIMEOUT_MS = 250;
const ESCALATION_MS = 1_500;
const POST_KILL_QUIESCENCE_MS = 500;
const ENV_MODEL_ALIAS = "__kimi_env_model__";
export function requiresSwarmPreactivation(version) {
    return version !== null && PREACTIVATION_VERSIONS.includes(version);
}
export async function preactivateSwarmSession(options) {
    const failureCode = "SWARM_ACTIVATION_FAILED";
    let web;
    let identity;
    let profileMutationAttempted = false;
    try {
        const prepared = await prepareWebSpawn(options, failureCode);
        throwIfAborted(options.signal, failureCode, "swarm-activation.pre-spawn");
        web = await startWebChild(options, prepared.env, prepared.expectedVersion, failureCode);
        await verifyMeta(web, prepared.expectedVersion, options.signal, failureCode);
        const model = await resolveProfileModel(web, options, failureCode);
        identity = await createSession(web, options, prepared.expectedVersion, failureCode);
        await verifyLocalEnvironment(web, identity, options.cwd, prepared.expectedVersion, options.signal, failureCode);
        options.onRecoveryEvent?.({ kind: "session", ...identity });
        profileMutationAttempted = true;
        await setSwarmMode(web, prepared, identity, true, model, options.signal, failureCode);
        if (usesBoundedSwarmPolicy(options.executionPlan) && options.swarmMaxConcurrency > 1) {
            await installBoundedSwarmToolPolicy(prepared.kimiHome, identity, options.signal);
        }
        throwIfAborted(options.signal, failureCode, "swarm-activation.complete");
        return identity;
    }
    catch (error) {
        const primary = asSafeFailure(error, failureCode, "swarm-activation");
        if (web !== undefined && !(await teardownOwnedChild(web))) {
            const cleanupError = failure("SWARM_SESSION_CLEANUP_FAILED", "swarm-activation.process-cleanup", "The Kimi web process tree did not become quiescent after activation failed.");
            throw failure("SWARM_SESSION_CLEANUP_FAILED", "swarm-activation.process-cleanup", "Swarm preactivation failed and its web process tree could not be verified quiescent.", {
                activation_error: errorReference(primary),
                cleanup_error: errorReference(cleanupError),
                process_cleanup_unverified: true,
                cancelled: primary.details.cancelled === true,
                ...(profileMutationAttempted && identity !== undefined
                    ? { session_id: identity.sessionId, workspace_id: identity.workspaceId }
                    : {}),
            });
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
export async function deactivateSwarmSession(options) {
    const failureCode = "SWARM_SESSION_CLEANUP_FAILED";
    let web;
    try {
        // Cleanup must still run when activation left no journal or the print run tainted it;
        // the print spawn owns resume plan-taint refusal.
        const prepared = await prepareWebSpawn(options, failureCode);
        throwIfAborted(options.signal, failureCode, "swarm-deactivation.pre-spawn");
        web = await startWebChild(options, prepared.env, prepared.expectedVersion, failureCode);
        await verifyMeta(web, prepared.expectedVersion, options.signal, failureCode);
        await verifyLocalEnvironment(web, options, options.cwd, prepared.expectedVersion, options.signal, failureCode);
        await setSwarmMode(web, prepared, options, false, undefined, options.signal, failureCode);
        options.onRecoveryEvent?.({ kind: "disabled" });
        throwIfAborted(options.signal, failureCode, "swarm-deactivation.complete");
    }
    catch (error) {
        const primary = asSafeFailure(error, failureCode, "swarm-deactivation");
        if (web !== undefined && !(await teardownOwnedChild(web))) {
            throw failure("SWARM_SESSION_CLEANUP_FAILED", "swarm-deactivation.process-cleanup", `Swarm deactivation failed and the Kimi web process tree did not become quiescent (${web.cleanupSummary ?? "summary unavailable"}).`, { cleanup_error: errorReference(primary) });
        }
        throw primary;
    }
}
/** Set swarm mode, prove the resulting state, stop the web child, then require the journal record. */
async function setSwarmMode(web, prepared, identity, active, model, signal, failureCode) {
    await postSwarmProfile(web, identity, active, model, signal, failureCode);
    await verifySwarmStatus(web, identity, active, model, prepared.expectedVersion, signal, failureCode);
    await shutdownWeb(web, signal, failureCode);
    await requireSwarmJournal(prepared.kimiHome, identity, active ? "enter" : "exit", signal, failureCode);
}
async function prepareWebSpawn(options, failureCode) {
    throwIfAborted(options.signal, failureCode, "swarm-activation.pre-spawn");
    const prefixArgs = options.prefixArgs ?? [];
    assertExecutionPlanMatchesSpawn(options.executionPlan, options.command, prefixArgs, options.env);
    if (options.commandLabel === "swarm-write" && !options.trustedWorkspaceRoot) {
        throw new RuntimeError("CLI_TRUSTED_WORKSPACE_ROOT_MISSING", "Refusing swarm-write: write-capable plugin launches require a plugin-owned trusted workspace root.", "swarm-activation.pre-spawn", { details: { command_label: options.commandLabel } });
    }
    if (options.commandLabel === "swarm-write") {
        assertWorkspaceSpellable(options.commandLabel, [options.cwd, options.trustedWorkspaceRoot], "swarm-activation.pre-spawn");
    }
    assertNoUnsafeExperimentalSelector(options.env, "swarm-activation.pre-spawn", options.executionPlan);
    assertPrefixArgsSafe(prefixArgs);
    if (options.expectedVersion !== undefined &&
        options.executionPlan.kimiVersion !== null &&
        options.expectedVersion !== options.executionPlan.kimiVersion) {
        throw failure(failureCode, "swarm-activation.version", "expectedVersion must match the execution plan version when that version is known.");
    }
    const expectedVersion = options.expectedVersion ?? options.executionPlan.kimiVersion;
    if (expectedVersion === null || !requiresSwarmPreactivation(expectedVersion)) {
        throw failure(failureCode, "swarm-activation.version", `Swarm web preactivation requires exact kimi-code ${PREACTIVATION_VERSIONS.join(" or ")}.`);
    }
    const kimiHome = resolveKimiHome(options.env, options.cwd);
    if (options.executionPlan.intendedEngine === "native-v2") {
        await assertNativeV2Preflight({
            kimiHome,
            env: options.env,
            expectedExecutionRoot: options.cwd,
            stage: "swarm-activation.pre-spawn",
            release: options.executionPlan,
        });
    }
    throwIfAborted(options.signal, failureCode, "swarm-activation.pre-spawn");
    return {
        expectedVersion,
        env: buildKimiCliEnvironment(options),
        kimiHome,
    };
}
async function startWebChild(options, env, expectedVersion, failureCode) {
    const args = [
        ...(options.prefixArgs ?? []),
        "web",
        "--json",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--log-level",
        "error",
    ];
    let child;
    options.onRecoveryEvent?.({ kind: "web-spawn" });
    try {
        child = spawn(options.command, args, {
            cwd: options.cwd,
            env,
            stdio: "pipe",
            detached: process.platform !== "win32",
        });
    }
    catch {
        options.onRecoveryEvent?.({ kind: "web-exit" });
        throw failure(failureCode, "swarm-activation.spawn", "Failed to spawn the Kimi web lifecycle process.");
    }
    let exited = false;
    let processError = false;
    let settleClose;
    const closePromise = new Promise((resolve) => {
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
    }
    catch {
    }
    const owned = {
        child,
        closePromise,
        descendants: [],
        onRecoveryEvent: options.onRecoveryEvent,
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
        const ready = await waitForReadyLine(owned, expectedVersion, options.signal, failureCode);
        await refreshOwnedDescendants(owned);
        if (owned.recoveryFailed)
            throw failure(failureCode, "swarm-activation.recovery", "Cannot persist web ownership; refusing session mutation.");
        return Object.assign(owned, ready);
    }
    catch (error) {
        const primary = asSafeFailure(error, failureCode, "swarm-activation.ready");
        if (!(await teardownOwnedChild(owned))) {
            throw failure("SWARM_SESSION_CLEANUP_FAILED", "swarm-activation.ready-cleanup", "The Kimi web process tree did not become quiescent after startup failed.", { activation_error: errorReference(primary), process_cleanup_unverified: true });
        }
        throw primary;
    }
}
async function waitForReadyLine(owned, _expectedVersion, signal, failureCode) {
    throwIfAborted(signal, failureCode, "swarm-activation.ready");
    return await new Promise((resolve, reject) => {
        let buffered = "";
        let settled = false;
        const timer = setTimeout(() => {
            settle(failure(failureCode, "swarm-activation.ready", "Timed out waiting for the Kimi web ready line.", { timeout_ms: READY_TIMEOUT_MS }));
        }, READY_TIMEOUT_MS);
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            owned.child.stdout.off("data", onStdout);
            owned.child.off("error", onError);
            owned.child.off("close", onClose);
        };
        const settle = (result) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            if (result instanceof RuntimeError)
                reject(result);
            else
                resolve(result);
        };
        const onAbort = () => {
            settle(cancelledFailure(failureCode, "swarm-activation.ready"));
        };
        const onError = () => {
            settle(failure(failureCode, "swarm-activation.process", "The Kimi web process failed before becoming ready."));
        };
        const onClose = () => {
            settle(failure(failureCode, "swarm-activation.process", "The Kimi web process exited before becoming ready."));
        };
        const onStdout = (chunk) => {
            buffered += chunk;
            if (buffered.length > READY_LINE_MAX_CHARS) {
                settle(failure(failureCode, "swarm-activation.ready", "The Kimi web ready line exceeded the bounded parser limit."));
                return;
            }
            while (buffered.includes("\n")) {
                const newline = buffered.indexOf("\n");
                const line = buffered.slice(0, newline).replace(/\r$/, "");
                buffered = buffered.slice(newline + 1);
                if (line.trim().length === 0)
                    continue;
                try {
                    settle(parseJsonReadyLine(line));
                }
                catch {
                    settle(failure(failureCode, "swarm-activation.ready", "The Kimi web JSON ready line did not confirm the authenticated KAP loopback contract."));
                }
                return;
            }
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        owned.child.stdout.on("data", onStdout);
        owned.child.on("error", onError);
        owned.child.on("close", onClose);
        if (signal?.aborted === true)
            onAbort();
    });
}
/** An http://127.0.0.1:<port>/ URL with no query or credentials. */
function isLoopbackRootUrl(url) {
    return (url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        url.port.length > 0 &&
        url.pathname === "/" &&
        url.search.length === 0 &&
        url.username.length === 0 &&
        url.password.length === 0);
}
function parseJsonReadyLine(line) {
    const data = JSON.parse(line);
    if (!isRecord(data) ||
        typeof data.origin !== "string" ||
        typeof data.ws_url !== "string" ||
        typeof data.token !== "string" ||
        data.token.trim().length === 0 ||
        data.kimi_agent_protocol_version !== KIMI_AGENT_PROTOCOL_VERSION) {
        throw new Error("invalid JSON ready payload");
    }
    const origin = new URL(data.origin);
    if (!isLoopbackRootUrl(origin) ||
        origin.hash.length > 0 ||
        (data.origin !== origin.origin && data.origin !== `${origin.origin}/`)) {
        throw new Error("invalid JSON ready origin");
    }
    const websocket = new URL(data.ws_url);
    if (websocket.protocol !== "ws:" ||
        websocket.host !== origin.host ||
        websocket.pathname !== "/api/v1/ws" ||
        websocket.search.length > 0 ||
        websocket.hash.length > 0 ||
        websocket.username.length > 0 ||
        websocket.password.length > 0 ||
        data.ws_url !== websocket.href) {
        throw new Error("invalid JSON ready WebSocket URL");
    }
    return { origin: origin.origin, token: data.token };
}
async function verifyMeta(web, expectedVersion, signal, failureCode) {
    const data = await restData(web, "GET", "/api/v1/meta", undefined, signal, failureCode);
    if (!isRecord(data)) {
        throw failure(failureCode, "swarm-activation.meta", "Kimi web /meta returned an invalid payload.");
    }
    if (data.kimi_agent_protocol_version !== KIMI_AGENT_PROTOCOL_VERSION ||
        !isRecord(data.capabilities) ||
        data.capabilities.websocket !== true ||
        "backend" in data) {
        throw failure(failureCode, "swarm-activation.meta", "Kimi web /meta did not confirm the KAP 1.0.0 WebSocket contract without a legacy backend.");
    }
    if (data.dangerous_bypass_auth !== false) {
        throw failure(failureCode, "swarm-activation.meta", "Refusing a Kimi web server with authentication bypass enabled.");
    }
    if (data.server_version !== expectedVersion) {
        throw failure(failureCode, "swarm-activation.meta", "Kimi web /meta server_version did not exactly match the execution plan.");
    }
}
async function resolveProfileModel(web, options, failureCode) {
    if (options.model !== undefined) {
        if (options.model.length === 0) {
            throw failure(failureCode, "swarm-activation.model", "The explicit swarm model alias is empty.");
        }
        return options.model;
    }
    if (options.env.KIMI_MODEL_NAME?.trim())
        return ENV_MODEL_ALIAS;
    const data = await restData(web, "GET", "/api/v1/config", undefined, options.signal, failureCode);
    if (!isRecord(data) || typeof data.default_model !== "string" || data.default_model.trim().length === 0) {
        throw failure(failureCode, "swarm-activation.model", "Kimi web /config did not provide a usable default_model.");
    }
    return data.default_model;
}
async function createSession(web, options, expectedVersion, failureCode) {
    const request = { metadata: { cwd: options.cwd } };
    if (kimiReleaseHas(expectedVersion, "local-environment")) {
        request.environment_id = "local";
        request.environment_cwd = options.cwd;
    }
    const data = await restData(web, "POST", "/api/v1/sessions", request, options.signal, failureCode);
    if (!isRecord(data) || !validPathId(data.id) || !validPathId(data.workspace_id)) {
        throw failure(failureCode, "swarm-activation.create-session", "Kimi web returned an invalid session identity.");
    }
    return { sessionId: data.id, workspaceId: data.workspace_id };
}
async function verifyLocalEnvironment(web, identity, expectedCwd, expectedVersion, signal, failureCode) {
    if (!kimiReleaseHas(expectedVersion, "local-environment"))
        return;
    const data = await restData(web, "GET", `/api/v1/sessions/${encodeURIComponent(identity.sessionId)}/environment`, undefined, signal, failureCode);
    if (!isRecord(data)) {
        throw failure(failureCode, "swarm-activation.environment", "Kimi web /environment returned an invalid payload.");
    }
    if (data.workspace_id !== identity.workspaceId || data.environment_id !== "local" || data.cwd !== expectedCwd) {
        throw failure(failureCode, "swarm-activation.environment", "Kimi web /environment did not confirm the expected local workspace binding.");
    }
}
async function postSwarmProfile(web, identity, active, model, signal, failureCode) {
    const agentConfig = {
        swarm_mode: active,
        permission_mode: "auto",
    };
    if (active)
        agentConfig.model = model;
    await restData(web, "POST", `/api/v1/sessions/${encodeURIComponent(identity.sessionId)}/profile`, { agent_config: agentConfig }, signal, failureCode);
}
async function verifySwarmStatus(web, identity, active, model, _expectedVersion, signal, failureCode) {
    const data = await readWebSocketAgentState(web, identity.sessionId, signal, failureCode);
    if (!isRecord(data)) {
        throw failure(failureCode, "swarm-activation.status", "Kimi web agent state returned an invalid payload.");
    }
    if (data.swarm_mode !== active) {
        throw failure(failureCode, "swarm-activation.status", `Kimi web agent state did not confirm swarm_mode=${active}.`, { expected_swarm_mode: active });
    }
    if (data.plan_mode !== false) {
        throw failure(failureCode, "swarm-activation.status", "Kimi web agent state did not confirm plan mode is off.");
    }
    if (data.tower_mode !== false) {
        throw failure(failureCode, "swarm-activation.status", "Kimi web agent state did not confirm tower mode is off.");
    }
    if (data.permission_mode !== "auto") {
        throw failure(failureCode, "swarm-activation.status", "Kimi web agent state did not confirm auto permission mode.");
    }
    if (active && data.model !== model) {
        throw failure(failureCode, "swarm-activation.status", "Kimi web agent state did not confirm the selected model alias.");
    }
}
async function readWebSocketAgentState(web, sessionId, signal, failureCode) {
    throwIfAborted(signal, failureCode, "swarm-activation.status");
    await refreshOwnedDescendants(web);
    throwIfAborted(signal, failureCode, "swarm-activation.status");
    try {
        return await new Promise((resolve, reject) => {
            let socket;
            const bearerProtocol = `kimi-code.bearer.${web.token}`;
            const subscribeId = `swarm-activation-subscribe-${randomUUID()}`;
            try {
                const url = new URL(web.origin);
                url.protocol = "ws:";
                url.pathname = "/api/v1/ws";
                socket = new WebSocket(url, bearerProtocol);
            }
            catch {
                reject(failure(failureCode, "swarm-activation.status", "Could not open the authenticated Kimi web agent-state channel."));
                return;
            }
            let settled = false;
            let subscribeSent = false;
            let subscriptionAcknowledged = false;
            let closeRequested = false;
            let closeTimer;
            let latestState;
            let frames = 0;
            let receivedChars = 0;
            const timer = setTimeout(() => {
                settle(failure(failureCode, "swarm-activation.status", "Kimi web agent-state verification timed out.", { timeout_ms: REST_TIMEOUT_MS }));
            }, REST_TIMEOUT_MS);
            const cleanup = () => {
                clearTimeout(timer);
                if (closeTimer !== undefined)
                    clearTimeout(closeTimer);
                signal?.removeEventListener("abort", onAbort);
                socket.removeEventListener("open", onOpen);
                socket.removeEventListener("message", onMessage);
                socket.removeEventListener("error", onError);
                socket.removeEventListener("close", onClose);
                try {
                    socket.close();
                }
                catch {
                }
            };
            const settle = (result) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                if (result instanceof RuntimeError)
                    reject(result);
                else
                    resolve(result);
            };
            const rejectState = (message) => {
                settle(failure(failureCode, "swarm-activation.status", message));
            };
            const send = (frame) => {
                try {
                    socket.send(JSON.stringify(frame));
                    return true;
                }
                catch {
                    rejectState("Could not send a Kimi web agent-state control frame.");
                    return false;
                }
            };
            const closeForValidation = () => {
                closeRequested = true;
                try {
                    socket.close();
                }
                catch {
                    rejectState("Could not close the Kimi web agent-state channel for final validation.");
                }
            };
            const completeIfReady = () => {
                if (!subscriptionAcknowledged || latestState === undefined || closeRequested)
                    return;
                closeTimer ??= setTimeout(() => {
                    closeTimer = undefined;
                    closeForValidation();
                }, 0);
            };
            const onOpen = () => {
                if (socket.protocol !== bearerProtocol) {
                    rejectState("Kimi web did not authenticate the agent-state channel with the expected subprotocol.");
                    return;
                }
                subscribeSent = send({
                    type: "subscribe",
                    request_id: subscribeId,
                    session_id: sessionId,
                    agent_ids: ["main"],
                });
            };
            const onMessage = (event) => {
                if (settled)
                    return;
                if (typeof event.data !== "string") {
                    rejectState("Kimi web agent-state channel returned a non-text frame.");
                    return;
                }
                frames += 1;
                receivedChars += event.data.length;
                if (frames > WEBSOCKET_MAX_FRAMES || receivedChars > WEBSOCKET_RESPONSE_MAX_CHARS) {
                    rejectState("Kimi web agent-state channel exceeded the bounded response limit.");
                    return;
                }
                let frame;
                try {
                    frame = JSON.parse(event.data);
                }
                catch {
                    rejectState("Kimi web agent-state channel returned malformed JSON.");
                    return;
                }
                if (!isRecord(frame) || typeof frame.type !== "string") {
                    rejectState("Kimi web agent-state channel returned an invalid frame.");
                    return;
                }
                if (frame.type === "response") {
                    if (typeof frame.request_id !== "string" || !Number.isInteger(frame.code)) {
                        rejectState("Kimi web agent-state channel returned an invalid subscription response.");
                        return;
                    }
                    if (frame.request_id !== subscribeId) {
                        rejectState("Kimi web agent-state channel returned an unexpected subscription response.");
                        return;
                    }
                    if (subscriptionAcknowledged || !subscribeSent || frame.code !== 0) {
                        rejectState("Kimi web agent-state channel did not accept the exact main-session subscription.");
                        return;
                    }
                    subscriptionAcknowledged = true;
                    completeIfReady();
                    return;
                }
                if (frame.type === "agent") {
                    if (!subscribeSent || !subscriptionAcknowledged || !isAgentStateFrame(frame, sessionId)) {
                        rejectState("Kimi web agent-state channel returned invalid or misbound main-agent state.");
                        return;
                    }
                    latestState = frame;
                    completeIfReady();
                    return;
                }
                if (frame.type === "ping") {
                    send({ type: "pong" });
                }
            };
            const onAbort = () => {
                settle(cancelledFailure(failureCode, "swarm-activation.status"));
            };
            const onError = () => {
                rejectState("Kimi web agent-state channel failed before valid state was received.");
            };
            const onClose = () => {
                if (closeRequested &&
                    subscriptionAcknowledged &&
                    latestState !== undefined) {
                    settle(latestState);
                    return;
                }
                rejectState("Kimi web agent-state channel closed before valid state was received.");
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            socket.addEventListener("open", onOpen);
            socket.addEventListener("message", onMessage);
            socket.addEventListener("error", onError);
            socket.addEventListener("close", onClose);
            if (signal?.aborted === true)
                onAbort();
        });
    }
    finally {
        await refreshOwnedDescendants(web);
    }
}
function isAgentStateFrame(frame, sessionId) {
    return frame.session_id === sessionId &&
        frame.agent_id === "main" &&
        typeof frame.event_created_at === "string" &&
        Number.isFinite(Date.parse(frame.event_created_at)) &&
        (frame.status === "idle" || frame.status === "running") &&
        (frame.model === undefined || typeof frame.model === "string") &&
        (frame.thinking === undefined || typeof frame.thinking === "string") &&
        (frame.permission_mode === undefined ||
            frame.permission_mode === "manual" ||
            frame.permission_mode === "yolo" ||
            frame.permission_mode === "auto") &&
        typeof frame.plan_mode === "boolean" &&
        typeof frame.swarm_mode === "boolean" &&
        typeof frame.tower_mode === "boolean";
}
async function shutdownWeb(web, signal, failureCode) {
    await restData(web, "POST", "/api/v1/shutdown", undefined, signal, failureCode);
    const settlement = await waitForChildClose(web, signal, failureCode);
    if (!(await teardownOwnedChild(web))) {
        throw failure(failureCode, "swarm-activation.shutdown", "The Kimi web process tree did not become quiescent after shutdown.", { exit_code: settlement.exitCode, signal: settlement.signal, cleanup_summary: web.cleanupSummary ?? null });
    }
    if (web.processError || settlement.exitCode !== 0) {
        throw failure(failureCode, "swarm-activation.shutdown", "The Kimi web process did not exit cleanly after shutdown.", { exit_code: settlement.exitCode, signal: settlement.signal });
    }
}
async function waitForChildClose(web, signal, failureCode) {
    let timer;
    let onAbort;
    try {
        return await Promise.race([
            web.closePromise,
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => {
                    reject(failure(failureCode, "swarm-activation.shutdown", "Timed out waiting for the Kimi web process to shut down.", { timeout_ms: SHUTDOWN_TIMEOUT_MS }));
                }, SHUTDOWN_TIMEOUT_MS);
                onAbort = () => reject(cancelledFailure(failureCode, "swarm-activation.shutdown"));
                signal?.addEventListener("abort", onAbort, { once: true });
                if (signal?.aborted === true)
                    onAbort();
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
        if (onAbort !== undefined)
            signal?.removeEventListener("abort", onAbort);
    }
}
async function restData(web, method, route, body, signal, failureCode) {
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
    if (signal?.aborted === true)
        onAbort();
    try {
        const headers = { accept: "application/json", authorization: `Bearer ${web.token}` };
        if (body !== undefined)
            headers["content-type"] = "application/json";
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
            throw failure(failureCode, "swarm-activation.rest", "Kimi web REST returned an unsuccessful HTTP status.", { route, http_status: response.status });
        }
        const text = await readBoundedResponse(response, failureCode, route);
        let envelope;
        try {
            envelope = JSON.parse(text);
        }
        catch {
            throw failure(failureCode, "swarm-activation.rest", "Kimi web REST returned malformed JSON.", { route });
        }
        if (!isRecord(envelope) || !("data" in envelope)) {
            throw failure(failureCode, "swarm-activation.rest", "Kimi web REST returned an invalid response envelope.", { route });
        }
        if (envelope.code !== 0) {
            throw failure(failureCode, "swarm-activation.rest", "Kimi web REST returned an unsuccessful business response.", {
                route,
                business_code: typeof envelope.code === "number" ? envelope.code : null,
            });
        }
        return envelope.data;
    }
    catch (error) {
        if (signal?.aborted === true)
            throw cancelledFailure(failureCode, "swarm-activation.rest");
        if (timedOut) {
            throw failure(failureCode, "swarm-activation.rest", "Kimi web REST timed out.", { route, timeout_ms: REST_TIMEOUT_MS });
        }
        if (error instanceof RuntimeError)
            throw error;
        throw failure(failureCode, "swarm-activation.rest", "Kimi web REST failed before a valid response was received.", { route });
    }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
}
async function readBoundedResponse(response, failureCode, route) {
    if (response.body === null) {
        throw failure(failureCode, "swarm-activation.rest", "Kimi web REST returned an empty response.", { route });
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        if (value === undefined)
            continue;
        size += value.byteLength;
        if (size > REST_RESPONSE_MAX_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw failure(failureCode, "swarm-activation.rest", "Kimi web REST response exceeded the bounded size limit.", { route, max_bytes: REST_RESPONSE_MAX_BYTES });
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
async function requireSwarmJournal(kimiHome, identity, expected, signal, failureCode) {
    const stage = expected === "enter" ? "swarm-activation.journal" : "swarm-deactivation.journal";
    const journalPath = path.join(kimiHome, "sessions", identity.workspaceId, identity.sessionId, "agents", "main", "wire.jsonl");
    const deadline = Date.now() + JOURNAL_TIMEOUT_MS;
    let observed = "missing";
    while (true) {
        throwIfAborted(signal, failureCode, stage);
        observed = await readSwarmJournalState(journalPath);
        if (observed === expected)
            return;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw failure(failureCode, stage, `The main-agent journal did not confirm swarm_mode.${expected === "enter" ? "enter with manual trigger" : "exit"}.`, { journal_state: observed, timeout_ms: JOURNAL_TIMEOUT_MS });
        }
        await delay(Math.min(JOURNAL_POLL_MS, remaining), signal, failureCode, stage);
    }
}
async function readSwarmJournalState(journalPath) {
    let handle;
    try {
        handle = await open(journalPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    }
    catch (error) {
        const code = error.code;
        return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable";
    }
    try {
        const stats = await handle.stat({ bigint: true });
        if (!stats.isFile() || stats.size > BigInt(JOURNAL_MAX_BYTES))
            return "unreadable";
        const size = Number(stats.size);
        const buffer = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
            const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
            if (bytesRead === 0)
                break;
            offset += bytesRead;
        }
        // Framed as kimi-code replays it. Replay stops at the first corrupt
        // terminated line, so no later record may confirm a state: fail closed.
        // An unparseable unterminated tail is truncation, which replay drops.
        let state = "missing";
        for await (const { line, parsed: record, terminated } of kimiJournalRecords([buffer.subarray(0, offset)])) {
            if (record === UNPARSEABLE_JOURNAL_LINE) {
                if (terminated || line.includes("swarm_mode."))
                    return "unreadable";
                continue;
            }
            if (!isRecord(record))
                continue;
            if (record.type === "swarm_mode.enter") {
                state = record.trigger === "manual" ? "enter" : "other";
            }
            else if (record.type === "swarm_mode.exit") {
                state = "exit";
            }
        }
        return state;
    }
    catch {
        return "unreadable";
    }
    finally {
        await handle.close().catch(() => undefined);
    }
}
function startDescendantTracking(owned) {
    if (process.platform === "win32")
        return;
    owned.trackerPromise = (async () => {
        while (!owned.trackingStopped && !owned.exited) {
            await refreshOwnedDescendants(owned);
            if (owned.trackingStopped || owned.exited)
                break;
            await sleep(DESCENDANT_TRACK_INTERVAL_MS);
        }
    })();
}
async function stopDescendantTracking(owned) {
    owned.trackingStopped = true;
    await owned.trackerPromise;
    await owned.refreshPromise;
}
async function refreshOwnedDescendants(owned) {
    if (process.platform === "win32" || owned.exited)
        return;
    if (owned.refreshPromise !== undefined)
        return await owned.refreshPromise;
    const childPid = owned.child.pid;
    if (childPid === undefined) {
        owned.lastSnapshotComplete = true;
        return;
    }
    owned.refreshPromise = (async () => {
        const snapshot = await retryIncompleteCapture(() => captureDescendantIdentities(childPid));
        const previousRoot = owned.rootIdentity;
        if (snapshot.root !== undefined) {
            if (previousRoot === undefined) {
                owned.rootIdentity = snapshot.root;
            }
            else if (previousRoot.startToken !== snapshot.root.startToken) {
                owned.snapshotIncomplete = true;
                owned.lastSnapshotComplete = false;
                return;
            }
        }
        const seen = new Set(owned.descendants.map(identityKey));
        for (const identity of snapshot.identities) {
            const key = identityKey(identity);
            if (seen.has(key))
                continue;
            seen.add(key);
            owned.descendants.push(identity);
        }
        if (snapshot.complete && (snapshot.root !== undefined || previousRoot !== undefined)) {
            if (!owned.snapshotIncomplete)
                owned.lastSnapshotComplete = true;
        }
        else {
            owned.snapshotIncomplete = true;
            owned.lastSnapshotComplete = false;
        }
        try {
            owned.onRecoveryEvent?.({ kind: "web-processes", identities: [...(owned.rootIdentity ? [owned.rootIdentity] : []), ...owned.descendants], complete: owned.lastSnapshotComplete });
        }
        catch {
            owned.recoveryFailed = true;
        }
    })().finally(() => {
        owned.refreshPromise = undefined;
    });
    return await owned.refreshPromise;
}
async function teardownOwnedChild(owned) {
    const quiescent = await teardownOwnedChildInner(owned);
    if (quiescent && !owned.recoveryFailed) {
        owned.onRecoveryEvent?.({ kind: "web-exit" });
        return true;
    }
    return false;
}
async function teardownOwnedChildInner(owned) {
    await stopDescendantTracking(owned);
    const childPid = owned.child.pid;
    if (childPid === undefined)
        return true;
    try {
        if (process.platform === "win32") {
            if (!owned.exited) {
                try {
                    owned.child.kill("SIGTERM");
                }
                catch {
                }
            }
            const exited = await waitForProcessTreeExit([], ESCALATION_MS, {
                isRootAlive: () => !owned.exited,
            });
            if (!exited) {
                try {
                    owned.child.kill("SIGKILL");
                }
                catch {
                }
                return await waitForProcessTreeExit([], POST_KILL_QUIESCENCE_MS, {
                    isRootAlive: () => !owned.exited,
                });
            }
            return true;
        }
        if (!owned.exited)
            await refreshOwnedDescendants(owned);
        const identities = owned.descendants;
        await signalCapturedTree(owned, childPid, identities, "SIGTERM");
        const exited = await waitForProcessTreeExit(identities, ESCALATION_MS, {
            isRootAlive: () => !owned.exited,
        });
        let quiescent = exited && await processGroupsQuiescent(owned, childPid);
        let killWaitExited;
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
    }
    catch {
        if (!owned.exited) {
            if (process.platform !== "win32")
                trySignalPid(-childPid, "SIGKILL");
            try {
                owned.child.kill("SIGKILL");
            }
            catch {
            }
        }
        return false;
    }
}
async function processGroupsQuiescent(owned, childPid) {
    const groupIds = new Set([childPid]);
    for (const identity of owned.descendants)
        groupIds.add(identity.processGroupId);
    const scan = await retryIncompleteCapture(async () => {
        const members = await collectProcessGroupsIdentities([...groupIds]);
        return { members, complete: members !== undefined };
    });
    return scan.members !== undefined && scan.members.every((identity) => /^[ZX]/i.test(identity.state.trim()));
}
async function captureDescendantIdentities(childPid) {
    let timer;
    try {
        const snapshot = await Promise.race([
            Promise.all([
                collectDescendantIdentities(childPid),
                probeProcessIdentity(childPid),
            ]),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(null), DESCENDANT_SNAPSHOT_TIMEOUT_MS);
            }),
        ]);
        if (snapshot === null)
            return { identities: [], complete: false, timedOut: true };
        const [collected, rootProbe] = snapshot;
        const identities = [];
        const seen = new Set();
        for (const identity of collected) {
            const key = identityKey(identity);
            if (Number.isInteger(identity.pid) &&
                identity.pid > 0 &&
                identity.pid !== childPid &&
                Number.isInteger(identity.processGroupId) &&
                identity.processGroupId > 0 &&
                identity.startToken.length > 0 &&
                !seen.has(key)) {
                seen.add(key);
                identities.push({ ...identity });
            }
        }
        return { identities, complete: rootProbe.complete, root: rootProbe.identity };
    }
    catch {
        return { identities: [], complete: false };
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
function identityKey(identity) {
    return `${identity.pid}:${identity.startToken}:${identity.processGroupId}`;
}
async function signalCapturedTree(owned, childPid, identities, signal) {
    if (!owned.exited) {
        trySignalPid(-childPid, signal);
        try {
            owned.child.kill(signal);
        }
        catch {
        }
    }
    const pidValidation = await revalidateProcessIdentities(identities, {
        timeoutMs: IDENTITY_REVALIDATION_TIMEOUT_MS,
    });
    for (const identity of pidValidation.identities)
        trySignalPid(identity.pid, signal);
    const activeGroupIds = new Set(pidValidation.identities.map((identity) => identity.processGroupId));
    if (!owned.exited)
        activeGroupIds.delete(childPid);
    for (const processGroupId of activeGroupIds)
        trySignalPid(-processGroupId, signal);
}
function trySignalPid(pid, signal) {
    try {
        process.kill(pid, signal);
    }
    catch {
    }
}
function throwIfAborted(signal, code, stage) {
    if (signal?.aborted === true)
        throw cancelledFailure(code, stage);
}
function cancelledFailure(code, stage) {
    return failure(code, stage, "Swarm web lifecycle cancelled by the caller.", { cancelled: true });
}
function failure(code, stage, message, details = {}) {
    return new RuntimeError(code, message, stage, { details });
}
function asSafeFailure(error, code, stage) {
    if (error instanceof RuntimeError)
        return error;
    return failure(code, stage, "The swarm web lifecycle failed without a safe diagnostic payload.");
}
function errorReference(error) {
    return {
        code: error.code,
        stage: error.stage,
        cancelled: error.details.cancelled === true,
    };
}
function validPathId(value) {
    return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function delay(ms, signal, code, stage) {
    throwIfAborted(signal, code, stage);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(cancelledFailure(code, stage));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted === true)
            onAbort();
    });
}
