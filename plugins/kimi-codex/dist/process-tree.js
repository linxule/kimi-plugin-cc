import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const MAX_DESCENDANT_DEPTH = 8;
const MAX_DESCENDANT_PIDS = 512;
export async function collectDescendants(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return [];
    if (process.platform === "win32")
        return [];
    if (process.platform === "linux") {
        const procRows = await collectProcessRowsFromProc();
        if (procRows !== undefined) {
            return descendantsFromRows(pid, procRows);
        }
        return collectDescendantsWithPgrep(pid);
    }
    const psRows = await collectProcessRowsFromPs();
    if (psRows === undefined)
        return collectDescendantsWithPgrep(pid);
    return descendantsFromRows(pid, psRows);
}
function descendantsFromRows(rootPid, rows) {
    const childrenByParent = new Map();
    for (const row of rows) {
        if (row.pid <= 0 || row.ppid <= 0 || row.pid === row.ppid)
            continue;
        const children = childrenByParent.get(row.ppid);
        if (children === undefined) {
            childrenByParent.set(row.ppid, [row.pid]);
        }
        else {
            children.push(row.pid);
        }
    }
    const descendants = [];
    const seen = new Set([rootPid]);
    let frontier = [rootPid];
    for (let depth = 0; depth < MAX_DESCENDANT_DEPTH && frontier.length > 0; depth += 1) {
        const next = [];
        for (const parentPid of frontier) {
            const children = childrenByParent.get(parentPid) ?? [];
            for (const childPid of children) {
                if (seen.has(childPid))
                    continue;
                seen.add(childPid);
                descendants.push(childPid);
                if (descendants.length >= MAX_DESCENDANT_PIDS)
                    return descendants;
                next.push(childPid);
            }
        }
        frontier = next;
    }
    return descendants;
}
async function collectProcessRowsFromProc() {
    let entries;
    try {
        entries = await readdir("/proc");
    }
    catch (err) {
        if (isErrnoException(err, "ENOENT") || isErrnoException(err, "EPERM"))
            return undefined;
        return undefined;
    }
    const rows = [];
    await Promise.all(entries
        .filter((entry) => /^\d+$/.test(entry))
        .map(async (entry) => {
        const statusPath = `/proc/${entry}/status`;
        let status;
        try {
            status = await readFile(statusPath, "utf8");
        }
        catch (err) {
            if (isErrnoException(err, "ENOENT") || isErrnoException(err, "EPERM"))
                return;
            return;
        }
        const pidMatch = status.match(/^Pid:\s+(\d+)$/m);
        const ppidMatch = status.match(/^PPid:\s+(\d+)$/m);
        if (pidMatch === null || ppidMatch === null)
            return;
        const parsedPid = Number.parseInt(pidMatch[1], 10);
        const parsedPpid = Number.parseInt(ppidMatch[1], 10);
        if (Number.isInteger(parsedPid) && Number.isInteger(parsedPpid)) {
            rows.push({ pid: parsedPid, ppid: parsedPpid });
        }
    }));
    return rows;
}
async function collectProcessRowsFromPs() {
    let stdout;
    try {
        const result = await execFileAsync("ps", ["-axo", "pid=,ppid="], {
            timeout: 1_000,
            maxBuffer: 1024 * 1024,
        });
        stdout = result.stdout;
    }
    catch {
        return undefined;
    }
    const rows = [];
    for (const line of stdout.split("\n")) {
        const match = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (match === null)
            continue;
        rows.push({
            pid: Number.parseInt(match[1], 10),
            ppid: Number.parseInt(match[2], 10),
        });
    }
    return rows;
}
async function collectDescendantsWithPgrep(rootPid) {
    const descendants = [];
    const seen = new Set([rootPid]);
    let frontier = [rootPid];
    for (let depth = 0; depth < MAX_DESCENDANT_DEPTH && frontier.length > 0; depth += 1) {
        const next = [];
        for (const parentPid of frontier) {
            const children = await pgrepChildren(parentPid);
            for (const childPid of children) {
                if (seen.has(childPid))
                    continue;
                seen.add(childPid);
                descendants.push(childPid);
                if (descendants.length >= MAX_DESCENDANT_PIDS)
                    return descendants;
                next.push(childPid);
            }
        }
        frontier = next;
    }
    return descendants;
}
async function pgrepChildren(pid) {
    let stdout;
    try {
        const result = await execFileAsync("pgrep", ["-P", String(pid)], {
            timeout: 1_000,
            maxBuffer: 64 * 1024,
        });
        stdout = result.stdout;
    }
    catch (err) {
        if (isErrnoException(err, "ENOENT") || isErrnoException(err, "EPERM"))
            return [];
        if (isExitCode(err, 1))
            return [];
        return [];
    }
    return stdout
        .split("\n")
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((childPid) => Number.isInteger(childPid) && childPid > 0);
}
function isErrnoException(err, code) {
    return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
function isExitCode(err, code) {
    return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
