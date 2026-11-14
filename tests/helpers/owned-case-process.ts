import { spawn } from "node:child_process";
import {
  collectDescendantIdentities,
  probeProcessIdentity,
  revalidateProcessIdentities,
  waitForProcessTreeExit,
  type ProcessIdentity,
} from "../../runtime/process-tree.js";

export interface OwnedCaseOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  graceMs?: number;
  killWaitMs?: number;
}

/** Own the runner and observed, identity-verified descendants through settlement. */
export async function runOwnedCaseProcess(command: string, args: string[], options: OwnedCaseOptions = {}) {
  if (process.platform === "win32") throw new Error("owned case process tests require POSIX process identities");
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", exited = false, timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshPromise: Promise<void> | undefined;
  const identities = new Map<string, ProcessIdentity>();
  const remember = (identity: ProcessIdentity) => identities.set(`${identity.pid}:${identity.startToken}:${identity.processGroupId}`, identity);
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("exit", () => { exited = true; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { exited = true; resolve({ code, signal }); });
  });
  // Keep the rejection observed even when the watchdog wins the race.
  void closed.catch(() => {});

  const refreshOnce = async () => {
    if (child.pid !== undefined && !exited) {
      const root = await probeProcessIdentity(child.pid);
      if (!root.complete) throw new Error("cannot inspect the owned case root");
      if (root.identity) remember(root.identity);
    }
    const validation = await revalidateProcessIdentities([...identities.values()]);
    if (!validation.complete || validation.groupChanged?.length) throw new Error("cannot refresh the owned case process range");
    const covered = new Set<number>();
    for (const anchor of validation.identities) {
      if (covered.has(anchor.pid)) continue;
      // Continue from surviving owned descendants after the runner exits.
      // A second identity check inside collection prevents PID reuse from
      // turning an unrelated process into a new ancestry anchor.
      let descendants: ProcessIdentity[];
      try {
        descendants = await collectDescendantIdentities(anchor.pid, anchor);
      } catch (error) {
        // Collection can race a normal exit between its two snapshots.
        const remaining = await revalidateProcessIdentities([anchor]);
        if (remaining.complete && remaining.identities.length === 0 && !remaining.groupChanged?.length) continue;
        throw error;
      }
      const observedAnchor = descendants.find((identity) => identity.pid === anchor.pid);
      if (!observedAnchor || observedAnchor.startToken !== anchor.startToken || observedAnchor.processGroupId !== anchor.processGroupId) continue;
      for (const identity of descendants) { remember(identity); covered.add(identity.pid); }
    }
  };
  const refresh = (): Promise<void> => {
    refreshPromise ??= refreshOnce().finally(() => { refreshPromise = undefined; });
    return refreshPromise;
  };
  // Discovery remains active during graceful shutdown and escalation. A
  // runner may launch its cleanup process only after receiving SIGTERM.
  const poll = setInterval(() => { void refresh().catch(() => {}); }, 50);
  const waitForOwnedExit = async (timeoutMs: number, killObserved = false): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    let emptySince: number | undefined;
    let emptyCount = 0;
    while (true) {
      await refresh();
      const validation = await revalidateProcessIdentities([...identities.values()]);
      if (!validation.complete || validation.groupChanged?.length) throw new Error("cannot verify the refreshed case process range");
      if (exited && validation.identities.length === 0) {
        if (emptySince === undefined || emptyCount !== identities.size) {
          emptySince = Date.now(); emptyCount = identities.size;
        } else if (Date.now() - emptySince >= 50) return true;
      } else emptySince = undefined;
      if (killObserved && validation.identities.length > 0) await signalCaptured("SIGKILL");
      if (killObserved && !exited) child.kill("SIGKILL");
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));
    }
  };
  const signal = (pid: number, value: NodeJS.Signals) => {
    try { process.kill(pid, value); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  const signalCaptured = async (value: NodeJS.Signals) => {
    const validation = await revalidateProcessIdentities([...identities.values()]);
    if (!validation.complete || validation.groupChanged?.length) throw new Error("case cleanup could not revalidate all owned process identities");
    // Anchor each detached group to a still-matching PID/start-token/PGID.
    // The runner itself was detached, so its descendants cannot share this
    // test process's original group through ordinary process inheritance.
    const own = await probeProcessIdentity(process.pid);
    if (!own.complete || !own.identity) throw new Error("cannot establish the test process group");
    const anchors = await revalidateProcessIdentities(validation.identities);
    if (!anchors.complete || anchors.groupChanged?.length) throw new Error("case cleanup could not verify group anchors");
    const groups = new Set(anchors.identities.map((identity) => identity.processGroupId));
    groups.delete(own.identity.processGroupId);
    for (const group of groups) signal(-group, value);
    const current = await revalidateProcessIdentities(validation.identities);
    if (!current.complete || current.groupChanged?.length) throw new Error("case cleanup lost process identity verification");
    for (const identity of current.identities) signal(identity.pid, value);
  };

  let outcome: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let quiescent = false;
  try {
    await refresh();
    outcome = await Promise.race([
      closed,
      new Promise<undefined>((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(undefined); }, options.timeoutMs ?? 260_000); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    try {
     await refreshPromise;
     await refresh();
     quiescent = await waitForOwnedExit(150);
     if (!quiescent) {
      // First signal only the case runner: runSwarm gets time to cancel its
      // own CLI and capture a write patch using the normal teardown path.
      if (!exited && child.pid !== undefined) {
        const root = [...identities.values()].filter((identity) => identity.pid === child.pid);
        const verified = await revalidateProcessIdentities(root);
        if (verified.complete && verified.identities.length === 1) signal(child.pid, "SIGTERM");
        else child.kill("SIGTERM"); // A live ChildProcess still owns this root.
      } else await signalCaptured("SIGTERM");
      quiescent = await waitForOwnedExit(options.graceMs ?? 10_000);
      if (!quiescent) {
        // Refresh while the parent is still alive to catch late descendants.
        await refresh();
        await signalCaptured("SIGKILL");
        if (!exited) child.kill("SIGKILL");
        // Include newly discovered descendants in escalation as well, rather
        // than merely noticing them after the first kill snapshot was sent.
        quiescent = await waitForOwnedExit(options.killWaitMs ?? 4_000, true);
      }
     }
    } catch (error) {
      // An enumeration/verification error must not strand the live case
      // runner. Its ChildProcess handle owns that root. Signal only captured
      // identities that still validate; never guess an unverified group.
      if (!exited) child.kill("SIGKILL");
      const verified = await revalidateProcessIdentities([...identities.values()]);
      for (const identity of verified.identities) signal(identity.pid, "SIGKILL");
      await waitForProcessTreeExit([...identities.values()], options.killWaitMs ?? 4_000, { isRootAlive: () => !exited });
      throw error;
    } finally {
      clearInterval(poll);
      await refreshPromise?.catch(() => {});
    }
    if (!quiescent) throw new Error("owned case subprocess tree did not become quiescent");
  }
  // All captured processes and the root are gone, so inherited stdout/stderr
  // pipes must now close; the small barrier remains within the test deadline.
  if (!outcome) {
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      outcome = await Promise.race([closed, new Promise<never>((_, reject) => {
        closeTimer = setTimeout(() => reject(new Error("owned case stdio did not close after quiescence")), 2_000);
      })]);
    } finally { if (closeTimer) clearTimeout(closeTimer); }
  }
  return { ...outcome, stdout, stderr, timedOut, quiescent, identities: [...identities.values()] };
}
