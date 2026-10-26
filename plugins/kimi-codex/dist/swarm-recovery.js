import { RuntimeError } from "./errors.js";
import { collectDescendantIdentities, collectProcessGroupsIdentities, probeProcessIdentity, revalidateProcessIdentities } from "./process-tree.js";
export function recordRecoveryEvent(store, record, event) {
    record.complete = false;
    if (event.kind === "session") {
        record.session = { sessionId: event.sessionId, workspaceId: event.workspaceId };
        // Write-ahead: this must commit before the profile mutation is attempted.
        record.sessionDirty = true;
    }
    else if (event.kind === "disabled") {
        record.sessionDirty = false;
    }
    else if (event.kind.endsWith("-spawn")) {
        record.launches.push({ kind: event.kind === "web-spawn" ? "web" : "print", pending: true, identities: [], quiescent: false, uncertain: false });
    }
    else {
        const kind = event.kind.startsWith("web-") ? "web" : "print";
        const launch = [...record.launches].reverse().find((entry) => entry.kind === kind);
        if (!launch)
            throw recoveryError("Missing durable launch intent.");
        if (event.kind === "web-exit" || event.kind === "print-exit") {
            launch.quiescent = true;
            launch.pending = false;
        }
        else if ("identities" in event) {
            const all = [...launch.identities, ...event.identities];
            launch.identities = [...new Map(all.map((identity) => [`${identity.pid}:${identity.startToken}:${identity.processGroupId}`, identity])).values()];
            launch.pending = launch.identities.length === 0;
            launch.uncertain ||= !event.complete;
        }
    }
    store.saveSwarmRecovery(record.jobId, record);
}
export function finishRecoveryRecord(store, record) {
    record.complete = !record.sessionDirty && record.launches.every((entry) => entry.quiescent)
        && (record.workspaceRoot === null || record.patchPath !== null);
    store.saveSwarmRecovery(record.jobId, record);
}
export function recoveryError(message) {
    return new RuntimeError("SWARM_RECOVERY_REQUIRED", message, "swarm.recovery");
}
export async function assertRecoveryOwnerGone(record) {
    if (!record.owner || process.platform === "win32")
        throw recoveryError("No durable, verifiable owner identity; recovery requires manual inspection on this host.");
    const probe = await probeProcessIdentity(record.ownerPid);
    if (!probe.complete)
        throw recoveryError("Cannot verify the original companion's identity.");
    if (probe.identity?.startToken === record.owner.startToken && !/^[ZX]/i.test(probe.identity.state)) {
        throw recoveryError("The original companion is still alive. Use cancel for a running job, not recovery.");
    }
}
/** Never signal an unproven group, PID replacement, or changed-PGID process. */
export async function recoverLaunch(launch, persist, signal) {
    if (launch.quiescent)
        return;
    if (launch.pending || launch.uncertain || launch.identities.length === 0) {
        throw recoveryError("Launch ownership was not fully recorded before interruption; manual inspection is required. No process was signalled.");
    }
    const root = launch.identities[0];
    const rootProbe = await probeProcessIdentity(root.pid);
    if (!rootProbe.complete)
        throw recoveryError("Process identity probe is incomplete.");
    if (rootProbe.identity?.startToken === root.startToken) {
        if (rootProbe.identity.processGroupId !== root.processGroupId)
            throw recoveryError("The recorded root changed process groups; refusing to signal it.");
        const descendants = await collectDescendantIdentities(root.pid);
        // Revalidate the ancestry anchor after collection before retaining new identities.
        const after = await probeProcessIdentity(root.pid);
        if (!after.complete || after.identity?.startToken !== root.startToken || after.identity.processGroupId !== root.processGroupId) {
            throw recoveryError("Process ownership changed during recovery inspection.");
        }
        launch.identities = [...new Map([...launch.identities, ...descendants].map((id) => [`${id.pid}:${id.startToken}:${id.processGroupId}`, id])).values()];
        persist();
    }
    const inspect = async () => {
        const live = await revalidateProcessIdentities(launch.identities);
        const members = await collectProcessGroupsIdentities(launch.identities.map((id) => id.processGroupId));
        if (!live.complete || live.groupChanged?.length || members === undefined)
            throw recoveryError("Process ownership or group membership is uncertain.");
        if (members.some((member) => !/^[ZX]/i.test(member.state) && !launch.identities.some((id) => id.pid === member.pid && id.startToken === member.startToken && id.processGroupId === member.processGroupId))) {
            throw recoveryError("An unrecorded process survives in the recorded group; refusing group cleanup.");
        }
        return live.identities;
    };
    for (const [killSignal, waitMs] of [["SIGTERM", 1500], ["SIGKILL", 500]]) {
        signal?.throwIfAborted();
        for (const identity of await inspect()) {
            signal?.throwIfAborted();
            const current = await revalidateProcessIdentities([identity]);
            if (!current.complete || current.groupChanged?.length)
                throw recoveryError("Process identity changed before signalling.");
            if (current.identities.length) {
                try {
                    process.kill(identity.pid, killSignal);
                }
                catch (error) {
                    if (error.code !== "ESRCH")
                        throw recoveryError("Unable to stop the recorded process.");
                }
            }
        }
        const deadline = Date.now() + waitMs;
        do {
            signal?.throwIfAborted();
            if ((await inspect()).length === 0) {
                launch.quiescent = true;
                persist();
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        } while (Date.now() < deadline);
    }
    throw recoveryError("Recorded processes did not become quiescent; recovery remains pending.");
}
