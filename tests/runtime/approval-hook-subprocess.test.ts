// End-to-end subprocess tests for the kimi-plugin-cc PreToolUse hook
// entry script. The pure decision function is covered by
// approval-policy.test.ts; this file verifies the load-bearing
// protocol surface — stdin JSON parsing, exit-code semantics,
// stderr-as-deny-reason — by spawning the actual compiled hook script
// the way kimi-code would.
//
// Why subprocess tests matter:
//
//   kimi-code's hook runner (agent-core/src/agent/hooks/runner.ts) is
//   fail-open on most error paths: spawn error → allow, timeout →
//   allow, non-zero non-2 exit → allow. A bug like "we accidentally
//   exit 1 on deny" would silently grant Bash. The function-level
//   tests can't catch that.
//
//   The harness pattern mirrors tests/runtime/review-gate-hook.test.ts.

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

const hookScriptPath = path.join(process.cwd(), "runtime/hooks/approval-hook.ts");

interface InvokeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

async function invokeHook(
  payload: unknown,
  env: NodeJS.ProcessEnv = process.env,
  options?: { skipStdin?: boolean; closeStdinWithoutPayload?: boolean },
): Promise<InvokeResult> {
  return await new Promise<InvokeResult>((resolve, reject) => {
    const child = spawn("node", ["--import", "tsx", hookScriptPath], {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code, stdout, stderr }));

    if (options?.skipStdin) {
      // Do not even open writes; the child should fail closed via the
      // stdin timeout.
      child.stdin.end();
      return;
    }
    if (options?.closeStdinWithoutPayload) {
      child.stdin.end();
      return;
    }
    child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}

describe("approval-hook entry script", () => {
  test("undefined KIMI_PLUGIN_CC_CMD → exit 0 (out-of-plugin context allows everything)", async () => {
    const env = { ...process.env };
    delete env.KIMI_PLUGIN_CC_CMD;
    const result = await invokeHook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf /" } },
      env,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    // stderr might contain unrelated Node deprecation noise (e.g. tsx's
    // DEP0205 banner) — what matters for the kimi-code contract is that
    // we exited 0 without an explicit deny reason. The runner only
    // surfaces stderr on exit 2.
    expect(result.stderr).not.toContain("misconfigured");
    expect(result.stderr).not.toContain("denied");
  });

  test("ask label + Bash → exit 2 + stderr reason (PR 4: ask is read-only)", async () => {
    // PR 2 originally allowed every tool under `ask` on the assumption
    // the user was watching the prompt. PR 4 reviewers flagged that
    // /kimi:ask runs as a non-interactive subprocess and `ask` is
    // documented read-only in AGENTS.md. Ask now shares the read-only
    // allowlist with review/challenge/review_gate.
    const result = await invokeHook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
      { ...process.env, KIMI_PLUGIN_CC_CMD: "ask" },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("ask");
    expect(result.stderr).toContain("Bash");
  });

  test.each(["ask", "review", "challenge", "review_gate"])(
    "%s label + Read → exit 0",
    async (label) => {
      const result = await invokeHook(
        { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "x" } },
        { ...process.env, KIMI_PLUGIN_CC_CMD: label },
      );
      expect(result.exitCode).toBe(0);
    },
  );

  test.each(["ask", "review", "challenge", "review_gate"])(
    "%s label + Bash → exit 2 + stderr reason",
    async (label) => {
      const result = await invokeHook(
        { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
        { ...process.env, KIMI_PLUGIN_CC_CMD: label },
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(label);
      expect(result.stderr).toContain("Bash");
      // kimi-code surfaces stderr.trim() as the reason, so empty
      // trailing newline must not collapse the line.
      expect(result.stderr.trim().length).toBeGreaterThan(0);
    },
  );

  test("malformed stdin JSON → exit 2 + 'misconfigured' on stderr", async () => {
    const result = await invokeHook(
      "{not json at all",
      { ...process.env, KIMI_PLUGIN_CC_CMD: "review" },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("misconfigured");
  });

  test("stdin payload is an array (not an object) → exit 2", async () => {
    const result = await invokeHook(
      JSON.stringify(["not", "an", "object"]),
      { ...process.env, KIMI_PLUGIN_CC_CMD: "review" },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("misconfigured");
  });

  test("rescue + Write inside workspace → exit 0 (PR 3 evaluator wired)", async () => {
    // file_path "x" resolves against cwd (process.cwd()), which is the
    // plugin repo — inside the workspace, so the rescue evaluator
    // allows it.
    const result = await invokeHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "x" },
        cwd: process.cwd(),
      },
      {
        ...process.env,
        KIMI_PLUGIN_CC_CMD: "rescue",
        KIMI_PLUGIN_CC_WORKSPACE_ROOT: process.cwd(),
      },
    );
    expect(result.exitCode).toBe(0);
  });

  test("rescue + Write outside workspace → exit 2 (PR 3 evaluator wired)", async () => {
    const result = await invokeHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "/etc/should-not-write" },
        cwd: process.cwd(),
      },
      {
        ...process.env,
        KIMI_PLUGIN_CC_CMD: "rescue",
        KIMI_PLUGIN_CC_WORKSPACE_ROOT: process.cwd(),
      },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("outside the workspace");
  });

  test("rescue + Bash with disallowed command → exit 2", async () => {
    const result = await invokeHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
        cwd: process.cwd(),
      },
      {
        ...process.env,
        KIMI_PLUGIN_CC_CMD: "rescue",
        KIMI_PLUGIN_CC_WORKSPACE_ROOT: process.cwd(),
      },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  test("rescue + Bash with allowlisted git status → exit 0", async () => {
    const result = await invokeHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git status" },
        cwd: process.cwd(),
      },
      {
        ...process.env,
        KIMI_PLUGIN_CC_CMD: "rescue",
        KIMI_PLUGIN_CC_WORKSPACE_ROOT: process.cwd(),
      },
    );
    expect(result.exitCode).toBe(0);
  });

  test("rescue + allowlisted Bash with outside tool cwd → exit 2", async () => {
    const result = await invokeHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "bun test", cwd: "/tmp" },
        cwd: process.cwd(),
      },
      {
        ...process.env,
        KIMI_PLUGIN_CC_CMD: "rescue",
        KIMI_PLUGIN_CC_WORKSPACE_ROOT: process.cwd(),
      },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Bash cwd");
  });

  test("rescue label + Read → exit 0", async () => {
    const result = await invokeHook(
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "x" } },
      { ...process.env, KIMI_PLUGIN_CC_CMD: "rescue" },
    );
    expect(result.exitCode).toBe(0);
  });

  test("unknown command label + Bash → exit 2 (conservative default)", async () => {
    const result = await invokeHook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
      { ...process.env, KIMI_PLUGIN_CC_CMD: "future_cmd_v2" },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unrecognized");
  });

  test("ReadMediaFile is read-only and allowed under review", async () => {
    const result = await invokeHook(
      { hook_event_name: "PreToolUse", tool_name: "ReadMediaFile", tool_input: { file_path: "x.png" } },
      { ...process.env, KIMI_PLUGIN_CC_CMD: "review" },
    );
    expect(result.exitCode).toBe(0);
  });
});

describe("pursue metadata hook environment", () => {
  test.each([
    ["GetGoal", {}],
    ["UpdateGoal", { status: "complete" }],
    ["UpdateGoal", { status: "blocked" }],
  ] as const)("pursue environment allows %s %j through the real hook subprocess", async (tool_name, tool_input) => {
    const result = await invokeHook({ hook_event_name: "PreToolUse", tool_name, tool_input }, {
      ...process.env,
      KIMI_PLUGIN_CC_CMD: "rescue",
      KIMI_PLUGIN_CC_OPERATION: "pursue",
      KIMI_PLUGIN_CC_WORKSPACE_ROOT: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("untrusted payload cannot supply pursue provenance, and ordinary rescue stays denied", async () => {
    for (const operationKind of [undefined, "rescue"]) {
      const env: NodeJS.ProcessEnv = { ...process.env, KIMI_PLUGIN_CC_CMD: "rescue", KIMI_PLUGIN_CC_WORKSPACE_ROOT: process.cwd() };
      if (operationKind !== undefined) env.KIMI_PLUGIN_CC_OPERATION = operationKind;
      else delete env.KIMI_PLUGIN_CC_OPERATION;
      const result = await invokeHook({
        tool_name: "UpdateGoal", tool_input: { status: "complete" }, operationKind: "pursue", cwd: process.cwd(),
      }, env);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("UpdateGoal");
    }
  });

  test.each([
    ["UpdateGoal", { status: "active" }], ["UpdateGoal", { status: "complete", extra: true }],
    ["SetGoalBudget", { turns: 1 }], ["CreateGoal", { objective: "replace" }],
  ] as const)("pursue environment denies %s %j with exit 2", async (tool_name, tool_input) => {
    const result = await invokeHook({ tool_name, tool_input }, {
      ...process.env, KIMI_PLUGIN_CC_CMD: "rescue", KIMI_PLUGIN_CC_OPERATION: "pursue", KIMI_PLUGIN_CC_WORKSPACE_ROOT: process.cwd(),
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(tool_name);
  });

  test("confined read scope: a workspace read exits 0 and a read outside the roots exits 2", async () => {
    const root = await realpath(process.cwd());
    const env = { ...process.env, KIMI_PLUGIN_CC_CMD: "ask", KIMI_PLUGIN_CC_READ_ROOTS: JSON.stringify([root]) };
    const inside = await invokeHook({ tool_name: "Read", tool_input: { path: "package.json" } }, env);
    expect(inside.exitCode).toBe(0);
    const outside = await invokeHook({ tool_name: "Read", tool_input: { path: "/etc/hosts" } }, env);
    expect(outside.exitCode).toBe(2);
    expect(outside.stderr).toContain("reads are confined");
  });

  test("ambient KIMI_PLUGIN_CC_NETWORK=1 without read roots keeps web tools denied (exit 2)", async () => {
    const result = await invokeHook({ tool_name: "WebSearch", tool_input: { query: "x" } },
      { ...process.env, KIMI_PLUGIN_CC_CMD: "ask", KIMI_PLUGIN_CC_NETWORK: "1" });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--network");
  });
});
