import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { RuntimeError } from "./errors.js";
const execFileAsync = promisify(execFile);
const MAX_DIFF_CHARS = 80_000;
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
