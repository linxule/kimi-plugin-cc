import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { revalidateProcessIdentities, waitForProcessTreeExit } from "../../runtime/process-tree.js";

const captured = { pid: 4_242, processGroupId: 100, startToken: "test:start", state: "S" };

describe("process identity group changes", () => {
  test("same PID and start token under a new PGID remains active but is not signal-valid", async () => {
    const current = { ...captured, processGroupId: captured.pid };
    const validation = await revalidateProcessIdentities([captured], {
      identityReader: async () => current,
    });
    expect(validation).toEqual({ identities: [], groupChanged: [current], complete: true });
  });

  test("a changed PGID cannot be mistaken for process exit", async () => {
    const current = { ...captured, processGroupId: captured.pid };
    const exited = await waitForProcessTreeExit([captured], 10, {
      identityReader: async () => current,
    });
    expect(exited).toBe(false);
  });

  test("an unchanged active identity revalidates and settles only after it exits", async () => {
    let active = true;
    const reader = async () => active ? captured : undefined;
    const validation = await revalidateProcessIdentities([captured], { identityReader: reader });
    expect(validation).toEqual({ identities: [captured], complete: true });
    active = false;
    await expect(waitForProcessTreeExit([captured], 10, { identityReader: reader })).resolves.toBe(true);
  });

  test("teardown treats a changed PGID as unverified and sends no signal", async () => {
    const source = await readFile("runtime/swarm-activation.ts", "utf8");
    const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
      source.slice(source.indexOf("async function teardownOwnedChild("), source.indexOf("function throwIfAborted(")),
    );
    const original = { pid: 102, processGroupId: 101, startToken: "ps:unchanged-start", state: "S" };
    const current = { ...original, processGroupId: 102 };
    const reader = async (pid: number) => pid === current.pid ? current : undefined;
    const signals: Array<{ pid: number; signal: string }> = [];
    const bindings = {
      process: { platform: "darwin", kill: (pid: number, signal: string) => signals.push({ pid, signal }) },
      stopDescendantTracking: async () => undefined,
      refreshOwnedDescendants: async () => undefined,
      revalidateProcessIdentities: (ids: any, options: any) =>
        revalidateProcessIdentities(ids, { ...options, identityReader: reader }),
      waitForProcessTreeExit: (ids: any, timeout: number, options: any) =>
        waitForProcessTreeExit(ids, timeout, { ...options, identityReader: reader }),
      collectProcessGroupsIdentities: async (groups: number[]) => groups.includes(current.processGroupId) ? [current] : [],
      ESCALATION_MS: 1_500,
      POST_KILL_QUIESCENCE_MS: 500,
      IDENTITY_REVALIDATION_TIMEOUT_MS: 250,
    };
    const teardown = new Function(...Object.keys(bindings), `${code}; return teardownOwnedChild;`)(
      ...Object.values(bindings),
    ) as (owned: unknown) => Promise<boolean>;
    const result = await teardown({
      child: { pid: 101 },
      exited: true,
      lastSnapshotComplete: true,
      descendants: [original],
    });
    expect(result).toBe(false);
    expect(signals).toEqual([]);
  }, 10_000);
});
