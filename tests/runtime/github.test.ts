import { describe, expect, test } from "bun:test";

import {
  buildPullRequestComment,
  fetchPullRequest,
  parsePullRequestRef,
  postPullRequestComment,
  type GhRunner,
  type PullRequestData,
} from "../../runtime/github.js";

const metadata = {
  title: "Fix parser",
  body: "PR body",
  baseRefName: "main",
  headRefName: "fix/parser",
  headRefOid: "a".repeat(40),
  author: { login: "octocat" },
  changedFiles: 2,
  additions: 8,
  deletions: 3,
  state: "OPEN",
  url: "https://github.com/acme/widgets/pull/42",
};

function pullRequest(overrides: Partial<PullRequestData> = {}): PullRequestData {
  return {
    repo: "acme/widgets",
    number: "42",
    ...metadata,
    author: metadata.author.login,
    diff: "diff --git a/a.ts b/a.ts\n+const fixed = true;\n",
    ...overrides,
  };
}

describe("GitHub PR references", () => {
  test.each([
    ["acme/widgets#42", { repo: "acme/widgets", number: "42" }],
    ["https://github.com/acme/widgets/pull/42", { repo: "acme/widgets", number: "42" }],
    ["https://github.com/acme/widgets/pull/42/", { repo: "acme/widgets", number: "42" }],
    ["#42", { repo: "fallback/repo", number: "42" }],
    ["42", { repo: "fallback/repo", number: "42" }],
  ])("parses %s", (value, expected) => {
    expect(parsePullRequestRef(value, "fallback/repo")).toEqual(expected);
  });

  test.each([
    "http://github.com/acme/widgets/pull/42",
    "https://github.com/acme/widgets/pull/42/files",
    "https://evil.example/acme/widgets/pull/42",
    "acme/widgets#0",
    "acme/widgets#12345678901",
    "../repo#42",
    "acme/..#42",
    "#42",
    "acme/widgets",
  ])("rejects %s", (value) => {
    expect(() => parsePullRequestRef(value)).toThrow();
  });
});

describe("GitHub PR data", () => {
  test("resolves a numeric ref through the current repository and fetches metadata plus diff", async () => {
    const calls: string[][] = [];
    const runner: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === "repo") return "acme/widgets\n";
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify(metadata);
      if (args[0] === "pr" && args[1] === "diff") return "diff --git a/a.ts b/a.ts\n";
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const result = await fetchPullRequest("#42", "/workspace", runner);
    expect(result).toEqual(pullRequest({ diff: "diff --git a/a.ts b/a.ts\n" }));
    expect(calls[0]).toEqual(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
    expect(calls).toContainEqual(["pr", "view", "42", "--repo", "acme/widgets", "--json", "title,body,baseRefName,headRefName,headRefOid,author,changedFiles,additions,deletions,state,url"]);
    expect(calls).toContainEqual(["pr", "diff", "42", "--repo", "acme/widgets"]);
  });

  test.each([
    ["not-json", "PR_METADATA_INVALID"],
    ["null", "PR_METADATA_INVALID"],
    [JSON.stringify({ ...metadata, changedFiles: -1 }), "PR_METADATA_INVALID"],
    [JSON.stringify({ ...metadata, headRefOid: null }), "PR_METADATA_INVALID"],
  ])("rejects malformed metadata %s", async (response, code) => {
    const runner: GhRunner = async (args) => args[1] === "view" ? response : "diff";
    await expect(fetchPullRequest("acme/widgets#42", "/workspace", runner)).rejects.toMatchObject({ code });
  });

  test("builds a summary comment bound to the reviewed head", () => {
    const body = buildPullRequestComment(pullRequest(), "concern\n\nFinding one.");
    expect(body).toContain("## Kimi review of acme/widgets#42");
    expect(body).toContain("concern\n\nFinding one.");
    expect(body).toContain(`<!-- kimi-plugin-cc:review-pr:${"a".repeat(40)} -->`);
  });

  test("posts JSON over stdin and returns the comment URL without a live API call", async () => {
    let invocation: { args: string[]; cwd: string; input?: string } | undefined;
    const runner: GhRunner = async (args, cwd, input) => {
      invocation = { args, cwd, input };
      return JSON.stringify({ html_url: "https://github.com/acme/widgets/issues/42#issuecomment-1" });
    };
    const url = await postPullRequestComment(pullRequest(), "review body", "/workspace", runner);

    expect(url).toBe("https://github.com/acme/widgets/issues/42#issuecomment-1");
    expect(invocation).toEqual({
      args: ["api", "repos/acme/widgets/issues/42/comments", "--method", "POST", "--input", "-"],
      cwd: "/workspace",
      input: JSON.stringify({ body: "review body" }),
    });
  });
});
