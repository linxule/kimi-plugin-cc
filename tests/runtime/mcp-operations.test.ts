import { describe, expect, test } from "bun:test";

import { RuntimeError } from "../../runtime/errors.js";
import { allocateJobId } from "../../runtime/job-id.js";
import {
  buildMcpOperationInvocation,
  MCP_TOOL_DEFINITIONS,
  readJobControlArguments,
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
    name: "kimi_ask",
    input: { ...common, prompt: "Explain this repository" },
    operationKind: "ask",
    argv: ["ask", ...commonArgv, "--", "Explain this repository"],
  },
  {
    name: "kimi_review",
    input: { ...common, base: "main", focus: "Check the changed API" },
    operationKind: "review",
    argv: ["review", ...commonArgv, "--base", "main", "--", "Check the changed API"],
  },
  {
    name: "kimi_review",
    input: { ...common, mode: "challenge", base: "HEAD~2", focus: "Challenge the design" },
    operationKind: "challenge",
    argv: ["task", "challenge", ...commonArgv, "--base", "HEAD~2", "--", "Challenge the design"],
  },
  {
    name: "kimi_rescue",
    input: { ...common, prompt: "Fix the failing parser" },
    operationKind: "rescue",
    argv: ["task", "rescue", ...commonArgv, "--", "Fix the failing parser"],
  },
  {
    name: "kimi_pursue",
    input: { ...common, objective: "Finish the migration", turns: 4 },
    operationKind: "pursue",
    argv: ["task", "pursue", ...commonArgv, "--turns", "4", "--", "Finish the migration"],
  },
  {
    name: "kimi_swarm",
    input: { ...common, objective: "Audit these modules", cap: 6, max_concurrency: 2 },
    operationKind: "swarm",
    argv: ["task", "swarm", ...commonArgv, "--cap", "6", "--max-concurrency", "2", "--", "Audit these modules"],
  },
  {
    name: "kimi_swarm_write",
    input: { ...common, objective: "Implement disjoint fixes", cap: 3, max_concurrency: 1 },
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
        argv: operation.argv,
      });
    });
  }

  test("omits optional common flags and workspace when they are not supplied", () => {
    const invocation = buildMcpOperationInvocation("kimi_ask", { prompt: "Hello" });
    expect(invocation).toEqual({ operationKind: "ask", argv: ["ask", "--", "Hello"] });
    expect(Object.hasOwn(invocation, "workspace")).toBe(false);
  });

  test("preserves whitespace and leading dashes in every free-text argument", () => {
    const text = "  \t--fresh\nkeep this verbatim  ";
    const cases: Array<[McpModelToolName, string]> = [
      ["kimi_ask", "prompt"],
      ["kimi_review", "focus"],
      ["kimi_rescue", "prompt"],
      ["kimi_pursue", "objective"],
      ["kimi_swarm", "objective"],
      ["kimi_swarm_write", "objective"],
    ];
    for (const [name, property] of cases) {
      const invocation = buildMcpOperationInvocation(name, { [property]: text });
      expect(invocation.argv.at(-2)).toBe("--");
      expect(invocation.argv.at(-1)).toBe(text);
    }
  });

  test("only swarm-write adds --write", () => {
    const minimalInputs: Record<McpModelToolName, Record<string, unknown>> = {
      kimi_ask: { prompt: "question" },
      kimi_review: {},
      kimi_rescue: { prompt: "fix" },
      kimi_pursue: { objective: "goal" },
      kimi_swarm: { objective: "audit" },
      kimi_swarm_write: { objective: "implement" },
    };
    for (const name of Object.keys(minimalInputs) as McpModelToolName[]) {
      expect(buildMcpOperationInvocation(name, minimalInputs[name]).argv.includes("--write")).toBe(name === "kimi_swarm_write");
    }
    expectRuntimeError(
      () => buildMcpOperationInvocation("kimi_swarm", { objective: "audit", write: true }),
      "MCP_INVALID_ARGUMENTS",
      "Unknown argument write",
    );
  });

  test("supports fresh, explicit resume, and latest resume forms for ask and rescue", () => {
    for (const [name, command] of [["kimi_ask", ["ask"]], ["kimi_rescue", ["task", "rescue"]]] as const) {
      expect(buildMcpOperationInvocation(name, { fresh: true, prompt: "new" }).argv)
        .toEqual([...command, "--fresh", "--", "new"]);
      expect(buildMcpOperationInvocation(name, { resume: "job-123" }).argv)
        .toEqual([...command, "--resume", "job-123"]);
      expect(buildMcpOperationInvocation(name, { resume_latest: true }).argv)
        .toEqual([...command, "-r"]);
      expect(buildMcpOperationInvocation(name, { resume_latest: true, prompt: "continue with this" }).argv)
        .toEqual([...command, "-r", "--", "continue with this"]);
      expect(buildMcpOperationInvocation(name, { fresh: false, resume_latest: false, prompt: "new" }).argv)
        .toEqual([...command, "--", "new"]);
    }
  });

  test("rejects incompatible or incomplete resume selections", () => {
    for (const name of ["kimi_ask", "kimi_rescue"] as const) {
      expectRuntimeError(() => buildMcpOperationInvocation(name, {}), "MCP_INVALID_ARGUMENTS", "requires prompt");
      expectRuntimeError(
        () => buildMcpOperationInvocation(name, { fresh: true, resume: "job-123" }),
        "MCP_INVALID_ARGUMENTS",
        "fresh cannot be combined",
      );
      expectRuntimeError(
        () => buildMcpOperationInvocation(name, { fresh: true, resume_latest: true }),
        "MCP_INVALID_ARGUMENTS",
        "fresh cannot be combined",
      );
      expectRuntimeError(
        () => buildMcpOperationInvocation(name, { resume: "job-123", resume_latest: true }),
        "MCP_INVALID_ARGUMENTS",
        "alternatives",
      );
      expectRuntimeError(
        () => buildMcpOperationInvocation(name, { resume: "job-123", prompt: "not allowed" }),
        "MCP_INVALID_ARGUMENTS",
        "cannot include prompt",
      );
    }
  });

  test("rejects a blank explicit resume target", () => {
    for (const name of ["kimi_ask", "kimi_rescue"] as const) {
      expectRuntimeError(
        () => buildMcpOperationInvocation(name, { resume: "   " }),
        "MCP_INVALID_ARGUMENTS",
        "resume must be a non-empty string",
      );
    }
  });

  test("validates common options without rewriting their argv values", () => {
    expectRuntimeError(
      () => buildMcpOperationInvocation("kimi_ask", { prompt: "x", model: "  " }),
      "MCP_INVALID_ARGUMENTS",
      "model must be a non-empty string",
    );
    for (const budget of ["0", "25h", "1.5h", "forever"]) {
      expectRuntimeError(
        () => buildMcpOperationInvocation("kimi_ask", { prompt: "x", budget }),
        "INVALID_ARGS",
      );
    }
    for (const thinking of ["", "two words", "-high", "x".repeat(33)]) {
      expectRuntimeError(
        () => buildMcpOperationInvocation("kimi_ask", { prompt: "x", thinking }),
        "INVALID_ARGS",
      );
    }
  });

  test("rejects unknown keys, malformed argument containers, and invalid scalar types", () => {
    for (const operation of operationCases) {
      expectRuntimeError(
        () => buildMcpOperationInvocation(operation.name, { ...operation.input, mystery: true }),
        "MCP_INVALID_ARGUMENTS",
        "Unknown argument mystery",
      );
    }
    for (const input of [null, [], "prompt", 1, true]) {
      expectRuntimeError(() => buildMcpOperationInvocation("kimi_review", input), "MCP_INVALID_ARGUMENTS");
    }
    expectRuntimeError(
      () => buildMcpOperationInvocation("kimi_ask", { prompt: "x", fresh: 1 }),
      "MCP_INVALID_ARGUMENTS",
      "fresh must be a boolean",
    );
    for (const [name, key] of [["kimi_pursue", "turns"], ["kimi_swarm", "cap"], ["kimi_swarm", "max_concurrency"]] as const) {
      for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2"]) {
        expectRuntimeError(
          () => buildMcpOperationInvocation(name, { objective: "x", [key]: value }),
          "MCP_INVALID_ARGUMENTS",
          `${key} must be a positive safe integer`,
        );
      }
    }
  });
});

describe("MCP review mode and read scope", () => {
  test("kimi_review defaults to a defect review and selects challenge only by mode", () => {
    expect(buildMcpOperationInvocation("kimi_review", {})).toEqual({ operationKind: "review", argv: ["review"] });
    expect(buildMcpOperationInvocation("kimi_review", { mode: "defects" })).toEqual({ operationKind: "review", argv: ["review"] });
    expect(buildMcpOperationInvocation("kimi_review", { mode: "challenge" })).toEqual({ operationKind: "challenge", argv: ["task", "challenge"] });
    for (const mode of ["Challenge", "adversarial", "", 1, true]) {
      expectRuntimeError(() => buildMcpOperationInvocation("kimi_review", { mode }), "MCP_INVALID_ARGUMENTS");
    }
    expectRuntimeError(
      () => buildMcpOperationInvocation("kimi_ask", { prompt: "x", mode: "challenge" }),
      "MCP_INVALID_ARGUMENTS",
      "Unknown argument mode",
    );
  });

  test("read_roots and network map to repeated --read-root and --network before the text terminator", () => {
    const scope = { read_roots: ["/opt/docs", "/srv/a dir"], network: true };
    const flags = ["--read-root", "/opt/docs", "--read-root", "/srv/a dir", "--network"];
    expect(buildMcpOperationInvocation("kimi_ask", { ...scope, prompt: "q" }).argv).toEqual(["ask", ...flags, "--", "q"]);
    expect(buildMcpOperationInvocation("kimi_review", { ...scope, focus: "f" }).argv).toEqual(["review", ...flags, "--", "f"]);
    expect(buildMcpOperationInvocation("kimi_review", { ...scope, mode: "challenge" }).argv).toEqual(["task", "challenge", ...flags]);
    expect(buildMcpOperationInvocation("kimi_swarm", { ...scope, objective: "o" }).argv).toEqual(["task", "swarm", ...flags, "--", "o"]);
    expect(buildMcpOperationInvocation("kimi_ask", { prompt: "q", network: false, read_roots: [] }).argv).toEqual(["ask", "--", "q"]);
  });

  test("write-capable tools do not accept read_roots or network", () => {
    for (const [name, input] of [
      ["kimi_rescue", { prompt: "fix" }],
      ["kimi_pursue", { objective: "goal" }],
      ["kimi_swarm_write", { objective: "edit" }],
    ] as const) {
      for (const [key, value] of [["read_roots", ["/opt"]], ["network", true]] as const) {
        expectRuntimeError(
          () => buildMcpOperationInvocation(name, { ...input, [key]: value }),
          "MCP_INVALID_ARGUMENTS",
          `Unknown argument ${key}`,
        );
      }
    }
  });

  test("scope parameters are type-checked only; path rules stay with the runtime", () => {
    for (const read_roots of ["/opt", [1], [null], {}]) {
      expectRuntimeError(() => buildMcpOperationInvocation("kimi_ask", { prompt: "q", read_roots }), "MCP_INVALID_ARGUMENTS", "read_roots");
    }
    expectRuntimeError(() => buildMcpOperationInvocation("kimi_ask", { prompt: "q", network: "yes" }), "MCP_INVALID_ARGUMENTS", "network must be a boolean");
    expect(buildMcpOperationInvocation("kimi_ask", { prompt: "q", read_roots: ["relative"] }).argv)
      .toEqual(["ask", "--read-root", "relative", "--", "q"]);
  });

  test("tool definitions expose scope only on read-only tools and keep static annotations", () => {
    const byName = new Map(MCP_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
    expect(byName.has("kimi_challenge" as never)).toBe(false);
    for (const name of ["kimi_ask", "kimi_review", "kimi_swarm"] as const) {
      const properties = byName.get(name)!.inputSchema.properties as Record<string, unknown>;
      expect(Object.keys(properties)).toEqual(expect.arrayContaining(["read_roots", "network"]));
      expect(byName.get(name)!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
    }
    for (const name of ["kimi_rescue", "kimi_pursue", "kimi_swarm_write"] as const) {
      const properties = byName.get(name)!.inputSchema.properties as Record<string, unknown>;
      expect(Object.keys(properties)).not.toContain("read_roots");
      expect(Object.keys(properties)).not.toContain("network");
    }
    expect((byName.get("kimi_review")!.inputSchema.properties as any).mode.enum).toEqual(["defects", "challenge"]);
  });
});

describe("MCP job-control arguments", () => {
  test("reads job IDs and optional workspaces verbatim", () => {
    expect(readJobControlArguments({ job_id: "job-123" })).toEqual({ jobId: "job-123" });
    expect(readJobControlArguments({ job_id: " job-123 ", workspace: "/tmp/a workspace" })).toEqual({
      jobId: " job-123 ",
      workspace: "/tmp/a workspace",
    });
  });

  test("requires a non-empty job ID and rejects unknown or wrongly typed fields", () => {
    for (const input of [{}, { job_id: "" }, { job_id: " \t " }, { job_id: 3 }, null, []]) {
      expectRuntimeError(() => readJobControlArguments(input), "MCP_INVALID_ARGUMENTS");
    }
    expectRuntimeError(
      () => readJobControlArguments({ job_id: "job-123", taskId: "job-123" }),
      "MCP_INVALID_ARGUMENTS",
      "Unknown argument taskId",
    );
    expectRuntimeError(
      () => readJobControlArguments({ job_id: "job-123", workspace: false }),
      "MCP_INVALID_ARGUMENTS",
      "workspace must be a string",
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
