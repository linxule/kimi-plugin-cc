import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { carriesDenial, createHookEscapeMonitor } from "../../runtime/hook-escape.js";
import { decideHookOutcomePure } from "../../runtime/hooks/approval-policy.js";
import { BOUNDED_SWARM_POLICY } from "../../runtime/swarm-policy.js";
import type { AssistantRecord } from "../../runtime/stream-json.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

const call = (name = "Write", args = "{}", id = "one"): AssistantRecord => ({ role: "assistant",
  tool_calls: [{ type: "function", id, function: { name, arguments: args } }] });
const ctx = { commandLabel: "ask", cwd: "/workspace" };
const denialFor = (toolName: string, label = "ask") => {
  const denial = decideHookOutcomePure({ tool_name: toolName, tool_input: {} }, { commandLabel: label });
  if (!("decision" in denial) || denial.decision !== "deny") throw new Error("expected pure denial");
  return denial.reason!;
};

// Exact upstream 2.2.0 shapes (toolDedupeService.ts): REMINDER_TEXT_1 and HANDOFF_VETO_TEXT.
const REMINDER_1 = "\n\n<system-reminder>\nThe same tool call has been repeated several times in a row. Before making your next call, write one sentence stating what new information you expect it to produce. Then act on that sentence: if it names something this result does not already give you, choose the action that best provides it; otherwise, continue with the evidence you already have.\n</system-reminder>";
const HANDOFF = "This turn was ended by the repeat breaker after the same tool call was issued 12 times in a row. This step accepts a text response only, so the tool call was not executed. Reply in text: the current blocker, what you tried, and what you need.";

test("byte-exact denial, repeat-breaker decorated denial and handoff veto all count as the hook's denial", () => {
  const reason = denialFor("Write");
  expect(carriesDenial(reason, reason)).toBe(true);
  expect(carriesDenial(reason + REMINDER_1, reason)).toBe(true);
  expect(carriesDenial(reason + REMINDER_1 + REMINDER_1, reason)).toBe(true);
  expect(carriesDenial(HANDOFF, reason)).toBe(true);
  for (const other of [reason + "\n", reason + " extra", "ok: wrote file", REMINDER_1, reason.slice(1), `Tool "Write" not found`]) {
    expect(carriesDenial(other, reason)).toBe(false);
  }
});

test("monitor reports mismatch and unresolved, clears on any denial shape, and never reports twice for one call", () => {
  const reason = denialFor("Write");
  for (const content of [reason, reason + REMINDER_1, HANDOFF]) {
    const monitor = createHookEscapeMonitor(ctx);
    expect(monitor.observe(call())).toBeUndefined();
    expect(monitor.observe({ role: "tool", tool_call_id: "one", content })).toBeUndefined();
    expect(monitor.settle()).toEqual([]);
  }
  const monitor = createHookEscapeMonitor(ctx);
  monitor.observe(call());
  expect(monitor.observe({ role: "tool", tool_call_id: "one", content: "x".repeat(300) }))
    .toMatchObject({ kind: "mismatch", tool_name: "Write", tool_call_id: "one", content_excerpt: "x".repeat(200) });
  expect(monitor.observe({ role: "tool", tool_call_id: "one", content: "again" })).toBeUndefined();
  expect(monitor.settle()).toEqual([]);
  const pending = createHookEscapeMonitor(ctx);
  pending.observe({ role: "assistant", tool_calls: [...call("Read").tool_calls!, ...call("Write", "{}", "two").tool_calls!, ...call("Bash", "{}", "three").tool_calls!] });
  expect(pending.observe({ role: "tool", tool_call_id: "one", content: "read" })).toBeUndefined();
  expect(pending.settle()).toEqual([
    { kind: "unresolved", tool_call_id: "two", tool_name: "Write" },
    { kind: "unresolved", tool_call_id: "three", tool_name: "Bash" },
  ]);
  expect(pending.settle()).toEqual([]);
});

test("monitor ignores evaluator markers, remains inert without label, and covers pure write-label denials", () => {
  for (const commandLabel of [undefined, "", "rescue", "swarm-write"]) {
    const monitor = createHookEscapeMonitor({ ...ctx, commandLabel, trustedWorkspaceRoot: "/workspace" });
    monitor.observe(call());
    expect(monitor.observe({ role: "tool", tool_call_id: "one", content: "ok" })).toBeUndefined();
    expect(monitor.settle()).toEqual([]);
    monitor.observe(call("EnterPlanMode"));
    expect(monitor.settle().map((escape) => escape.kind)).toEqual(commandLabel ? ["unresolved"] : []);
  }
});

test("goal metadata honors pursue context and normalizes malformed arguments exactly like upstream", () => {
  for (const operationKind of ["rescue", "pursue"]) {
    for (const args of ["{}", "broken", "null", "[]", "42"]) {
      const monitor = createHookEscapeMonitor({ ...ctx, commandLabel: "rescue", operationKind, trustedWorkspaceRoot: "/workspace" });
      monitor.observe(call("GetGoal", args));
      expect(monitor.settle().length).toBe(operationKind === "pursue" ? 0 : 1);
    }
    for (const args of ['{"status":"complete"}', '{"status":"blocked"}', '{"status":"active"}', '{"status":"complete","budget":1}']) {
      const monitor = createHookEscapeMonitor({ ...ctx, commandLabel: "rescue", operationKind, trustedWorkspaceRoot: "/workspace" });
      monitor.observe(call("UpdateGoal", args));
      const allowed = operationKind === "pursue" && /complete|blocked/.test(args) && !args.includes("budget");
      expect(monitor.settle().length).toBe(allowed ? 0 : 1);
    }
  }
});

test("bounded swarm monitor detects admission and background-shell escapes", () => {
  const bounded = { ...ctx, commandLabel: "swarm-write", trustedWorkspaceRoot: "/workspace",
    swarmPolicy: BOUNDED_SWARM_POLICY, swarmWaveSize: "2" };
  for (const [name, args] of [
    ["AgentSwarm", { description: "oversized", items: ["one", "two", "three"] }],
    ["AgentSwarm", { description: "fork", items: ["one", "two"], fork: true }],
    ["Bash", { command: "git status", run_in_background: true }],
  ] as const) {
    const denial = decideHookOutcomePure({ tool_name: name, tool_input: args }, bounded);
    if ("evaluator" in denial || denial.decision !== "deny") throw new Error("expected bounded denial");
    for (const content of [denial.reason!, "executed despite the policy"]) {
      const monitor = createHookEscapeMonitor(bounded);
      monitor.observe(call(name, JSON.stringify(args)));
      const finding = monitor.observe({ role: "tool", tool_call_id: "one", content });
      if (content === denial.reason) expect(finding).toBeUndefined();
      else expect(finding).toMatchObject({ kind: "mismatch", tool_name: name });
      expect(monitor.settle()).toEqual([]);
    }
    const monitor = createHookEscapeMonitor(bounded);
    monitor.observe(call(name, JSON.stringify(args)));
    expect(monitor.settle()).toEqual([{ kind: "unresolved", tool_call_id: "one", tool_name: name }]);
  }
});

test("single-worker stock swarm-off refusal remains a non-enforcing mismatch finding", () => {
  const monitor = createHookEscapeMonitor({ ...ctx, commandLabel: "swarm", swarmPolicy: BOUNDED_SWARM_POLICY, swarmWaveSize: "1" });
  monitor.observe(call("AgentSwarm", JSON.stringify({ description: "delegate", items: ["one", "two"] })));
  expect(monitor.observe({ role: "tool", tool_call_id: "one",
    content: "Swarm mode is off, so AgentSwarm did not run and no subagents were started." }))
    .toMatchObject({ kind: "mismatch", tool_name: "AgentSwarm" });
  expect(monitor.settle()).toEqual([]);
});

const exec = promisify(execFile);
for (const command of [["ask"], ["review"], ["task", "challenge"], ["task", "swarm"], ["task", "rescue"], ["task", "pursue"]]) {
  for (const scenario of ["executed", "unresolved", "denied"]) {
    test(`compiled ${command.join(" ")} hook escape ${scenario}: detection evidence, never a failure`, async () => {
      const data = await createTestPluginDataRoot("escape-integration");
      const toolName = command.includes("rescue") || command.includes("pursue") ? "EnterPlanMode" : "Write";
      const env = { ...process.env, KIMI_PLUGIN_CC_MOCK_HOOK_TOOL: toolName, KIMI_PLUGIN_CC_DATA: data, KIMI_CODE_HOME: path.join(data, "home"),
        KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1", KIMI_PLUGIN_CC_KIMI_BIN: "bun",
        KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify([path.resolve("tests/helpers/mock-kimi-cli-v1.ts")]),
        KIMI_PLUGIN_CC_MOCK_VERSION: "2.2.0", KIMI_PLUGIN_CC_MOCK_RECOVERABLE_V2: "1",
        KIMI_PLUGIN_CC_MOCK_SCENARIO: `hook-escape-${scenario}` };
      try {
        const run = await exec("node", [path.resolve("dist/companion.js"), ...command, "inspect"], { env });
        const status = JSON.parse((await exec("node", [path.resolve("dist/companion.js"), "status"], { env })).stdout);
        expect(status.status).toBe("completed");
        expect(status.error).toBeNull();
        if (scenario === "denied") {
          expect(status.hook_escapes).toEqual([]);
          expect(run.stderr).not.toContain("safety hook notice");
        } else {
          expect(status.hook_escapes).toHaveLength(1);
          expect(status.hook_escapes[0]).toMatchObject({ kind: scenario === "executed" ? "mismatch" : "unresolved", tool_name: toolName, tool_call_id: "escape-1" });
          expect(run.stderr).toContain("safety hook notice");
          expect(await readFile(status.stream_log_path, "utf8")).toContain('"event":"hook_escape"');
          if (scenario === "executed") {
            // The run was NOT stopped: the sentinel the mock emits after the mismatching result is delivered.
            expect(await readFile(status.final_output_path, "utf8")).toContain("UNTRUSTED AFTER ESCAPE");
          }
          const json = JSON.parse((await exec("node", [path.resolve("dist/companion.js"), "result", status.job_id, "--json"], { env })).stdout);
          expect(json.hook_escapes).toEqual(status.hook_escapes);
        }
      } finally { await cleanupTestPath(data); }
    }, 15000);
  }
}

test("budget abort with a pending pure denial stays a timeout and carries the unresolved finding in details", async () => {
  const data = await createTestPluginDataRoot("escape-budget");
  const env = { ...process.env, KIMI_PLUGIN_CC_DATA: data, KIMI_CODE_HOME: path.join(data, "home"),
    KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1", KIMI_PLUGIN_CC_KIMI_BIN: "bun",
    KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify([path.resolve("tests/helpers/mock-kimi-cli-v1.ts")]),
    KIMI_PLUGIN_CC_MOCK_SCENARIO: "hook-escape-unresolved", KIMI_PLUGIN_CC_MOCK_HOOK_PENDING_MS: "5000" };
  try {
    await expect(exec("node", [path.resolve("dist/companion.js"), "ask", "--budget", "1s", "inspect"], { env })).rejects.toMatchObject({ code: 1 });
    const status = JSON.parse((await exec("node", [path.resolve("dist/companion.js"), "status"], { env })).stdout);
    expect(status.error.code).toMatch(/TIMEOUT/);
    expect(status.error.details.hook_escapes).toEqual([{ kind: "unresolved", tool_name: "Write", tool_call_id: "escape-1" }]);
    expect(await readFile(status.stream_log_path, "utf8")).toContain('"event":"hook_escape"');
  } finally { await cleanupTestPath(data); }
}, 10000);
