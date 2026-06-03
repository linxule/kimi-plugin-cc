import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { runCliPrompt, runCliPromptWithBudget, requireSessionId } from "../../runtime/cli-client.js";
import type {
  AssistantRecord,
  StreamJsonRecord,
  ToolResultRecord,
} from "../../runtime/stream-json.js";
import {
  cleanupTestPath,
  createTestPluginDataRoot,
} from "../helpers/test-env.js";

const mockKimiStreamPath = path.join(
  process.cwd(),
  "tests/helpers/mock-kimi-stream.ts",
);

function mockOptions(overrides: {
  cwd: string;
  records: unknown[];
  sessionId?: string;
  emitAnnounce?: boolean;
  /**
   * Which channel the mock uses to announce the session id.
   *   "stderr"      — 0.1.x style stderr line (default, existing tests)
   *   "stdout-meta" — kimi 0.2.0+ stream-json meta record on stdout
   *   "both"        — emit on both channels; exercises first-announce-wins
   */
  announceVia?: "stderr" | "stdout-meta" | "both";
  exitCode?: number;
  interleave?: boolean;
  commandLabel?: string;
    logPath?: string;
    stderrPrefix?: string;
    stderrSuffix?: string;
    prompt?: string;
    signal?: AbortSignal;
    delayMs?: number;
  onRecord?: (r: StreamJsonRecord) => void;
}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KIMI_MOCK_RECORDS: JSON.stringify(overrides.records),
    KIMI_MOCK_SESSION_ID:
      overrides.sessionId ?? "26242650-d95f-4805-80d9-c947d309b2c6",
    KIMI_MOCK_EMIT_ANNOUNCE: overrides.emitAnnounce === false ? "0" : "1",
    KIMI_MOCK_ANNOUNCE_VIA: overrides.announceVia ?? "stderr",
    KIMI_MOCK_EXIT_CODE: String(overrides.exitCode ?? 0),
    KIMI_MOCK_INTERLEAVE_LF: overrides.interleave ? "1" : "0",
    KIMI_MOCK_DELAY_MS: String(overrides.delayMs ?? 0),
    ...(overrides.stderrPrefix !== undefined && {
      KIMI_MOCK_STDERR_PREFIX: overrides.stderrPrefix,
    }),
    ...(overrides.stderrSuffix !== undefined && {
      KIMI_MOCK_STDERR_SUFFIX: overrides.stderrSuffix,
    }),
  };
  return {
    cwd: overrides.cwd,
    env,
    command: "bun",
    prefixArgs: ["run", mockKimiStreamPath],
    prompt: overrides.prompt ?? "test prompt",
    commandLabel: overrides.commandLabel,
    logPath: overrides.logPath,
    signal: overrides.signal,
    onRecord: overrides.onRecord,
  };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isErrnoException(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

function expectPidMissing(pid: number): void {
  try {
    process.kill(pid, 0);
  } catch (err) {
    expect(isErrnoException(err, "ESRCH")).toBe(true);
    return;
  }
  throw new Error(`pid ${pid} is still alive`);
}

async function waitForPidFile(pidFile: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(pidFile, "utf8");
      const match = text.match(/GRANDCHILD_PID=(\d+)/);
      if (match !== null) return Number.parseInt(match[1]!, 10);
    } catch (err) {
      lastError = err;
    }
    await sleepMs(25);
  }
  throw new Error(`grandchild pid file not readable after ${timeoutMs}ms: ${String(lastError)}`);
}

describe("runCliPrompt", () => {
  test("captures assistant + tool records and parses the session id from stderr", async () => {
    const root = await createTestPluginDataRoot("cli-client-basic");
    try {
      const records = [
        {
          role: "assistant",
          content: "Looking at the file",
          tool_calls: [
            {
              type: "function",
              id: "call_1",
              function: {
                name: "Read",
                arguments: '{"file_path":"/x"}',
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "file contents" },
        { role: "assistant", content: "Here's the answer." },
      ];
      const result = await runCliPrompt(
        mockOptions({ cwd: root, records }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.sessionId).toBe("26242650-d95f-4805-80d9-c947d309b2c6");
      expect(result.records).toHaveLength(3);
      expect(result.malformed).toEqual([]);
      const first = result.records[0] as AssistantRecord;
      expect(first.role).toBe("assistant");
      expect(first.tool_calls?.[0]?.function.name).toBe("Read");
      const tool = result.records[1] as ToolResultRecord;
      expect(tool.content).toBe("file contents");
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("captures the session id from a kimi 0.2.0 stdout meta record (no stderr announce)", async () => {
    // kimi 0.2.0 (PR #47) moved the resume hint from stderr to a
    // stream-json meta record on stdout, with token shape `session_<uuid>`.
    // The cli-client must consume the meta record and NOT include it in
    // the consumer-facing records[] surface (the meta record is wrapper
    // plumbing, not assistant prose).
    const root = await createTestPluginDataRoot("cli-client-meta-only");
    try {
      const sessionId = "session_233450b2-f558-499b-b133-bd4d5650d583";
      const result = await runCliPrompt(
        mockOptions({
          cwd: root,
          records: [{ role: "assistant", content: "Two plus two is four." }],
          sessionId,
          announceVia: "stdout-meta",
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.sessionId).toBe(sessionId);
      // Meta record filtered from consumer-facing records[]:
      expect(result.records).toHaveLength(1);
      expect((result.records[0] as AssistantRecord).content).toBe(
        "Two plus two is four.",
      );
      expect(result.malformed).toEqual([]);
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("first-announce-wins when both stdout meta and stderr line are emitted", async () => {
    // Mixed-version environments or paranoid kimi-code releases might
    // emit both. The order in our mock is meta-first; the cli-client
    // should pin to whichever arrives first via the data handler — meta
    // on stdout typically beats the stderr line.
    const root = await createTestPluginDataRoot("cli-client-meta-both");
    try {
      const sessionId = "session_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const result = await runCliPrompt(
        mockOptions({
          cwd: root,
          records: [{ role: "assistant", content: "Hi." }],
          sessionId,
          announceVia: "both",
        }),
      );
      expect(result.sessionId).toBe(sessionId);
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("invokes onRecord for assistant/tool records but NOT for the meta record", async () => {
    // The meta record is wrapper plumbing — callers wiring up record
    // streaming (e.g., for live UI updates) should never see it.
    const root = await createTestPluginDataRoot("cli-client-meta-onrecord");
    try {
      const seen: StreamJsonRecord[] = [];
      await runCliPrompt(
        mockOptions({
          cwd: root,
          records: [
            { role: "assistant", content: "before" },
            { role: "assistant", content: "after" },
          ],
          announceVia: "stdout-meta",
          onRecord: (r) => seen.push(r),
        }),
      );
      expect(seen).toHaveLength(2);
      for (const r of seen) {
        expect(r.role).toBe("assistant");
      }
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("captures a goal.summary out-of-band: sets result.goalSummary, keeps it out of records[] and onRecord, still captures the session id", async () => {
    // Goal mode (kimi-code 0.8.0+) emits a role-less {type:"goal.summary"} line
    // before the resume hint. cli-client must surface it on result.goalSummary,
    // filter it from records[]/onRecord (out-of-band, like the meta record), and
    // still capture the session id from the following resume hint.
    const root = await createTestPluginDataRoot("cli-client-goal-summary");
    try {
      const seen: StreamJsonRecord[] = [];
      const sessionId = "session_99999999-8888-7777-6666-555555555555";
      const result = await runCliPrompt(
        mockOptions({
          cwd: root,
          records: [
            { role: "assistant", content: "working on the goal" },
            {
              type: "goal.summary",
              goalId: "goal_42",
              status: "complete",
              reason: null,
              turnsUsed: 3,
              tokensUsed: 850,
              wallClockMs: 41000,
            },
          ],
          sessionId,
          announceVia: "stdout-meta",
          onRecord: (r) => seen.push(r),
        }),
      );
      expect(result.goalSummary).toEqual({
        type: "goal.summary",
        goalId: "goal_42",
        status: "complete",
        reason: null,
        turnsUsed: 3,
        tokensUsed: 850,
        wallClockMs: 41000,
      });
      // Filtered from the consumer-facing record surfaces.
      expect(result.records).toHaveLength(1);
      expect(result.records[0]!.role).toBe("assistant");
      expect(seen).toHaveLength(1);
      // Session id (from the resume hint emitted after the goal.summary) still captured.
      expect(result.sessionId).toBe(sessionId);
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("survives chunk-boundary splits in stream-json output", async () => {
    const root = await createTestPluginDataRoot("cli-client-chunks");
    try {
      const records = [
        { role: "assistant", content: "chunk one" },
        { role: "assistant", content: "chunk two" },
      ];
      const result = await runCliPrompt(
        mockOptions({ cwd: root, records, interleave: true }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.records).toHaveLength(2);
      expect((result.records[0] as AssistantRecord).content).toBe("chunk one");
      expect((result.records[1] as AssistantRecord).content).toBe("chunk two");
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("returns undefined sessionId when the kimi process exits before announce", async () => {
    const root = await createTestPluginDataRoot("cli-client-no-announce");
    try {
      const result = await runCliPrompt(
        mockOptions({
          cwd: root,
          records: [{ role: "assistant", content: "partial" }],
          emitAnnounce: false,
          exitCode: 1,
        }),
      );
      expect(result.exitCode).toBe(1);
      expect(result.sessionId).toBeUndefined();
      expect(result.records).toHaveLength(1);
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("propagates KIMI_PLUGIN_CC_CMD label to the subprocess env", async () => {
    const root = await createTestPluginDataRoot("cli-client-label");
    try {
      // The mock doesn't read this var, but it shouldn't error from the
      // overlay. We assert behavior indirectly: the run completes cleanly and
      // the spawn block in the diagnostics log captured the label.
      const logPath = path.join(root, "diag.jsonl");
      const result = await runCliPrompt(
        mockOptions({
          cwd: root,
          records: [{ role: "assistant", content: "ok" }],
          commandLabel: "review",
          logPath,
        }),
      );
      expect(result.exitCode).toBe(0);
      const log = await readFile(logPath, "utf8");
      const spawnLine = log
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((entry) => entry["event"] === "spawn");
      expect(spawnLine).toBeDefined();
      expect(spawnLine!["command_label"]).toBe("review");
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("writes one JSONL line per record to logPath", async () => {
    const root = await createTestPluginDataRoot("cli-client-log");
    try {
      const logPath = path.join(root, "logs", "trace.jsonl");
      const records = [
        { role: "assistant", content: "hi" },
        { role: "tool", tool_call_id: "c", content: "out" },
      ];
      const result = await runCliPrompt(
        mockOptions({ cwd: root, records, logPath }),
      );
      expect(result.exitCode).toBe(0);
      const log = await readFile(logPath, "utf8");
      const events = log
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      // Events: spawn, record x2, exit (order intentional)
      const kinds = events.map((e) => e["event"]);
      expect(kinds).toEqual(["spawn", "record", "record", "exit"]);
      const exit = events[events.length - 1]!;
      expect(exit["exit_code"]).toBe(0);
      expect(exit["session_id"]).toBe("26242650-d95f-4805-80d9-c947d309b2c6");
      expect(exit["record_count"]).toBe(2);
      expect(exit["malformed_count"]).toBe(0);
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("captures malformed lines without crashing", async () => {
    const root = await createTestPluginDataRoot("cli-client-malformed");
    try {
      // KIMI_MOCK_RECORDS is JSON-parsed, so we can't inject a malformed
      // line through it directly. Instead, drive a stderr-only run with a
      // valid record plus a malformed line baked into stderrPrefix... no,
      // stderr won't reach the stdout parser. The cleanest way is to use
      // stderrPrefix for noise and pass a record whose shape is invalid
      // (unknown role).
      const records = [
        { role: "system", content: "I shouldn't be valid" },
        { role: "assistant", content: "still here" },
      ];
      const result = await runCliPrompt(
        mockOptions({ cwd: root, records }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.malformed).toHaveLength(1);
      expect(result.malformed[0]!.reason).toContain("unknown role");
      expect(result.records).toHaveLength(1);
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("respects AbortSignal by sending SIGTERM to a live subprocess", async () => {
    const root = await createTestPluginDataRoot("cli-client-abort");
    try {
      // Force the mock to sleep so abort fires while kimi is still alive.
      // Without the delay this test is tautological — the mock finishes
      // before the abort can land.
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);
      const result = await runCliPrompt(
        mockOptions({
          cwd: root,
          records: [{ role: "assistant", content: "fast" }],
          delayMs: 2000,
          signal: controller.signal,
        }),
      );
      expect(result.aborted).toBe(true);
      expect(result.signal).toBe("SIGTERM");
      // The mock got far enough to emit its records before the sleep, so we
      // can still see them in the buffer. The session announce comes AFTER
      // the sleep, so sessionId should be undefined.
      expect(result.sessionId).toBeUndefined();
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("aborts the child if abort fires during the pre-spawn mkdir window (Codex H1 race)", async () => {
    // Audit finding (report 28 Codex H1): `await mkdir` is a yield
    // point between the pre-spawn aborted check and the
    // addEventListener call. If abort fires during the mkdir await,
    // the signal is already in an aborted state by the time
    // addEventListener runs — but addEventListener doesn't re-fire
    // for already-aborted signals. Without the post-attach
    // `if (signal.aborted) onAbort()` recovery, the child is orphaned.
    //
    // We reproduce the race by passing a logPath that forces mkdir
    // and aborting on the next microtask after spawn launches.
    const root = await createTestPluginDataRoot("cli-client-mkdir-abort-race");
    try {
      const controller = new AbortController();
      // Abort on the immediately-next microtask. By the time the cli-client
      // adds its abort listener (after mkdir resolves), the signal will
      // already be in aborted state.
      Promise.resolve().then(() => {
        controller.abort();
      });
      const result = await runCliPrompt(
        mockOptions({
          cwd: root,
          records: [{ role: "assistant", content: "should be killed" }],
          delayMs: 5_000,
          signal: controller.signal,
          logPath: path.join(root, "nested", "deeper", "log.jsonl"),
        }),
      );
      // The recovery path called onAbort() → SIGTERM was sent → result.aborted=true.
      expect(result.aborted).toBe(true);
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("rejects with CLI_ABORTED when the signal is already aborted at entry", async () => {
    const root = await createTestPluginDataRoot("cli-client-pre-aborted");
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        runCliPrompt(
          mockOptions({
            cwd: root,
            records: [{ role: "assistant", content: "should not run" }],
            signal: controller.signal,
          }),
        ),
      ).rejects.toMatchObject({ code: "CLI_ABORTED" });
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("onRecord fires per record before the run completes", async () => {
    const root = await createTestPluginDataRoot("cli-client-onrecord");
    try {
      const observed: StreamJsonRecord[] = [];
      const records = [
        { role: "assistant", content: "one" },
        { role: "tool", tool_call_id: "c1", content: "ok" },
        { role: "assistant", content: "two" },
      ];
      const result = await runCliPrompt(
        mockOptions({
          cwd: root,
          records,
          onRecord: (r) => {
            observed.push(r);
          },
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(observed).toHaveLength(3);
      expect((observed[0] as AssistantRecord).content).toBe("one");
      expect((observed[1] as ToolResultRecord).tool_call_id).toBe("c1");
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("onRecord throws are swallowed and do not destabilize the run", async () => {
    const root = await createTestPluginDataRoot("cli-client-onrecord-throws");
    try {
      const result = await runCliPrompt(
        mockOptions({
          cwd: root,
          records: [
            { role: "assistant", content: "a" },
            { role: "assistant", content: "b" },
          ],
          onRecord: () => {
            throw new Error("callback panic");
          },
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.records).toHaveLength(2);
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("requireSessionId throws CLI_NO_SESSION_ID when the result lacks an id", async () => {
    const root = await createTestPluginDataRoot("cli-client-require-sid");
    try {
      const result = await runCliPrompt(
        mockOptions({
          cwd: root,
          records: [{ role: "assistant", content: "x" }],
          emitAnnounce: false,
        }),
      );
      expect(result.sessionId).toBeUndefined();
      expect(() =>
        requireSessionId(result, { commandLabel: "review" }),
      ).toThrow(
        expect.objectContaining({
          code: "CLI_NO_SESSION_ID",
        }) as Error,
      );
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("requireSessionId returns the id when present", async () => {
    const root = await createTestPluginDataRoot("cli-client-require-sid-ok");
    try {
      const result = await runCliPrompt(
        mockOptions({
          cwd: root,
          records: [{ role: "assistant", content: "x" }],
          sessionId: "abcdef01-2345-6789-abcd-ef0123456789",
        }),
      );
      expect(
        requireSessionId(result, { commandLabel: "review" }),
      ).toBe("abcdef01-2345-6789-abcd-ef0123456789");
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("stderr tail is bounded by the rolling buffer even with large output", async () => {
    const root = await createTestPluginDataRoot("cli-client-stderr-bound");
    try {
      // Emit a stderrPrefix significantly larger than STDERR_TAIL_BYTES (8KB).
      const noise = "x".repeat(20_000);
      const result = await runCliPrompt(
        mockOptions({
          cwd: root,
          records: [{ role: "assistant", content: "ok" }],
          stderrPrefix: noise,
        }),
      );
      // The 8KB cap accounts for the announce line at the end too; just
      // verify we don't retain the full 20KB+.
      expect(result.stderrTail.length).toBeLessThanOrEqual(8192);
      expect(result.sessionId).toBe("26242650-d95f-4805-80d9-c947d309b2c6");
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("session id is captured when announce arrives before stderr overflows", async () => {
    const root = await createTestPluginDataRoot("cli-client-session-before-overflow");
    try {
      const sessionId = "33333333-3333-3333-3333-333333333333";
      const result = await runCliPrompt(
        mockOptions({
          cwd: root,
          records: [{ role: "assistant", content: "ok" }],
          sessionId,
          stderrSuffix: "j".repeat(9000),
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.sessionId).toBe(sessionId);
      expect(result.stderrTail.length).toBeLessThanOrEqual(8192);
      expect(result.stderrTail).not.toContain(sessionId);
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("captures the session id incrementally before stderr tail truncation", async () => {
    const root = await createTestPluginDataRoot("cli-client-session-before-large-tail");
    try {
      const sessionId = "40000000-0000-0000-0000-000000000000";
      const result = await runCliPrompt(
        mockOptions({
          cwd: root,
          records: [{ role: "assistant", content: "ok" }],
          sessionId,
          stderrSuffix: "x".repeat(20_000),
        }),
      );
      expect(result.stderrTail.length).toBeLessThanOrEqual(8192);
      expect(result.stderrTail).not.toContain(sessionId);
      expect(result.sessionId).toBe(sessionId);
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("classifies an unspawnable binary as CLI_SPAWN_FAILED or CLI_PROCESS_ERROR", async () => {
    const root = await createTestPluginDataRoot("cli-client-no-bin");
    try {
      // node's spawn raises ENOENT asynchronously via the 'error' event for
      // bare names not found on PATH, surfacing as CLI_PROCESS_ERROR. An
      // absolute non-existent path also routes through the same listener.
      await expect(
        runCliPrompt({
          cwd: root,
          env: { ...process.env },
          command: "/nonexistent/path/to/kimi-binary-does-not-exist",
          prompt: "x",
        }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/^CLI_(SPAWN_FAILED|PROCESS_ERROR)$/),
      });
    } finally {
      await cleanupTestPath(root);
    }
  });
});

describe("SIGKILL escalation", () => {
  // Helper that spawns a stub which traps SIGTERM (writes a record
  // then ignores SIGTERM forever). cli-client must escalate to
  // SIGKILL when the abort signal fires; without the escalation we'd
  // hang or leak the process.
  const stubKimiPath = path.join(process.cwd(), "tests/helpers/sigterm-trap.ts");

  test("escalates to SIGKILL when the child traps SIGTERM", async () => {
    const root = await createTestPluginDataRoot("cli-sigkill-escalate");
    try {
      const controller = new AbortController();
      const start = Date.now();
      // Fire abort 100ms into the run; child traps SIGTERM, so cli-client
      // must escalate to SIGKILL after the escalationMs window (50ms).
      setTimeout(() => controller.abort(), 100).unref();

      const result = await runCliPrompt({
        cwd: root,
        env: {
          ...process.env,
          KIMI_MOCK_RECORDS: JSON.stringify([{ role: "assistant", content: "x" }]),
          KIMI_MOCK_SESSION_ID: "10000000-0000-0000-0000-000000000000",
        },
        command: "bun",
        prefixArgs: ["run", stubKimiPath],
        prompt: "x",
        signal: controller.signal,
        escalationMs: 50,
      });

      const elapsed = Date.now() - start;
      expect(result.aborted).toBe(true);
      expect(result.signal).toBe("SIGKILL");
      // Must escalate within abort + escalationMs + slack; hard-fail
      // long enough above that to catch a regression where the timer
      // never fires.
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("escalationMs: Infinity opts out of SIGKILL", async () => {
    const root = await createTestPluginDataRoot("cli-sigkill-optout");
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100).unref();

      // Stub eventually exits cleanly on its own (after ~500ms). With
      // escalation disabled, cli-client only sends SIGTERM, which the
      // stub ignores; the stub's own self-exit ends the call.
      const result = await runCliPrompt({
        cwd: root,
        env: {
          ...process.env,
          KIMI_MOCK_RECORDS: JSON.stringify([{ role: "assistant", content: "x" }]),
          KIMI_MOCK_SESSION_ID: "20000000-0000-0000-0000-000000000000",
          SIGTERM_TRAP_SELF_EXIT_MS: "500",
        },
        command: "bun",
        prefixArgs: ["run", stubKimiPath],
        prompt: "x",
        signal: controller.signal,
        escalationMs: Number.POSITIVE_INFINITY,
      });

      expect(result.aborted).toBe(true);
      // SIGKILL must NOT have been delivered — the stub self-exited.
      expect(result.signal).not.toBe("SIGKILL");
    } finally {
      await cleanupTestPath(root);
    }
  });

});

describe("descendant reaping", () => {
  const processGroupGrandchildPath = path.join(
    process.cwd(),
    "tests/helpers/process-group-grandchild.ts",
  );

  test("kills a live grandchild in a separate pgrp on abort", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await createTestPluginDataRoot("cli-process-group-grandchild");
    const grandchildPidFile = path.join(root, "grandchild.pid");
    let grandchildPid: number | undefined;
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100).unref();

      const result = await runCliPrompt({
        cwd: root,
        env: {
          ...process.env,
          KIMI_MOCK_GRANDCHILD_PID_FILE: grandchildPidFile,
        },
        command: "bun",
        prefixArgs: ["run", processGroupGrandchildPath],
        prompt: "x",
        signal: controller.signal,
        descendantCollector: async () => [await waitForPidFile(grandchildPidFile, 1_000)],
      });

      const malformedStdout = result.malformed.map((entry) => entry.line).join("\n");
      const match = malformedStdout.match(/GRANDCHILD_PID=(\d+)/);
      expect(match).not.toBeNull();
      grandchildPid = Number.parseInt(match![1]!, 10);
      expect(result.aborted).toBe(true);
      await sleepMs(2_500);
      expectPidMissing(grandchildPid);
    } finally {
      if (grandchildPid !== undefined) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      await cleanupTestPath(root);
    }
  });
});

describe("runCliPromptWithBudget", () => {
  test("returns the result when kimi finishes inside the budget", async () => {
    const root = await createTestPluginDataRoot("cli-budget-ok");
    try {
      const result = await runCliPromptWithBudget(
        mockOptions({
          cwd: root,
          records: [{ role: "assistant", content: "ok" }],
        }),
        2_000,
        "test.budget-ok",
      );
      expect(result.exitCode).toBe(0);
      expect(result.records).toHaveLength(1);
      expect(result.aborted).toBe(false);
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("aborts the subprocess when the budget expires", async () => {
    const root = await createTestPluginDataRoot("cli-budget-timeout");
    try {
      // Mock holds for 5s; budget is 300ms — we should observe a
      // RESPONSE_TIMEOUT and the subprocess should be SIGTERMed.
      const start = Date.now();
      await expect(
        runCliPromptWithBudget(
          mockOptions({
            cwd: root,
            records: [{ role: "assistant", content: "late" }],
            delayMs: 5_000,
          }),
          300,
          "test.budget-timeout",
        ),
      ).rejects.toMatchObject({
        code: "RESPONSE_TIMEOUT",
        stage: "test.budget-timeout",
      });
      const elapsed = Date.now() - start;
      // We must NOT wait for the full 5s delay — the controller must
      // have killed the subprocess. Allow generous slack for CI but
      // hard-bound at 2.5s so a regression where the timeout doesn't
      // kill the child surfaces obviously.
      expect(elapsed).toBeLessThan(2_500);
    } finally {
      await cleanupTestPath(root);
    }
  });

  test("respects a caller-supplied pre-aborted signal", async () => {
    const root = await createTestPluginDataRoot("cli-budget-preabort");
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        runCliPromptWithBudget(
          mockOptions({
            cwd: root,
            records: [{ role: "assistant", content: "x" }],
            signal: controller.signal,
          }),
          2_000,
          "test.budget-preabort",
        ),
      ).rejects.toMatchObject({ code: "CLI_ABORTED" });
    } finally {
      await cleanupTestPath(root);
    }
  });
});
