import { describe, expect, test } from "bun:test";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertNativeV2Preflight,
  inspectExperimentalSelectors,
  inspectPlanModeConfig,
  upstreamSnakeToCamel,
  scanSessionJournalsForPlan,
} from "../../runtime/native-v2-preflight.js";
import { RuntimeError } from "../../runtime/errors.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

async function withHome(prefix: string, run: (home: string) => Promise<void>): Promise<void> {
  const home = await createTestPluginDataRoot(prefix);
  try {
    await run(home);
  } finally {
    await cleanupTestPath(home);
  }
}

async function writeConfig(home: string, contents: string): Promise<void> {
  await writeFile(path.join(home, "config.toml"), contents, "utf8");
}

async function writeJournal(
  home: string,
  workspaceId: string,
  sessionId: string,
  agentId: string,
  lines: readonly string[],
): Promise<string> {
  const agentDir = path.join(home, "sessions", workspaceId, sessionId, "agents", agentId);
  await mkdir(agentDir, { recursive: true });
  const journalPath = path.join(agentDir, "wire.jsonl");
  await writeFile(journalPath, lines.map((l) => `${l}\n`).join(""), "utf8");
  return journalPath;
}

const NO_ENV: Readonly<NodeJS.ProcessEnv> = {};

describe("inspectPlanModeConfig", () => {
  test("absent config → ok:absent", async () => {
    await withHome("plan-absent-config", async (home) => {
      expect(await inspectPlanModeConfig(home)).toEqual({ kind: "ok", setting: "absent" });
    });
  });

  test("no default_plan_mode key → ok:absent", async () => {
    await withHome("plan-no-key", async (home) => {
      await writeConfig(home, 'some_other_key = "value"\n');
      expect(await inspectPlanModeConfig(home)).toEqual({ kind: "ok", setting: "absent" });
    });
  });

  test("default_plan_mode = false → ok:false", async () => {
    await withHome("plan-false", async (home) => {
      await writeConfig(home, "default_plan_mode = false\n");
      expect(await inspectPlanModeConfig(home)).toEqual({ kind: "ok", setting: "false" });
    });
  });

  test("default_plan_mode = true → refuse v2-plan-mode-configured", async () => {
    await withHome("plan-true", async (home) => {
      await writeConfig(home, "default_plan_mode = true\n");
      const result = await inspectPlanModeConfig(home);
      expect(result.kind).toBe("refuse");
      expect((result as { refusalKind: string }).refusalKind).toBe("v2-plan-mode-configured");
    });
  });

  test('default_plan_mode = "false" (string) → refuse', async () => {
    await withHome("plan-string-false", async (home) => {
      await writeConfig(home, 'default_plan_mode = "false"\n');
      const result = await inspectPlanModeConfig(home);
      expect(result.kind).toBe("refuse");
      expect((result as { refusalKind: string }).refusalKind).toBe("v2-plan-mode-configured");
    });
  });

  test("default_plan_mode = 1 (number) → refuse", async () => {
    await withHome("plan-number", async (home) => {
      await writeConfig(home, "default_plan_mode = 1\n");
      const result = await inspectPlanModeConfig(home);
      expect(result.kind).toBe("refuse");
      expect((result as { refusalKind: string }).refusalKind).toBe("v2-plan-mode-configured");
    });
  });

  test("key of same name inside a nested table is ignored → ok:absent", async () => {
    await withHome("plan-nested-key", async (home) => {
      await writeConfig(home, "[foo]\ndefault_plan_mode = true\n");
      expect(await inspectPlanModeConfig(home)).toEqual({ kind: "ok", setting: "absent" });
    });
  });

  test("malformed TOML → refuse v2-config-unreadable", async () => {
    await withHome("plan-malformed", async (home) => {
      await writeConfig(home, "this is not = = valid toml [[[\n");
      const result = await inspectPlanModeConfig(home);
      expect(result.kind).toBe("refuse");
      expect((result as { refusalKind: string }).refusalKind).toBe("v2-config-unreadable");
    });
  });

  test("symlinked config → refuse v2-config-unreadable", async () => {
    await withHome("plan-symlink", async (home) => {
      const real = await createTestPluginDataRoot("plan-symlink-target");
      try {
        await writeFile(path.join(real, "real-config.toml"), "default_plan_mode = false\n", "utf8");
        await symlink(path.join(real, "real-config.toml"), path.join(home, "config.toml"));
        const result = await inspectPlanModeConfig(home);
        expect(result.kind).toBe("refuse");
        expect((result as { refusalKind: string }).refusalKind).toBe("v2-config-unreadable");
      } finally {
        await cleanupTestPath(real);
      }
    });
  });

  test("oversized config → refuse v2-config-unreadable", async () => {
    await withHome("plan-oversized", async (home) => {
      const big = `# ${"x".repeat(1024 * 1024 + 16)}\ndefault_plan_mode = false\n`;
      await writeConfig(home, big);
      const result = await inspectPlanModeConfig(home);
      expect(result.kind).toBe("refuse");
      expect((result as { refusalKind: string }).refusalKind).toBe("v2-config-unreadable");
    });
  });
});

describe("inspectExperimentalSelectors", () => {
  test("no config, no env → ok", async () => {
    await withHome("exp-clean", async (home) => {
      expect(await inspectExperimentalSelectors(home, NO_ENV)).toEqual({ kind: "ok" });
    });
  });

  test("[experimental].tower = true → refuse", async () => {
    await withHome("exp-tower", async (home) => {
      await writeConfig(home, "[experimental]\ntower = true\n");
      const result = await inspectExperimentalSelectors(home, NO_ENV);
      expect(result.kind).toBe("refuse");
      expect((result as { selectors: readonly string[] }).selectors).toEqual([
        "config:[experimental].tower",
      ]);
    });
  });

  test('[experimental].subagent_fork = "yes" → refuse', async () => {
    await withHome("exp-fork-yes", async (home) => {
      await writeConfig(home, '[experimental]\nsubagent_fork = "yes"\n');
      const result = await inspectExperimentalSelectors(home, NO_ENV);
      expect(result.kind).toBe("refuse");
      expect((result as { selectors: readonly string[] }).selectors).toEqual([
        "config:[experimental].subagent_fork",
      ]);
    });
  });

  test("env KIMI_CODE_EXPERIMENTAL_TOWER=On → refuse", async () => {
    await withHome("exp-env-tower", async (home) => {
      const result = await inspectExperimentalSelectors(home, { KIMI_CODE_EXPERIMENTAL_TOWER: "On" });
      expect(result.kind).toBe("refuse");
      expect((result as { selectors: readonly string[] }).selectors).toEqual([
        "env:KIMI_CODE_EXPERIMENTAL_TOWER",
      ]);
    });
  });

  test("both config and env set → selectors lists both", async () => {
    await withHome("exp-both", async (home) => {
      await writeConfig(home, "[experimental]\ntower = true\n");
      const result = await inspectExperimentalSelectors(home, {
        KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK: "1",
      });
      expect(result.kind).toBe("refuse");
      expect((result as { selectors: readonly string[] }).selectors).toEqual([
        "config:[experimental].tower",
        "env:KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK",
      ]);
    });
  });

  test("unreadable config → refuse with empty selectors", async () => {
    await withHome("exp-unreadable", async (home) => {
      await writeConfig(home, "not [ valid = toml\n");
      const result = await inspectExperimentalSelectors(home, NO_ENV);
      expect(result.kind).toBe("refuse");
      expect((result as { selectors: readonly string[] }).selectors).toEqual([]);
    });
  });
});

describe("scanSessionJournalsForPlan", () => {
  test("no session directory → unavailable", async () => {
    await withHome("journal-no-session", async (home) => {
      const result = await scanSessionJournalsForPlan(home, "session-1");
      expect(result.kind).toBe("unavailable");
    });
  });

  test("clean journal (assistant/tool records only) → clean", async () => {
    await withHome("journal-clean", async (home) => {
      await writeJournal(home, "ws1", "session-1", "main", [
        JSON.stringify({ type: "assistant.message", text: "hi" }),
        JSON.stringify({ type: "tool.call", name: "Read" }),
      ]);
      const result = await scanSessionJournalsForPlan(home, "session-1");
      expect(result.kind).toBe("clean");
    });
  });

  test("plan_mode.enter record → tainted", async () => {
    await withHome("journal-plan-mode-enter", async (home) => {
      await writeJournal(home, "ws1", "session-1", "main", [
        JSON.stringify({ type: "assistant.message", text: "hi" }),
        JSON.stringify({ type: "plan_mode.enter" }),
      ]);
      const result = await scanSessionJournalsForPlan(home, "session-1");
      expect(result.kind).toBe("tainted");
      expect((result as { recordType: string }).recordType).toBe("plan_mode.enter");
    });
  });

  test("plan.revision record → tainted", async () => {
    await withHome("journal-plan-revision", async (home) => {
      await writeJournal(home, "ws1", "session-1", "main", [
        JSON.stringify({ type: "plan.revision" }),
      ]);
      const result = await scanSessionJournalsForPlan(home, "session-1");
      expect(result.kind).toBe("tainted");
      expect((result as { recordType: string }).recordType).toBe("plan.revision");
    });
  });

  test("suspicious unparseable line → tainted with <unparseable>", async () => {
    await withHome("journal-unparseable", async (home) => {
      await writeJournal(home, "ws1", "session-1", "main", [
        '{"type":"plan_mode.enter", this is not valid json',
      ]);
      const result = await scanSessionJournalsForPlan(home, "session-1");
      expect(result.kind).toBe("tainted");
      expect((result as { recordType: string }).recordType).toBe("<unparseable>");
    });
  });

  test("substring match in a non-type field that parses cleanly is not tainted", async () => {
    await withHome("journal-coincidental-substring", async (home) => {
      await writeJournal(home, "ws1", "session-1", "main", [
        JSON.stringify({ type: "assistant.message", text: "see \"plan.md\" for details" }),
      ]);
      const result = await scanSessionJournalsForPlan(home, "session-1");
      expect(result.kind).toBe("clean");
    });
  });

  test("two agents, only the second tainted → tainted", async () => {
    await withHome("journal-two-agents", async (home) => {
      await writeJournal(home, "ws1", "session-1", "main", [
        JSON.stringify({ type: "assistant.message", text: "hi" }),
      ]);
      await writeJournal(home, "ws1", "session-1", "sub-1", [
        JSON.stringify({ type: "plan_mode.exit" }),
      ]);
      const result = await scanSessionJournalsForPlan(home, "session-1");
      expect(result.kind).toBe("tainted");
      expect((result as { recordType: string }).recordType).toBe("plan_mode.exit");
    });
  });

  test("legacy steer normalization cannot hide plan records in a child journal", async () => {
    await withHome("journal-legacy-steer-plan", async (home) => {
      await writeJournal(home, "ws1", "session-1", "main", [
        JSON.stringify({ type: "turn.prompt", turnId: 0, input: [], origin: { kind: "user" } }),
      ]);
      await writeJournal(home, "ws1", "session-1", "child-1", [
        JSON.stringify({ type: "turn.steer", turnId: 0, input: [], origin: { kind: "user" } }),
        JSON.stringify({ type: "plan_mode.enter" }),
        JSON.stringify({ type: "turn.steer", turnId: 1, input: [], origin: { kind: "user" } }),
        JSON.stringify({ type: "plan.revision" }),
      ]);
      const result = await scanSessionJournalsForPlan(home, "session-1");
      expect(result.kind).toBe("tainted");
      expect((result as { recordType: string }).recordType).toBe("plan_mode.enter");
    });
  });

  test("no matching session id → unavailable", async () => {
    await withHome("journal-no-match", async (home) => {
      await writeJournal(home, "ws1", "session-1", "main", [
        JSON.stringify({ type: "assistant.message" }),
      ]);
      const result = await scanSessionJournalsForPlan(home, "session-does-not-exist");
      expect(result.kind).toBe("unavailable");
    });
  });

  test("symlinked journal → unavailable", async () => {
    await withHome("journal-symlink", async (home) => {
      const real = await createTestPluginDataRoot("journal-symlink-target");
      try {
        const realJournal = path.join(real, "wire.jsonl");
        await writeFile(realJournal, `${JSON.stringify({ type: "assistant.message" })}\n`, "utf8");
        const agentDir = path.join(home, "sessions", "ws1", "session-1", "agents", "main");
        await mkdir(agentDir, { recursive: true });
        await symlink(realJournal, path.join(agentDir, "wire.jsonl"));
        const result = await scanSessionJournalsForPlan(home, "session-1");
        expect(result.kind).toBe("unavailable");
      } finally {
        await cleanupTestPath(real);
      }
    });
  });

  test("oversized journal → unavailable", async () => {
    await withHome("journal-oversized", async (home) => {
      const agentDir = path.join(home, "sessions", "ws1", "session-1", "agents", "main");
      await mkdir(agentDir, { recursive: true });
      const bigLine = JSON.stringify({ type: "assistant.message", text: "x".repeat(65 * 1024 * 1024) });
      await writeFile(path.join(agentDir, "wire.jsonl"), `${bigLine}\n`, "utf8");
      const result = await scanSessionJournalsForPlan(home, "session-1");
      expect(result.kind).toBe("unavailable");
    });
  });

  // Codex review P1.3: a JSON-escaped record type has no literal "plan_mode."
  // substring but decodes to one on parse.
  test("JSON-escaped plan record type → tainted (parse decodes it)", async () => {
    await withHome("journal-escaped-type", async (home) => {
      await writeJournal(home, "ws1", "session-1", "main", [
        '{"type":"plan_\\u006dode.enter","agentId":"main","id":"p"}',
      ]);
      const result = await scanSessionJournalsForPlan(home, "session-1");
      expect(result.kind).toBe("tainted");
      expect((result as { recordType: string }).recordType).toBe("plan_mode.enter");
    });
  });

  // Codex review P1.2: a symlinked agent dir has isDirectory() === false, so a
  // naive scan would skip it and miss the tainted journal behind it.
  test("symlinked agent directory → unavailable, not silently skipped", async () => {
    await withHome("journal-symlink-agent", async (home) => {
      // A real (clean) sibling agent, plus a tainted directory reached only via
      // a symlink named `main`.
      await writeJournal(home, "ws1", "session-1", "child", [
        '{"type":"assistant.message"}',
      ]);
      const tainted = await createTestPluginDataRoot("tainted-agent");
      await writeFile(path.join(tainted, "wire.jsonl"), '{"type":"plan_mode.enter"}\n', "utf8");
      try {
        await symlink(
          tainted,
          path.join(home, "sessions", "ws1", "session-1", "agents", "main"),
        );
        const result = await scanSessionJournalsForPlan(home, "session-1");
        expect(result.kind).toBe("unavailable");
      } finally {
        await cleanupTestPath(tainted);
      }
    });
  });
});

describe("assertNativeV2Preflight", () => {
  test("passes on a clean home without resumeSessionId", async () => {
    await withHome("assert-clean-no-resume", async (home) => {
      await expect(assertNativeV2Preflight({ kimiHome: home, env: NO_ENV })).resolves.toBeUndefined();
    });
  });

  test("passes on a clean home with a clean resumeSessionId", async () => {
    await withHome("assert-clean-with-resume", async (home) => {
      await writeJournal(home, "ws1", "session-1", "main", [
        JSON.stringify({ type: "assistant.message" }),
      ]);
      await expect(
        assertNativeV2Preflight({ kimiHome: home, env: NO_ENV, resumeSessionId: "session-1" }),
      ).resolves.toBeUndefined();
    });
  });

  test("throws CLI_V2_PLAN_MODE_CONFIGURED when default_plan_mode is truthy", async () => {
    await withHome("assert-plan-mode", async (home) => {
      await writeConfig(home, "default_plan_mode = true\n");
      try {
        await assertNativeV2Preflight({ kimiHome: home, env: NO_ENV });
        throw new Error("expected assertNativeV2Preflight to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(RuntimeError);
        const runtimeError = error as RuntimeError;
        expect(runtimeError.code).toBe("CLI_V2_PLAN_MODE_CONFIGURED");
        expect(runtimeError.details.refusal_kind).toBe("v2-plan-mode-configured");
        expect(runtimeError.details.retryable_after_setup).toBe(false);
        expect(runtimeError.message).not.toContain("/kimi:setup");
      }
    });
  });

  test("throws CLI_V2_CONFIG_UNREADABLE when config cannot be parsed", async () => {
    await withHome("assert-config-unreadable", async (home) => {
      await writeConfig(home, "not [ valid = toml\n");
      try {
        await assertNativeV2Preflight({ kimiHome: home, env: NO_ENV });
        throw new Error("expected assertNativeV2Preflight to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(RuntimeError);
        const runtimeError = error as RuntimeError;
        expect(runtimeError.code).toBe("CLI_V2_CONFIG_UNREADABLE");
        expect(runtimeError.details.refusal_kind).toBe("v2-config-unreadable");
        expect(runtimeError.details.retryable_after_setup).toBe(false);
        expect(runtimeError.message).not.toContain("/kimi:setup");
      }
    });
  });

  test("refuses a configured default remote environment before spawn", async () => {
    await withHome("assert-remote-default", async (home) => {
      await writeConfig(home, '[environments]\ndefault = "build"\n[environments.build]\ntype = "ssh"\nhost = "example.test"\ndefaultCwd = "/work"\n');
      await expect(assertNativeV2Preflight({ kimiHome: home, env: NO_ENV })).rejects.toMatchObject({
        code: "CLI_V2_ENVIRONMENT_UNSAFE",
        details: { refusal_kind: "v2-environment-configured", retryable_after_setup: false },
      });
    });
  });

  test("allows unused remote declarations without a default", async () => {
    await withHome("assert-unused-remote-declaration", async (home) => {
      await writeConfig(home, '[environments.build]\ntype = "ssh"\nhost = "example.test"\ndefaultCwd = "/work"\n');
      await expect(assertNativeV2Preflight({ kimiHome: home, env: NO_ENV })).resolves.toBeUndefined();
    });
  });

  test("refuses a resumed nonlocal journal binding", async () => {
    await withHome("assert-remote-journal", async (home) => {
      await writeJournal(home, "ws1", "session-1", "main", [
        JSON.stringify({ type: "environment.set_binding", environmentId: "build", cwd: "/work" }),
      ]);
      await expect(assertNativeV2Preflight({ kimiHome: home, env: NO_ENV, resumeSessionId: "session-1" }))
        .rejects.toMatchObject({
          code: "KIMI_SESSION_ENVIRONMENT_UNSAFE",
          details: { refusal_kind: "session-environment-unsafe", record_type: "environment.set_binding" },
        });
    });
  });

  test("refuses resumed nonlocal metadata and accepts an explicit local binding", async () => {
    await withHome("assert-remote-metadata", async (home) => {
      const statePath = await writeJournal(home, "ws1", "session-1", "main", [
        JSON.stringify({ type: "environment.set_binding", environmentId: "local", cwd: "/work" }),
      ]).then((journal) => path.join(path.dirname(path.dirname(path.dirname(journal))), "state.json"));
      await writeFile(statePath, JSON.stringify({ environmentId: "build", environmentCwd: "/work" }));
      await expect(assertNativeV2Preflight({ kimiHome: home, env: NO_ENV, resumeSessionId: "session-1" }))
        .rejects.toMatchObject({
          code: "KIMI_SESSION_ENVIRONMENT_UNSAFE",
          details: { refusal_kind: "session-environment-unsafe", record_type: "session.metadata.environmentId" },
        });
      await writeFile(statePath, JSON.stringify({ environmentId: "local", environmentCwd: "/work" }));
      await expect(assertNativeV2Preflight({ kimiHome: home, env: NO_ENV, resumeSessionId: "session-1" }))
        .resolves.toBeUndefined();
    });
  });

  test.each(["require_trust = false", "requireTrust = false", 'require_trust = "true"'])(
    "refuses disabled or malformed workspace trust: %s",
    async (setting) => {
      await withHome("assert-workspace-trust", async (home) => {
        await writeConfig(home, `[workspace]\n${setting}\n`);
        await expect(assertNativeV2Preflight({ kimiHome: home, env: NO_ENV })).rejects.toMatchObject({
          code: "CLI_V2_WORKSPACE_TRUST_UNSAFE",
          details: { refusal_kind: "v2-workspace-trust-disabled", retryable_after_setup: false },
        });
      });
    },
  );

  test("accepts literal workspace trust enforcement", async () => {
    await withHome("assert-workspace-trust-enabled", async (home) => {
      await writeConfig(home, "[workspace]\nrequire_trust = true\n");
      await expect(assertNativeV2Preflight({ kimiHome: home, env: NO_ENV })).resolves.toBeUndefined();
    });
  });

  test("refuses local binding cwd that diverges from the expected execution root", async () => {
    await withHome("assert-local-cwd-mismatch", async (home) => {
      const journalPath = await writeJournal(home, "ws1", "session-1", "main", [
        JSON.stringify({ type: "environment.set_binding", environmentId: "local", cwd: "/work" }),
      ]);
      const statePath = path.join(path.dirname(path.dirname(path.dirname(journalPath))), "state.json");
      await writeFile(statePath, JSON.stringify({ environmentCwd: "/work" }));
      const options = { kimiHome: home, env: NO_ENV, resumeSessionId: "session-1", expectedExecutionRoot: "/other" };
      await expect(assertNativeV2Preflight(options)).rejects.toMatchObject({
        code: "KIMI_SESSION_ENVIRONMENT_UNSAFE",
        details: { record_type: "session.metadata.environmentCwd" },
      });
      await writeFile(statePath, JSON.stringify({ environmentCwd: "/other" }));
      await expect(assertNativeV2Preflight(options)).rejects.toMatchObject({
        code: "KIMI_SESSION_ENVIRONMENT_UNSAFE",
        details: { record_type: "environment.set_binding.cwd" },
      });
      await writeJournal(home, "ws1", "session-1", "main", [
        JSON.stringify({ type: "environment.set_binding", environmentId: "local", cwd: "/other" }),
      ]);
      await expect(assertNativeV2Preflight(options)).resolves.toBeUndefined();
    });
  });

  test("throws CLI_V2_EXPERIMENTAL_UNSAFE when an experimental selector is truthy", async () => {
    await withHome("assert-experimental", async (home) => {
      await writeConfig(home, "[experimental]\ntower = true\n");
      try {
        await assertNativeV2Preflight({ kimiHome: home, env: NO_ENV });
        throw new Error("expected assertNativeV2Preflight to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(RuntimeError);
        const runtimeError = error as RuntimeError;
        expect(runtimeError.code).toBe("CLI_V2_EXPERIMENTAL_UNSAFE");
        expect(runtimeError.details.refusal_kind).toBe("v2-experimental-unsafe");
        expect(runtimeError.details.selectors).toEqual(["config:[experimental].tower"]);
        expect(runtimeError.details.retryable_after_setup).toBe(false);
        expect(runtimeError.message).not.toContain("/kimi:setup");
      }
    });
  });

  test("throws KIMI_SESSION_PLAN_TAINTED when the resumed session's journal is tainted", async () => {
    await withHome("assert-session-tainted", async (home) => {
      await writeJournal(home, "ws1", "session-1", "main", [
        JSON.stringify({ type: "plan_mode.enter" }),
      ]);
      try {
        await assertNativeV2Preflight({ kimiHome: home, env: NO_ENV, resumeSessionId: "session-1" });
        throw new Error("expected assertNativeV2Preflight to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(RuntimeError);
        const runtimeError = error as RuntimeError;
        expect(runtimeError.code).toBe("KIMI_SESSION_PLAN_TAINTED");
        expect(runtimeError.details.refusal_kind).toBe("session-plan-tainted");
        expect(runtimeError.details.record_type).toBe("plan_mode.enter");
        expect(runtimeError.details.retryable_after_setup).toBe(false);
        expect(runtimeError.message).not.toContain("/kimi:setup");
        expect(runtimeError.message).not.toContain("hook drift");
      }
    });
  });

  test("throws KIMI_SESSION_JOURNAL_UNAVAILABLE when the resumed session has no journal", async () => {
    await withHome("assert-session-unavailable", async (home) => {
      try {
        await assertNativeV2Preflight({ kimiHome: home, env: NO_ENV, resumeSessionId: "missing" });
        throw new Error("expected assertNativeV2Preflight to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(RuntimeError);
        const runtimeError = error as RuntimeError;
        expect(runtimeError.code).toBe("KIMI_SESSION_JOURNAL_UNAVAILABLE");
        expect(runtimeError.details.refusal_kind).toBe("session-journal-unavailable");
        expect(runtimeError.details.retryable_after_setup).toBe(false);
        expect(runtimeError.message).not.toContain("/kimi:setup");
        expect(runtimeError.message).not.toContain("hook drift");
      }
    });
  });
});

// Codex second-round F1: upstream's config loader camelCases every top-level
// TOML key (app/config/toml.ts::snakeToCamel) before the plan section reads
// `defaultPlanMode`, so a literal `default_plan_mode` check is bypassable by
// any spelling that normalizes to the same domain.
describe("inspectPlanModeConfig — upstream key normalization", () => {
  test.each([
    "defaultPlanMode = true",
    "default_planMode = true",
    "defaultPlan_mode = true",
    'defaultPlanMode = "false"',
    "default_plan_mode = false\ndefaultPlanMode = true",
  ])("%s → refuse v2-plan-mode-configured", async (contents) => {
    await withHome("preflight-camel", async (home) => {
      await writeConfig(home, `${contents}\n`);
      const result = await inspectPlanModeConfig(home);
      expect(result).toMatchObject({ kind: "refuse", refusalKind: "v2-plan-mode-configured" });
      expect((result as { reason: string }).reason).toContain("default_plan_mode");
    });
  });

  test("defaultPlanMode = false → ok:false", async () => {
    await withHome("preflight-camel-false", async (home) => {
      await writeConfig(home, "defaultPlanMode = false\n");
      expect(await inspectPlanModeConfig(home)).toEqual({ kind: "ok", setting: "false" });
    });
  });

  test("DEFAULT_PLAN_MODE = true is not normalized upstream (uppercase after _) → ok:absent", async () => {
    await withHome("preflight-camel-upper", async (home) => {
      await writeConfig(home, "DEFAULT_PLAN_MODE = true\n");
      expect(await inspectPlanModeConfig(home)).toEqual({ kind: "ok", setting: "absent" });
    });
  });

  test("upstreamSnakeToCamel mirrors upstream's regex exactly", () => {
    expect(upstreamSnakeToCamel("default_plan_mode")).toBe("defaultPlanMode");
    expect(upstreamSnakeToCamel("defaultPlanMode")).toBe("defaultPlanMode");
    expect(upstreamSnakeToCamel("a__b")).toBe("a_B");
    expect(upstreamSnakeToCamel("a_B")).toBe("a_B");
    expect(upstreamSnakeToCamel("_x")).toBe("X");
    expect(upstreamSnakeToCamel("experimental")).toBe("experimental");
  });

  test("[experimental] keeps raw keys upstream: subagentFork is NOT a selector, subagent_fork is", async () => {
    await withHome("preflight-exp-raw", async (home) => {
      await writeConfig(home, "[experimental]\nsubagentFork = true\n");
      expect(await inspectExperimentalSelectors(home, NO_ENV)).toEqual({ kind: "ok" });
      await writeConfig(home, "[experimental]\nsubagent_fork = true\n");
      expect(await inspectExperimentalSelectors(home, NO_ENV)).toMatchObject({ kind: "refuse" });
    });
  });
});

// Kimi second-round finding 3: an enumeration error other than ENOENT/ENOTDIR
// (EACCES on one workspace dir under sessions/) must land in the classified
// `unavailable` refusal, not escape as an untyped fs error.
describe("scanSessionJournalsForPlan — enumeration errors are classified", () => {
  test("an unreadable workspace directory → unavailable (not a thrown fs error)", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores mode bits
    await withHome("preflight-eacces", async (home) => {
      const locked = path.join(home, "sessions", "wd_locked");
      await mkdir(path.join(locked, "session_x", "agents", "main"), { recursive: true });
      await chmod(locked, 0o000);
      try {
        const result = await scanSessionJournalsForPlan(home, "session_x");
        expect(result.kind).toBe("unavailable");
        expect((result as { reason: string }).reason).toContain("EACCES");
      } finally {
        await chmod(locked, 0o700);
      }
    });
  });
});
