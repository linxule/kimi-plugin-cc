import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  captureWorktreePatch,
  createEphemeralWorktree,
  hasBornHead,
  isWorkingTreeDirty,
  removeWorktree,
} from "../../runtime/git.js";

// Exercises the write-swarm worktree lifecycle (v1.4) against a real git repo:
// create off HEAD, capture an applyable patch (incl. new files, no loose
// objects in the main repo), and remove — with the main checkout untouched.

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

let root: string;
let repo: string;
let worktrees: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kimi-wt-test-"));
  repo = path.join(root, "repo");
  worktrees = path.join(root, "worktrees");
  await mkdir(repo, { recursive: true });
  await mkdir(worktrees, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function initRepoWithCommit(): Promise<void> {
  git(["init", "-q"], repo);
  await writeFile(path.join(repo, "tracked.txt"), "original\n", "utf8");
  git(["add", "tracked.txt"], repo);
  git(["commit", "-q", "-m", "init"], repo);
}

describe("hasBornHead", () => {
  test("false on a fresh repo with no commits, true after the first commit", async () => {
    git(["init", "-q"], repo);
    expect(await hasBornHead(repo)).toBe(false);
    await writeFile(path.join(repo, "a.txt"), "x\n", "utf8");
    git(["add", "a.txt"], repo);
    git(["commit", "-q", "-m", "first"], repo);
    expect(await hasBornHead(repo)).toBe(true);
  });

  test("false outside a git repo", async () => {
    expect(await hasBornHead(root)).toBe(false);
  });
});

describe("isWorkingTreeDirty", () => {
  test("false on a clean tree, true with an untracked file", async () => {
    await initRepoWithCommit();
    expect(await isWorkingTreeDirty(repo)).toBe(false);
    await writeFile(path.join(repo, "new.txt"), "y\n", "utf8");
    expect(await isWorkingTreeDirty(repo)).toBe(true);
  });
});

describe("ephemeral worktree lifecycle", () => {
  test("create → edit → capture an applyable patch (tracked + new file) → remove; main tree untouched", async () => {
    await initRepoWithCommit();
    const wt = path.join(worktrees, "swarm-write-job1");

    await createEphemeralWorktree(repo, "HEAD", wt);
    expect((await stat(wt)).isDirectory()).toBe(true);

    // A coder subagent would: modify a tracked file and create a new one.
    await writeFile(path.join(wt, "tracked.txt"), "edited by swarm\n", "utf8");
    await writeFile(path.join(wt, "added.txt"), "brand new\n", "utf8");

    const patch = await captureWorktreePatch(wt);
    expect(patch).toContain("tracked.txt");
    expect(patch).toContain("edited by swarm");
    // The new file is captured via intent-to-add (no loose objects written).
    expect(patch).toContain("added.txt");
    expect(patch).toContain("brand new");

    // The main repo's working tree is UNTOUCHED by the worktree edits.
    expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("original\n");
    expect(await isWorkingTreeDirty(repo)).toBe(false);

    // The captured patch APPLIES cleanly back at the repo root.
    const patchFile = path.join(root, "capture.patch");
    await writeFile(patchFile, patch, "utf8");
    git(["apply", patchFile], repo);
    expect(await readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("edited by swarm\n");
    expect(await readFile(path.join(repo, "added.txt"), "utf8")).toBe("brand new\n");
    // Roll the working tree back so removeWorktree's assertions below are clean.
    git(["checkout", "--", "tracked.txt"], repo);
    await rm(path.join(repo, "added.txt"), { force: true });

    await removeWorktree(repo, wt);
    await expect(stat(wt)).rejects.toThrow();
    expect(git(["worktree", "list"], repo)).not.toContain(wt);
  });

  test("capture is index-state-invariant: a staged file is still in the patch (git diff HEAD)", async () => {
    // Regression for the capture bug found in review: a plain `git diff` (worktree
    // vs index) silently omits a fully-staged file; `git diff HEAD` captures it.
    await initRepoWithCommit();
    const wt = path.join(worktrees, "swarm-write-staged");
    await createEphemeralWorktree(repo, "HEAD", wt);

    await writeFile(path.join(wt, "tracked.txt"), "edited\n", "utf8");
    await writeFile(path.join(wt, "staged.txt"), "fully staged\n", "utf8");
    // Simulate something having staged a file with content (not intent-to-add).
    git(["add", "staged.txt"], wt);

    const patch = await captureWorktreePatch(wt);
    expect(patch).toContain("staged.txt");
    expect(patch).toContain("fully staged");
    expect(patch).toContain("tracked.txt");
    await removeWorktree(repo, wt);
  });

  test("capture on a worktree with no edits yields an empty patch", async () => {
    await initRepoWithCommit();
    const wt = path.join(worktrees, "swarm-write-job2");
    await createEphemeralWorktree(repo, "HEAD", wt);
    const patch = await captureWorktreePatch(wt);
    expect(patch.trim()).toBe("");
    await removeWorktree(repo, wt);
  });

  test("createEphemeralWorktree throws GIT_WORKTREE_ADD_FAILED outside a repo", async () => {
    const wt = path.join(worktrees, "swarm-write-job3");
    await expect(createEphemeralWorktree(root, "HEAD", wt)).rejects.toThrow();
  });

  test("removeWorktree is best-effort and never throws on a missing path", async () => {
    await initRepoWithCommit();
    await removeWorktree(repo, path.join(worktrees, "does-not-exist"));
  });
});
