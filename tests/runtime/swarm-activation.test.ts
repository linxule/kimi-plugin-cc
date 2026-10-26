import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { formatError, RuntimeError } from "../../runtime/errors.js";
import type { KimiExecutionPlan, KimiOperationKind } from "../../runtime/kimi-engine.js";
import { readProcessIdentity } from "../../runtime/process-tree.js";
import {
  deactivateSwarmSession,
  preactivateSwarmSession,
  requiresSwarmPreactivation,
  type SwarmActivationOptions,
  type SwarmSessionIdentity,
} from "../../runtime/swarm-activation.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

const mockWebPath = path.join(process.cwd(), "tests/helpers/mock-kimi-web.mjs");
const nodeCommand = Bun.which("node") ?? "node";
const tokenCanary = "ready-token-canary-7f3c";
const configCanary = "config-private-canary-91bd";

interface Fixture {
  readonly root: string;
  readonly cwd: string;
  readonly home: string;
  readonly logPath: string;
  readonly env: NodeJS.ProcessEnv;
}

interface LogEntry {
  readonly pid: number;
  readonly kind: "spawn" | "request" | "print" | "descendant" | "descendant-signal" | "parent-signal";
  readonly argv?: string[];
  readonly env?: Record<string, unknown>;
  readonly method?: string;
  readonly path?: string;
  readonly body?: any;
}

async function createFixture(scenario = "success"): Promise<Fixture> {
  const root = await createTestPluginDataRoot("swarm-activation");
  const cwd = path.join(root, "workspace");
  const home = path.join(root, "kimi-home");
  const logPath = path.join(root, "mock-web.jsonl");
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  return {
    root,
    cwd,
    home,
    logPath,
    env: {
      HOME: root,
      PATH: process.env.PATH,
      KIMI_CODE_HOME: home,
      KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: "1",
      MOCK_KIMI_WEB_SCENARIO: scenario,
      MOCK_KIMI_WEB_LOG: logPath,
      MOCK_KIMI_WEB_TOKEN: tokenCanary,
      MOCK_KIMI_WEB_CONFIG_CANARY: configCanary,
    },
  };
}

async function destroyFixture(fixture: Fixture): Promise<void> {
  for (const entry of await readLog(fixture)) {
    if (entry.kind !== "spawn" && entry.kind !== "descendant") continue;
    try {
      process.kill(-entry.pid, "SIGKILL");
    } catch {
      try {
        process.kill(entry.pid, "SIGKILL");
      } catch {
      }
    }
  }
  await cleanupTestPath(fixture.root);
}

async function withFixture(
  scenario: string,
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const fixture = await createFixture(scenario);
  try {
    await run(fixture);
  } finally {
    await destroyFixture(fixture);
  }
}

function makePlan(
  fixture: Fixture,
  operationKind: KimiOperationKind,
): KimiExecutionPlan {
  return {
    schemaVersion: 1,
    operationKind,
    intendedEngine: "native-v2",
    command: nodeCommand,
    prefixArgs: [mockWebPath],
    kimiVersion: null,
    certification: "test-bypass",
    resumedFromJobId: null,
    safetyProfile: "native-v2-no-plan/1",
  };
}

function makeOptions(
  fixture: Fixture,
  overrides: Partial<SwarmActivationOptions> = {},
): SwarmActivationOptions {
  const commandLabel = overrides.commandLabel ?? "swarm";
  return {
    cwd: fixture.cwd,
    env: fixture.env,
    command: nodeCommand,
    prefixArgs: [mockWebPath],
    executionPlan: makePlan(fixture, commandLabel),
    commandLabel,
    expectedVersion: "2.3.2",
    ...overrides,
  };
}

async function readLog(fixture: Fixture): Promise<LogEntry[]> {
  try {
    const text = await readFile(fixture.logPath, "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function requests(entries: readonly LogEntry[]): LogEntry[] {
  return entries.filter((entry) => entry.kind === "request");
}

function spawns(entries: readonly LogEntry[]): LogEntry[] {
  return entries.filter((entry) => entry.kind === "spawn");
}

function journalPath(fixture: Fixture, identity: SwarmSessionIdentity): string {
  return path.join(
    fixture.home,
    "sessions",
    identity.workspaceId,
    identity.sessionId,
    "agents",
    "main",
    "wire.jsonl",
  );
}

async function readJournal(fixture: Fixture, identity: SwarmSessionIdentity): Promise<any[]> {
  const text = await readFile(journalPath(fixture, identity), "utf8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForSpawn(fixture: Fixture): Promise<void> {
  const deadline = Date.now() + 2_000;
  while ((await readLog(fixture)).length === 0) {
    if (Date.now() >= deadline) throw new Error("mock web did not spawn");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForLog(
  fixture: Fixture,
  predicate: (entry: LogEntry) => boolean,
): Promise<LogEntry> {
  const deadline = Date.now() + 3_000;
  while (true) {
    const entry = (await readLog(fixture)).find(predicate);
    if (entry !== undefined) return entry;
    if (Date.now() >= deadline) throw new Error("timed out waiting for mock lifecycle log");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function expectProcessInactive(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (true) {
    const identity = await readProcessIdentity(pid);
    const active = identity !== undefined && !/^[ZX]/i.test(identity.state);
    if (!active) return;
    if (Date.now() >= deadline) {
      expect(identity, `process ${pid} is still active`).toBeUndefined();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("requiresSwarmPreactivation", () => {
  test("journal failure before profile mutation refuses activation and reaps the web child", async () => {
    await withFixture("success", async (fixture) => {
      await expect(preactivateSwarmSession(makeOptions(fixture, {
        onRecoveryEvent: (event) => { if (event.kind === "session") throw new Error("journal unavailable"); },
      }))).rejects.toBeDefined();
      const log = await readLog(fixture);
      expect(requests(log).some((entry) => entry.path?.endsWith("/profile"))).toBe(false);
      for (const child of spawns(log)) expect(await readProcessIdentity(child.pid)).toBeUndefined();
    });
  });

  test("matches exact upstream 2.3.2 only", () => {
    expect(requiresSwarmPreactivation("2.3.2")).toBe(true);
    for (const version of [null, "2.3.1", "2.3.3", "v2.3.2", "2.3.2-beta.1", "kimi-code 2.3.2"]) {
      expect(requiresSwarmPreactivation(version)).toBe(false);
    }
  });
});

describe("swarm web lifecycle", () => {
  test("activates and deactivates through two real web processes with identical CLI environment", async () => {
    await withFixture("success", async (fixture) => {
      fixture.env.KIMI_CODE_TRUST_WORKSPACE = "1";
      const options = makeOptions(fixture, {
        commandLabel: "swarm-write",
        model: "chosen-model",
        thinkingEffort: "high",
        swarmMaxConcurrency: 3,
        trustedWorkspaceRoot: fixture.cwd,
      });
      const identity = await preactivateSwarmSession(options);
      expect(identity).toEqual({ sessionId: "session_mock", workspaceId: "wd_mock" });
      expect((await readJournal(fixture, identity)).at(-1)).toMatchObject({
        type: "swarm_mode.enter",
        trigger: "manual",
      });

      const activationLog = await readLog(fixture);
      expect(requests(activationLog).map((entry) => `${entry.method} ${entry.path}`)).toEqual([
        "GET /api/v1/meta",
        "POST /api/v1/sessions",
        "POST /api/v1/sessions/session_mock/profile",
        "GET /api/v1/sessions/session_mock/status",
        "POST /api/v1/shutdown",
      ]);
      const profile = requests(activationLog).find((entry) => entry.path?.endsWith("/profile"));
      expect(profile?.body).toEqual({
        agent_config: { swarm_mode: true, permission_mode: "auto", model: "chosen-model" },
      });
      const spawn = spawns(activationLog)[0]!;
      expect(spawn.argv).toEqual([
        "web", "--no-open", "--host", "127.0.0.1", "--port", "0", "--log-level", "error",
      ]);
      expect(spawn.env).toMatchObject({
        KIMI_CODE_HOME: fixture.home,
        KIMI_CODE_NO_AUTO_UPDATE: "1",
        KIMI_CODE_TRUST_WORKSPACE: null,
        KIMI_MODEL_THINKING_EFFORT: "high",
        KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: "3",
        KIMI_PLUGIN_CC_OPERATION: "swarm-write",
        KIMI_PLUGIN_CC_CMD: "swarm-write",
        KIMI_PLUGIN_CC_WORKSPACE_ROOT: fixture.cwd,
      });

      await deactivateSwarmSession({ ...options, ...identity });
      const fullLog = await readLog(fixture);
      expect(spawns(fullLog)).toHaveLength(2);
      expect(spawns(fullLog)[1]?.env).toEqual(spawn.env);
      expect(requests(fullLog).slice(5).map((entry) => `${entry.method} ${entry.path}`)).toEqual([
        "GET /api/v1/meta",
        "POST /api/v1/sessions/session_mock/profile",
        "GET /api/v1/sessions/session_mock/status",
        "POST /api/v1/shutdown",
      ]);
      expect(requests(fullLog).at(-3)?.body).toEqual({
        agent_config: { swarm_mode: false, permission_mode: "auto" },
      });
      expect((await readJournal(fixture, identity)).at(-1)).toMatchObject({ type: "swarm_mode.exit" });
    });
  }, 15_000);

  test("uses the redacted config projection's default_model only when no override is in effect", async () => {
    await withFixture("success", async (fixture) => {
      const options = makeOptions(fixture);
      const identity = await preactivateSwarmSession(options);
      const activationRequests = requests(await readLog(fixture));
      expect(activationRequests.filter((entry) => entry.path === "/api/v1/config")).toHaveLength(1);
      expect(activationRequests.find((entry) => entry.path?.endsWith("/profile"))?.body.agent_config.model)
        .toBe("configured-default");
      await deactivateSwarmSession({ ...options, ...identity });
      expect(requests(await readLog(fixture)).filter((entry) => entry.path === "/api/v1/config"))
        .toHaveLength(1);
    });
  }, 15_000);

  test("explicit model wins over KIMI_MODEL_NAME and skips /config", async () => {
    await withFixture("success", async (fixture) => {
      fixture.env.KIMI_MODEL_NAME = "provider-model-id";
      const options = makeOptions(fixture, { model: "explicit-alias" });
      const identity = await preactivateSwarmSession(options);
      const log = requests(await readLog(fixture));
      expect(log.find((entry) => entry.path?.endsWith("/profile"))?.body.agent_config.model)
        .toBe("explicit-alias");
      expect(log.some((entry) => entry.path === "/api/v1/config")).toBe(false);
      await deactivateSwarmSession({ ...options, ...identity });
    });
  }, 15_000);

  test("KIMI_MODEL_NAME selects the environment alias and skips /config", async () => {
    await withFixture("success", async (fixture) => {
      fixture.env.KIMI_MODEL_NAME = "provider-model-id";
      const options = makeOptions(fixture);
      const identity = await preactivateSwarmSession(options);
      const log = requests(await readLog(fixture));
      expect(log.find((entry) => entry.path?.endsWith("/profile"))?.body.agent_config.model)
        .toBe("__kimi_env_model__");
      expect(log.some((entry) => entry.path === "/api/v1/config")).toBe(false);
      await deactivateSwarmSession({ ...options, ...identity });
    });
  }, 15_000);

  test("rejects a token-less ready URL before any REST call", async () => {
    await withFixture("tokenless-ready", async (fixture) => {
      await expect(preactivateSwarmSession(makeOptions(fixture))).rejects.toMatchObject({
        code: "SWARM_ACTIVATION_FAILED",
        stage: "swarm-activation.ready",
      });
      const log = await readLog(fixture);
      expect(spawns(log)).toHaveLength(1);
      expect(requests(log)).toEqual([]);
    });
  }, 15_000);

  test.each(["meta-version-mismatch", "meta-backend-mismatch", "dangerous-auth"])(
    "refuses unsafe or inexact /meta: %s",
    async (scenario) => {
      await withFixture(scenario, async (fixture) => {
        await expect(preactivateSwarmSession(makeOptions(fixture))).rejects.toMatchObject({
          code: "SWARM_ACTIVATION_FAILED",
          stage: "swarm-activation.meta",
        });
        const log = await readLog(fixture);
        expect(requests(log).map((entry) => entry.path)).toEqual(["/api/v1/meta"]);
        expect(spawns(log)).toHaveLength(1);
      });
    },
    15_000,
  );

  test.each(["status-swarm-mismatch", "status-plan-mismatch", "status-model-mismatch"])(
    "rejects unconfirmed status and preserves identity for caller cleanup: %s",
    async (scenario) => {
      await withFixture(scenario, async (fixture) => {
        const options = makeOptions(fixture, { model: "chosen-model" });
        const identity = { sessionId: "session_mock", workspaceId: "wd_mock" };
        await expect(preactivateSwarmSession(options)).rejects.toMatchObject({
          code: "SWARM_ACTIVATION_FAILED",
          stage: "swarm-activation.status",
          details: { session_id: identity.sessionId, workspace_id: identity.workspaceId },
        });
        expect(spawns(await readLog(fixture))).toHaveLength(1);
        await deactivateSwarmSession({ ...options, ...identity });
        const log = await readLog(fixture);
        expect(spawns(log)).toHaveLength(2);
        expect(requests(log).at(-3)?.body.agent_config.swarm_mode).toBe(false);
        expect((await readJournal(fixture, identity)).at(-1)).toMatchObject({ type: "swarm_mode.exit" });
      });
    },
    15_000,
  );

  test("requires a manual activation journal before returning", async () => {
    await withFixture("missing-activation-journal", async (fixture) => {
      const options = makeOptions(fixture);
      const identity = { sessionId: "session_mock", workspaceId: "wd_mock" };
      await expect(preactivateSwarmSession(options)).rejects.toMatchObject({
        code: "SWARM_ACTIVATION_FAILED",
        stage: "swarm-activation.journal",
        details: {
          journal_state: "missing",
          session_id: identity.sessionId,
          workspace_id: identity.workspaceId,
        },
      });
      expect(spawns(await readLog(fixture))).toHaveLength(1);
      await deactivateSwarmSession({ ...options, ...identity });
      expect(spawns(await readLog(fixture))).toHaveLength(2);
      expect((await readJournal(fixture, identity)).at(-1)).toMatchObject({ type: "swarm_mode.exit" });
    });
  }, 15_000);

  test("classifies REST business failures and preserves the attempted mutation identity", async () => {
    await withFixture("rest-failure", async (fixture) => {
      const options = makeOptions(fixture);
      const identity = { sessionId: "session_mock", workspaceId: "wd_mock" };
      await expect(preactivateSwarmSession(options)).rejects.toMatchObject({
        code: "SWARM_ACTIVATION_FAILED",
        stage: "swarm-activation.rest",
        details: {
          business_code: 50001,
          session_id: identity.sessionId,
          workspace_id: identity.workspaceId,
        },
      });
      expect(spawns(await readLog(fixture))).toHaveLength(1);
      await deactivateSwarmSession({ ...options, ...identity });
      const log = await readLog(fixture);
      expect(spawns(log)).toHaveLength(2);
      expect(requests(log).at(-3)?.body.agent_config.swarm_mode).toBe(false);
    });
  }, 15_000);

  test("never exposes the ready token, REST body, or non-default config fields in errors", async () => {
    await withFixture("rest-failure", async (fixture) => {
      let caught: unknown;
      try {
        await preactivateSwarmSession(makeOptions(fixture, { model: "explicit-model" }));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RuntimeError);
      const error = caught as RuntimeError;
      const rendered = `${formatError(error)}\n${error.stack ?? ""}\n${JSON.stringify(error.details)}`;
      expect(rendered).not.toContain(tokenCanary);
      expect(rendered).not.toContain(configCanary);
      expect(rendered).not.toContain("#token=");
      expect(rendered).not.toContain("forced failure");
      expect(rendered).not.toContain("diagnostic");
    });
  }, 15_000);

  test("does not expose non-default config fields after the config projection was read", async () => {
    await withFixture("status-plan-mismatch", async (fixture) => {
      let caught: unknown;
      try {
        await preactivateSwarmSession(makeOptions(fixture));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RuntimeError);
      expect(requests(await readLog(fixture)).some((entry) => entry.path === "/api/v1/config")).toBe(true);
      const error = caught as RuntimeError;
      const rendered = `${formatError(error)}\n${error.stack ?? ""}\n${JSON.stringify(error.details)}`;
      expect(rendered).not.toContain(configCanary);
      expect(rendered).not.toContain(tokenCanary);
      expect(rendered).not.toContain("private_note");
    });
  }, 15_000);

  test("pre-abort does not spawn and preserves cancellation semantics", async () => {
    await withFixture("success", async (fixture) => {
      const controller = new AbortController();
      controller.abort();
      await expect(preactivateSwarmSession(makeOptions(fixture, { signal: controller.signal })))
        .rejects.toMatchObject({
          code: "SWARM_ACTIVATION_FAILED",
          details: { cancelled: true },
        });
      expect(await readLog(fixture)).toEqual([]);
    });
  });

  test("mid-start abort tears down the owned process promptly", async () => {
    await withFixture("success", async (fixture) => {
      fixture.env.MOCK_KIMI_WEB_READY_DELAY_MS = "10000";
      const controller = new AbortController();
      const started = Date.now();
      const pending = preactivateSwarmSession(makeOptions(fixture, { signal: controller.signal }));
      await waitForSpawn(fixture);
      controller.abort();
      await expect(pending).rejects.toMatchObject({
        code: "SWARM_ACTIVATION_FAILED",
        details: { cancelled: true },
      });
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(requests(await readLog(fixture))).toEqual([]);
      expect(spawns(await readLog(fixture))).toHaveLength(1);
    });
  }, 15_000);

  test("native no-plan preflight refuses before any web spawn", async () => {
    await withFixture("success", async (fixture) => {
      await writeFile(path.join(fixture.home, "config.toml"), "default_plan_mode = true\n", "utf8");
      await expect(preactivateSwarmSession(makeOptions(fixture))).rejects.toMatchObject({
        code: "CLI_V2_PLAN_MODE_CONFIGURED",
      });
      expect(await readLog(fixture)).toEqual([]);
    });
  });

  test("deactivation fails loudly when the exit journal is absent", async () => {
    await withFixture("success", async (fixture) => {
      const options = makeOptions(fixture);
      const identity = await preactivateSwarmSession(options);
      fixture.env.MOCK_KIMI_WEB_SCENARIO = "missing-deactivation-journal";
      await expect(deactivateSwarmSession({ ...options, ...identity })).rejects.toMatchObject({
        code: "SWARM_SESSION_CLEANUP_FAILED",
        stage: "swarm-deactivation.journal",
        details: { journal_state: "enter" },
      });
      expect((await readJournal(fixture, identity)).at(-1)).toMatchObject({ type: "swarm_mode.enter" });
    });
  }, 15_000);

  test("deactivation REST failure cannot be reported as cleanup success", async () => {
    await withFixture("success", async (fixture) => {
      const options = makeOptions(fixture);
      const identity = await preactivateSwarmSession(options);
      fixture.env.MOCK_KIMI_WEB_SCENARIO = "deactivate-rest-failure";
      await expect(deactivateSwarmSession({ ...options, ...identity })).rejects.toMatchObject({
        code: "SWARM_SESSION_CLEANUP_FAILED",
        stage: "swarm-activation.rest",
        details: { business_code: 50001 },
      });
      expect((await readJournal(fixture, identity)).at(-1)).toMatchObject({ type: "swarm_mode.enter" });
    });
  }, 15_000);

  test("reaps a retained descendant identity after an early parent exit", async () => {
    if (process.platform === "win32") return;
    await withFixture("early-parent-exit", async (fixture) => {
      const pending = preactivateSwarmSession(makeOptions(fixture));
      const descendant = await waitForLog(fixture, (entry) => entry.kind === "descendant");
      await expect(pending).rejects.toMatchObject({
        code: "SWARM_ACTIVATION_FAILED",
        stage: "swarm-activation.process",
      });
      await expectProcessInactive(descendant.pid);
    });
  }, 15_000);

  test("reports a late-forked process-group survivor instead of false quiescence", async () => {
    if (process.platform === "win32") return;
    await withFixture("late-fork-after-parent-exit", async (fixture) => {
      const pending = preactivateSwarmSession(makeOptions(fixture));
      const rejection = expect(pending).rejects.toMatchObject({
        code: "SWARM_SESSION_CLEANUP_FAILED",
        details: { process_cleanup_unverified: true },
      });
      const descendant = await waitForLog(fixture, (entry) => entry.kind === "descendant");
      await rejection;
      const identity = await readProcessIdentity(descendant.pid);
      expect(identity).toBeDefined();
      expect(identity!.state).not.toMatch(/^[ZX]/i);
    });
  }, 15_000);

  test("reaps descendants that survive an otherwise clean web shutdown", async () => {
    if (process.platform === "win32") return;
    await withFixture("shutdown-survivor", async (fixture) => {
      const options = makeOptions(fixture);
      const identity = await preactivateSwarmSession(options);
      const first = (await readLog(fixture)).find((entry) => entry.kind === "descendant");
      expect(first).toBeDefined();
      await expectProcessInactive(first!.pid);
      await deactivateSwarmSession({ ...options, ...identity });
      const descendants = (await readLog(fixture)).filter((entry) => entry.kind === "descendant");
      expect(descendants).toHaveLength(2);
      await expectProcessInactive(descendants[1]!.pid);
    });
  }, 15_000);

  test("escalates a SIGTERM-ignoring web child to SIGKILL", async () => {
    if (process.platform === "win32") return;
    await withFixture("ignore-sigterm", async (fixture) => {
      fixture.env.MOCK_KIMI_WEB_READY_DELAY_MS = "10000";
      const controller = new AbortController();
      const pending = preactivateSwarmSession(makeOptions(fixture, { signal: controller.signal }));
      const spawned = await waitForLog(fixture, (entry) => entry.kind === "spawn");
      const started = Date.now();
      controller.abort();
      await expect(pending).rejects.toMatchObject({
        code: "SWARM_ACTIVATION_FAILED",
        details: { cancelled: true },
      });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(1_400);
      expect(elapsed).toBeLessThan(4_000);
      await expectProcessInactive(spawned.pid);
      expect(spawns(await readLog(fixture))).toHaveLength(1);
    });
  }, 15_000);

  test("escalates a SIGTERM-ignoring shutdown descendant and still completes activation", async () => {
    if (process.platform === "win32") return;
    await withFixture("shutdown-survivor-ignore-term", async (fixture) => {
      const started = Date.now();
      const identity = await preactivateSwarmSession(makeOptions(fixture));
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
      const descendant = (await readLog(fixture)).find((entry) => entry.kind === "descendant");
      expect(descendant).toBeDefined();
      await expectProcessInactive(descendant!.pid);
      await deactivateSwarmSession({ ...makeOptions(fixture), ...identity });
    });
  }, 15_000);

  test("post-profile cancellation skips fresh deactivation and reports cleanup uncertainty", async () => {
    await withFixture("success", async (fixture) => {
      fixture.env.MOCK_KIMI_WEB_STATUS_DELAY_MS = "5000";
      const controller = new AbortController();
      const started = Date.now();
      const pending = preactivateSwarmSession(makeOptions(fixture, { signal: controller.signal }));
      await waitForLog(fixture, (entry) =>
        entry.kind === "request" && entry.path?.endsWith("/profile") === true &&
        entry.body?.agent_config?.swarm_mode === true);
      controller.abort();
      await expect(pending).rejects.toMatchObject({
        code: "SWARM_ACTIVATION_FAILED",
        details: {
          cancelled: true,
          cleanup_unverified: true,
          session_id: "session_mock",
          workspace_id: "wd_mock",
        },
      });
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(spawns(await readLog(fixture))).toHaveLength(1);
      expect(requests(await readLog(fixture)).some((entry) =>
        entry.path?.endsWith("/profile") && entry.body?.agent_config?.swarm_mode === false)).toBe(false);
    });
  }, 15_000);

  test("rejects a non-manual activation enter record", async () => {
    await withFixture("nonmanual-activation-journal", async (fixture) => {
      const options = makeOptions(fixture);
      const identity = { sessionId: "session_mock", workspaceId: "wd_mock" };
      await expect(preactivateSwarmSession(options)).rejects.toMatchObject({
        code: "SWARM_ACTIVATION_FAILED",
        stage: "swarm-activation.journal",
        details: {
          journal_state: "other",
          session_id: identity.sessionId,
          workspace_id: identity.workspaceId,
        },
      });
      expect(spawns(await readLog(fixture))).toHaveLength(1);
      await deactivateSwarmSession({ ...options, ...identity });
      expect(spawns(await readLog(fixture))).toHaveLength(2);
      expect((await readJournal(fixture, identity)).at(-1)).toMatchObject({ type: "swarm_mode.exit" });
    });
  }, 15_000);

  test("malformed swarm journals expose activation and cleanup failures separately", async () => {
    await withFixture("malformed-swarm-journal", async (fixture) => {
      const options = makeOptions(fixture);
      const identity = { sessionId: "session_mock", workspaceId: "wd_mock" };
      await expect(preactivateSwarmSession(options)).rejects.toMatchObject({
        code: "SWARM_ACTIVATION_FAILED",
        stage: "swarm-activation.journal",
        details: { session_id: identity.sessionId, workspace_id: identity.workspaceId },
      });
      await expect(deactivateSwarmSession({ ...options, ...identity })).rejects.toMatchObject({
        code: "SWARM_SESSION_CLEANUP_FAILED",
        stage: "swarm-deactivation.journal",
      });
      expect(spawns(await readLog(fixture))).toHaveLength(2);
      const raw = await readFile(journalPath(fixture, identity), "utf8");
      expect(raw).toContain("swarm_mode.exit");
    });
  }, 15_000);

  test("deactivation refuses plan_mode=true even after writing the swarm exit", async () => {
    await withFixture("success", async (fixture) => {
      const options = makeOptions(fixture);
      const identity = await preactivateSwarmSession(options);
      fixture.env.MOCK_KIMI_WEB_SCENARIO = "deactivation-plan-mismatch";
      await expect(deactivateSwarmSession({ ...options, ...identity })).rejects.toMatchObject({
        code: "SWARM_SESSION_CLEANUP_FAILED",
        stage: "swarm-activation.status",
      });
      expect((await readJournal(fixture, identity)).at(-1)).toMatchObject({ type: "swarm_mode.exit" });
    });
  }, 15_000);

  test("expectedVersion cannot diverge from a known execution-plan version", async () => {
    await withFixture("success", async (fixture) => {
      const options = makeOptions(fixture, {
        executionPlan: {
          ...makePlan(fixture, "swarm"),
          kimiVersion: "2.3.1",
          certification: "certified",
        },
        expectedVersion: "2.3.2",
      });
      await expect(preactivateSwarmSession(options)).rejects.toMatchObject({
        code: "SWARM_ACTIVATION_FAILED",
        stage: "swarm-activation.version",
      });
      expect(await readLog(fixture)).toEqual([]);
    });
  });

  test("status and deactivation failures retain separate safe diagnostics", async () => {
    await withFixture("composite-failure", async (fixture) => {
      const options = makeOptions(fixture);
      const identity = { sessionId: "session_mock", workspaceId: "wd_mock" };
      await expect(preactivateSwarmSession(options)).rejects.toMatchObject({
        code: "SWARM_ACTIVATION_FAILED",
        stage: "swarm-activation.status",
        details: { session_id: identity.sessionId, workspace_id: identity.workspaceId },
      });
      await expect(deactivateSwarmSession({ ...options, ...identity })).rejects.toMatchObject({
        code: "SWARM_SESSION_CLEANUP_FAILED",
        stage: "swarm-activation.rest",
        details: { business_code: 50001 },
      });
      expect(spawns(await readLog(fixture))).toHaveLength(2);
      expect((await readJournal(fixture, identity)).at(-1)).toMatchObject({ type: "swarm_mode.enter" });
    });
  }, 15_000);
});
