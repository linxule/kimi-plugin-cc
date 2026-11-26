import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { runSetup } from "../../runtime/commands/setup.js";
import { RuntimeError } from "../../runtime/errors.js";
import { resolveRepoIdentity } from "../../runtime/git.js";
import {
  hookRefusalDetails,
  hookRefusalRetryProtocol,
  verifyHookInstalled,
} from "../../runtime/hooks/install.js";
import { isOurApprovalHookCommand } from "../../runtime/hooks/install-paths.js";
import { evaluateInstalled } from "../../runtime/hooks/managed-block.js";
import { JobStore, type JobRecord } from "../../runtime/job-store.js";
import { sweepStaleJobs } from "../../runtime/jobs.js";
import { formatVersionOutOfRangeWarning } from "../../runtime/kimi-version-probe.js";
import { writeInvocationLogHeader } from "../../runtime/logging.js";
import { awaitMcpJob, cancelMcpJob, handleMcpJobTool } from "../../runtime/mcp/job-control.js";
import { MCP_TOOL_DEFINITIONS } from "../../runtime/mcp/operations.js";
import { ensurePluginPaths, resolvePluginPaths } from "../../runtime/paths.js";
import { renderManagedJobOutput } from "../../runtime/render.js";
import { Database } from "bun:sqlite";
import { sleep } from "../../runtime/util.js";
import { createMcpFixture, McpClient, modernMeta } from "../helpers/mcp.js";
import {
  cleanupTestPath,
  createGitRepoFixture,
  createTestPluginDataRoot,
} from "../helpers/test-env.js";

const repoRoot = process.cwd();

function makeContext(cwd: string, env: NodeJS.ProcessEnv) {
  return {
    cwd,
    env,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

function makeSetupEnv(dataDir: string, kimiHome: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KIMI_PLUGIN_CC_DATA: dataDir,
    KIMI_CODE_HOME: kimiHome,
    ...extra,
  };
  delete env.KIMI_PLUGIN_CC_HOOK_SCRIPT;
  delete env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK;
  delete env.KIMI_PLUGIN_CC_NODE_BIN;
  if (!("KIMI_PLUGIN_CC_SKIP_VERSION_PROBE" in extra)) {
    env.KIMI_PLUGIN_CC_SKIP_VERSION_PROBE = "1";
  }
  return env;
}

async function expectRuntimeErrorCode(promise: Promise<unknown>, code: string): Promise<RuntimeError> {
  try {
    await promise;
    throw new Error(`Expected RuntimeError(${code}) but resolved`);
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeError);
    const runtimeError = error as RuntimeError;
    expect(runtimeError.code).toBe(code);
    return runtimeError;
  }
}

describe("Council 3.1.0 hardening regressions", () => {
  describe("hook artifact safety, probe-before-activate, and managed-artifact verification", () => {
    test("runSetup refuses symlinked pluginRoot, hookDir, and approval-hook.js with SETUP_HOOK_PATH_UNSAFE", async () => {
      const scratch = await createTestPluginDataRoot("council-hook-symlink");
      const kimiHome = path.join(scratch, "kimi-home");
      const realTarget = path.join(scratch, "real-target");
      await mkdir(kimiHome, { recursive: true });
      await mkdir(realTarget, { recursive: true });

      try {
        // 1. Symlinked pluginRoot (<dataRoot>/kimi-plugin-cc)
        const dataWithPluginRootLink = path.join(scratch, "data-plugin-root-link");
        await mkdir(dataWithPluginRootLink, { recursive: true });
        await symlink(realTarget, path.join(dataWithPluginRootLink, "kimi-plugin-cc"));
        await expectRuntimeErrorCode(
          runSetup([], makeContext(repoRoot, makeSetupEnv(dataWithPluginRootLink, kimiHome))),
          "SETUP_HOOK_PATH_UNSAFE",
        );

        // 2. Symlinked hookDir (<dataRoot>/kimi-plugin-cc/hook)
        const dataWithHookDirLink = path.join(scratch, "data-hook-dir-link");
        await mkdir(path.join(dataWithHookDirLink, "kimi-plugin-cc"), { recursive: true });
        await symlink(realTarget, path.join(dataWithHookDirLink, "kimi-plugin-cc", "hook"));
        await expectRuntimeErrorCode(
          runSetup([], makeContext(repoRoot, makeSetupEnv(dataWithHookDirLink, kimiHome))),
          "SETUP_HOOK_PATH_UNSAFE",
        );

        // 3. Symlinked approval-hook.js (<dataRoot>/kimi-plugin-cc/hook/approval-hook.js)
        const dataWithScriptLink = path.join(scratch, "data-script-link");
        await mkdir(path.join(dataWithScriptLink, "kimi-plugin-cc", "hook"), { recursive: true });
        await symlink(
          path.join(repoRoot, "dist/hooks/approval-hook.js"),
          path.join(dataWithScriptLink, "kimi-plugin-cc", "hook", "approval-hook.js"),
        );
        await expectRuntimeErrorCode(
          runSetup([], makeContext(repoRoot, makeSetupEnv(dataWithScriptLink, kimiHome))),
          "SETUP_HOOK_PATH_UNSAFE",
        );
      } finally {
        await cleanupTestPath(scratch);
      }
    });

    test("staged hook probe runs before activation and preserves existing live hook and config on failure", async () => {
      const scratch = await createTestPluginDataRoot("council-hook-probe-before-activate");
      const dataDir = path.join(scratch, "data");
      const kimiHome = path.join(scratch, "kimi-home");
      await mkdir(kimiHome, { recursive: true });

      try {
        const goodEnv = makeSetupEnv(dataDir, kimiHome);
        const first = await runSetup([], makeContext(repoRoot, goodEnv));
        expect(first.probe).toBe("ok");

        const hookStatBefore = await stat(first.hookScriptPath);
        const hookBytesBefore = await readFile(first.hookScriptPath, "utf8");
        const configBytesBefore = await readFile(first.configPath, "utf8");

        const badNode = path.join(scratch, "bad-node.sh");
        await writeFile(badNode, "#!/bin/sh\nexit 42\n", "utf8");
        await chmod(badNode, 0o755);

        const badEnv = makeSetupEnv(dataDir, kimiHome);
        badEnv.KIMI_PLUGIN_CC_NODE_BIN = badNode;
        await expectRuntimeErrorCode(
          runSetup([], makeContext(repoRoot, badEnv)),
          "SETUP_HOOK_PROBE_FAILED",
        );

        const hookStatAfter = await stat(first.hookScriptPath);
        expect(hookStatAfter.ino).toBe(hookStatBefore.ino);
        expect(await readFile(first.hookScriptPath, "utf8")).toBe(hookBytesBefore);
        expect(await readFile(first.configPath, "utf8")).toBe(configBytesBefore);
      } finally {
        await cleanupTestPath(scratch);
      }
    });

    test("verifyHookInstalled and setup --check fail on tampered SHA-256 (retryable) and symlinked hook script (non-retryable)", async () => {
      const scratch = await createTestPluginDataRoot("council-hook-verify");
      const dataDir = path.join(scratch, "data");
      const kimiHome = path.join(scratch, "kimi-home");
      await mkdir(kimiHome, { recursive: true });

      try {
        const env = makeSetupEnv(dataDir, kimiHome);
        const installed = await runSetup([], makeContext(repoRoot, env));
        expect(installed.probe).toBe("ok");

        // 1. Tamper SHA-256 -> retryable drift on hook-script + setup --check fails.
        const originalBytes = await readFile(installed.hookScriptPath, "utf8");
        await writeFile(installed.hookScriptPath, `${originalBytes}\n// tampered\n`, "utf8");

        const tamperedStatus = await verifyHookInstalled(env);
        expect(tamperedStatus.installed).toBe(false);
        expect(tamperedStatus.drift).toMatchObject({
          axis: "hook-script",
          nodeInterpreterUnchanged: true,
        });
        expect(hookRefusalDetails(tamperedStatus).retryable_after_setup).toBe(true);

        const tamperedCheck = await runSetup(["--check"], makeContext(repoRoot, env));
        expect(tamperedCheck.probe).toBe("failed");

        // 2. Replace with symlink -> non-retryable failure (no drift) + setup --check fails.
        await rm(installed.hookScriptPath, { force: true });
        await symlink(path.join(repoRoot, "dist/hooks/approval-hook.js"), installed.hookScriptPath);

        const symlinkStatus = await verifyHookInstalled(env);
        expect(symlinkStatus.installed).toBe(false);
        expect(symlinkStatus.drift).toBeUndefined();
        expect(hookRefusalDetails(symlinkStatus).retryable_after_setup).toBeUndefined();

        const symlinkCheck = await runSetup(["--check"], makeContext(repoRoot, env));
        expect(symlinkCheck.probe).toBe("failed");
      } finally {
        await cleanupTestPath(scratch);
      }
    });

    test("hookRefusalRetryProtocol ignores forged ambient CLAUDE_PLUGIN_ROOT and PLUGIN_ROOT", () => {
      const message = hookRefusalRetryProtocol({
        CLAUDE_PLUGIN_ROOT: "/forged/claude-root",
        PLUGIN_ROOT: "/forged/plugin-root",
      });
      expect(message).toContain(`${repoRoot}/scripts/companion.sh setup`);
      expect(message).not.toContain("/forged/");
    });
  });

  describe("strict hook ownership, extra-table block refusal, inline uninstall, and legacy duplicate guidance", () => {
    test("isOurApprovalHookCommand accepts exact known layouts and rejects custom paths", () => {
      const owned = [
        "'/usr/bin/node' '/home/u/.local/share/kimi-plugin-cc/hook/approval-hook.js'",
        "'/usr/bin/node' '/opt/kimi-plugin-cc/dist/hooks/approval-hook.js'",
        "'/usr/bin/node' '/opt/kimi-plugin-cc/runtime/hooks/approval-hook.js'",
        "'/usr/bin/node' '/opt/plugins/kimi-codex/dist/hooks/approval-hook.js'",
        "'/usr/bin/node' '/opt/dsh-kimi-plugin-cc/dist/hooks/approval-hook.js'",
        "'/usr/bin/node' '/opt/kimi-marketplace/kimi/3.0.0/dist/hooks/approval-hook.js'",
        "'/usr/bin/node' '/home/u/.gemini/config/plugins/kimi/dist/hooks/approval-hook.js'",
      ];
      for (const cmd of owned) {
        expect(isOurApprovalHookCommand(cmd)).toBe(true);
      }

      const foreign = [
        "'/usr/bin/node' '/home/u/kimi-plugin-cc/custom/approval-hook.js'",
        "'/usr/bin/node' '/home/u/my-hooks/approval-hook.js'",
        "'/usr/bin/node' '/tmp/approval-hook.js'",
        "/usr/bin/node /opt/kimi-plugin-cc/dist/hooks/approval-hook.js",
      ];
      for (const cmd of foreign) {
        expect(isOurApprovalHookCommand(cmd)).toBe(false);
      }
    });

    test("setup and setup --uninstall refuse managed blocks containing extra [[hooks]] or non-hooks tables", async () => {
      const scratch = await createTestPluginDataRoot("council-extra-table");
      const dataDir = path.join(scratch, "data");
      const kimiHome = path.join(scratch, "kimi-home");
      await mkdir(kimiHome, { recursive: true });
      const configPath = path.join(kimiHome, "config.toml");

      try {
        const env = makeSetupEnv(dataDir, kimiHome);
        const extraHooksContent = [
          "# === BEGIN kimi-plugin-cc-managed (v3.1.0) ===",
          "[[hooks]]",
          'event = "PreToolUse"',
          `command = "'/usr/bin/node' '/opt/kimi-plugin-cc/hook/approval-hook.js'"`,
          "timeout = 15",
          "[[hooks]]",
          'event = "PostToolUse"',
          'command = "/usr/bin/true"',
          "# === END kimi-plugin-cc-managed ===",
          "",
        ].join("\n");
        await writeFile(configPath, extraHooksContent, "utf8");

        await expectRuntimeErrorCode(runSetup([], makeContext(repoRoot, env)), "SETUP_INVALID_HOOKS_CONFIG");
        expect(await readFile(configPath, "utf8")).toBe(extraHooksContent);

        await expectRuntimeErrorCode(runSetup(["--uninstall"], makeContext(repoRoot, env)), "SETUP_INVALID_HOOKS_CONFIG");
        expect(await readFile(configPath, "utf8")).toBe(extraHooksContent);

        const nonHooksTableContent = [
          "# === BEGIN kimi-plugin-cc-managed (v3.1.0) ===",
          "[[hooks]]",
          'event = "PreToolUse"',
          `command = "'/usr/bin/node' '/opt/kimi-plugin-cc/hook/approval-hook.js'"`,
          "timeout = 15",
          "[custom]",
          'key = "keep"',
          "# === END kimi-plugin-cc-managed ===",
          "",
        ].join("\n");
        await writeFile(configPath, nonHooksTableContent, "utf8");

        await expectRuntimeErrorCode(runSetup([], makeContext(repoRoot, env)), "SETUP_INVALID_HOOKS_CONFIG");
        expect(await readFile(configPath, "utf8")).toBe(nonHooksTableContent);

        await expectRuntimeErrorCode(runSetup(["--uninstall"], makeContext(repoRoot, env)), "SETUP_INVALID_HOOKS_CONFIG");
        expect(await readFile(configPath, "utf8")).toBe(nonHooksTableContent);
      } finally {
        await cleanupTestPath(scratch);
      }
    });

    test("setup --uninstall normalizes top-level inline hooks to strip owned entries while leaving foreign-only inline configs untouched", async () => {
      const scratch = await createTestPluginDataRoot("council-inline-uninstall");
      const dataDir = path.join(scratch, "data");
      const kimiHome = path.join(scratch, "kimi-home");
      await mkdir(kimiHome, { recursive: true });
      const configPath = path.join(kimiHome, "config.toml");

      try {
        const env = makeSetupEnv(dataDir, kimiHome);

        // 1. Foreign-only inline hooks -> untouched, blockRemoved: false.
        const foreignOnly = [
          'default_model = "k2.5"',
          'hooks = [{ event = "PostToolUse", command = "/usr/bin/true" }]',
          "",
        ].join("\n");
        await writeFile(configPath, foreignOnly, "utf8");
        const noOp = await runSetup(["--uninstall"], makeContext(repoRoot, env));
        expect(noOp.blockRemoved).toBe(false);
        expect(await readFile(configPath, "utf8")).toBe(foreignOnly);

        // 2. Mixed owned + foreign inline hooks -> owned removed, foreign preserved.
        const mixed = [
          'default_model = "k2.5"',
          `hooks = [{ event = "PreToolUse", command = "'/usr/bin/node' '/opt/kimi-plugin-cc/hook/approval-hook.js'", timeout = 15 }, { event = "PostToolUse", command = "/usr/bin/true" }]`,
          "",
        ].join("\n");
        await writeFile(configPath, mixed, "utf8");
        const removed = await runSetup(["--uninstall"], makeContext(repoRoot, env));
        expect(removed.blockRemoved).toBe(true);
        const after = await readFile(configPath, "utf8");
        expect(after).toContain("/usr/bin/true");
        expect(after).not.toContain("approval-hook.js");
      } finally {
        await cleanupTestPath(scratch);
      }
    });

    test("evaluateInstalled recommends consolidation when duplicate blocks include a legacy host-scoped block", () => {
      const cmd = "'/usr/bin/node' '/opt/kimi-plugin-cc/hook/approval-hook.js'";
      const toml = [
        "# === BEGIN kimi-plugin-cc-managed:claude-code (v3.0.0) ===",
        "[[hooks]]",
        'event = "PreToolUse"',
        `command = "${cmd}"`,
        "timeout = 15",
        "# === END kimi-plugin-cc-managed:claude-code ===",
        "",
        "# === BEGIN kimi-plugin-cc-managed (v3.1.0) ===",
        "[[hooks]]",
        'event = "PreToolUse"',
        `command = "${cmd}"`,
        "timeout = 15",
        "# === END kimi-plugin-cc-managed ===",
        "",
      ].join("\n");

      const check = evaluateInstalled(toml, cmd);
      expect(check.installed).toBe(false);
      expect(check.state.kind).toBe("duplicate");
      expect(check.reason).toContain("legacy host-scoped block(s)");
      expect(check.reason).toContain("consolidate");
    });
  });

  describe("MCP containment, bound-task parity, tasks/cancel, scoped sweep, and CLI cancel identity", () => {
    test("monorepo workspace containment filters list before limit, isolates sibling jobs, and enforces bound-task parity on fallback", async () => {
      const data = await createTestPluginDataRoot("council-mcp-contain");
      const repo = await createGitRepoFixture("council-mcp-contain-repo");
      const pkgA = path.join(repo, "pkg-a");
      const pkgB = path.join(repo, "pkg-b");
      await mkdir(pkgA, { recursive: true });
      await mkdir(pkgB, { recursive: true });

      try {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          KIMI_PLUGIN_CC_DATA: data,
          KIMI_CODE_HOME: path.join(data, "kimi-home"),
        };
        const paths = resolvePluginPaths(env);
        await ensurePluginPaths(paths);
        const repoIdentity = await resolveRepoIdentity(repo);

        const store = new JobStore(paths);
        try {
          store.createJob({
            job_id: "job-pkg-a",
            repo_id: repoIdentity.repoId,
            command_type: "ask",
            operation_kind: "ask",
            cwd: pkgA,
            model: null,
            thinking: null,
            background: true,
            pid: null,
            kimi_pid: null,
            status: "completed",
            kimi_session_id: null,
            agent_profile: "read-only",
            prompt_digest: "digest-a",
            summary: "Job in pkg-a",
            final_output_path: null,
            stream_log_path: path.join(paths.logsDir, "job-pkg-a.jsonl"),
            error: null,
          });

          // Sleep 15ms so pkg-b has a strictly newer updated_at than pkg-a.
          await sleep(15);

          store.createJob({
            job_id: "job-pkg-b",
            repo_id: repoIdentity.repoId,
            command_type: "ask",
            operation_kind: "ask",
            cwd: pkgB,
            model: null,
            thinking: null,
            background: true,
            pid: null,
            kimi_pid: null,
            status: "completed",
            kimi_session_id: null,
            agent_profile: "read-only",
            prompt_digest: "digest-b",
            summary: "Job in pkg-b",
            final_output_path: null,
            stream_log_path: path.join(paths.logsDir, "job-pkg-b.jsonl"),
            error: null,
          });

          store.createMcpTask({
            task_id: "job-pkg-b",
            operation_kind: "ask",
            repo_id: repoIdentity.repoId,
            workspace_cwd: pkgB,
            stdout_path: path.join(paths.logsDir, "job-pkg-b.out"),
            stderr_path: path.join(paths.logsDir, "job-pkg-b.err"),
          });
        } finally {
          store.close();
        }

        // 1. list with limit=1 in pkg-a returns job-pkg-a (filter runs BEFORE limit, not truncated by newer job-pkg-b).
        const listed = await handleMcpJobTool(env, { action: "list", workspace: pkgA, limit: 1 });
        expect(listed.structuredContent?.count).toBe(1);
        expect((listed.structuredContent?.jobs as Array<{ job_id: string }>)[0]?.job_id).toBe("job-pkg-a");

        // 2. Sibling lookup from pkg-a for job-pkg-b fails JOB_NOT_FOUND.
        await expectRuntimeErrorCode(
          handleMcpJobTool(env, { action: "status", job_id: "job-pkg-b", workspace: pkgA }),
          "JOB_NOT_FOUND",
        );

        // 3. Bound-task parity: omitted job_id from parent repo finds newest job (job-pkg-b inside repo),
        //    routes to loadBoundTaskSnapshot, and refuses because task.workspace_cwd (pkg-b) !== repo.
        await expectRuntimeErrorCode(
          handleMcpJobTool(env, { action: "status", workspace: repo }),
          "JOB_NOT_FOUND",
        );
      } finally {
        await cleanupTestPath(data);
        await cleanupTestPath(repo);
      }
    });

    test("tasks/cancel rejects a CLI-only job UUID with JSON-RPC -32602 Unknown task ID", async () => {
      const fixture = await createMcpFixture("council-tasks-cancel-cli", {
        scenario: "ask-success",
        delayMs: "0",
      });
      let client: McpClient | undefined;
      try {
        const paths = resolvePluginPaths(fixture.env);
        await ensurePluginPaths(paths);
        const repoIdentity = await resolveRepoIdentity(fixture.repo);
        const store = new JobStore(paths);
        try {
          store.createJob({
            job_id: "cli-only-job-id",
            repo_id: repoIdentity.repoId,
            command_type: "ask",
            operation_kind: "ask",
            cwd: fixture.repo,
            model: null,
            thinking: null,
            background: false,
            pid: null,
            kimi_pid: null,
            status: "completed",
            kimi_session_id: null,
            agent_profile: "read-only",
            prompt_digest: "digest-cli",
            summary: "CLI-only job",
            final_output_path: null,
            stream_log_path: path.join(paths.logsDir, "cli-only.jsonl"),
            error: null,
          });
        } finally {
          store.close();
        }

        client = await McpClient.modern(fixture);
        let caught: Error | undefined;
        try {
          await client.request("tasks/cancel", {
            _meta: modernMeta(true),
            taskId: "cli-only-job-id",
          });
        } catch (error) {
          caught = error as Error;
        }
        expect(caught).toBeDefined();
        const rpcErr = JSON.parse(caught!.message) as { code: number; message: string };
        expect(rpcErr.code).toBe(-32602);
        expect(rpcErr.message).toContain("Unknown task ID");
      } finally {
        if (client) await client.close();
        await fixture.cleanup();
      }
    }, 30_000);

    test("sweepStaleJobs respects repoId and workspaceCwd scope so other repos and sibling workspaces are never swept", async () => {
      const data = await createTestPluginDataRoot("council-scoped-sweep");
      const repoA = await createGitRepoFixture("council-scoped-sweep-a");
      const repoB = await createGitRepoFixture("council-scoped-sweep-b");
      const pkgA = path.join(repoA, "pkg-a");
      const pkgB = path.join(repoA, "pkg-b");
      await mkdir(pkgA, { recursive: true });
      await mkdir(pkgB, { recursive: true });

      try {
        const paths = resolvePluginPaths({ ...process.env, KIMI_PLUGIN_CC_DATA: data });
        await ensurePluginPaths(paths);
        const idA = await resolveRepoIdentity(repoA);
        const idB = await resolveRepoIdentity(repoB);

        const store = new JobStore(paths);
        try {
          for (const [jobId, repoId, cwd] of [
            ["stale-a", idA.repoId, pkgA],
            ["stale-b-sibling", idA.repoId, pkgB],
            ["stale-other-repo", idB.repoId, repoB],
          ] as const) {
            store.createJob({
              job_id: jobId,
              repo_id: repoId,
              command_type: "ask",
              operation_kind: "ask",
              cwd,
              model: null,
              thinking: null,
              background: true,
              pid: 999_999,
              kimi_pid: null,
              status: "running",
              kimi_session_id: null,
              agent_profile: "read-only",
              prompt_digest: `digest-${jobId}`,
              summary: "Stale running job",
              final_output_path: null,
              stream_log_path: path.join(paths.logsDir, `${jobId}.jsonl`),
              error: null,
            });
          }

          // Backdate all three rows beyond STALE_SWEEP_GRACE_MS.
          const staleTime = new Date(Date.now() - 10 * 60_000).toISOString();
          const rawDb = new Database(paths.stateDbPath);
          try {
            rawDb.run("UPDATE jobs SET updated_at = ?", [staleTime]);
          } finally {
            rawDb.close();
          }

          await sweepStaleJobs(store, paths, { repoId: idA.repoId, workspaceCwd: pkgA });

          expect(store.getJob("stale-a")?.status).toBe("failed");
          expect(store.getJob("stale-b-sibling")?.status).toBe("running");
          expect(store.getJob("stale-other-repo")?.status).toBe("running");
        } finally {
          store.close();
        }
      } finally {
        await cleanupTestPath(data);
        await cleanupTestPath(repoA);
        await cleanupTestPath(repoB);
      }
    });

    test("cancelMcpJob refuses PID-only cancellation for a CLI-only running job missing persisted identities", async () => {
      const data = await createTestPluginDataRoot("council-cli-cancel-id");
      const repo = await createGitRepoFixture("council-cli-cancel-id-repo");
      try {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          KIMI_PLUGIN_CC_DATA: data,
          KIMI_CODE_HOME: path.join(data, "kimi-home"),
        };
        const paths = resolvePluginPaths(env);
        await ensurePluginPaths(paths);
        const repoIdentity = await resolveRepoIdentity(repo);

        const store = new JobStore(paths);
        try {
          store.createJob({
            job_id: "cli-missing-identity",
            repo_id: repoIdentity.repoId,
            command_type: "ask",
            operation_kind: "ask",
            cwd: repo,
            model: null,
            thinking: null,
            background: true,
            pid: process.pid,
            kimi_pid: null,
            companion_identity: null,
            kimi_identity: null,
            status: "running",
            kimi_session_id: null,
            agent_profile: "read-only",
            prompt_digest: "digest-noid",
            summary: "Running job without recorded process identity",
            final_output_path: null,
            stream_log_path: path.join(paths.logsDir, "cli-missing-identity.jsonl"),
            error: null,
          });
        } finally {
          store.close();
        }

        const err = await expectRuntimeErrorCode(
          cancelMcpJob(env, { job_id: "cli-missing-identity", workspace: repo }),
          "CANCEL_NOT_SUPPORTED",
        );
        expect(err.message).toContain("refusing PID-only cancellation");
      } finally {
        await cleanupTestPath(data);
        await cleanupTestPath(repo);
      }
    });
  });

  describe("POSIX private directory and stream-log permissions", () => {
    test("ensurePluginPaths applies 0700 to pluginRoot/logs/artifacts without chmodding parent XDG_DATA_HOME, and logs use 0600", async () => {
      if (process.platform === "win32") return;
      const parent = await createTestPluginDataRoot("council-perms");
      const xdgHome = path.join(parent, "xdg-data");
      await mkdir(xdgHome, { recursive: true, mode: 0o755 });
      await chmod(xdgHome, 0o755);

      try {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          XDG_DATA_HOME: xdgHome,
        };
        delete env.KIMI_PLUGIN_CC_DATA;
        delete env.KIMI_PLUGIN_CC_TEST_NO_DEFAULT_DATA;

        const paths = resolvePluginPaths(env);
        await ensurePluginPaths(paths);

        expect((await stat(xdgHome)).mode & 0o777).toBe(0o755);
        expect((await stat(paths.pluginRoot)).mode & 0o777).toBe(0o700);
        expect((await stat(paths.logsDir)).mode & 0o777).toBe(0o700);
        expect((await stat(paths.artifactsDir)).mode & 0o777).toBe(0o700);

        const logPath = path.join(paths.logsDir, "perm-check.jsonl");
        await writeInvocationLogHeader(logPath, {
          commandType: "ask",
          kimiSessionId: null,
          cwd: repoRoot,
        });
        expect((await stat(logPath)).mode & 0o777).toBe(0o600);
      } finally {
        await cleanupTestPath(parent);
      }
    });
  });

  describe("MCP wait/abort, disconnect durability, wait:false fast launch, and ID-less wait pin", () => {
    test("MCP tool schema enforces wait_timeout_ms bounds and non-idempotent kimi_job", () => {
      const readTool = MCP_TOOL_DEFINITIONS.find((t) => t.name === "kimi_read")!;
      const writeTool = MCP_TOOL_DEFINITIONS.find((t) => t.name === "kimi_write")!;
      const jobTool = MCP_TOOL_DEFINITIONS.find((t) => t.name === "kimi_job")!;

      const readWaitProp = (readTool.inputSchema.properties as Record<string, any>).wait_timeout_ms;
      const writeWaitProp = (writeTool.inputSchema.properties as Record<string, any>).wait_timeout_ms;
      expect(readWaitProp.minimum).toBe(1_000);
      expect(readWaitProp.maximum).toBe(86_400_000);
      expect(writeWaitProp.minimum).toBe(1_000);
      expect(writeWaitProp.maximum).toBe(86_400_000);
      expect(jobTool.annotations.idempotentHint).toBe(false);
    });

    test("notifications/cancelled aborts wait polling without cancelling the durable Kimi job", async () => {
      const fixture = await createMcpFixture("council-mcp-cancel-wait", {
        scenario: "ask-success",
        delayMs: "3000",
      });
      const child = spawn(path.join(fixture.pluginRoot, "scripts/companion.sh"), ["mcp"], {
        cwd: fixture.repo,
        env: { ...fixture.env, KIMI_PLUGIN_CC_MCP_WORKSPACE: fixture.repo },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const responses = new Map<number, any>();
      let stdoutBuf = "";
      let stderrBuf = "";
      child.stdout!.on("data", (chunk) => {
        stdoutBuf += chunk.toString("utf8");
        for (;;) {
          const idx = stdoutBuf.indexOf("\n");
          if (idx < 0) break;
          const line = stdoutBuf.slice(0, idx);
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (typeof msg.id === "number") responses.set(msg.id, msg);
        }
      });
      child.stderr!.on("data", (chunk) => {
        stderrBuf += chunk.toString("utf8");
      });

      const send = (payload: Record<string, unknown>) => {
        child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
      };
      const waitForResponse = async (id: number, timeoutMs = 15_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (responses.has(id)) return responses.get(id);
          await sleep(25);
        }
        throw new Error(`Timed out waiting for response ${id}; stderr=${stderrBuf}`);
      };

      try {
        send({
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "cancel-test", version: "1" },
          },
        });
        await waitForResponse(1);

        // Fire synchronous wait:true kimi_read on id=99.
        send({
          id: 99,
          method: "tools/call",
          params: {
            name: "kimi_read",
            arguments: { mode: "ask", prompt: "Keep running after request cancel", workspace: fixture.repo },
          },
        });

        // Discover the job via multiplexed kimi_job list over the same MCP stream.
        let launchedJobId: string | undefined;
        let probeId = 200;
        const discoverDeadline = Date.now() + 15_000;
        while (Date.now() < discoverDeadline) {
          if (responses.has(99)) {
            throw new Error(`Request 99 settled unexpectedly before cancel: ${JSON.stringify(responses.get(99))}; stderr=${stderrBuf}`);
          }
          const currentProbe = probeId++;
          send({
            id: currentProbe,
            method: "tools/call",
            params: {
              name: "kimi_job",
              arguments: { action: "list", workspace: fixture.repo },
            },
          });
          const listed = await waitForResponse(currentProbe, 10_000);
          const firstJobId = listed.result?.structuredContent?.jobs?.[0]?.job_id;
          if (typeof firstJobId === "string" && firstJobId.length > 0) {
            launchedJobId = firstJobId;
            break;
          }
          await sleep(40);
        }
        expect(launchedJobId).toBeDefined();

        // Cancel the MCP wait request via notifications/cancelled.
        send({ method: "notifications/cancelled", params: { requestId: 99, reason: "client abort" } });

        // Connection remains responsive immediately.
        send({ id: 100, method: "ping", params: {} });
        const pong = await waitForResponse(100, 5_000);
        expect(pong.error).toBeUndefined();

        // Wait on the durable job via kimi_job; it must complete rather than being cancelled.
        send({
          id: 101,
          method: "tools/call",
          params: {
            name: "kimi_job",
            arguments: { action: "wait", job_id: launchedJobId, workspace: fixture.repo, wait_ms: 15_000 },
          },
        });
        const waited = await waitForResponse(101, 15_000);
        expect(waited.result.isError).toBe(false);
        expect(waited.result.structuredContent.status).toBe("completed");
        expect(responses.has(99)).toBe(false);
      } finally {
        child.stdin!.end();
        await new Promise<void>((resolve) => child.once("close", () => resolve()));
        await fixture.cleanup();
      }
    }, 30_000);

    test("client disconnect (stdin EOF) during wait:true does not cancel the durable Kimi job", async () => {
      const fixture = await createMcpFixture("council-mcp-eof-wait", {
        scenario: "ask-success",
        delayMs: "3000",
      });
      const child = spawn(path.join(fixture.pluginRoot, "scripts/companion.sh"), ["mcp"], {
        cwd: fixture.repo,
        env: { ...fixture.env, KIMI_PLUGIN_CC_MCP_WORKSPACE: fixture.repo },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const responses = new Map<number, any>();
      let buf = "";
      let stderrBuf = "";
      child.stdout!.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        for (;;) {
          const idx = buf.indexOf("\n");
          if (idx < 0) break;
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (typeof msg.id === "number") responses.set(msg.id, msg);
        }
      });
      child.stderr!.on("data", (chunk) => {
        stderrBuf += chunk.toString("utf8");
      });

      const send = (payload: Record<string, unknown>) => {
        child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
      };
      const waitForResponse = async (id: number, timeoutMs = 15_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (responses.has(id)) return responses.get(id);
          await sleep(25);
        }
        throw new Error(`Timed out waiting for response ${id}; stderr=${stderrBuf}`);
      };

      let client: McpClient | undefined;
      try {
        send({
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "eof-test", version: "1" } },
        });
        await waitForResponse(1);

        send({
          id: 2,
          method: "tools/call",
          params: {
            name: "kimi_read",
            arguments: { mode: "ask", prompt: "Survive client disconnect", workspace: fixture.repo },
          },
        });

        let launchedJobId: string | undefined;
        let probeId = 200;
        const discoverDeadline = Date.now() + 15_000;
        while (Date.now() < discoverDeadline) {
          if (responses.has(2)) {
            throw new Error(`Request 2 settled unexpectedly before disconnect: ${JSON.stringify(responses.get(2))}; stderr=${stderrBuf}`);
          }
          const currentProbe = probeId++;
          send({
            id: currentProbe,
            method: "tools/call",
            params: {
              name: "kimi_job",
              arguments: { action: "list", workspace: fixture.repo },
            },
          });
          const listed = await waitForResponse(currentProbe, 10_000);
          const firstJobId = listed.result?.structuredContent?.jobs?.[0]?.job_id;
          if (typeof firstJobId === "string" && firstJobId.length > 0) {
            launchedJobId = firstJobId;
            break;
          }
          await sleep(40);
        }
        expect(launchedJobId).toBeDefined();

        // Disconnect client by closing stdin.
        const exitCode = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
        child.stdin!.end();
        expect(await exitCode).toBe(0);

        // Durable job still finishes cleanly on reconnect.
        client = await McpClient.legacy(fixture);
        const waited = await client.request("tools/call", {
          name: "kimi_job",
          arguments: { action: "wait", job_id: launchedJobId, workspace: fixture.repo, wait_ms: 15_000 },
        });
        expect(waited.isError).toBe(false);
        expect(waited.structuredContent.status).toBe("completed");
      } finally {
        if (client) await client.close();
        if (!child.killed) child.kill("SIGTERM");
        await fixture.cleanup();
      }
    }, 30_000);

    test("kimi_read with wait:false always returns the launch handle even for fast jobs", async () => {
      const fixture = await createMcpFixture("council-mcp-wait-false", {
        scenario: "ask-success",
        delayMs: "0",
      });
      let client: McpClient | undefined;
      try {
        client = await McpClient.legacy(fixture);
        const res = await client.request("tools/call", {
          name: "kimi_read",
          arguments: {
            mode: "ask",
            prompt: "Fast wait false launch",
            workspace: fixture.repo,
            wait: false,
          },
        });
        expect(res.isError).toBe(false);
        expect(res.content[0].text).toContain("Started ask job");
        expect(res.structuredContent.job_id).toBeString();
        expect(res.structuredContent.operation_kind).toBe("ask");
      } finally {
        if (client) await client.close();
        await fixture.cleanup();
      }
    }, 30_000);

    test("ID-less awaitMcpJob pins the first resolved job_id even if a newer job appears mid-wait", async () => {
      const data = await createTestPluginDataRoot("council-wait-pin");
      const repo = await createGitRepoFixture("council-wait-pin-repo");
      try {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          KIMI_PLUGIN_CC_DATA: data,
          KIMI_CODE_HOME: path.join(data, "kimi-home"),
        };
        const paths = resolvePluginPaths(env);
        await ensurePluginPaths(paths);
        const repoIdentity = await resolveRepoIdentity(repo);

        const artifactA = path.join(paths.artifactsDir, "ask-job-a.md");
        const artifactB = path.join(paths.artifactsDir, "ask-job-b.md");
        await writeFile(artifactA, "Answer from pinned job A\n", "utf8");
        await writeFile(artifactB, "Answer from newer job B\n", "utf8");

        const store = new JobStore(paths);
        try {
          store.createJob({
            job_id: "pinned-job-a",
            repo_id: repoIdentity.repoId,
            command_type: "ask",
            operation_kind: "ask",
            cwd: repo,
            model: null,
            thinking: null,
            background: true,
            pid: null,
            kimi_pid: null,
            status: "running",
            kimi_session_id: null,
            agent_profile: "read-only",
            prompt_digest: "digest-pin-a",
            summary: "Running job A",
            final_output_path: null,
            stream_log_path: path.join(paths.logsDir, "pinned-job-a.jsonl"),
            error: null,
          });
        } finally {
          store.close();
        }

        let settled = false;
        const waitPromise = awaitMcpJob(env, { workspace: repo, waitTimeoutMs: 5_000 }).then((res) => {
          settled = true;
          return res;
        });

        // Allow poll #1 to resolve and pin pinned-job-a.
        await sleep(120);

        // Insert a newer completed job B while pinned-job-a is still running.
        const store2 = new JobStore(paths);
        try {
          store2.createJob({
            job_id: "newer-job-b",
            repo_id: repoIdentity.repoId,
            command_type: "ask",
            operation_kind: "ask",
            cwd: repo,
            model: null,
            thinking: null,
            background: true,
            pid: null,
            kimi_pid: null,
            status: "completed",
            kimi_session_id: null,
            agent_profile: "read-only",
            prompt_digest: "digest-pin-b",
            summary: "Completed job B",
            final_output_path: artifactB,
            stream_log_path: path.join(paths.logsDir, "newer-job-b.jsonl"),
            error: null,
          });
        } finally {
          store2.close();
        }

        // Wait must NOT jump to newer-job-b.
        await sleep(150);
        expect(settled).toBe(false);

        // Complete pinned-job-a; wait must return pinned-job-a.
        const store3 = new JobStore(paths);
        try {
          store3.markCompleted("pinned-job-a", {
            summary: "Job A done",
            final_output_path: artifactA,
            error: null,
          });
        } finally {
          store3.close();
        }

        const result = await waitPromise;
        expect(result.structuredContent?.job_id).toBe("pinned-job-a");
        expect(result.content[0]?.text).toContain("Answer from pinned job A");
      } finally {
        await cleanupTestPath(data);
        await cleanupTestPath(repo);
      }
    });
  });

  describe("replay partial/isError semantics and historical review_gate rendering", () => {
    test("kimi_job replay returns isError:true and partial:true for a failed job with a truncated stream log", async () => {
      const data = await createTestPluginDataRoot("council-replay-partial");
      const repo = await createGitRepoFixture("council-replay-partial-repo");
      try {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          KIMI_PLUGIN_CC_DATA: data,
          KIMI_CODE_HOME: path.join(data, "kimi-home"),
        };
        const paths = resolvePluginPaths(env);
        await ensurePluginPaths(paths);
        const repoIdentity = await resolveRepoIdentity(repo);

        const logPath = path.join(paths.logsDir, "failed-partial.jsonl");
        const nowIso = new Date().toISOString();
        await writeFile(
          logPath,
          [
            JSON.stringify({ ts: nowIso, event: "spawn", command: "kimi" }),
            JSON.stringify({
              ts: nowIso,
              event: "record",
              record: { role: "assistant", content: "Partial output before failure." },
            }),
          ].join("\n") + "\n",
          "utf8",
        );

        const store = new JobStore(paths);
        try {
          store.createJob({
            job_id: "failed-partial-job",
            repo_id: repoIdentity.repoId,
            command_type: "ask",
            operation_kind: "ask",
            cwd: repo,
            model: null,
            thinking: null,
            background: false,
            pid: null,
            kimi_pid: null,
            status: "failed",
            kimi_session_id: null,
            agent_profile: "read-only",
            prompt_digest: "digest-partial",
            summary: "Timed out with partial output",
            final_output_path: null,
            stream_log_path: logPath,
            error: { code: "JOB_TIMEOUT", message: "timed out", stage: "ask.runtime" },
          });
        } finally {
          store.close();
        }

        const replayed = await handleMcpJobTool(env, {
          action: "replay",
          job_id: "failed-partial-job",
          workspace: repo,
        });
        expect(replayed.isError).toBe(true);
        expect(replayed.structuredContent).toMatchObject({
          job_id: "failed-partial-job",
          action: "replay",
          status: "failed",
          partial: true,
        });
        expect(replayed.content[0]?.text).toContain("Partial output before failure.");
      } finally {
        await cleanupTestPath(data);
        await cleanupTestPath(repo);
      }
    });

    test("renderManagedJobOutput supports historical read-only review_gate rows and rejects blank output", () => {
      const fakeHistoricalJob = {
        job_id: "hist-rg-1",
        repo_id: "repo",
        command_type: "review_gate",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        cwd: repoRoot,
        model: null,
        thinking: null,
        thinking_effort: null,
        hook_escapes: null,
        warnings: null,
        read_scope: null,
        background: false,
        pid: null,
        kimi_pid: null,
        companion_identity: null,
        kimi_identity: null,
        status: "completed",
        kimi_session_id: null,
        kimi_session_id_source: null,
        operation_kind: null,
        intended_engine: null,
        observed_engine: null,
        kimi_version: null,
        system_version: null,
        kimi_command: null,
        kimi_prefix_args: null,
        plan_certification: null,
        resumed_from_job_id: null,
        safety_profile: null,
        agent_profile: "read-only",
        prompt_digest: "digest",
        summary: "",
        phase: null,
        budget_ms: null,
        budget_source: null,
        final_output_path: null,
        stream_log_path: "/tmp/rg.jsonl",
        error: null,
      } as unknown as JobRecord;

      const rendered = renderManagedJobOutput(fakeHistoricalJob, "  Historical review_gate finding.\n");
      expect(rendered.output).toBe("Historical review_gate finding.");
      expect(rendered.rendered).toBe("Historical review_gate finding.\n");
      expect(rendered.summary).toBe("Historical review_gate finding.");

      expect(() => renderManagedJobOutput(fakeHistoricalJob, "   \n  ")).toThrow(RuntimeError);
      try {
        renderManagedJobOutput(fakeHistoricalJob, "   ");
      } catch (error) {
        expect((error as RuntimeError).code).toBe("REVIEW_GATE_EMPTY_OUTPUT");
      }
    });
  });

  describe("version warning accuracy and failed probe reporting", () => {
    test("formatVersionOutOfRangeWarning distinguishes suffixed/strict refusal from plain 2.y.z read-only fallback", () => {
      const suffixed = formatVersionOutOfRangeWarning(
        { kind: "ok", version: "2.8.1-rc.1", major: 2, minor: 8, patch: 1 },
        "3.1.0",
        ["2.8.0"],
        {},
      );
      expect(suffixed).toContain("model-spawning operations will refuse");
      expect(suffixed).not.toContain("Read-only operations");

      const strictPlain = formatVersionOutOfRangeWarning(
        { kind: "ok", version: "2.9.0", major: 2, minor: 9, patch: 0 },
        "3.1.0",
        ["2.8.0"],
        { KIMI_PLUGIN_CC_STRICT_VERSIONS: "1" },
      );
      expect(strictPlain).toContain("model-spawning operations will refuse");
      expect(strictPlain).not.toContain("Read-only operations");

      const nonStrictPlain = formatVersionOutOfRangeWarning(
        { kind: "ok", version: "2.9.0", major: 2, minor: 9, patch: 0 },
        "3.1.0",
        ["2.8.0"],
        {},
      );
      expect(nonStrictPlain).toContain("Read-only operations (ask, review, challenge) run on it with a warning");
    });

    test("setup --check surfaces a warning when probing the selected kimi binary fails", async () => {
      const scratch = await createTestPluginDataRoot("council-failed-probe");
      const dataDir = path.join(scratch, "data");
      const kimiHome = path.join(scratch, "kimi-home");
      await mkdir(kimiHome, { recursive: true });

      try {
        const installEnv = makeSetupEnv(dataDir, kimiHome);
        const installed = await runSetup([], makeContext(repoRoot, installEnv));
        expect(installed.probe).toBe("ok");

        const checkEnv = makeSetupEnv(dataDir, kimiHome, {
          KIMI_PLUGIN_CC_KIMI_BIN: path.join(scratch, "missing-kimi-binary"),
        });
        delete checkEnv.KIMI_PLUGIN_CC_SKIP_VERSION_PROBE;

        const checked = await runSetup(["--check"], makeContext(repoRoot, checkEnv));
        expect(checked.probe).toBe("ok");
        expect(checked.warnings.some((w) => /version|probe|missing-kimi-binary|could not/i.test(w))).toBe(true);
      } finally {
        await cleanupTestPath(scratch);
      }
    });
  });
});
