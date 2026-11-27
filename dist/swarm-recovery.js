import { RuntimeError } from "./errors.js";
import { sleep } from "./util.js";
import { collectDescendantIdentities, collectProcessGroupsIdentities, probeProcessIdentity, processGroupIsProvenEmpty, revalidateProcessIdentities } from "./process-tree.js";
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
        else if (event.kind === "print-processes-snapshot") {
            const root = launch.identities[0];
            if (!root) {
                // The root can exit before its identity is read, and the read can fail
                // or time out. With no anchor, settlement rests on four observations
                // that need none: the launcher's own handle reported the exit; the
                // launcher saw its pipes close; a complete pass tracks no process; and
                // the kernel reports no process in the root's own group. Each one
                // missing is a refusal, exactly as every rootless snapshot was refused
                // before. A helper that left the group and keeps no pipe open is
                // invisible here, as it is behind an identified root that has exited.
                if (event.rootExited !== true || event.rootClosed !== true || event.rootGroupEmpty !== true ||
                    !event.complete || event.identities.length > 0) {
                    throw recoveryError("The print root identity was not durably recorded before its process snapshot.");
                }
                launch.pending = false;
                launch.uncertain = false;
                launch.boundedSnapshot = true;
                launch.rootUnidentified = true;
            }
            else {
                // The root remains the recovery anchor after exit. Complete bounded
                // snapshots replace historical descendants; an incomplete observation
                // cannot discard an identity whose exit has not been proven.
                const previous = new Map(launch.identities.map((identity) => [processIdentityKey(identity), identity]));
                const current = event.identities.map((identity) => previous.get(processIdentityKey(identity)) ?? identity);
                const all = event.complete ? [root, ...current] : [...launch.identities, ...current];
                launch.identities = [...new Map(all.map((identity) => [processIdentityKey(identity), identity])).values()];
                launch.pending = false;
                launch.uncertain = !event.complete;
                launch.boundedSnapshot = true;
            }
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
/**
 * Record one bounded print snapshot. For a launch with no recorded root, and
 * only then, probe the root's own process group once the other conditions
 * hold. The child is spawned as the leader of its own group, so that group's
 * id is the child's PID. The probe observes and never signals; anything short
 * of the kernel's "no such process" is a refusal. A recorded root is never probed.
 */
export function recordPrintSnapshot(store, record, snapshot, rootPid, groupIsProvenEmpty = processGroupIsProvenEmpty) {
    const launch = [...record.launches].reverse().find((entry) => entry.kind === "print");
    const rootGroupEmpty = launch !== undefined && launch.identities.length === 0 && rootPid !== undefined &&
        snapshot.rootExited && snapshot.rootClosed && snapshot.complete && snapshot.identities.length === 0 &&
        groupIsProvenEmpty(rootPid);
    recordRecoveryEvent(store, record, {
        kind: "print-processes-snapshot", identities: [...snapshot.identities], complete: snapshot.complete,
        rootExited: snapshot.rootExited, rootClosed: snapshot.rootClosed, rootGroupEmpty,
    });
}
function processIdentityKey(identity) {
    // A changed process group is not a new ownership grant for the same process.
    return `${identity.pid}:${identity.startToken}`;
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
/**
 * Older Linux records may retain ps start tokens while current snapshots use
 * /proc start ticks. Prove both representations current around the known identity
 * read; never accept a member based on PID/PGID equality alone.
 */
export async function validateRecoveryGroupMembers(known, members, validate = revalidateProcessIdentities) {
    const membership = await validate(members);
    const ownership = await validate(known);
    const membershipAfter = await validate(membership.identities);
    for (const proof of [membership, ownership, membershipAfter]) {
        if (!proof.complete || proof.groupChanged?.length)
            throw recoveryError("Process ownership or group membership is uncertain.");
    }
    for (const member of membershipAfter.identities) {
        const owner = ownership.identities.find((id) => id.pid === member.pid && id.processGroupId === member.processGroupId);
        const crossNamespace = owner && ((owner.startToken.startsWith("proc:") && member.startToken.startsWith("ps:")) ||
            (owner.startToken.startsWith("ps:") && member.startToken.startsWith("proc:")));
        if (!owner || (owner.startToken !== member.startToken && !crossNamespace)) {
            throw recoveryError("An unrecorded process survives in the recorded group; refusing group cleanup.");
        }
    }
    return ownership.identities;
}
export async function inspectRecoveryLaunchProcesses(launch, validate = revalidateProcessIdentities, collect = collectProcessGroupsIdentities) {
    let known = launch.identities;
    if (launch.kind === "print" && launch.boundedSnapshot === true) {
        const live = await validate(known);
        if (!live.complete || live.groupChanged?.length) {
            throw recoveryError("Process ownership or group membership is uncertain.");
        }
        // The saved root remains first for ancestry recovery, but an exited root
        // grants no ownership of its numeric group after that group is reused.
        known = live.identities;
        if (known.length === 0)
            return [];
    }
    const members = await collect(known.map((identity) => identity.processGroupId));
    if (members === undefined)
        throw recoveryError("Process group membership is unreadable.");
    return validateRecoveryGroupMembers(known, members, validate);
}
/** Never signal an unproven group, PID replacement, or changed-PGID process. */
export async function recoverLaunch(launch, persist, signal) {
    if (launch.quiescent)
        return;
    // A rootless launch that settled already rests on the root's exit, closed
    // pipes, an empty group and an empty complete pass. It records no identity to
    // inspect or signal, so recovery finishes it without probing anything.
    if (launch.rootUnidentified === true && !launch.pending && !launch.uncertain && launch.identities.length === 0) {
        launch.quiescent = true;
        persist();
        return;
    }
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
    const inspect = () => inspectRecoveryLaunchProcesses(launch);
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
            await sleep(25);
        } while (Date.now() < deadline);
    }
    throw recoveryError("Recorded processes did not become quiescent; recovery remains pending.");
}
