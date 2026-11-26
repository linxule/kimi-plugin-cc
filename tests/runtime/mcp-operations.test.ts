import { describe, expect, test } from "bun:test";

import { RuntimeError } from "../../runtime/errors.js";
import { allocateJobId } from "../../runtime/job-id.js";
import {
  buildMcpOperationInvocation,
  MCP_TOOL_DEFINITIONS,
  readJobControlArguments,
  readSetupArguments,
  type McpModelOperation,
  type McpModelToolName,
} from "../../runtime/mcp/operations.js";
import { runMcpChild } from "../../runtime/mcp/supervised-child.js";
import type { CommandContext } from "../../runtime/types.js";

const context: CommandContext = {
  cwd: process.cwd(),
  env: {},
  stdout: process.stdout,
  stderr: process.stderr,
};

const common = {
  workspace: "/tmp/workspace with spaces",
  model: "kimi-k2",
  thinking: "HIGH",
  budget: "90s",
};
const commonArgv = ["--budget", "90s", "-m", "kimi-k2", "--thinking", "HIGH"];

const operationCases: Array<{
  name: McpModelToolName;
  input: Record<string, unknown>;
  operationKind: McpModelOperation;
  argv: string[];
}> = [
  {
    name: "kimi_read",
    input: { ...common, mode: "ask", prompt: "Explain this repository" },
    operationKind: "ask",
    argv: ["ask", ...commonArgv, "--", "Explain this repository"],
  },
  {
    name: "kimi_read",
    input: { ...common, mode: "review", base: "main", prompt: "Check the changed API" },
    operationKind: "review",
    argv: ["review", ...commonArgv, "--base", "main", "--", "Check the changed API"],
  },
  {
    name: "kimi_read",
    input: { ...common, mode: "challenge", base: "HEAD~2", prompt: "Challenge the design" },
    operationKind: "challenge",
    argv: ["task", "challenge", ...commonArgv, "--base", "HEAD~2", "--", "Challenge the design"],
  },
  {
    name: "kimi_read",
    input: { ...common, mode: "swarm", prompt: "Audit these modules", cap: 6, max_concurrency: 2 },
    operationKind: "swarm",
    argv: ["task", "swarm", ...commonArgv, "--cap", "6", "--max-concurrency", "2", "--", "Audit these modules"],
  },
  {
    name: "kimi_write",
    input: { ...common, mode: "rescue", prompt: "Fix the failing parser" },
    operationKind: "rescue",
    argv: ["task", "rescue", ...commonArgv, "--fresh", "--", "Fix the failing parser"],
  },
  {
    name: "kimi_write",
    input: { ...common, mode: "pursue", prompt: "Finish the migration" },
    operationKind: "pursue",
    argv: ["task", "pursue", ...commonArgv, "--", "Finish the migration"],
  },
  {
    name: "kimi_write",
    input: { ...common, mode: "swarm_patch", prompt: "Implement disjoint fixes", cap: 3, max_concurrency: 1 },
    operationKind: "swarm-write",
    argv: ["task", "swarm", ...commonArgv, "--cap", "3", "--max-concurrency", "1", "--write", "--", "Implement disjoint fixes"],
  },
];

function expectRuntimeError(call: () => unknown, code: string, message?: string | RegExp): void {
  let thrown: unknown;
  try {
    call();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RuntimeError);
  expect((thrown as RuntimeError).code).toBe(code);
  expect((thrown as RuntimeError).stage).toEqual(expect.any(String));
  if (typeof message === "string") expect((thrown as RuntimeError).message).toContain(message);
  if (message instanceof RegExp) expect((thrown as RuntimeError).message).toMatch(message);
}

async function expectAsyncRuntimeError(promise: Promise<unknown>, code: string, message?: string | RegExp): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RuntimeError);
  expect((thrown as RuntimeError).code).toBe(code);
  if (message !== undefined) {
    if (typeof message === "string") expect((thrown as RuntimeError).message).toContain(message);
    else expect((thrown as RuntimeError).message).toMatch(message);
  }
}

describe("MCP operation invocation construction", () => {
  for (const operation of operationCases) {
    test(`${operation.name} (${operation.operationKind}) maps to the exact companion operation and argv`, () => {
      expect(buildMcpOperationInvocation(operation.name, operation.input)).toEqual({
        operationKind: operation.operationKind,
        workspace: common.workspace,
        wait: true,
        argv: operation.argv,
      });
    });
  }

  test("defaults kimi_read to ask, kimi_write to rescue, wait to true, and omits optional fields when absent", () => {
    const read = buildMcpOperationInvocation("kimi_read", { prompt: "Hello" });
    expect(read).toEqual({ operationKind: "ask", wait: true, argv: ["ask", "--", "Hello"] });
    expect(Object.hasOwn(read, "workspace")).toBe(false);
    expect(Object.hasOwn(read, "waitTimeoutMs")).toBe(false);

    const write = buildMcpOperationInvocation("kimi_write", { prompt: "Fix it" });
    expect(write).toEqual({ operationKind: "rescue", wait: true, argv: ["task", "rescue", "--fresh", "--", "Fix it"] });
    expect(Object.hasOwn(write, "workspace")).toBe(false);
  });

  test("honors wait and wait_timeout_ms and validates bounds", () => {
    expect(buildMcpOperationInvocation("kimi_read", { prompt: "Hello", wait: false })).toEqual({
      operationKind: "ask",
      wait: false,
      argv: ["ask", "--", "Hello"],
    });
    expect(buildMcpOperationInvocation("kimi_write", { prompt: "Fix", wait: true, wait_timeout_ms: 5_000 })).toEqual({
      operationKind: "rescue",
      wait: true,
      waitTimeoutMs: 5_000,
      argv: ["task", "rescue", "--fresh", "--", "Fix"],
    });
    expectRuntimeError(
      () => buildMcpOperationInvocation("kimi_read", { prompt: "x", wait: "false" }),
      "MCP_INVALID_ARGUMENTS",
      "wait must be a boolean",
    );
    for (const wait_timeout_ms of [0, 999, 86_400_001, 1500.5, "5000"]) {
      expectRuntimeError(
        () => buildMcpOperationInvocation("kimi_read", { prompt: "x", wait_timeout_ms }),
        "MCP_INVALID_ARGUMENTS",
        "wait_timeout_ms must be an integer between 1000 and 86400000",
      );
    }
  });

  test("preserves whitespace and leading dashes in prompt across all read and write modes", () => {
    const text = "  \t--fresh\nkeep this verbatim  ";
    const cases: Array<[McpModelToolName, string]> = [
      ["kimi_read", "ask"],
      ["kimi_read", "review"],
      ["kimi_read", "challenge"],
      ["kimi_read", "swarm"],
      ["kimi_write", "rescue"],
      ["kimi_write", "pursue"],
      ["kimi_write", "swarm_patch"],
    ];
    for (const [name, mode] of cases) {
      const invocation = buildMcpOperationInvocation(name, { mode, prompt: text });
      expect(invocation.argv.at(-2)).toBe("--");
      expect(invocation.argv.at(-1)).toBe(text);
    }
  });

  test("only kimi_write mode swarm_patch adds --write", () => {
    const minimalCases: Array<[McpModelToolName, Record<string, unknown>, boolean]> = [
      ["kimi_read", { mode: "ask", prompt: "question" }, false],
      ["kimi_read", { mode: "review" }, false],
      ["kimi_read", { mode: "challenge" }, false],
      ["kimi_read", { mode: "swarm", prompt: "audit" }, false],
      ["kimi_write", { mode: "rescue", prompt: "fix" }, false],
      ["kimi_write", { mode: "pursue", prompt: "goal" }, false],
      ["kimi_write", { mode: "swarm_patch", prompt: "implement" }, true],
    ];
    for (const [name, input, expectsWrite] of minimalCases) {
      expect(buildMcpOperationInvocation(name, input).argv.includes("--write")).toBe(expectsWrite);
    }
    expectRuntimeError(
      () => buildMcpOperationInvocation("kimi_read", { mode: "swarm", prompt: "audit", write: true }),
      "MCP_INVALID_ARGUMENTS",
      "Unknown argument write",
    );
  });

  test("validates kimi_read and kimi_write mode enums strictly", () => {
    for (const mode of ["rescue", "pursue", "swarm_patch", "defects", "Ask", "", 1, true]) {
      expectRuntimeError(() => buildMcpOperationInvocation("kimi_read", { mode, prompt: "x" }), "MCP_INVALID_ARGUMENTS");
    }
    for (const mode of ["ask", "review", "challenge", "swarm", "swarm-write", "Rescue", "", 1, true]) {
      expectRuntimeError(() => buildMcpOperationInvocation("kimi_write", { mode, prompt: "x" }), "MCP_INVALID_ARGUMENTS");
    }
  });

  test("supports resume='last' and explicit resume ID for ask and rescue, and rejects invalid combinations", () => {
    for (const [name, mode, command] of [
      ["kimi_read", "ask", ["ask"]],
      ["kimi_write", "rescue", ["task", "rescue"]],
    ] as const) {
      expect(buildMcpOperationInvocation(name, { mode, resume: "last" }).argv)
        .toEqual([...command, "-r"]);
      expect(buildMcpOperationInvocation(name, { mode, resume: "last", prompt: "continue with this" }).argv)
        .toEqual([...command, "-r", "--", "continue with this"]);
      expect(buildMcpOperationInvocation(name, { mode, resume: "job-123" }).argv)
        .toEqual([...command, "--resume", "job-123"]);

      expectRuntimeError(
        () => buildMcpOperationInvocation(name, { mode }),
        "MCP_INVALID_ARGUMENTS",
        "prompt must be a non-empty string",
      );
      expectRuntimeError(
        () => buildMcpOperationInvocation(name, { mode, resume: "job-123", prompt: "not allowed" }),
        "MCP_INVALID_ARGUMENTS",
        "cannot include prompt",
      );
      expectRuntimeError(
        () => buildMcpOperationInvocation(name, { mode, resume: "   " }),
        "MCP_INVALID_ARGUMENTS",
        "resume must be a non-empty string",
      );
    }

    for (const [name, mode] of [
      ["kimi_read", "review"],
      ["kimi_read", "challenge"],
      ["kimi_read", "swarm"],
      ["kimi_write", "pursue"],
      ["kimi_write", "swarm_patch"],
    ] as const) {
      expectRuntimeError(
        () => buildMcpOperationInvocation(name, { mode, prompt: "x", resume: "last" }),
        "MCP_INVALID_ARGUMENTS",
        "resume is only valid for mode",
      );
    }
  });

  test("enforces mode-specific parameters across review/challenge, swarm, and pursue", () => {
    expect(buildMcpOperationInvocation("kimi_read", { mode: "review" }).argv).toEqual(["review"]);
    expect(buildMcpOperationInvocation("kimi_read", { mode: "review", uncommitted: true }).argv).toEqual(["review"]);
    expect(buildMcpOperationInvocation("kimi_read", { mode: "challenge", base: "main", uncommitted: false }).argv)
      .toEqual(["task", "challenge", "--base", "main"]);
    expect(buildMcpOperationInvocation("kimi_read", { mode: "review", prompt: "   " }).argv).toEqual(["review"]);

    expectRuntimeError(
      () => buildMcpOperationInvocation("kimi_read", { mode: "review", base: "main", uncommitted: true }),
      "MCP_INVALID_ARGUMENTS",
      "mutually exclusive",
    );
    expectRuntimeError(
      () => buildMcpOperationInvocation("kimi_read", { mode: "review", uncommitted: false }),
      "MCP_INVALID_ARGUMENTS",
      "uncommitted=false requires a base ref",
    );
    expectRuntimeError(
      () => buildMcpOperationInvocation("kimi_read", { mode: "challenge", uncommitted: false }),
      "MCP_INVALID_ARGUMENTS",
      "uncommitted=false requires a base ref",
    );
    for (const mode of ["ask", "swarm"] as const) {
      expectRuntimeError(
        () => buildMcpOperationInvocation("kimi_read", { mode, prompt: "x", base: "main" }),
        "MCP_INVALID_ARGUMENTS",
        'only valid for mode "review" or "challenge"',
      );
      expectRuntimeError(
        () => buildMcpOperationInvocation("kimi_read", { mode, prompt: "x", uncommitted: true }),
        "MCP_INVALID_ARGUMENTS",
        'only valid for mode "review" or "challenge"',
      );
    }
    for (const [name, mode] of [
      ["kimi_read", "ask"],
      ["kimi_read", "review"],
      ["kimi_read", "challenge"],
      ["kimi_write", "rescue"],
      ["kimi_write", "pursue"],
    ] as const) {
      expectRuntimeError(
        () => buildMcpOperationInvocation(name, { mode, prompt: "x", cap: 2 }),
        "MCP_INVALID_ARGUMENTS",
        "cap and max_concurrency are only valid for mode",
      );
      expectRuntimeError(
        () => buildMcpOperationInvocation(name, { mode, prompt: "x", max_concurrency: 2 }),
        "MCP_INVALID_ARGUMENTS",
        "cap and max_concurrency are only valid for mode",
      );
    }
  });

  test("validates referenced_sessions, cap, max_concurrency, and common options", () => {
    expect(
      buildMcpOperationInvocation("kimi_read", {
        mode: "ask",
        prompt: "compare",
        referenced_sessions: ["job-1", "job-2", "job-1"],
      }).argv,
    ).toEqual(["ask", "--reference-session", "job-1", "--reference-session", "job-2", "--", "compare"]);
    expect(
      buildMcpOperationInvocation("kimi_write", {
        mode: "rescue",
        prompt: "fix",
        referenced_sessions: ["job-1"],
      }).argv,
    ).toEqual(["task", "rescue", "--reference-session", "job-1", "--fresh", "--", "fix"]);
    expectRuntimeError(
      () => buildMcpOperationInvocation("kimi_write", {
        mode: "pursue",
        prompt: "goal",
        referenced_sessions: ["job-1"],
      }),
      "MCP_INVALID_ARGUMENTS",
      'referenced_sessions is not supported for mode "pursue"',
    );
    expectRuntimeError(
      () => buildMcpOperationInvocation("kimi_read", {
        mode: "ask",
        prompt: "x",
        referenced_sessions: Array.from({ length: 9 }, (_, i) => `session-${i}`),
      }),
      "MCP_INVALID_ARGUMENTS",
      "at most 8 distinct sessions",
    );

    expectRuntimeError(
      () => buildMcpOperationInvocation("kimi_read", { prompt: "x", model: "  " }),
      "MCP_INVALID_ARGUMENTS",
      "model must be a non-empty string",
    );
    for (const budget of ["0", "25h", "1.5h", "forever"]) {
      expectRuntimeError(
        () => buildMcpOperationInvocation("kimi_read", { prompt: "x", budget }),
        "INVALID_ARGS",
      );
    }
    for (const thinking of ["", "two words", "-high", "x".repeat(33)]) {
      expectRuntimeError(
        () => buildMcpOperationInvocation("kimi_read", { prompt: "x", thinking }),
        "INVALID_ARGS",
      );
    }
    for (const [name, mode] of [["kimi_read", "swarm"], ["kimi_write", "swarm_patch"]] as const) {
      for (const cap of [0, -1, 26, 1.5, "2"]) {
        expectRuntimeError(
          () => buildMcpOperationInvocation(name, { mode, prompt: "x", cap }),
          "MCP_INVALID_ARGUMENTS",
          "cap must be an integer between 1 and 25",
        );
      }
      for (const max_concurrency of [0, -1, 17, 1.5, "2"]) {
        expectRuntimeError(
          () => buildMcpOperationInvocation(name, { mode, prompt: "x", max_concurrency }),
          "MCP_INVALID_ARGUMENTS",
          "max_concurrency must be an integer between 1 and 16",
        );
      }
    }
  });

  test("rejects unknown keys and malformed argument containers", () => {
    for (const operation of operationCases) {
      expectRuntimeError(
        () => buildMcpOperationInvocation(operation.name, { ...operation.input, mystery: true }),
        "MCP_INVALID_ARGUMENTS",
        "Unknown argument mystery",
      );
    }
    for (const input of [null, [], "prompt", 1, true]) {
      expectRuntimeError(() => buildMcpOperationInvocation("kimi_read", input), "MCP_INVALID_ARGUMENTS");
      expectRuntimeError(() => buildMcpOperationInvocation("kimi_write", input), "MCP_INVALID_ARGUMENTS");
    }
  });
});

describe("MCP read scope and tool definitions", () => {
  test("read_roots and network map to repeated --read-root and --network on all kimi_read modes", () => {
    const scope = { read_roots: ["/opt/docs", "/srv/a dir"], network: true };
    const flags = ["--read-root", "/opt/docs", "--read-root", "/srv/a dir", "--network"];
    expect(buildMcpOperationInvocation("kimi_read", { ...scope, mode: "ask", prompt: "q" }).argv)
      .toEqual(["ask", ...flags, "--", "q"]);
    expect(buildMcpOperationInvocation("kimi_read", { ...scope, mode: "review", prompt: "f" }).argv)
      .toEqual(["review", ...flags, "--", "f"]);
    expect(buildMcpOperationInvocation("kimi_read", { ...scope, mode: "challenge" }).argv)
      .toEqual(["task", "challenge", ...flags]);
    expect(buildMcpOperationInvocation("kimi_read", { ...scope, mode: "swarm", prompt: "o" }).argv)
      .toEqual(["task", "swarm", ...flags, "--", "o"]);
    expect(buildMcpOperationInvocation("kimi_read", { prompt: "q", network: false, read_roots: [] }).argv)
      .toEqual(["ask", "--", "q"]);
  });

  test("kimi_write rejects read_roots and network", () => {
    for (const mode of ["rescue", "pursue", "swarm_patch"] as const) {
      for (const [key, value] of [["read_roots", ["/opt"]], ["network", true]] as const) {
        expectRuntimeError(
          () => buildMcpOperationInvocation("kimi_write", { mode, prompt: "edit", [key]: value }),
          "MCP_INVALID_ARGUMENTS",
          `Unknown argument ${key}`,
        );
      }
    }
  });

  test("scope parameters are type-checked only; path rules stay with the runtime", () => {
    for (const read_roots of ["/opt", [1], [null], {}]) {
      expectRuntimeError(
        () => buildMcpOperationInvocation("kimi_read", { prompt: "q", read_roots }),
        "MCP_INVALID_ARGUMENTS",
        "read_roots",
      );
    }
    expectRuntimeError(
      () => buildMcpOperationInvocation("kimi_read", { prompt: "q", network: "yes" }),
      "MCP_INVALID_ARGUMENTS",
      "network must be a boolean",
    );
    expect(buildMcpOperationInvocation("kimi_read", { prompt: "q", read_roots: ["relative"] }).argv)
      .toEqual(["ask", "--read-root", "relative", "--", "q"]);
  });

  test("tool definitions expose the 4-tool surface with exact schemas and annotations", () => {
    expect(MCP_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      "kimi_read",
      "kimi_write",
      "kimi_job",
      "kimi_setup",
    ]);
    const byName = new Map(MCP_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
    const readProps = byName.get("kimi_read")!.inputSchema.properties as Record<string, any>;
    const writeProps = byName.get("kimi_write")!.inputSchema.properties as Record<string, any>;
    const jobProps = byName.get("kimi_job")!.inputSchema.properties as Record<string, any>;
    const setupProps = byName.get("kimi_setup")!.inputSchema.properties as Record<string, any>;

    expect(readProps.mode.enum).toEqual(["ask", "review", "challenge", "swarm"]);
    expect(Object.keys(readProps)).toEqual(expect.arrayContaining(["read_roots", "network", "wait", "wait_timeout_ms"]));
    expect(byName.get("kimi_read")!.annotations).toEqual({
      title: "kimi read",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });

    expect(writeProps.mode.enum).toEqual(["rescue", "pursue", "swarm_patch"]);
    expect(Object.keys(writeProps)).not.toContain("read_roots");
    expect(Object.keys(writeProps)).not.toContain("network");
    expect(byName.get("kimi_write")!.annotations).toEqual({
      title: "kimi write",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });

    expect(jobProps.action.enum).toEqual(["list", "status", "result", "wait", "cancel", "replay", "recover_swarm"]);
    expect(setupProps.action.enum).toEqual(["check", "models", "install", "install_kimi", "repair_sessions"]);
  });
});

describe("MCP job-control and setup arguments", () => {
  test("readJobControlArguments parses every action and enforces action-specific flags", () => {
    expect(readJobControlArguments({ action: "list", status_filter: "completed", limit: 10, workspace: "/tmp/ws" }))
      .toEqual({ action: "list", statusFilter: "completed", limit: 10, workspace: "/tmp/ws" });
    expect(readJobControlArguments({ action: "status" })).toEqual({ action: "status" });
    expect(readJobControlArguments({ action: "result", job_id: "job-123" })).toEqual({
      action: "result",
      jobId: "job-123",
    });
    expect(readJobControlArguments({ action: "wait", job_id: "job-123", wait_ms: 5_000 })).toEqual({
      action: "wait",
      jobId: "job-123",
      waitMs: 5_000,
    });
    expect(readJobControlArguments({ action: "cancel" })).toEqual({ action: "cancel" });
    expect(readJobControlArguments({ action: "replay", job_id: "job-123" })).toEqual({
      action: "replay",
      jobId: "job-123",
    });
    expect(readJobControlArguments({ action: "recover_swarm", job_id: "job-123", apply: true })).toEqual({
      action: "recover_swarm",
      jobId: "job-123",
      apply: true,
    });

    for (const input of [{}, { action: "unknown" }, { action: "replay" }, { action: "recover_swarm" }, null, []]) {
      expectRuntimeError(() => readJobControlArguments(input), "MCP_INVALID_ARGUMENTS");
    }
    expectRuntimeError(
      () => readJobControlArguments({ action: "status", status_filter: "running" }),
      "MCP_INVALID_ARGUMENTS",
      'only valid for action "list"',
    );
    expectRuntimeError(
      () => readJobControlArguments({ action: "status", wait_ms: 500 }),
      "MCP_INVALID_ARGUMENTS",
      'only valid for action "wait"',
    );
    expectRuntimeError(
      () => readJobControlArguments({ action: "status", apply: true }),
      "MCP_INVALID_ARGUMENTS",
      'only valid for action "recover_swarm"',
    );
    expectRuntimeError(
      () => readJobControlArguments({ action: "status", job_id: "   " }),
      "MCP_INVALID_ARGUMENTS",
      "job_id must be a non-empty string",
    );
    expectRuntimeError(
      () => readJobControlArguments({ action: "status", taskId: "job-123" }),
      "MCP_INVALID_ARGUMENTS",
      "Unknown argument taskId",
    );
  });

  test("readSetupArguments defaults to check and validates repair_sessions-only flags", () => {
    expect(readSetupArguments(undefined)).toEqual({ action: "check" });
    expect(readSetupArguments({})).toEqual({ action: "check" });
    for (const action of ["check", "models", "install", "install_kimi", "repair_sessions"] as const) {
      expect(readSetupArguments({ action })).toEqual({ action });
    }
    expect(readSetupArguments({ action: "repair_sessions", apply: true, all: true, workspace: "/tmp/ws" })).toEqual({
      action: "repair_sessions",
      apply: true,
      all: true,
      workspace: "/tmp/ws",
    });
    expectRuntimeError(
      () => readSetupArguments({ action: "check", apply: true }),
      "MCP_INVALID_ARGUMENTS",
      'only valid for action "repair_sessions"',
    );
    expectRuntimeError(
      () => readSetupArguments({ action: "models", all: true }),
      "MCP_INVALID_ARGUMENTS",
      'only valid for action "repair_sessions"',
    );
    expectRuntimeError(
      () => readSetupArguments({ action: "uninstall" }),
      "MCP_INVALID_ARGUMENTS",
      "action must be one of",
    );
  });
});

describe("MCP supervised child identity and dispatch guards", () => {
  test("allocateJobId generates a UUID by default and preserves a valid fixed UUID", () => {
    expect(allocateJobId(context)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const fixed = "123e4567-e89b-42d3-a456-426614174000";
    expect(allocateJobId({ ...context, mcpJobId: fixed })).toBe(fixed);
  });

  test("allocateJobId rejects malformed fixed IDs before command dispatch", async () => {
    for (const value of ["", "not-a-uuid", "123e4567-e89b-02d3-a456-426614174000"]) {
      expectRuntimeError(() => allocateJobId({ ...context, mcpJobId: value }), "MCP_INVALID_JOB_ID");
    }
    await expectAsyncRuntimeError(runMcpChild(["not-a-uuid", "ask", "--", "hello"], context), "MCP_INVALID_JOB_ID");
  });

  test("runMcpChild rejects missing commands and non-model operations without launching work", async () => {
    await expectAsyncRuntimeError(runMcpChild([], context), "MCP_INVALID_CHILD", "expects a job UUID");
    await expectAsyncRuntimeError(runMcpChild(["123e4567-e89b-42d3-a456-426614174000"], context), "MCP_INVALID_CHILD");
    await expectAsyncRuntimeError(
      runMcpChild(["123e4567-e89b-42d3-a456-426614174000", "status"], context),
      "MCP_INVALID_CHILD",
      "only the public model operations",
    );
  });
});
