import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  collectDescendantIdentities,
  collectDescendantIdentitiesForRoots,
  probeProcessIdentity,
  type ProcessIdentity,
} from "../../runtime/process-tree.js";

type ProcessTreeApi = typeof import("../../runtime/process-tree.js");

function stat(pid: number, parent: number, group: number, start: number, flags = 0): string {
  const fields = Array<string>(20).fill("0");
  fields[0] = "S";
  fields[1] = String(parent);
  fields[2] = String(group);
  fields[6] = String(flags);
  fields[19] = String(start);
  return `${pid} (fixture with ) parens) ${fields.join(" ")}`;
}

async function linuxApi(
  entries: Record<number, string | Error | ((read: number) => string)>,
  psOutput = "",
) {
  const source = (await readFile("runtime/process-tree.ts", "utf8"))
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, "");
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  const reads = new Map<number, number>();
  let psCalls = 0;
  const bindings = {
    process: { platform: "linux" },
    readdir: async () => Object.keys(entries),
    readFile: async (file: string) => {
      const pid = Number(file.split("/")[2]);
      const entry = entries[pid];
      if (entry === undefined) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      if (entry instanceof Error) throw entry;
      const count = (reads.get(pid) ?? 0) + 1;
      reads.set(pid, count);
      return typeof entry === "function" ? entry(count) : entry;
    },
    execFile: undefined,
    promisify: () => async () => { psCalls += 1; return { stdout: psOutput }; },
  };
  const api = new Function(...Object.keys(bindings), `${code}; return {
    collectDescendantIdentities, collectDescendantIdentitiesForRoots,
    collectProcessGroupsIdentities, probeProcessIdentity, revalidateProcessIdentities,
  };`)(...Object.values(bindings)) as ProcessTreeApi;
  return { api, psCalls: () => psCalls };
}

describe("canonical Linux process identity", () => {
  const root: ProcessIdentity = { pid: 101, processGroupId: 101, startToken: "proc:1000", state: "S" };
  const child: ProcessIdentity = { pid: 102, processGroupId: 102, startToken: "proc:1001", state: "S" };
  const users = { 101: stat(101, 1, 101, 1000), 102: stat(102, 101, 102, 1001) };

  test("an unrelated PGID-zero kernel thread cannot switch captured identities to ps", async () => {
    const { api, psCalls } = await linuxApi({ 2: stat(2, 0, 0, 1, 0x0020_0000), ...users });
    await expect(api.probeProcessIdentity(root.pid)).resolves.toEqual({ complete: true, identity: root });
    await expect(api.collectDescendantIdentities(root.pid, root)).resolves.toEqual([root, child]);
    await expect(api.collectDescendantIdentitiesForRoots([root])).resolves.toEqual([root, child]);
    await expect(api.collectProcessGroupsIdentities([child.processGroupId])).resolves.toEqual([child]);
    await expect(api.probeProcessIdentity(child.pid)).resolves.toEqual({ complete: true, identity: child });
    await expect(api.revalidateProcessIdentities([root, child])).resolves.toEqual({ complete: true, identities: [root, child] });
    expect(psCalls()).toBe(0);
  });

  test("an unrelated permission failure keeps the snapshot incomplete without a ps fallback", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const { api, psCalls } = await linuxApi({ 3: denied, ...users });
    await expect(api.collectDescendantIdentities(root.pid, root)).rejects.toThrow("process snapshot unavailable");
    await expect(api.collectDescendantIdentitiesForRoots([root])).rejects.toThrow("process snapshot unavailable");
    await expect(api.collectProcessGroupsIdentities([root.processGroupId])).resolves.toBeUndefined();
    await expect(api.probeProcessIdentity(3)).resolves.toEqual({ complete: false, identity: undefined });
    await expect(api.probeProcessIdentity(root.pid)).resolves.toEqual({ complete: true, identity: root });
    expect(psCalls()).toBe(0);
  });

  test("PGID zero without PF_KTHREAD remains an error rather than false process exit", async () => {
    const { api, psCalls } = await linuxApi({ 3: stat(3, 1, 0, 2), ...users });
    await expect(api.collectDescendantIdentities(root.pid, root)).rejects.toThrow("process snapshot unavailable");
    await expect(api.probeProcessIdentity(3)).resolves.toEqual({ complete: false, identity: undefined });
    expect(psCalls()).toBe(0);
  });

  test("kernel rows are excluded only from full tables, never reported as a vanished target", async () => {
    const { api } = await linuxApi({ 2: stat(2, 0, 0, 1, 0x0020_0000), ...users });
    await expect(api.probeProcessIdentity(2)).resolves.toEqual({ complete: false, identity: undefined });
    await expect(api.revalidateProcessIdentities([{ ...root, pid: 2 }])).resolves.toEqual({ complete: false, identities: [] });
  });

  test("malformed stat fields cannot be accepted as a kernel-row exception", async () => {
    const kernel = stat(2, 0, 0, 1, 0x0020_0000);
    for (const malformed of [
      kernel.replace(/1$/, "invalid"),
      kernel.replace(/^2 /, "2junk "),
      kernel.replace(") S 0 0", ") S -1 0"),
      kernel.replace(") S 0 0", ") S 1junk 0"),
      kernel.replace(") S 0 0", ") SS 0 0"),
      kernel.replace("2097152", "2097152junk"),
    ]) {
      const { api, psCalls } = await linuxApi({ 2: malformed, ...users });
      await expect(api.collectDescendantIdentities(root.pid, root)).rejects.toThrow("process snapshot unavailable");
      expect(psCalls()).toBe(0);
    }
  });

  test("root PID reuse between proc reads still disqualifies its descendants", async () => {
    for (const batch of [false, true]) {
      const { api } = await linuxApi({
        ...users,
        101: (read) => stat(101, 1, 101, read === 1 ? 1000 : 2000),
      });
      await expect(batch ? api.collectDescendantIdentitiesForRoots([root]) : api.collectDescendantIdentities(root.pid, root)).resolves.toEqual([]);
    }
  });

  test("legacy captured ps identities retain explicit ps revalidation", async () => {
    const legacy = { ...root, startToken: "ps:Sat Nov 14 14:28:17 2026" };
    const { api, psCalls } = await linuxApi(users, "101 101 S Sat Nov 14 14:28:17 2026\n");
    await expect(api.revalidateProcessIdentities([legacy])).resolves.toEqual({ complete: true, identities: [legacy] });
    expect(psCalls()).toBe(1);
  });

  test.skipIf(process.platform !== "linux")("real Linux descendant capture and direct probes agree", async () => {
    const leafCode = "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));";
    const anchorCode = `const leaf=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leafCode)}],{stdio:['pipe','ignore','ignore']});console.log(leaf.pid);process.stdin.resume();process.stdin.on('end',()=>leaf.stdin.end());leaf.on('exit',()=>process.exit(0));setTimeout(()=>leaf.stdin.end(),3000).unref();`;
    const anchor = spawn(process.execPath, ["-e", anchorCode], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const closed = new Promise<void>((resolve) => anchor.once("close", () => resolve()));
    try {
      const leafPid = await new Promise<number>((resolve, reject) => {
        anchor.once("error", reject);
        anchor.once("exit", () => reject(new Error("anchor exited before publishing its child")));
        anchor.stdout.once("data", (data) => resolve(Number(String(data).trim())));
      });
      const rootProbe = await probeProcessIdentity(anchor.pid!);
      const leafProbe = await probeProcessIdentity(leafPid);
      expect(rootProbe.complete).toBe(true);
      expect(leafProbe.complete).toBe(true);
      expect(rootProbe.identity?.startToken).toStartWith("proc:");
      expect(leafProbe.identity?.startToken).toStartWith("proc:");
      const expectSameLiveLeaf = (identity: ProcessIdentity | undefined) => {
        expect(identity).toMatchObject({
          pid: leafPid,
          processGroupId: leafProbe.identity!.processGroupId,
          startToken: leafProbe.identity!.startToken,
        });
        expect(identity?.state).toMatch(/^[RSDTtIKWP]$/);
      };
      const captured = await collectDescendantIdentities(anchor.pid!, rootProbe.identity);
      expectSameLiveLeaf(captured.find((identity) => identity.pid === leafPid));
      const batch = await collectDescendantIdentitiesForRoots([rootProbe.identity!]);
      expectSameLiveLeaf(batch.find((identity) => identity.pid === leafPid));
    } finally {
      anchor.stdin.end();
      cleanupTimer = setTimeout(() => { try { process.kill(-anchor.pid!, "SIGKILL"); } catch {} }, 1_000);
      await closed;
      clearTimeout(cleanupTimer);
    }
  }, 5_000);
});
