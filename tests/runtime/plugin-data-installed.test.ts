import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveRepoIdentity } from "../../runtime/git.js";
import { JobStore } from "../../runtime/job-store.js";
import { ensurePluginPaths, resolvePluginPaths } from "../../runtime/paths.js";

const repo = path.resolve(import.meta.dir, "../..");
const node = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim();
let scratch: string;
let installDir: string;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "kimi-data-installed-"));
  installDir = path.join(scratch, "installed-package");
  await mkdir(installDir, { recursive: true });
  for (const dir of ["dist", "scripts"]) {
    expect(spawnSync("cp", ["-R", path.join(repo, dir), path.join(installDir, dir)]).status).toBe(0);
  }
}, 30_000);

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe("installed canonical data root", () => {
  test.skipIf(process.platform === "win32")(
    "installed companion shares canonical XDG_DATA_HOME across hosts and ignores legacy CLAUDE_PLUGIN_DATA / PLUGIN_DATA",
    async () => {
      const xdgData = path.join(scratch, "xdg-data");
      const foreignClaude = path.join(scratch, "foreign-claude-data");
      const foreignCodex = path.join(scratch, "foreign-codex-data");
      const customData = path.join(scratch, "custom-override-data");

      const paths = resolvePluginPaths({ XDG_DATA_HOME: xdgData });
      await ensurePluginPaths(paths);
      const store = new JobStore(paths);
      try {
        store.createJob({
          job_id: "existing-job",
          repo_id: (await resolveRepoIdentity(repo)).repoId,
          command_type: "ask",
          cwd: repo,
          model: null,
          thinking: null,
          background: false,
          pid: null,
          kimi_pid: null,
          status: "completed",
          kimi_session_id: null,
          agent_profile: "read-only",
          prompt_digest: "old",
          summary: "Existing history",
          phase: "done",
          final_output_path: null,
          stream_log_path: "unused",
          error: null,
        });
      } finally {
        store.close();
      }

      const env: NodeJS.ProcessEnv = {
        PATH: "/usr/bin:/bin",
        KIMI_PLUGIN_CC_NODE_BIN: node,
        XDG_DATA_HOME: xdgData,
        CLAUDE_PLUGIN_ROOT: installDir,
        PLUGIN_ROOT: installDir,
        CLAUDE_PLUGIN_DATA: foreignClaude,
        PLUGIN_DATA: foreignCodex,
        KIMI_CODE_HOME: path.join(scratch, "unused-kimi-home"),
      };
      const run = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
        spawnSync(path.join(installDir, "scripts/companion.sh"), args, {
          cwd: repo,
          env: { ...env, ...extra },
          encoding: "utf8",
        });

      const shared = run(["status", "existing-job"]);
      expect(shared.status).toBe(0);
      expect(JSON.parse(shared.stdout)).toMatchObject({
        job_id: "existing-job",
        summary: "Existing history",
      });
      expect(existsSync(foreignClaude)).toBe(false);
      expect(existsSync(foreignCodex)).toBe(false);
      expect(existsSync(env.KIMI_CODE_HOME!)).toBe(false);

      // Explicit KIMI_PLUGIN_CC_DATA override selects an isolated store without migrating XDG data.
      const overridden = run(["status", "existing-job"], { KIMI_PLUGIN_CC_DATA: customData });
      expect(overridden.status).not.toBe(0);
      expect(overridden.stderr).toContain("JOB_NOT_FOUND");
      expect(existsSync(path.join(customData, "kimi-plugin-cc"))).toBe(true);
      expect(existsSync(foreignClaude)).toBe(false);
      expect(existsSync(foreignCodex)).toBe(false);
    },
    30_000,
  );

  test.skipIf(process.platform === "win32")(
    "first launch via symlinked HOME resolves ~/.local/share/kimi-plugin-cc and publishes the bundled hook",
    async () => {
      const home = path.join(scratch, "first-home");
      const alias = path.join(scratch, "first-home-alias");
      const kimiHome = path.join(scratch, "first-kimi-home");
      await mkdir(home, { recursive: true });
      await symlink(home, alias);

      const expectedHook = path.join(home, ".local/share/kimi-plugin-cc/hook/approval-hook.js");
      expect(existsSync(expectedHook)).toBe(false);

      const result = spawnSync(path.join(installDir, "scripts/companion.sh"), ["setup"], {
        cwd: repo,
        encoding: "utf8",
        env: {
          PATH: "/usr/bin:/bin",
          HOME: alias,
          KIMI_PLUGIN_CC_NODE_BIN: node,
          KIMI_CODE_HOME: kimiHome,
          KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: "1",
        },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Probe:          ok");
      expect(existsSync(expectedHook)).toBe(true);
      expect(existsSync(path.join(alias, ".local/share/kimi-plugin-cc/hook/package.json"))).toBe(true);
    },
    30_000,
  );

  test("KIMI_PLUGIN_CC_TEST_NO_DEFAULT_DATA=1 and invalid KIMI_PLUGIN_CC_DATA fail closed without writing", () => {
    const unusedXdg = path.join(scratch, "fail-closed-xdg");
    const unusedLegacy = path.join(scratch, "fail-closed-legacy");
    const missing = spawnSync(path.join(installDir, "scripts/companion.sh"), ["status", "missing"], {
      cwd: repo,
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        KIMI_PLUGIN_CC_NODE_BIN: node,
        KIMI_PLUGIN_CC_TEST_NO_DEFAULT_DATA: "1",
        XDG_DATA_HOME: unusedXdg,
        CLAUDE_PLUGIN_DATA: unusedLegacy,
      },
    });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("MISSING_PLUGIN_DATA");
    expect(existsSync(unusedXdg)).toBe(false);
    expect(existsSync(unusedLegacy)).toBe(false);

    const invalid = spawnSync(path.join(installDir, "scripts/companion.sh"), ["status", "missing"], {
      cwd: repo,
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        KIMI_PLUGIN_CC_NODE_BIN: node,
        KIMI_PLUGIN_CC_DATA: "relative/path",
      },
    });
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain("INVALID_PLUGIN_DATA");
  });
});
