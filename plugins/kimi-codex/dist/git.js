import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { RuntimeError } from "./errors.js";
const execFileAsync = promisify(execFile);
const MAX_DIFF_CHARS = 80_000;
/**
 * Buffer ceiling for a write-swarm capture patch. Unlike review diffs (capped at
 * MAX_DIFF_CHARS for prompt budget), a capture patch MUST be byte-complete to
 * `git apply`, so it is never truncated — only bounded by this generous buffer to
 * avoid an unbounded RSS spike. A swarm patch larger than this is pathological.
 */
const MAX_PATCH_BYTES = 64 * 1024 * 1024;
export async function collectReviewContext(cwd, base) {
    const { repoRoot } = await resolveRepoIdentity(cwd);
    const statusSummary = (await runGit(["status", "--short", "--untracked-files=all"], cwd)).trim();
    if (base) {
        const diffText = await getBaseDiff(cwd, base);
        return {
            repoRoot,
            statusSummary,
            diffText: truncateDiff(diffText),
            targetDescription: `branch diff against ${base}`,
        };
    }
    // Working-tree review is repo-wide. status --short is already repo-wide; limiting diff to
    // the caller's subdirectory would mask unrelated-but-relevant changes elsewhere in the repo.
    const headDiff = await runGitAllowFailure(["diff", "--no-ext-diff", "--unified=3", "HEAD", "--"], cwd);
    const diffText = headDiff.ok && headDiff.stdout.trim().length > 0
        ? headDiff.stdout
        : await runGit(["diff", "--no-ext-diff", "--unified=3", "--"], cwd);
    return {
        repoRoot,
        statusSummary,
        diffText: truncateDiff(diffText),
        targetDescription: "current working tree changes",
    };
}
export async function resolveRepoIdentity(cwd) {
    const workspaceRoot = await realpath(cwd);
    const result = await runGitAllowFailure(["rev-parse", "--show-toplevel", "--git-common-dir"], cwd);
    if (!result.ok) {
        return {
            repoId: sha256(workspaceRoot),
            repoRoot: workspaceRoot,
            gitCommonDir: null,
            isGitRepo: false,
        };
    }
    const [repoRootRaw, gitCommonDirRaw] = result.stdout
        .trim()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    const repoRoot = repoRootRaw ? await realpath(repoRootRaw) : workspaceRoot;
    const gitCommonDir = gitCommonDirRaw && gitCommonDirRaw.length > 0
        ? await realpath(path.resolve(cwd, gitCommonDirRaw))
        : null;
    return {
        repoId: sha256(`${gitCommonDir ?? repoRoot}::${repoRoot}`),
        repoRoot,
        gitCommonDir,
        isGitRepo: true,
    };
}
async function getBaseDiff(cwd, base) {
    // --end-of-options is a git safety marker (since 2.24) telling git every token after it is
    // a refspec, not a flag. Defense in depth against argument injection via --base.
    const threeDot = await runGitAllowFailure(["diff", "--no-ext-diff", "--unified=3", "--end-of-options", `${base}...HEAD`, "--"], cwd);
    if (threeDot.ok) {
        return threeDot.stdout;
    }
    return runGit(["diff", "--no-ext-diff", "--unified=3", "--end-of-options", base, "--"], cwd);
}
async function runGit(args, cwd) {
    const result = await runGitAllowFailure(args, cwd);
    if (!result.ok) {
        throw new RuntimeError("GIT_COMMAND_FAILED", `git ${args.join(" ")} failed: ${result.stderr || "unknown error"}`, "review.git");
    }
    return result.stdout;
}
async function runGitAllowFailure(args, cwd) {
    try {
        const { stdout, stderr } = await execFileAsync("git", args, {
            cwd,
            env: process.env,
            maxBuffer: 10 * 1024 * 1024,
        });
        return { ok: true, stdout, stderr };
    }
    catch (error) {
        const execError = error;
        return {
            ok: false,
            stdout: execError.stdout ?? "",
            stderr: execError.stderr ?? execError.message,
        };
    }
}
function truncateDiff(diffText) {
    if (diffText.length <= MAX_DIFF_CHARS) {
        return diffText;
    }
    return `${diffText.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated by companion after ${MAX_DIFF_CHARS} characters]`;
}
function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
// ---------------------------------------------------------------------
// Ephemeral worktree lifecycle — write-swarm (v1.4).
//
// A write-swarm spawns its coordinator `kimi -p` with cwd = a throwaway
// detached worktree off the user's HEAD, so `coder` subagents edit there and
// never touch the user's checkout. The worktree is a LINKED worktree: its
// working tree + index are isolated and disposable, but it SHARES the main
// repo's object DB and refs. The PreToolUse hook (swarm-write label) confines
// every subagent write to this worktree; the plugin captures the result as a
// patch and removes the worktree. See .claude/docs/write-swarm-spec.md.
// ---------------------------------------------------------------------
/**
 * True if the repo at `cwd` has a born HEAD (at least one commit). `git worktree
 * add --detach HEAD` fails on an unborn HEAD (fresh repo, no commits) and on a
 * bare repo, so write-swarm gates on this before creating any job state.
 */
export async function hasBornHead(cwd) {
    const result = await runGitAllowFailure(["rev-parse", "--verify", "--quiet", "HEAD"], cwd);
    return result.ok && result.stdout.trim().length > 0;
}
/**
 * Create a throwaway detached worktree at `worktreePath` checked out to `base`
 * (write-swarm hard-codes "HEAD"; never user input). `worktreePath` MUST be
 * outside the repo (the plugin's worktrees dir). Throws GIT_WORKTREE_ADD_FAILED
 * on failure. Caller owns removal (`removeWorktree`) on EVERY terminal path.
 */
export async function createEphemeralWorktree(repoRoot, base, worktreePath) {
    const result = await runGitAllowFailure(["worktree", "add", "--detach", worktreePath, base], repoRoot);
    if (!result.ok) {
        throw new RuntimeError("GIT_WORKTREE_ADD_FAILED", `git worktree add failed: ${result.stderr || "unknown error"}`, "swarm.worktree", { details: { repoRoot, worktreePath, base } });
    }
}
/**
 * Capture the full change set in a worktree as a byte-complete, applyable patch.
 *
 * `git add -N -- .` records intent-to-add index entries for untracked files so
 * the diff includes their content — WITHOUT writing blob objects into the shared
 * object DB (intent-to-add stores a zero-oid entry in the worktree's OWN index
 * only). This keeps the "plugin never mutates git state" invariant literally
 * true: no loose objects, no ref/HEAD movement.
 *
 * The diff is taken against **HEAD** (the worktree's base commit), NOT the index:
 * `git diff HEAD` captures the complete change set regardless of index state, so
 * the patch is invariant to any intermediate staging (e.g. if a tool ever
 * `git add`s a file, a plain `git diff` would silently omit it; `git diff HEAD`
 * still captures it). `--binary` makes binary changes applyable; the diff is
 * NEVER truncated (a capture patch must apply cleanly) and uses a raised
 * maxBuffer. Mirrors `collectReviewContext`'s HEAD-based diff.
 *
 * Returns the patch text (empty string if the swarm changed nothing).
 */
export async function captureWorktreePatch(worktreePath) {
    // Best-effort intent-to-add so untracked files surface in `git diff HEAD`
    // (without -N, git diff ignores untracked files entirely). A failure here just
    // means new files are omitted from the diff, surfaced as a smaller patch.
    await runGitAllowFailure(["add", "-N", "--", "."], worktreePath);
    try {
        const { stdout } = await execFileAsync("git", ["diff", "--binary", "HEAD", "--"], {
            cwd: worktreePath,
            env: process.env,
            maxBuffer: MAX_PATCH_BYTES,
        });
        return stdout;
    }
    catch (error) {
        const execError = error;
        throw new RuntimeError("GIT_WORKTREE_DIFF_FAILED", `git diff (worktree capture) failed: ${execError.stderr || execError.message || "unknown error"}`, "swarm.worktree", { details: { worktreePath } });
    }
}
/**
 * Remove a worktree (best-effort, idempotent). `--force` discards the dirty tree,
 * so callers MUST capture the patch BEFORE calling this. Falls back to pruning the
 * admin entry and removing the on-disk dir if `worktree remove` cannot (e.g. the
 * dir was partially deleted). Never throws — cleanup must not mask the real error
 * on a failure path.
 */
export async function removeWorktree(repoRoot, worktreePath) {
    const removed = await runGitAllowFailure(["worktree", "remove", "--force", worktreePath], repoRoot);
    if (!removed.ok) {
        // Prune the admin entry (handles the case where the dir is already gone) then
        // force-delete any on-disk remnant so no orphan accretes in the plugin dir.
        await runGitAllowFailure(["worktree", "prune"], repoRoot);
        await rm(worktreePath, { recursive: true, force: true }).catch(() => {
            // Best-effort; a residual dir is swept on the next run.
        });
    }
}
/**
 * Prune stale worktree admin entries (entries whose on-disk dir is gone). Cheap;
 * run at the start of every write-swarm. Does NOT remove on-disk worktrees whose
 * dirs still exist — the caller sweeps those by path. Never throws.
 */
export async function pruneWorktrees(repoRoot) {
    await runGitAllowFailure(["worktree", "prune"], repoRoot);
}
/**
 * True if the working tree at `cwd` has uncommitted changes (tracked or
 * untracked). write-swarm bases its worktree on HEAD, so a dirty tree means the
 * user's in-progress work is NOT visible to the swarm — the caller warns. Returns
 * false on a git failure (don't block the run on a status probe).
 */
export async function isWorkingTreeDirty(cwd) {
    const result = await runGitAllowFailure(["status", "--porcelain", "--untracked-files=all"], cwd);
    return result.ok && result.stdout.trim().length > 0;
}
