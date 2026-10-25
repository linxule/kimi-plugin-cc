// Subprocess client for `kimi -p --output-format stream-json`.
//
// Per-job env (`KIMI_PLUGIN_CC_CMD`) is set on this spawn so the
// PreToolUse hook can branch per command (review vs rescue vs ask). It is
// passed via the spawn `env` option, not exported to a shell, so concurrent
// jobs never share an env block.
import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHookEscapeMonitor } from "./hook-escape.js";
import { RuntimeError, formatError } from "./errors.js";
import { assertNoUnsafeExperimentalSelector, assertExecutionPlanMatchesSpawn, } from "./kimi-engine.js";
import { assertPrefixArgsSafe } from "./kimi-command.js";
import { resolveKimiHome } from "./kimi-home.js";
import { assertNativeV2Preflight } from "./native-v2-preflight.js";
import { parseVersionLine } from "./kimi-version-probe.js";
import { StreamJsonParser, extractSessionIdFromStderr, } from "./stream-json.js";
import { collectDescendantIdentities, revalidateProcessIdentities, waitForProcessTreeExit, } from "./process-tree.js";
/** Bytes of stderr retained for diagnostics on completion. Rolling buffer. */
const STDERR_TAIL_BYTES = 8192;
/** Hard cap on awaiting diagnostics log drain before resolving the result. */
const LOG_DRAIN_TIMEOUT_MS = 250;
/** Default 1500 ms delay between SIGTERM and SIGKILL after an abort. */
const DEFAULT_ESCALATION_MS = 1_500;
/** Maximum time spent confirming POSIX tree exit after SIGKILL dispatch. */
const POST_KILL_QUIESCENCE_MS = 500;
/** Hard bound for the one-shot descendant identity snapshot. */
const DESCENDANT_SNAPSHOT_TIMEOUT_MS = 1_000;
/** Hard bound for each batched identity revalidation pass. */
const IDENTITY_REVALIDATION_TIMEOUT_MS = 250;
const DESCENDANT_SNAPSHOT_TIMEOUT = Symbol("descendant-snapshot-timeout");
export async function runCliPrompt(opts) {
    // Pre-aborted signal: refuse to spawn at all.
    if (opts.signal?.aborted === true) {
        throw new RuntimeError("CLI_ABORTED", "kimi subprocess request cancelled before spawn", "cli-client.pre-spawn", { details: { command: opts.command } });
    }
    assertExecutionPlanMatchesSpawn(opts.executionPlan, opts.command, opts.prefixArgs ?? [], opts.env);
    if ((opts.commandLabel === "rescue" || opts.commandLabel === "swarm-write") &&
        !opts.trustedWorkspaceRoot) {
        throw new RuntimeError("CLI_TRUSTED_WORKSPACE_ROOT_MISSING", `Refusing ${opts.commandLabel}: write-capable plugin launches require a plugin-owned trusted workspace root.`, "cli-client.pre-spawn", { details: { command_label: opts.commandLabel } });
    }
    // The master experimental flag enables v2-only features (tower, subagent
    // fork) outside the certified no-plan profile. Refuse it at the final
    // boundary too, in case the environment changed after plan creation.
    assertNoUnsafeExperimentalSelector(opts.env, "cli-client.pre-spawn");
    // Validate the ACTUAL prefix argv used for this spawn — not only the
    // env-resolved value — so a forged/corrupt persisted plan cannot smuggle a
    // reserved kimi flag (e.g. `-r <session>`, which would resume a session the
    // v2 preflight never scanned for plan taint).
    assertPrefixArgsSafe(opts.prefixArgs ?? []);
    if (opts.executionPlan.intendedEngine === "native-v2") {
        // Re-run the cheap no-plan preconditions at the final boundary: the
        // operator's config.toml and the resume journal are mutable between plan
        // creation (possibly in another process) and this spawn.
        await assertNativeV2Preflight({
            kimiHome: resolveKimiHome(opts.env, opts.cwd),
            env: opts.env,
            resumeSessionId: opts.resumeSessionId,
            stage: "cli-client.spawn",
        });
    }
    const args = buildArgs(opts);
    const env = buildKimiCliEnvironment(opts);
    if (opts.logPath !== undefined) {
        await mkdir(path.dirname(opts.logPath), { recursive: true }).catch(() => {
            // Best-effort; if mkdir fails the appendFile below will error and be
            // swallowed by the log chain (diagnostics are non-blocking).
        });
    }
    let child;
    let spawnedAt;
    try {
        spawnedAt = Date.now();
        child = spawn(opts.command, args, {
            cwd: opts.cwd,
            env,
            stdio: "pipe",
            // POSIX gets a fresh process group so cancellation reaches kimi's
            // descendants; Windows has no negative-pid process-group signaling.
            detached: process.platform !== "win32",
        });
    }
    catch (err) {
        throw new RuntimeError("CLI_SPAWN_FAILED", `Failed to spawn kimi: ${formatError(err)}`, "cli-client.spawn", err instanceof Error
            ? { cause: err, details: { command: opts.command, args } }
            : { details: { command: opts.command, args } });
    }
    // Pre-attach an 'error' listener immediately. Bun (and Node) can emit
    // 'error' asynchronously between spawn returning and our Promise body
    // attaching the real listener — without a handler in place, EventEmitter
    // crashes the process. Capture into an array (not a single slot) so two
    // back-to-back errors don't lose the first; we replay the first one when
    // the real handler installs. The replacement is atomic across two
    // synchronous statements (flag-flip + .on attach), so no async work can
    // interleave between them.
    const earlyErrors = [];
    let earlyErrorHandled = false;
    child.on("error", function earlyErrorListener(err) {
        if (earlyErrorHandled)
            return;
        earlyErrors.push(err);
    });
    const parser = new StreamJsonParser();
    const records = [];
    const malformed = [];
    // Rolling stderr tail — keep only the trailing STDERR_TAIL_BYTES so a
    // long-running kimi process emitting megabytes of stderr (tool.progress,
    // thinking deltas) doesn't grow our RSS unboundedly.
    let stderrTail = "";
    let announcedSessionId;
    let announcedGoalSummary;
    let announcedCliError;
    let announcedSystemVersion;
    const hookMonitor = createHookEscapeMonitor({ commandLabel: opts.commandLabel,
        operationKind: opts.executionPlan.operationKind, trustedWorkspaceRoot: opts.trustedWorkspaceRoot, cwd: opts.cwd });
    const hookEscapes = [];
    const noteHookEscape = (escape) => {
        hookEscapes.push(escape);
        appendLogLine({ event: "hook_escape", ...escape, command_label: opts.commandLabel,
            operation_kind: opts.executionPlan.operationKind });
    };
    let engineMismatchDetected = false;
    let handleEngineMismatch;
    const plannedEngine = opts.executionPlan.intendedEngine;
    const plannedVersion = opts.executionPlan.kimiVersion === null
        ? null
        : (parseVersionLine(opts.executionPlan.kimiVersion)?.raw ?? opts.executionPlan.kimiVersion);
    let logChain = Promise.resolve();
    const appendLogLine = (payload) => {
        if (opts.logPath === undefined)
            return;
        const line = `${JSON.stringify({ ts: new Date().toISOString(), ...payload })}\n`;
        logChain = logChain.then(() => appendFile(opts.logPath, line, "utf8").catch(() => {
            // Diagnostics best-effort; never crash on log failure.
        }));
    };
    appendLogLine({
        event: "spawn",
        command: opts.command,
        args,
        cwd: opts.cwd,
        command_label: opts.commandLabel ?? null,
        operation_kind: opts.executionPlan.operationKind,
        intended_engine: opts.executionPlan.intendedEngine,
        kimi_version: opts.executionPlan.kimiVersion,
        plan_certification: opts.executionPlan.certification,
        safety_profile: opts.executionPlan.safetyProfile,
        swarm_max_concurrency: opts.swarmMaxConcurrency ?? null,
        legacy_v1_forced: env.KIMI_CODE_LEGACY_FLAG === KIMI_LEGACY_FORCED_VALUE,
    });
    const invokeOnRecord = (record) => {
        if (opts.onRecord === undefined)
            return;
        try {
            opts.onRecord(record);
        }
        catch {
            // Caller-supplied callback must never destabilize the parse loop.
        }
    };
    // A native-v2 plan must see agent-core-v2's pre-tool system.version marker
    // before any consumer-facing output; a legacy plan must never see it.
    const requireMarkerBeforeOutput = (what) => {
        if (plannedEngine !== "native-v2" || announcedSystemVersion !== undefined)
            return false;
        handleEngineMismatch?.({
            observedEngine: null,
            systemVersion: undefined,
            reason: `${what} arrived before the native-v2 system.version marker; the engine that started cannot be established.`,
        });
        return true;
    };
    const consumeOutcomes = (outcomes) => {
        for (const outcome of outcomes) {
            if (engineMismatchDetected)
                return;
            if (outcome.cliError !== undefined) {
                if (requireMarkerBeforeOutput("a CLI error record"))
                    return;
                announcedCliError ??= outcome.cliError;
                appendLogLine({ event: "cli_error", ...outcome.cliError });
                continue;
            }
            if (outcome.unknownRecord !== undefined) {
                // Unknown roles are diagnostic-only and excluded from consumer records;
                // native-v2 still refuses any output before its marker.
                if (requireMarkerBeforeOutput(`an unknown-role (${outcome.unknownRecord.role}) record`)) {
                    return;
                }
                appendLogLine({
                    event: "unknown_record",
                    role: outcome.unknownRecord.role,
                });
                continue;
            }
            if (outcome.goalSummary !== undefined) {
                if (requireMarkerBeforeOutput("goal.summary"))
                    return;
                // Out-of-band metadata; first-announce-wins, excluded from consumer records.
                if (announcedGoalSummary === undefined) {
                    announcedGoalSummary = outcome.goalSummary;
                    appendLogLine({
                        event: "goal_summary",
                        goal_id: outcome.goalSummary.goalId,
                        status: outcome.goalSummary.status,
                        turns_used: outcome.goalSummary.turnsUsed,
                        tokens_used: outcome.goalSummary.tokensUsed,
                        wall_clock_ms: outcome.goalSummary.wallClockMs,
                    });
                }
                continue;
            }
            if (outcome.record !== undefined) {
                // Meta records are out-of-band wrapper metadata, never consumer-facing
                // assistant/tool records. Capture session.resume_hint (first-announce
                // wins, mirroring the stderr capture below for kimi 0.1.x), and skip
                // every recognized meta type, including 0.23.5's turn.step.retrying and
                // agent-core-v2's system.version. This keeps records[] and onRecord
                // stable while preserving the resume hint as the primary session-id
                // source under kimi 0.2.0+.
                if (outcome.record.role === "meta") {
                    // Contract: on a native-v2 plan the system.version marker is the
                    // FIRST stream-json line. Any other meta (e.g. session.resume_hint)
                    // arriving before it violates the ordering and means the started
                    // engine cannot be established — refuse before pinning a session id.
                    if (outcome.record.type !== "system.version" &&
                        requireMarkerBeforeOutput(`a ${outcome.record.type} record`)) {
                        return;
                    }
                    if (outcome.record.type === "session.resume_hint" &&
                        announcedSessionId === undefined) {
                        announcedSessionId = outcome.record.sessionId;
                        appendLogLine({
                            event: "session_announce",
                            source: "stream-json.meta",
                            session_id: outcome.record.sessionId,
                        });
                    }
                    else if (outcome.record.type === "system.version" &&
                        announcedSystemVersion === undefined) {
                        announcedSystemVersion = outcome.record.version;
                        appendLogLine({
                            event: "system_version",
                            source: "stream-json.meta",
                            version: outcome.record.version,
                        });
                        if (plannedEngine !== "native-v2") {
                            handleEngineMismatch?.({
                                observedEngine: "native-v2",
                                systemVersion: outcome.record.version,
                                reason: `the pre-tool system.version marker proves native-v2 ${outcome.record.version} started.`,
                            });
                            return;
                        }
                        // The marker's `version` is a structured field, not a CLI banner:
                        // require a single well-formed semver token. A multi-line or
                        // otherwise decorated value must not be normalized into a certified
                        // one by taking its first line.
                        const observedVersion = parseExactVersionToken(outcome.record.version);
                        if (observedVersion === undefined) {
                            handleEngineMismatch?.({
                                observedEngine: "native-v2",
                                systemVersion: outcome.record.version,
                                reason: `the system.version marker carries a malformed version value ${JSON.stringify(outcome.record.version)}; the started engine's version cannot be established.`,
                            });
                            return;
                        }
                        if (plannedVersion !== null && observedVersion !== plannedVersion) {
                            handleEngineMismatch?.({
                                observedEngine: "native-v2",
                                systemVersion: outcome.record.version,
                                reason: `the system.version marker reports ${outcome.record.version}, but the plan certified ${plannedVersion}.`,
                            });
                            return;
                        }
                    }
                    continue;
                }
                if (requireMarkerBeforeOutput(`a ${outcome.record.role} record`))
                    return;
                const escape = hookMonitor.observe(outcome.record);
                if (escape)
                    noteHookEscape(escape);
                records.push(outcome.record);
                appendLogLine({ event: "record", record: outcome.record });
                invokeOnRecord(outcome.record);
            }
            else if (outcome.malformedLine !== undefined) {
                // Diagnostics-only in general, but on a native-v2 plan a line that is
                // not the marker arriving first still violates marker-first: the
                // engine that produced it cannot be established.
                if (requireMarkerBeforeOutput("a malformed stream-json line"))
                    return;
                const entry = {
                    line: truncateChars(outcome.malformedLine, 200),
                    reason: outcome.malformedReason ?? "unknown",
                };
                malformed.push(entry);
                appendLogLine({ event: "malformed", ...entry });
            }
        }
    };
    const errorDetails = () => ({
        command: opts.command,
        args,
        command_label: opts.commandLabel ?? null,
    });
    return await new Promise(async (resolve, reject) => {
        let aborted = false;
        let cancellationTeardown;
        let settlementStarted = false;
        const settle = (kind, payload) => {
            if (settlementStarted)
                return;
            // Denied calls still without a result (a cancel/budget race, an abnormal
            // exit, or a turn that ended without the denial the hook owes) are reported
            // alongside the real outcome, never instead of it.
            for (const escape of hookMonitor.settle())
                noteHookEscape(escape);
            if (kind === "resolve" && hookEscapes.length > 0)
                payload = { ...payload, hookEscapes: [...hookEscapes] };
            settlementStarted = true;
            opts.signal?.removeEventListener("abort", onAbort);
            // Abort teardown can outlive the direct child's close event while a
            // detached descendant is still being enumerated or escalated. Never
            // expose a result/error until that one owned teardown path completes.
            void (cancellationTeardown ?? Promise.resolve({ ok: true })).then((teardown) => {
                if (!teardown.ok) {
                    appendLogLine({
                        event: "cancellation_teardown_error",
                        message: formatError(teardown.error),
                    });
                    reject(new RuntimeError("CLI_CANCELLATION_TEARDOWN_FAILED", `kimi cancellation teardown failed: ${formatError(teardown.error)}`, "cli-client.cancellation", teardown.error instanceof Error
                        ? { cause: teardown.error, details: errorDetails() }
                        : { details: errorDetails() }));
                    return;
                }
                if (kind === "resolve")
                    resolve({ ...payload, settledAt: Date.now() });
                else
                    reject(payload);
            });
        };
        const escalationMs = opts.escalationMs ?? DEFAULT_ESCALATION_MS;
        const identityReader = opts.processIdentityReader;
        let processExited = false;
        child.once("exit", () => {
            processExited = true;
        });
        const captureDescendantIdentities = async (childPid) => {
            let snapshot;
            try {
                const collected = await raceWithValueTimeout((opts.descendantIdentityCollector ?? collectDescendantIdentities)(childPid), DESCENDANT_SNAPSHOT_TIMEOUT_MS, DESCENDANT_SNAPSHOT_TIMEOUT);
                if (collected === DESCENDANT_SNAPSHOT_TIMEOUT) {
                    appendLogLine({
                        event: "descendant_collection_timeout",
                        timeout_ms: DESCENDANT_SNAPSHOT_TIMEOUT_MS,
                    });
                    return [];
                }
                snapshot = collected;
            }
            catch (err) {
                appendLogLine({
                    event: "descendant_collection_error",
                    message: formatError(err),
                });
                return [];
            }
            const identities = [];
            const seen = new Set();
            for (const identity of snapshot) {
                const key = `${identity.pid}:${identity.startToken}:${identity.processGroupId}`;
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
            return identities;
        };
        const trySignalPid = (pid, signal) => {
            try {
                process.kill(pid, signal);
            }
            catch (err) {
                const ignored = isErrnoException(err, "ESRCH") || isErrnoException(err, "EPERM");
                void ignored;
            }
        };
        const signalCapturedTree = async (childPid, identities, signal) => {
            // The live ChildProcess anchors its detached group. Signal the group
            // before the direct child can exit and make that numeric PGID stale.
            if (!processExited) {
                trySignalPid(-childPid, signal);
                try {
                    child.kill(signal);
                }
                catch {
                    // Best-effort direct-child signaling; ChildProcess owns this pid.
                }
            }
            // One bounded pass replaces up to 512 sequential ps calls. A pid whose
            // start token or PGID changed belongs to another process and is skipped.
            const pidValidation = await revalidateProcessIdentities(identities, {
                identityReader,
                timeoutMs: IDENTITY_REVALIDATION_TIMEOUT_MS,
            });
            for (const current of pidValidation.identities) {
                trySignalPid(current.pid, signal);
            }
            // Revalidate again immediately before signaling non-root groups. Never
            // send to an unanchored numeric PGID left over from collection.
            const groupValidation = await revalidateProcessIdentities(identities, {
                identityReader,
                timeoutMs: IDENTITY_REVALIDATION_TIMEOUT_MS,
            });
            const activeGroupIds = new Set(groupValidation.identities.map((identity) => identity.processGroupId));
            activeGroupIds.delete(childPid);
            for (const processGroupId of activeGroupIds) {
                trySignalPid(-processGroupId, signal);
            }
        };
        const teardownChildTree = async () => {
            await opts.cancellationTeardownHook?.();
            const childPid = child.pid;
            if (childPid === undefined || processExited)
                return;
            const finiteEscalation = Number.isFinite(escalationMs);
            if (process.platform === "win32") {
                // Preserve the documented win32 behavior: only the direct child is
                // managed; descendant enumeration/reaping remains unsupported.
                try {
                    child.kill("SIGTERM");
                }
                catch {
                    // Best-effort.
                }
                const exited = await waitForProcessTreeExit([], escalationMs, {
                    isRootAlive: () => !processExited,
                });
                if (!exited && finiteEscalation) {
                    try {
                        child.kill("SIGKILL");
                    }
                    catch {
                        // Best-effort.
                    }
                }
                return;
            }
            const identities = await captureDescendantIdentities(childPid);
            await signalCapturedTree(childPid, identities, "SIGTERM");
            // The grace interval starts only after SIGTERM has reached every
            // revalidated target. Slow process enumeration never consumes the grace.
            const exited = await waitForProcessTreeExit(identities, escalationMs, {
                identityReader,
                isRootAlive: () => !processExited,
            });
            if (!exited && finiteEscalation) {
                await signalCapturedTree(childPid, identities, "SIGKILL");
                const quiescent = await waitForProcessTreeExit(identities, POST_KILL_QUIESCENCE_MS, {
                    identityReader,
                    isRootAlive: () => !processExited,
                });
                if (!quiescent) {
                    appendLogLine({
                        event: "post_kill_quiescence_timeout",
                        timeout_ms: POST_KILL_QUIESCENCE_MS,
                        descendant_count: identities.length,
                    });
                }
            }
        };
        const stopForPolicyFailure = (error) => {
            engineMismatchDetected = true; // Stops all further consumer output.
            cancellationTeardown ??= teardownChildTree().then(() => ({ ok: true }), (error) => ({ ok: false, error }));
            settle("reject", error);
        };
        let engineMismatchError;
        handleEngineMismatch = (mismatch) => {
            if (engineMismatchError !== undefined)
                return;
            engineMismatchDetected = true;
            engineMismatchError = new RuntimeError("CLI_ENGINE_PROVENANCE_MISMATCH", `Refusing kimi output: execution plan required ${plannedEngine}, but ${mismatch.reason}`, "cli-client.engine-provenance", {
                details: {
                    operation_kind: opts.executionPlan.operationKind,
                    intended_engine: plannedEngine,
                    observed_engine: mismatch.observedEngine,
                    planned_kimi_version: opts.executionPlan.kimiVersion,
                    system_version: mismatch.systemVersion ?? null,
                },
            });
            appendLogLine({
                event: "engine_provenance_mismatch",
                intended_engine: plannedEngine,
                observed_engine: mismatch.observedEngine,
                system_version: mismatch.systemVersion ?? null,
                reason: mismatch.reason,
            });
            stopForPolicyFailure(engineMismatchError);
        };
        const onAbort = () => {
            if (aborted)
                return;
            aborted = true;
            cancellationTeardown = teardownChildTree().then(() => ({ ok: true }), (error) => ({ ok: false, error }));
            void cancellationTeardown.then((outcome) => {
                if (outcome.ok)
                    return;
                // A bug in teardown must neither strand the outer promise nor leave the
                // owned root running. The controlled child anchors this emergency kill.
                const childPid = child.pid;
                if (childPid !== undefined && !processExited) {
                    if (process.platform !== "win32")
                        trySignalPid(-childPid, "SIGKILL");
                    try {
                        child.kill("SIGKILL");
                    }
                    catch {
                        // Best-effort; settlement still surfaces the teardown failure.
                    }
                }
                settle("reject", new RuntimeError("CLI_CANCELLATION_TEARDOWN_FAILED", "kimi cancellation teardown failed", "cli-client.cancellation"));
            });
        };
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        // Abort may occur during any pre-spawn await, and addEventListener does not
        // replay an already-aborted signal. Re-check after attaching the listener so
        // the spawned child cannot escape cancellation teardown.
        if (opts.signal?.aborted === true) {
            onAbort();
        }
        if (child.pid !== undefined && opts.onSpawn) {
            try {
                await opts.onSpawn(child.pid);
            }
            catch (error) {
                onAbort();
                settle("reject", new RuntimeError("CLI_SPAWN_CALLBACK_FAILED", `Failed to record the spawned kimi process: ${formatError(error)}`, "cli-client.spawn", error instanceof Error ? { cause: error, details: errorDetails() } : { details: errorDetails() }));
                return;
            }
        }
        earlyErrorHandled = true;
        child.on("error", (err) => {
            appendLogLine({ event: "process_error", message: formatError(err) });
            settle("reject", new RuntimeError("CLI_PROCESS_ERROR", `kimi subprocess error: ${formatError(err)}`, "cli-client.process", err instanceof Error
                ? { cause: err, details: errorDetails() }
                : { details: errorDetails() }));
        });
        if (earlyErrors.length > 0) {
            const captured = earlyErrors[0];
            queueMicrotask(() => {
                appendLogLine({
                    event: "process_error",
                    message: formatError(captured),
                    early: true,
                    additional_count: earlyErrors.length - 1,
                });
                settle("reject", new RuntimeError("CLI_PROCESS_ERROR", `kimi subprocess error: ${formatError(captured)}`, "cli-client.process", { cause: captured, details: errorDetails() }));
            });
        }
        child.on("close", async (exitCode, signal) => {
            consumeOutcomes(parser.flush());
            if (!engineMismatchDetected &&
                exitCode === 0 &&
                !aborted &&
                requireMarkerBeforeOutput("a clean exit")) {
                return;
            }
            // The stderr resume-hint channel is the kimi 0.1.x fallback and exists
            // only for legacy-v1 plans; a native-v2 plan pins a session id from the
            // stdout meta record alone (after the marker), so stderr can never pin
            // an id ahead of, or different from, the provenance-checked stream.
            const sessionId = announcedSessionId ??
                (plannedEngine === "legacy-v1" ? extractSessionIdFromStderr(stderrTail) : undefined);
            appendLogLine({
                event: "exit",
                exit_code: exitCode,
                signal,
                session_id: sessionId,
                malformed_count: malformed.length,
                record_count: records.length,
                aborted,
            });
            // Cap the log drain wait so a wedged disk can't block result delivery.
            // The result itself is in memory; diagnostics are best-effort.
            await raceWithTimeout(logChain, LOG_DRAIN_TIMEOUT_MS);
            settle("resolve", {
                spawnedAt,
                settledAt: 0,
                sessionId,
                goalSummary: announcedGoalSummary,
                cliError: announcedCliError,
                systemVersion: announcedSystemVersion,
                observedEngine: announcedSystemVersion !== undefined
                    ? "native-v2"
                    : plannedEngine === "legacy-v1" &&
                        (exitCode === 0 ||
                            records.length > 0 ||
                            sessionId !== undefined ||
                            announcedGoalSummary !== undefined)
                        ? "legacy-v1"
                        : null,
                records,
                malformed,
                stderrTail,
                exitCode: exitCode ?? -1,
                signal,
                aborted,
            });
        });
        // Stdin: kimi -p reads from argv, not stdin. End it immediately so the
        // child never blocks. Stream method calls on a failed-spawn child can
        // throw synchronously — guard so the 'error' event still wins.
        try {
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (chunk) => {
                consumeOutcomes(parser.push(chunk));
            });
            child.stderr.on("data", (chunk) => {
                // First-announce-wins across both channels: once a session id is
                // pinned (from the stdout meta record or an earlier stderr line),
                // never let a later stderr line overwrite it. The stderr channel is
                // the 0.1.x fallback and is consulted ONLY for legacy-v1 plans — on a
                // native-v2 plan a stderr line could otherwise pin a session id before
                // (or different from) the provenance-checked stdout stream.
                if (plannedEngine === "legacy-v1" && announcedSessionId === undefined) {
                    const nextSessionId = extractSessionIdFromStderr(stderrTail + chunk);
                    if (nextSessionId !== undefined) {
                        announcedSessionId = nextSessionId;
                    }
                }
                stderrTail = appendToTail(stderrTail, chunk, STDERR_TAIL_BYTES);
            });
            child.stdin.end();
        }
        catch (err) {
            settle("reject", new RuntimeError("CLI_PROCESS_ERROR", `kimi subprocess stream setup failed: ${formatError(err)}`, "cli-client.streams", err instanceof Error
                ? { cause: err, details: errorDetails() }
                : { details: errorDetails() }));
        }
    });
}
/**
 * Helper for callers that require a session id (replay-capable commands).
 * Throws CLI_NO_SESSION_ID if the result lacks one, embedding the command
 * label and exit code in details so the failure is actionable in logs.
 *
 * Use this AT the call site rather than baking the requirement into
 * runCliPrompt — some callers (setup probes, smoke tests) are fine with
 * an undefined sessionId.
 */
export function requireSessionId(result, context) {
    if (result.sessionId !== undefined && result.sessionId.length > 0) {
        return result.sessionId;
    }
    throw new RuntimeError("CLI_NO_SESSION_ID", "kimi subprocess completed without announcing a session id; replay and resume will be unavailable", "cli-client.session-id", {
        details: {
            command_label: context.commandLabel ?? null,
            exit_code: result.exitCode,
            signal: result.signal,
            aborted: result.aborted,
            stderr_tail_len: result.stderrTail.length,
        },
    });
}
/** Settled timeout data; stream records are deliberately non-serializable.
 * Without a partial result (teardown rejection), aborted means abort was issued,
 * not that the process was observed aborting. */
export class ResponseTimeoutError extends RuntimeError {
    constructor(budgetMs, stage, commandLabel, partialResult, cause) {
        super("RESPONSE_TIMEOUT", `${stage} timed out after ${budgetMs}ms.`, stage, {
            ...(cause instanceof Error ? { cause } : {}),
            details: {
                budget_ms: budgetMs,
                command_label: commandLabel ?? null,
                record_count: partialResult?.records.length ?? 0,
                partial_output_chars: partialResult?.records.reduce((count, record) => count + (record.role === "assistant" && typeof record.content === "string" ? record.content.length : 0), 0) ?? 0,
                aborted: partialResult?.aborted ?? true,
                ...(partialResult ? { settled_post_abort: true } : {}),
                ...(partialResult?.hookEscapes?.length ? { hook_escapes: partialResult.hookEscapes } : {}),
            },
        });
        this.name = "ResponseTimeoutError";
        // Never serialize stream records into job error details or error envelopes.
        Object.defineProperty(this, "partialResult", { value: partialResult, enumerable: false });
    }
}
/**
 * Run `kimi -p` under a budget that also tells the subprocess to die
 * when the budget expires.
 *
 * Why this exists separately from `withTimeout`:
 *
 *   The generic `withTimeout` (runtime/kimi-timeouts.ts) only rejects
 *   the outer Promise — it has no handle on the kimi child process.
 *
 * Behavior:
 *
 *   - Owns an internal AbortController. If the caller passes
 *     `opts.signal`, both signals are linked — abort on either side
 *     aborts the internal controller.
 *   - When the budget expires, abort the internal controller, await the
 *     subprocess/tree teardown, then reject with
 *     `RuntimeError("RESPONSE_TIMEOUT", …)` matching the legacy
 *     `withTimeout` code shape.
 *   - A clean non-aborted exit-0 result wins same-tick budget expiry.
 *     Otherwise a settled result on timeout is carried as partial output.
 */
export async function runCliPromptWithBudget(opts, budgetMs, stage) {
    const controller = new AbortController();
    if (opts.signal?.aborted === true) {
        controller.abort();
    }
    const onParentAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onParentAbort, { once: true });
    let timeoutFired = false;
    let timer;
    timer = setTimeout(() => {
        timeoutFired = true;
        controller.abort();
    }, budgetMs);
    timer.unref();
    const timeoutError = (partialResult, cause) => new ResponseTimeoutError(budgetMs, stage, opts.commandLabel, partialResult, cause);
    try {
        let result;
        try {
            // Deliberately do not race this promise against an early timeout
            // rejection. The timer aborts it, and runCliPrompt owns the complete
            // child/descendant teardown before it can settle.
            result = await runCliPrompt({ ...opts, signal: controller.signal });
        }
        catch (error) {
            if (timeoutFired)
                throw timeoutError(undefined, error);
            throw error;
        }
        if (timeoutFired && (result.aborted || result.exitCode !== 0)) {
            // A clean, non-aborted result won the settle/timeout boundary and is success.
            // Budget aborts normally resolve with records, after owned teardown settles.
            throw timeoutError(result);
        }
        return result;
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onParentAbort);
    }
}
/**
 * Parse a structured version FIELD (the system.version marker), not a CLI
 * banner: the whole value must be one semver token (optional leading `v`,
 * optional pre-release/build suffix) with no surrounding whitespace or extra
 * lines. Returns the normalized `raw` form, or undefined when malformed.
 */
function parseExactVersionToken(value) {
    if (/\s/.test(value) || value.length === 0)
        return undefined;
    return parseVersionLine(value)?.raw;
}
const KIMI_LEGACY_ENV = "KIMI_CODE_LEGACY_FLAG";
const KIMI_LEGACY_FORCED_VALUE = "1";
function buildArgs(opts) {
    const args = [...(opts.prefixArgs ?? [])];
    args.push("--output-format", "stream-json");
    if (opts.resumeSessionId !== undefined) {
        args.push("-r", opts.resumeSessionId);
    }
    if (opts.model !== undefined) {
        args.push("-m", opts.model);
    }
    if (opts.skillsDirs !== undefined) {
        for (const dir of opts.skillsDirs) {
            args.push("--skills-dir", dir);
        }
    }
    // -p accepts the prompt as the option value. We pass it as a separate argv
    // entry so prompts with leading dashes or whitespace are not interpreted as
    // additional flags.
    args.push("-p", opts.prompt);
    return args;
}
export function buildKimiCliEnvironment(opts) {
    const env = { ...opts.env };
    if (opts.thinkingEffort !== undefined)
        env.KIMI_MODEL_THINKING_EFFORT = opts.thinkingEffort;
    // Ambient workspace trust starts project MCP stdio servers outside PreToolUse.
    delete env.KIMI_CODE_TRUST_WORKSPACE;
    // Legacy-v1 plans use this flag on releases whose unflagged -p default can
    // route to native-v2. Always overwrite ambient false values; older releases
    // ignore it. The engine choice stays plugin-owned, while certified native-v2
    // plans use the no-plan construction rather than a legacy pin.
    if (opts.executionPlan.intendedEngine === "legacy-v1") {
        env[KIMI_LEGACY_ENV] = KIMI_LEGACY_FORCED_VALUE;
    }
    // The update preflight runs on the `-p` path too; a plugin spawn must never
    // swap the certified binary underneath the execution plan.
    env.KIMI_CODE_NO_AUTO_UPDATE = "1";
    // Rescue and pursue share the write label. Only the immutable execution
    // plan can grant pursue's narrow goal-metadata access; never trust ambient
    // state inherited from another plugin job.
    env.KIMI_PLUGIN_CC_OPERATION = opts.executionPlan.operationKind;
    env.KIMI_CODE_HOME = resolveKimiHome(opts.env, opts.cwd);
    if (opts.commandLabel !== undefined) {
        env.KIMI_PLUGIN_CC_CMD = opts.commandLabel;
    }
    if (opts.swarmMaxConcurrency !== undefined) {
        env.KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY = String(opts.swarmMaxConcurrency);
    }
    if (opts.trustedWorkspaceRoot !== undefined) {
        // Trusted allowlist root for write-capable PreToolUse cases. Forge-proof
        // (env on the spawned process; the model cannot alter it). See field doc.
        env.KIMI_PLUGIN_CC_WORKSPACE_ROOT = opts.trustedWorkspaceRoot;
    }
    return env;
}
function appendToTail(tail, chunk, maxBytes) {
    const combined = tail + chunk;
    if (combined.length <= maxBytes)
        return combined;
    return combined.slice(combined.length - maxBytes);
}
function truncateChars(value, maxChars) {
    return value.length <= maxChars ? value : value.slice(0, maxChars);
}
function isErrnoException(err, code) {
    return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
function raceWithTimeout(promise, timeoutMs) {
    let timer;
    const timeoutPromise = new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
    });
    return Promise.race([
        promise.then(() => { }, () => { }),
        timeoutPromise,
    ]).finally(() => {
        if (timer !== undefined)
            clearTimeout(timer);
    });
}
async function raceWithValueTimeout(promise, timeoutMs, timeoutValue) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(timeoutValue), Math.max(0, timeoutMs));
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
