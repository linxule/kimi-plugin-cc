import { describe, expect, test } from "bun:test";
import { lstat, mkdir, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { installBoundedSwarmToolPolicy } from "../../runtime/swarm-tool-policy.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

const identity = { workspaceId: "wd_test", sessionId: "session_test" };
const expectedState = `${JSON.stringify({ disabledTools: ["TaskStop"] })}\n`;
const expectedFailure = { code: "SWARM_ACTIVATION_FAILED", stage: "swarm-activation.tool-policy" };

interface Fixture {
  root: string;
  home: string;
  sessions: string;
  workspace: string;
  session: string;
  policy: string;
  state: string;
  outside: string;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await createTestPluginDataRoot("swarm-tool-policy");
  const home = path.join(root, "home");
  const sessions = path.join(home, "sessions");
  const workspace = path.join(sessions, identity.workspaceId);
  const session = path.join(workspace, identity.sessionId);
  const policy = path.join(session, "tool-policy");
  const state = path.join(policy, "state.json");
  const outside = path.join(root, "outside");
  await mkdir(session, { recursive: true });
  await mkdir(outside);
  try {
    await run({ root, home, sessions, workspace, session, policy, state, outside });
  } finally {
    await cleanupTestPath(root);
  }
}

async function assertPublished(fixture: Fixture): Promise<void> {
  expect(await readFile(fixture.state, "utf8")).toBe(expectedState);
  expect(await readdir(fixture.policy)).toEqual(["state.json"]);
  const state = await lstat(fixture.state);
  const policy = await lstat(fixture.policy);
  expect(state.isFile()).toBe(true);
  expect(state.isSymbolicLink()).toBe(false);
  expect(policy.isDirectory()).toBe(true);
  expect(policy.isSymbolicLink()).toBe(false);
  if (process.platform !== "win32") {
    expect(state.mode & 0o777).toBe(0o600);
    expect(policy.mode & 0o777).toBe(0o700);
  }
}

async function inode(file: string): Promise<{ dev: number; ino: number }> {
  const value = await lstat(file);
  return { dev: value.dev, ino: value.ino };
}

describe("bounded swarm native tool-policy installation", () => {
  test("publishes only TaskStop disabled with private modes and no temporary files", async () => {
    await withFixture(async (fixture) => {
      await installBoundedSwarmToolPolicy(fixture.home, identity);
      await assertPublished(fixture);
    });
  });

  test("uses an existing real empty policy directory", async () => {
    await withFixture(async (fixture) => {
      await mkdir(fixture.policy, { mode: 0o700 });
      const before = await inode(fixture.policy);
      await installBoundedSwarmToolPolicy(fixture.home, identity);
      await assertPublished(fixture);
      expect(await inode(fixture.policy)).toEqual(before);
    });
  });

  test("canonicalizes a home alias without following symlinked descendants", async () => {
    await withFixture(async (fixture) => {
      const alias = path.join(fixture.root, "home-alias");
      await symlink(fixture.home, alias, "dir");
      await installBoundedSwarmToolPolicy(alias, identity);
      await assertPublished(fixture);
      expect(await readlink(alias)).toBe(fixture.home);
    });
  });

  test("refuses repeat installation even when the existing state is exact", async () => {
    await withFixture(async (fixture) => {
      await installBoundedSwarmToolPolicy(fixture.home, identity);
      const before = await inode(fixture.state);
      await expect(installBoundedSwarmToolPolicy(fixture.home, identity)).rejects.toMatchObject(expectedFailure);
      expect(await inode(fixture.state)).toEqual(before);
      await assertPublished(fixture);
    });
  });

  test("never overwrites conflicting regular state", async () => {
    await withFixture(async (fixture) => {
      await mkdir(fixture.policy, { mode: 0o700 });
      const original = '{"disabledTools":["Read"],"owner":"operator"}\n';
      await writeFile(fixture.state, original, { mode: 0o600 });
      const before = await inode(fixture.state);
      await expect(installBoundedSwarmToolPolicy(fixture.home, identity)).rejects.toMatchObject(expectedFailure);
      expect(await readFile(fixture.state, "utf8")).toBe(original);
      expect(await inode(fixture.state)).toEqual(before);
      expect(await readdir(fixture.policy)).toEqual(["state.json"]);
    });
  });

  test.each(["sessions", "workspace", "session", "policy"] as const)("refuses a symlinked %s directory", async (segment) => {
    await withFixture(async (fixture) => {
      const link = fixture[segment];
      await rm(link, { recursive: true, force: true });
      await writeFile(path.join(fixture.outside, "sentinel"), "untouched\n");
      await symlink(fixture.outside, link, "dir");
      const before = await inode(link);
      await expect(installBoundedSwarmToolPolicy(fixture.home, identity)).rejects.toMatchObject(expectedFailure);
      expect(await readlink(link)).toBe(fixture.outside);
      expect(await inode(link)).toEqual(before);
      expect(await readdir(fixture.outside)).toEqual(["sentinel"]);
      expect(await readFile(path.join(fixture.outside, "sentinel"), "utf8")).toBe("untouched\n");
    });
  });

  test.each([false, true])("refuses a state symlink, including dangling=%s", async (dangling) => {
    await withFixture(async (fixture) => {
      await mkdir(fixture.policy, { mode: 0o700 });
      const target = path.join(fixture.outside, "state.json");
      if (!dangling) await writeFile(target, "outside state\n");
      await symlink(target, fixture.state, "file");
      const before = await inode(fixture.state);
      await expect(installBoundedSwarmToolPolicy(fixture.home, identity)).rejects.toMatchObject(expectedFailure);
      expect(await readlink(fixture.state)).toBe(target);
      expect(await inode(fixture.state)).toEqual(before);
      expect(await readdir(fixture.policy)).toEqual(["state.json"]);
      if (dangling) expect(await readdir(fixture.outside)).toEqual([]);
      else expect(await readFile(target, "utf8")).toBe("outside state\n");
    });
  });

  test("refuses an existing state directory", async () => {
    await withFixture(async (fixture) => {
      await mkdir(fixture.state, { recursive: true });
      const sentinel = path.join(fixture.state, "sentinel");
      await writeFile(sentinel, "preserved\n");
      const before = await inode(fixture.state);
      await expect(installBoundedSwarmToolPolicy(fixture.home, identity)).rejects.toMatchObject(expectedFailure);
      expect(await inode(fixture.state)).toEqual(before);
      expect(await readFile(sentinel, "utf8")).toBe("preserved\n");
      expect(await readdir(fixture.policy)).toEqual(["state.json"]);
    });
  });

  test.each(["sessions", "workspace", "session", "policy"] as const)("refuses a non-directory %s component", async (segment) => {
    await withFixture(async (fixture) => {
      const file = fixture[segment];
      await rm(file, { recursive: true, force: true });
      await writeFile(file, "do not replace\n");
      const before = await inode(file);
      await expect(installBoundedSwarmToolPolicy(fixture.home, identity)).rejects.toMatchObject(expectedFailure);
      expect(await inode(file)).toEqual(before);
      expect(await readFile(file, "utf8")).toBe("do not replace\n");
    });
  });

  test.each(["home", "sessions", "workspace", "session"] as const)("refuses a missing %s without creating its tree", async (segment) => {
    await withFixture(async (fixture) => {
      const missing = fixture[segment];
      await rm(missing, { recursive: true });
      await expect(installBoundedSwarmToolPolicy(fixture.home, identity)).rejects.toMatchObject(expectedFailure);
      await expect(lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test("rejects invalid identities before creating a policy directory", async () => {
    const invalid = ["", ".", "..", "../escape", "/absolute", "a/b", "a\\b", "_first", "-first", "a.", "a b", "a".repeat(257)];
    await withFixture(async (fixture) => {
      for (const id of invalid) {
        for (const key of ["sessionId", "workspaceId"] as const) {
          await expect(installBoundedSwarmToolPolicy(fixture.home, { ...identity, [key]: id }))
            .rejects.toMatchObject(expectedFailure);
        }
      }
      expect(await readdir(fixture.session)).toEqual([]);
      expect(await readdir(fixture.outside)).toEqual([]);
    });
  });

  test("accepts safe mixed-case, numeric, hyphen and underscore identities", async () => {
    await withFixture(async (fixture) => {
      const safe = { workspaceId: "7A-workspace_name", sessionId: "S9-session_Name" };
      const session = path.join(fixture.sessions, safe.workspaceId, safe.sessionId);
      await mkdir(session, { recursive: true });
      await installBoundedSwarmToolPolicy(fixture.home, safe);
      expect(await readFile(path.join(session, "tool-policy", "state.json"), "utf8")).toBe(expectedState);
    });
  });

  test("an already-aborted signal refuses before any filesystem mutation", async () => {
    await withFixture(async (fixture) => {
      const controller = new AbortController();
      controller.abort();
      await expect(installBoundedSwarmToolPolicy(fixture.home, identity, controller.signal))
        .rejects.toMatchObject({ ...expectedFailure, details: { cancelled: true } });
      expect(await readdir(fixture.session)).toEqual([]);
      expect(await readdir(fixture.outside)).toEqual([]);
    });
  });

  test("concurrent installations have one publisher and leave no temporary files", async () => {
    await withFixture(async (fixture) => {
      const results = await Promise.allSettled(Array.from({ length: 6 }, () =>
        installBoundedSwarmToolPolicy(fixture.home, identity)));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(rejected).toHaveLength(5);
      for (const result of rejected) expect(result.reason).toMatchObject(expectedFailure);
      await assertPublished(fixture);
      expect((await stat(fixture.state)).nlink).toBe(1);
    });
  });
});
