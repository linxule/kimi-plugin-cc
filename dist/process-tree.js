import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const MAX_DESCENDANT_DEPTH = 8;
const MAX_DESCENDANT_PIDS = 512;
const PROCESS_EXIT_POLL_MS = 10;
const PROCESS_SNAPSHOT_TIMEOUT_MS = 1_000;
const PROCESS_IDENTITY_PROBE_TIMEOUT_MS = 250;
const PROBE_TIMEOUT = Symbol("process-probe-timeout");
/**
 * Capture descendant ancestry and reusable identities in the same bounded
 * process-table snapshot. There is no PID-only handoff: on Linux, PPID, PGID,
 * state, and start time come from one /proc/<pid>/stat read per row; other
 * POSIX systems use one ps invocation for the whole table.
 */
export async function collectDescendantIdentities(rootPid) {
    if (!Number.isInteger(rootPid) || rootPid <= 0 || process.platform === "win32")
        return [];
    const snapshot = await raceValueWithTimeout(collectVerifiedDescendantIdentities(rootPid), PROCESS_SNAPSHOT_TIMEOUT_MS);
    if (snapshot === PROBE_TIMEOUT) {
        throw new Error(`process snapshot exceeded ${PROCESS_SNAPSHOT_TIMEOUT_MS}ms`);
    }
    return snapshot;
}
/**
 * Compatibility surface for callers that only need numeric process listings.
 * Cancellation must use collectDescendantIdentities so ancestry and identity
 * cannot be separated by a PID-reuse window.
 */
export async function collectDescendants(rootPid) {
    try {
        return (await collectDescendantIdentities(rootPid)).map((identity) => identity.pid);
    }
    catch {
        return [];
    }
}
/** Read one reusable process identity. PID alone is not stable across teardown. */
export async function readProcessIdentity(pid) {
    if (!Number.isInteger(pid) || pid <= 0 || process.platform === "win32")
        return undefined;
    const read = process.platform === "linux"
        ? readProcessIdentityBatchFromProc([pid])
        : readProcessIdentityBatchWithPs([pid]);
    const batch = await raceValueWithTimeout(read, PROCESS_IDENTITY_PROBE_TIMEOUT_MS);
    return batch === PROBE_TIMEOUT ? undefined : batch.identities.get(pid);
}
/**
 * Revalidate all captured identities concurrently under one deadline. The
 * default path batches ps fallback reads; an injected per-pid reader is fanned
 * out with Promise.all rather than multiplied by descendant count.
 */
export async function revalidateProcessIdentities(expectedIdentities, options = {}) {
    const expected = dedupeIdentities(expectedIdentities);
    if (expected.length === 0)
        return { identities: [], complete: true };
    const timeoutMs = Math.max(0, options.timeoutMs ?? PROCESS_IDENTITY_PROBE_TIMEOUT_MS);
    const read = options.identityReader === undefined
        ? readCurrentIdentityBatch(expected)
        : readIdentityBatchWithReader(expected, options.identityReader);
    const batch = await raceValueWithTimeout(read, timeoutMs);
    if (batch === PROBE_TIMEOUT)
        return { identities: [], complete: false };
    const identities = [];
    for (const expectedIdentity of expected) {
        const current = batch.identities.get(expectedIdentity.pid);
        if (current !== undefined &&
            current.startToken === expectedIdentity.startToken &&
            current.processGroupId === expectedIdentity.processGroupId &&
            !isQuiescentState(current.state)) {
            identities.push(current);
        }
    }
    return { identities, complete: batch.complete };
}
/** Return the current identity only when pid, start token, and PGID still match. */
export async function revalidateProcessIdentity(expected, identityReader) {
    const validation = await revalidateProcessIdentities([expected], { identityReader });
    return validation.identities[0];
}
/**
 * Wait until the direct child and every captured identity are quiescent.
 * Every probe is bounded even when the overall wait is infinite, and an
 * incomplete probe is conservatively treated as still active.
 */
export async function waitForProcessTreeExit(identities, timeoutMs, options = {}) {
    const targets = dedupeIdentities(identities);
    const finiteTimeout = Number.isFinite(timeoutMs);
    const deadline = finiteTimeout ? Date.now() + Math.max(0, timeoutMs) : Number.POSITIVE_INFINITY;
    while (true) {
        const rootAlive = options.isRootAlive?.() === true;
        if (!rootAlive && targets.length === 0)
            return true;
        const remainingMs = deadline - Date.now();
        if (finiteTimeout && remainingMs <= 0)
            return false;
        let active = rootAlive;
        if (!active) {
            const probeTimeoutMs = finiteTimeout
                ? Math.min(PROCESS_IDENTITY_PROBE_TIMEOUT_MS, remainingMs)
                : PROCESS_IDENTITY_PROBE_TIMEOUT_MS;
            const validation = await revalidateProcessIdentities(targets, {
                identityReader: options.identityReader,
                timeoutMs: probeTimeoutMs,
            });
            active = !validation.complete || validation.identities.length > 0;
        }
        if (!active)
            return true;
        const afterProbeRemainingMs = deadline - Date.now();
        if (finiteTimeout && afterProbeRemainingMs <= 0)
            return false;
        await sleep(Math.min(PROCESS_EXIT_POLL_MS, afterProbeRemainingMs));
    }
}
async function collectVerifiedDescendantIdentities(rootPid) {
    const initialRows = await collectProcessSnapshotRows();
    if (initialRows === undefined)
        return [];
    const candidateRows = descendantRowsFromSnapshot(rootPid, initialRows);
    const initialRoot = initialRows.find((row) => row.pid === rootPid);
    if (initialRoot === undefined || candidateRows.length === 0)
        return [];
    // A second, targeted snapshot closes the cross-row /proc race: every child
    // identity and every numeric parent edge must still match before acceptance.
    const expectedRows = [initialRoot, ...candidateRows];
    const expectedByPid = new Map(expectedRows.map((row) => [row.pid, row]));
    const verificationRows = await readCurrentSnapshotRows(expectedRows);
    const stableRows = verificationRows.filter((current) => {
        const expected = expectedByPid.get(current.pid);
        return (expected !== undefined &&
            current.startToken === expected.startToken &&
            current.processGroupId === expected.processGroupId &&
            current.parentPid === expected.parentPid &&
            !isQuiescentState(current.state));
    });
    return descendantRowsFromSnapshot(rootPid, stableRows).map(toProcessIdentity);
}
function descendantRowsFromSnapshot(rootPid, rows) {
    const root = rows.find((row) => row.pid === rootPid);
    if (root === undefined || isQuiescentState(root.state))
        return [];
    const childrenByParent = new Map();
    for (const row of rows) {
        if (row.pid <= 0 || row.parentPid <= 0 || row.pid === row.parentPid)
            continue;
        const children = childrenByParent.get(row.parentPid);
        if (children === undefined)
            childrenByParent.set(row.parentPid, [row]);
        else
            children.push(row);
    }
    const descendants = [];
    const seen = new Set([rootPid]);
    let frontier = [rootPid];
    for (let depth = 0; depth < MAX_DESCENDANT_DEPTH && frontier.length > 0; depth += 1) {
        const next = [];
        for (const parentPid of frontier) {
            for (const child of childrenByParent.get(parentPid) ?? []) {
                if (seen.has(child.pid))
                    continue;
                seen.add(child.pid);
                descendants.push(child);
                if (descendants.length >= MAX_DESCENDANT_PIDS)
                    return descendants;
                next.push(child.pid);
            }
        }
        frontier = next;
    }
    return descendants;
}
async function readCurrentSnapshotRows(expectedRows) {
    const procPids = [];
    const psPids = [];
    for (const row of expectedRows) {
        if (process.platform === "linux" && row.startToken.startsWith("proc:")) {
            procPids.push(row.pid);
        }
        else {
            psPids.push(row.pid);
        }
    }
    const [procOutcomes, psRows] = await Promise.all([
        Promise.all(procPids.map((pid) => readProcRow(pid))),
        collectProcessSnapshotRowsFromPs(psPids),
    ]);
    return [
        ...procOutcomes.flatMap((outcome) => outcome.status === "found" ? [outcome.row] : []),
        ...(psRows ?? []),
    ];
}
async function collectProcessSnapshotRows() {
    if (process.platform === "linux") {
        const procRows = await collectProcessSnapshotRowsFromProc();
        if (procRows !== undefined)
            return procRows;
    }
    return collectProcessSnapshotRowsFromPs();
}
async function collectProcessSnapshotRowsFromProc() {
    let entries;
    try {
        entries = await readdir("/proc");
    }
    catch (err) {
        if (isErrnoException(err, "ENOENT") || isErrnoException(err, "EPERM"))
            return undefined;
        return undefined;
    }
    const outcomes = await Promise.all(entries
        .filter((entry) => /^\d+$/.test(entry))
        .map((entry) => readProcRow(Number.parseInt(entry, 10))));
    return outcomes.flatMap((outcome) => outcome.status === "found" ? [outcome.row] : []);
}
async function collectProcessSnapshotRowsFromPs(pids) {
    const uniquePids = pids === undefined ? undefined : uniqueValidPids(pids);
    if (uniquePids !== undefined && uniquePids.length === 0)
        return [];
    let stdout;
    try {
        const result = await execFileAsync("ps", uniquePids === undefined
            ? ["-axo", "pid=,ppid=,pgid=,state=,lstart="]
            : ["-o", "pid=,ppid=,pgid=,state=,lstart=", "-p", uniquePids.join(",")], {
            timeout: uniquePids === undefined
                ? PROCESS_SNAPSHOT_TIMEOUT_MS
                : PROCESS_IDENTITY_PROBE_TIMEOUT_MS,
            maxBuffer: uniquePids === undefined ? 2 * 1024 * 1024 : 256 * 1024,
        });
        stdout = result.stdout;
    }
    catch {
        return undefined;
    }
    return parsePsSnapshotRows(stdout);
}
async function readCurrentIdentityBatch(expected) {
    if (process.platform !== "linux") {
        return readProcessIdentityBatchWithPs(expected.map((identity) => identity.pid));
    }
    const procPids = [];
    const psPids = [];
    for (const identity of expected) {
        if (identity.startToken.startsWith("proc:"))
            procPids.push(identity.pid);
        else
            psPids.push(identity.pid);
    }
    const [procBatch, psBatch] = await Promise.all([
        readProcessIdentityBatchFromProc(procPids),
        readProcessIdentityBatchWithPs(psPids),
    ]);
    return mergeIdentityBatches(procBatch, psBatch);
}
async function readProcessIdentityBatchFromProc(pids) {
    if (pids.length === 0)
        return { identities: new Map(), complete: true };
    const outcomes = await Promise.all(pids.map((pid) => readProcRow(pid)));
    const identities = new Map();
    let complete = true;
    for (const outcome of outcomes) {
        if (outcome.status === "found") {
            identities.set(outcome.row.pid, toProcessIdentity(outcome.row));
        }
        else if (outcome.status === "error") {
            complete = false;
        }
    }
    return { identities, complete };
}
async function readProcessIdentityBatchWithPs(pids) {
    const uniquePids = uniqueValidPids(pids);
    if (uniquePids.length === 0)
        return { identities: new Map(), complete: true };
    let stdout;
    try {
        const result = await execFileAsync("ps", ["-o", "pid=,pgid=,state=,lstart=", "-p", uniquePids.join(",")], { timeout: PROCESS_IDENTITY_PROBE_TIMEOUT_MS, maxBuffer: 256 * 1024 });
        stdout = result.stdout;
    }
    catch (err) {
        if (isExitCode(err, 1))
            return { identities: new Map(), complete: true };
        return { identities: new Map(), complete: false };
    }
    const identities = new Map();
    for (const line of stdout.split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
        if (match === null)
            continue;
        const pid = Number.parseInt(match[1], 10);
        const processGroupId = Number.parseInt(match[2], 10);
        if (!Number.isInteger(pid) || !Number.isInteger(processGroupId) || processGroupId <= 0) {
            continue;
        }
        identities.set(pid, {
            pid,
            processGroupId,
            state: match[3],
            startToken: psStartToken(match[4]),
        });
    }
    return { identities, complete: true };
}
async function readIdentityBatchWithReader(expected, identityReader) {
    const outcomes = await Promise.all(expected.map(async (identity) => {
        try {
            return { identity: await identityReader(identity.pid), failed: false };
        }
        catch {
            return { identity: undefined, failed: true };
        }
    }));
    const identities = new Map();
    let complete = true;
    for (const outcome of outcomes) {
        if (outcome.failed)
            complete = false;
        if (outcome.identity !== undefined)
            identities.set(outcome.identity.pid, outcome.identity);
    }
    return { identities, complete };
}
async function readProcRow(pid) {
    let stat;
    try {
        stat = await readFile(`/proc/${pid}/stat`, "utf8");
    }
    catch (err) {
        if (isErrnoException(err, "ENOENT") || isErrnoException(err, "ESRCH")) {
            return { status: "missing" };
        }
        return { status: "error" };
    }
    const closeParen = stat.lastIndexOf(")");
    const openParen = stat.indexOf("(");
    if (openParen < 1 || closeParen < openParen)
        return { status: "error" };
    const parsedPid = Number.parseInt(stat.slice(0, openParen).trim(), 10);
    const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
    const state = fields[0];
    const parentPid = Number.parseInt(fields[1] ?? "", 10);
    const processGroupId = Number.parseInt(fields[2] ?? "", 10);
    const startTimeTicks = fields[19];
    if (parsedPid !== pid ||
        state === undefined ||
        startTimeTicks === undefined ||
        !Number.isInteger(parentPid) ||
        !Number.isInteger(processGroupId) ||
        processGroupId <= 0) {
        return { status: "error" };
    }
    return {
        status: "found",
        row: {
            pid,
            parentPid,
            processGroupId,
            startToken: `proc:${startTimeTicks}`,
            state,
        },
    };
}
function parsePsSnapshotRows(stdout) {
    const rows = [];
    for (const line of stdout.split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
        if (match === null)
            continue;
        const pid = Number.parseInt(match[1], 10);
        const parentPid = Number.parseInt(match[2], 10);
        const processGroupId = Number.parseInt(match[3], 10);
        if (!Number.isInteger(pid) ||
            !Number.isInteger(parentPid) ||
            !Number.isInteger(processGroupId) ||
            processGroupId <= 0) {
            continue;
        }
        rows.push({
            pid,
            parentPid,
            processGroupId,
            state: match[4],
            startToken: psStartToken(match[5]),
        });
    }
    return rows;
}
function mergeIdentityBatches(first, second) {
    return {
        identities: new Map([...first.identities, ...second.identities]),
        complete: first.complete && second.complete,
    };
}
function toProcessIdentity(row) {
    return {
        pid: row.pid,
        processGroupId: row.processGroupId,
        startToken: row.startToken,
        state: row.state,
    };
}
function dedupeIdentities(identities) {
    const seen = new Set();
    const deduped = [];
    for (const identity of identities) {
        const key = `${identity.pid}:${identity.startToken}:${identity.processGroupId}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        deduped.push(identity);
    }
    return deduped;
}
function uniqueValidPids(pids) {
    return [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
}
function psStartToken(value) {
    return `ps:${value.replace(/\s+/g, " ").trim()}`;
}
function isQuiescentState(state) {
    const normalized = state.trim().toUpperCase();
    return normalized.startsWith("Z") || normalized.startsWith("X");
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function raceValueWithTimeout(promise, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(PROBE_TIMEOUT), Math.max(0, timeoutMs));
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
function isErrnoException(err, code) {
    return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
function isExitCode(err, code) {
    return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
