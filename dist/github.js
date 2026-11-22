import { spawn } from "node:child_process";
import { RuntimeError } from "./errors.js";
const GH_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;
export function parsePullRequestRef(value, fallbackRepo) {
    const url = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(value);
    const short = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(value);
    const match = url ?? short;
    if (match !== null)
        return validatedRef(match[1], match[2], match[3]);
    const number = /^#?(\d+)$/.exec(value)?.[1];
    if (number !== undefined && fallbackRepo !== undefined) {
        const fallback = /^([^/]+)\/([^/]+)$/.exec(fallbackRepo);
        if (fallback !== null)
            return validatedRef(fallback[1], fallback[2], number);
    }
    throw new RuntimeError("PR_REF_INVALID", `Invalid PR reference ${JSON.stringify(value)}. Use owner/repo#123, a full github.com PR URL, or #123 inside a GitHub repository.`, "review-pr.parse");
}
function validatedRef(owner, repo, number) {
    if (!REPOSITORY_PART.test(owner) || !REPOSITORY_PART.test(repo) ||
        owner === "." || owner === ".." || repo === "." || repo === ".." ||
        !/^[1-9]\d{0,9}$/.test(number)) {
        throw new RuntimeError("PR_REF_INVALID", "The PR owner, repository name, or number is invalid.", "review-pr.parse");
    }
    return { repo: `${owner}/${repo}`, number };
}
export async function fetchPullRequest(value, cwd, runner = runGh) {
    let fallbackRepo;
    if (/^#?\d+$/.test(value)) {
        fallbackRepo = (await runner(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], cwd)).trim();
    }
    const ref = parsePullRequestRef(value, fallbackRepo);
    const fields = "title,body,baseRefName,headRefName,headRefOid,author,changedFiles,additions,deletions,state,url";
    const [metadataText, diff] = await Promise.all([
        runner(["pr", "view", ref.number, "--repo", ref.repo, "--json", fields], cwd),
        runner(["pr", "diff", ref.number, "--repo", ref.repo], cwd),
    ]);
    let raw;
    try {
        raw = JSON.parse(metadataText);
    }
    catch (error) {
        throw new RuntimeError("PR_METADATA_INVALID", "gh returned invalid PR metadata.", "review-pr.fetch", { cause: error });
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new RuntimeError("PR_METADATA_INVALID", "gh returned PR metadata that is not an object.", "review-pr.fetch");
    }
    const metadata = raw;
    for (const field of ["title", "baseRefName", "headRefName", "headRefOid", "state", "url"]) {
        if (typeof metadata[field] !== "string") {
            throw new RuntimeError("PR_METADATA_INVALID", `PR metadata is missing string field ${field}.`, "review-pr.fetch");
        }
    }
    for (const field of ["changedFiles", "additions", "deletions"]) {
        if (!Number.isSafeInteger(metadata[field]) || metadata[field] < 0) {
            throw new RuntimeError("PR_METADATA_INVALID", `PR metadata is missing numeric field ${field}.`, "review-pr.fetch");
        }
    }
    return {
        ...ref,
        title: metadata.title,
        body: typeof metadata.body === "string" ? metadata.body : "",
        baseRefName: metadata.baseRefName,
        headRefName: metadata.headRefName,
        headRefOid: metadata.headRefOid,
        author: typeof metadata.author === "object" && metadata.author !== null && "login" in metadata.author
            ? String(metadata.author.login ?? "unknown")
            : "unknown",
        changedFiles: metadata.changedFiles,
        additions: metadata.additions,
        deletions: metadata.deletions,
        state: metadata.state,
        url: metadata.url,
        diff,
    };
}
export function buildPullRequestComment(pr, review) {
    return [
        `## Kimi review of ${pr.repo}#${pr.number}`,
        "",
        review.trim(),
        "",
        `<!-- kimi-plugin-cc:review-pr:${pr.headRefOid} -->`,
    ].join("\n");
}
export async function postPullRequestComment(pr, body, cwd, runner = runGh) {
    const response = await runner([
        "api",
        `repos/${pr.repo}/issues/${pr.number}/comments`,
        "--method",
        "POST",
        "--input",
        "-",
    ], cwd, JSON.stringify({ body }));
    try {
        const parsed = JSON.parse(response);
        return typeof parsed.html_url === "string" ? parsed.html_url : null;
    }
    catch {
        return null;
    }
}
async function runGh(args, cwd, input) {
    return await new Promise((resolve, reject) => {
        const child = spawn("gh", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
        const stdout = [];
        let stdoutBytes = 0;
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
            child.kill("SIGTERM");
            fail(new RuntimeError("GH_TIMEOUT", `gh ${args[0] ?? "command"} timed out.`, "review-pr.gh"));
        }, GH_TIMEOUT_MS);
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        };
        child.on("error", (error) => fail(new RuntimeError("GH_UNAVAILABLE", `Unable to start gh: ${error.message}`, "review-pr.gh", { cause: error })));
        child.stdout.on("data", (chunk) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > MAX_STDOUT_BYTES) {
                child.kill("SIGTERM");
                fail(new RuntimeError("GH_OUTPUT_TOO_LARGE", "gh output exceeded the 16 MiB limit.", "review-pr.gh"));
                return;
            }
            stdout.push(chunk);
        });
        child.stderr.on("data", (chunk) => {
            stderr = `${stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR_BYTES);
        });
        child.on("close", (code) => {
            if (settled)
                return;
            if (code !== 0) {
                fail(new RuntimeError("GH_COMMAND_FAILED", `gh ${args.slice(0, 2).join(" ")} failed: ${stderr.trim() || `exit ${code}`}`, "review-pr.gh"));
                return;
            }
            settled = true;
            clearTimeout(timer);
            resolve(Buffer.concat(stdout).toString("utf8"));
        });
        child.stdin.on("error", (error) => fail(error));
        child.stdin.end(input ?? "");
    });
}
