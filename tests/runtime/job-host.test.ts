import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildKimiCliEnvironment } from "../../runtime/cli-client.js";
import { runSetup } from "../../runtime/commands/setup.js";
import { resolveHookScriptPath } from "../../runtime/hooks/install-paths.js";
import {
  hookAbstainsForJob,
  JOB_HOOK_ENV,
  JOB_HOST_ENV,
  jobHostForHookScript,
  ownHookHostIds,
} from "../../runtime/hooks/job-host.js";
import type { KimiExecutionPlan } from "../../runtime/kimi-engine.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

const plan: KimiExecutionPlan = {
  schemaVersion: 1,
  operationKind: "ask",
  intendedEngine: "legacy-v1",
  command: "kimi",
  prefixArgs: [],
  kimiVersion: "0.39.0",
  certification: "certified",
  resumedFromJobId: null,
  safetyProfile: null,
};

function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return buildKimiCliEnvironment({ cwd: process.cwd(), env, executionPlan: plan, commandLabel: "ask" });
}

describe("hookAbstainsForJob", () => {
  const own = ["host-0123456789abcdef"];
  let dir: string;
  let codexHook: string;

  beforeAll(async () => {
    dir = await createTestPluginDataRoot("job-host-abstain");
    codexHook = path.join(dir, ".codex", "plugins", "cache", "kimi-marketplace", "kimi", "3.0.0", "dist", "hooks", "approval-hook.js");
    await mkdir(path.dirname(codexHook), { recursive: true });
    await writeFile(codexHook, "", "utf8");
  });

  afterAll(async () => {
    await cleanupTestPath(dir);
  });

  test("abstains for a well-formed different host whose matching script exists", () => {
    expect(jobHostForHookScript(codexHook)).toBe("codex");
    expect(hookAbstainsForJob("codex", codexHook, own)).toBe(true);
  });

  test("its own host enforces", () => {
    expect(hookAbstainsForJob("codex", codexHook, ["claude-code", "codex"])).toBe(false);
  });

  test.each([undefined, "", "Codex", "dsh", "host-0123", " codex", "codex\n", "host-0123456789ABCDEF"])(
    "absent, empty or malformed job host %p enforces",
    (value) => {
      expect(hookAbstainsForJob(value, codexHook, own)).toBe(false);
    },
  );

  test("an unknown own identity enforces", () => {
    expect(hookAbstainsForJob("codex", codexHook, [])).toBe(false);
  });

  test("a missing launching script enforces (removed mid-job)", () => {
    const gone = path.join(dir, ".codex", "plugins", "cache", "kimi-marketplace", "kimi", "2.9.0", "dist", "hooks", "approval-hook.js");
    expect(jobHostForHookScript(gone)).toBe("codex");
    expect(hookAbstainsForJob("codex", gone, own)).toBe(false);
  });

  test("an absent, empty or relative job hook enforces", () => {
    expect(hookAbstainsForJob("codex", undefined, own)).toBe(false);
    expect(hookAbstainsForJob("codex", "", own)).toBe(false);
    expect(hookAbstainsForJob("codex", path.relative(process.cwd(), codexHook), own)).toBe(false);
  });

  test("a directory enforces", () => {
    expect(hookAbstainsForJob("codex", path.join(dir, ".codex"), own)).toBe(false);
  });

  test("a job hook that maps to a different host id enforces", () => {
    const elsewhere = path.join(dir, "elsewhere", "approval-hook.js");
    expect(hookAbstainsForJob("claude-code", codexHook, own)).toBe(false);
    expect(hookAbstainsForJob("codex", elsewhere, own, () => true)).toBe(false);
  });

  test("a stat error enforces", () => {
    expect(hookAbstainsForJob("codex", codexHook, own, () => { throw new Error("EACCES"); })).toBe(false);
  });
});

describe("ownHookHostIds", () => {
  test("includes the spelling and the realpath of a symlinked script", async () => {
    const dir = await createTestPluginDataRoot("job-host-ids");
    try {
      const real = path.join(process.cwd(), "runtime/hooks/approval-hook.ts");
      const link = path.join(dir, "approval-hook.ts");
      await symlink(real, link);
      const ids = ownHookHostIds([link]);
      expect(ids).toContain(jobHostForHookScript(link));
      expect(ids).toContain(jobHostForHookScript(real));
    } finally {
      await cleanupTestPath(dir);
    }
  });

  test("ignores missing spellings", () => {
    expect(ownHookHostIds([undefined, ""])).toEqual([]);
  });

  test("normalizes the spelling the way Node resolves argv[1]", () => {
    const messy = "/opt/x//plugins/./kimi/dist/hooks/approval-hook.js";
    expect(jobHostForHookScript(messy)).toBe(jobHostForHookScript(path.resolve(messy)));
  });
});

describe("buildKimiCliEnvironment exports the launching hook's host", () => {
  const hookScript = "/opt/kimi-plugin-cc/dist/hooks/approval-hook.js";

  test("an ambient value is overwritten with this runtime's own hook id", () => {
    const env = childEnv({ KIMI_PLUGIN_CC_HOOK_SCRIPT: hookScript, [JOB_HOST_ENV]: "codex", [JOB_HOOK_ENV]: "/elsewhere/approval-hook.js" });
    expect(env[JOB_HOST_ENV]).toBe(jobHostForHookScript(hookScript));
    expect(env[JOB_HOOK_ENV]).toBe(hookScript);
  });

  test("the exported hook path is resolved so both variables agree", () => {
    const env = childEnv({ KIMI_PLUGIN_CC_HOOK_SCRIPT: "/opt//kimi-plugin-cc/./dist/hooks/approval-hook.js" });
    expect(env[JOB_HOOK_ENV]).toBe(hookScript);
    expect(jobHostForHookScript(env[JOB_HOOK_ENV]!)).toBe(env[JOB_HOST_ENV]!);
  });

  test("the default resolution matches the verifier's hook path", () => {
    const env = childEnv({ [JOB_HOST_ENV]: "codex" });
    expect(env[JOB_HOST_ENV]).toBe(jobHostForHookScript(resolveHookScriptPath({})));
    expect(env[JOB_HOOK_ENV]).toBe(path.resolve(resolveHookScriptPath({})));
  });

  test("a host-id override (DSH pins dsh) never changes the exported id", () => {
    const env = childEnv({ KIMI_PLUGIN_CC_HOOK_SCRIPT: hookScript, KIMI_PLUGIN_CC_HOST_ID: "dsh" });
    expect(env[JOB_HOST_ENV]).toBe(jobHostForHookScript(hookScript));
    expect(env[JOB_HOST_ENV]).not.toBe("dsh");
  });

  test("the skip-check bypass deletes an ambient value so every hook enforces", () => {
    const env = childEnv({
      KIMI_PLUGIN_CC_HOOK_SCRIPT: hookScript,
      KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
      [JOB_HOST_ENV]: "codex",
      [JOB_HOOK_ENV]: hookScript,
    });
    expect(JOB_HOST_ENV in env).toBe(false);
    expect(JOB_HOOK_ENV in env).toBe(false);
  });

  test("an unresolvable hook path deletes an ambient value", () => {
    const env = childEnv({ KIMI_PLUGIN_CC_HOOK_SCRIPT: "relative/approval-hook.js", [JOB_HOST_ENV]: "codex", [JOB_HOOK_ENV]: hookScript });
    expect(JOB_HOST_ENV in env).toBe(false);
    expect(JOB_HOOK_ENV in env).toBe(false);
  });
});

describe("setup probe", () => {
  test("an ambient job host cannot make the probe's hook abstain", async () => {
    const dir = await createTestPluginDataRoot("job-host-probe");
    try {
      const script = path.join(dir, "kimi-plugin-cc", "dist", "hooks", "approval-hook.js");
      await mkdir(path.dirname(script), { recursive: true });
      // Abstains when any job host reaches it, otherwise denies like the real hook.
      await writeFile(script, `if (process.env.${JOB_HOST_ENV} !== undefined) process.exit(0);\nprocess.stderr.write("deny\\n"); process.exit(2);\n`);
      await mkdir(path.join(dir, "home"));
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        KIMI_CODE_HOME: path.join(dir, "home"),
        CLAUDE_PLUGIN_DATA: path.join(dir, "data"),
        KIMI_PLUGIN_CC_HOOK_SCRIPT: script,
        KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: "1",
        [JOB_HOST_ENV]: "codex",
      };
      const result = await runSetup([], { cwd: dir, env, stdout: process.stdout, stderr: process.stderr });
      expect(result.probe).toBe("ok");
    } finally {
      await cleanupTestPath(dir);
    }
  });
});
