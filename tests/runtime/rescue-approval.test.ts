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

  test("allows read-only shell commands and rejects non-allowlisted or mutating variants", async () => {
    const repoRoot = await createGitRepoFixture("approval-shell");
    const policy = await createRescueApprovalPolicy(repoRoot);

    try {
      await expect(policy(shellApproval("pwd"), { commandType: "rescue" })).resolves.toMatchObject({
        response: "approve",
      });
      await expect(policy(shellApproval("rg todo src | head -n 5"), { commandType: "rescue" })).resolves.toMatchObject({
        response: "approve",
      });
      await expect(policy(shellApproval("curl https://example.com"), { commandType: "rescue" })).resolves.toMatchObject({
        response: "reject",
      });
      await expect(policy(shellApproval("find . -delete"), { commandType: "rescue" })).resolves.toMatchObject({
        response: "reject",
      });
      await expect(policy(shellApproval("eslint . --fix"), { commandType: "rescue" })).resolves.toMatchObject({
        response: "reject",
      });
      await expect(policy(shellApproval("bun run dev"), { commandType: "rescue" })).resolves.toMatchObject({
        response: "reject",
      });
    } finally {
      await cleanupTestPath(repoRoot);
    }
  });
});
