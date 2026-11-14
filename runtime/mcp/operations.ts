import { RuntimeError } from "../errors.js";
import type { KimiOperationKind } from "../kimi-engine.js";
import { parseDurationMs, validateThinkingEffort } from "../parsing.js";

export type McpModelOperation = Exclude<KimiOperationKind, "review_gate">;
export type McpModelToolName =
  | "kimi_ask"
  | "kimi_review"
  | "kimi_challenge"
  | "kimi_rescue"
  | "kimi_pursue"
  | "kimi_swarm"
  | "kimi_swarm_write";
export type McpJobToolName = "kimi_job_status" | "kimi_job_result" | "kimi_job_cancel";
export type McpToolName = McpModelToolName | McpJobToolName;

export interface McpToolDefinition {
  name: McpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

export interface McpOperationInvocation {
  operationKind: McpModelOperation;
  workspace?: string;
  argv: string[];
}

interface OperationSpec {
  kind: McpModelOperation;
  command: string[];
  write: boolean;
  inputSchema: Record<string, unknown>;
  summary: string;
}

const WORKSPACE_PROPERTY = {
  type: "string",
  description: "Absolute workspace directory. Required when the host does not configure a default; Codex normally supplies it explicitly.",
} as const;
const MODEL_PROPERTY = {
  type: "string",
  description: "One configured Kimi model alias. Omit to preserve the normal session default; never guess an alias.",
} as const;
const THINKING_PROPERTY = {
  type: "string",
  description: "Per-run thinking-effort request such as off, low, medium, or high. Provider/model support varies and is not observable by the plugin.",
} as const;
const BUDGET_PROPERTY = {
  type: "string",
  description: "Finite duration such as 30m, 1h, or 90s; bare numbers mean minutes. Maximum 24h. Background operation does not extend it.",
} as const;
const COMMON_PROPERTIES = {
  workspace: WORKSPACE_PROPERTY,
  model: MODEL_PROPERTY,
  thinking: THINKING_PROPERTY,
  budget: BUDGET_PROPERTY,
} as const;
const RESUME_PROPERTIES = {
  fresh: {
    type: "boolean",
    description: "Start a fresh Kimi session. Incompatible with resume and resume_latest.",
  },
  resume: {
    type: "string",
    description: "Resume this job ID or Kimi session ID with the standard continuation instruction. Do not also supply prompt.",
  },
  resume_latest: {
    type: "boolean",
    description: "Resume the latest matching session for this repository. May be combined with a new prompt.",
  },
} as const;
const PROMPT_PROPERTY = {
  type: "string",
  description: "The complete user request, preserved verbatim. Required except when resume or resume_latest supplies the continuation context.",
} as const;
const OBJECTIVE_PROPERTY = {
  type: "string",
  description: "The complete objective, preserved verbatim.",
} as const;
const FOCUS_PROPERTY = {
  type: "string",
  description: "Optional review focus or adversarial framing, preserved verbatim.",
} as const;
const BASE_PROPERTY = {
  type: "string",
  description: "Optional Git base ref. The committed branch diff is authoritative; dirty current files are not treated as committed snapshots.",
} as const;
const TURNS_PROPERTY = {
  type: "integer",
  minimum: 1,
  description: "Soft turn-count hint included in the objective. The finite budget is the hard bound.",
} as const;
const CAP_PROPERTY = {
  type: "integer",
  minimum: 1,
  description: "Soft hint for total subagent count, not a hook-enforced limit.",
} as const;
const MAX_CONCURRENCY_PROPERTY = {
  type: "integer",
  minimum: 1,
  description: "Requested normal-launch subagent concurrency on supported Kimi Code versions. Rate-limit recovery can exceed it on reviewed 2.5.3/2.6.0/2.6.2 sources. Distinct from the soft total cap.",
} as const;
const START_RESULT_GUIDANCE =
  "Task-capable clients receive an MCP task. Other clients receive a job ID immediately after launch; use kimi_job_status and kimi_job_result until terminal, and kimi_job_cancel to stop. Do not present a launch handle as the finished answer.";

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

const OPERATION_SPECS: Readonly<Record<McpModelToolName, OperationSpec>> = {
  kimi_ask: {
    kind: "ask",
    command: ["ask"],
    write: false,
    summary: "Start an independent read-only Kimi repository explanation.",
    inputSchema: schema({ ...COMMON_PROPERTIES, prompt: PROMPT_PROPERTY, ...RESUME_PROPERTIES }),
  },
  kimi_review: {
    kind: "review",
    command: ["review"],
    write: false,
    summary: "Start an independent read-only Kimi review of working-tree changes, including untracked files, or a committed base diff.",
    inputSchema: schema({ ...COMMON_PROPERTIES, base: BASE_PROPERTY, focus: FOCUS_PROPERTY }),
  },
  kimi_challenge: {
    kind: "challenge",
    command: ["task", "challenge"],
    write: false,
    summary: "Start a read-only Kimi challenge of assumptions, design choices, and tradeoffs rather than a defect-only review.",
    inputSchema: schema({ ...COMMON_PROPERTIES, base: BASE_PROPERTY, focus: FOCUS_PROPERTY }),
  },
  kimi_rescue: {
    kind: "rescue",
    command: ["task", "rescue"],
    write: true,
    summary: "Start a bounded write-capable Kimi investigation or fix inside the validated workspace. Review the resulting changes; no commit is made.",
    inputSchema: schema({ ...COMMON_PROPERTIES, prompt: PROMPT_PROPERTY, ...RESUME_PROPERTIES }),
  },
  kimi_pursue: {
    kind: "pursue",
    command: ["task", "pursue"],
    write: true,
    summary: "Start explicitly autonomous Kimi goal mode with a finite hard budget and workspace write limits. Use only for hands-off objectives, not a single bounded fix.",
    inputSchema: schema({ ...COMMON_PROPERTIES, objective: OBJECTIVE_PROPERTY, turns: TURNS_PROPERTY }, ["objective"]),
  },
  kimi_swarm: {
    kind: "swarm",
    command: ["task", "swarm"],
    write: false,
    summary: "Start a read-only parallel Kimi fan-out across many independent review targets.",
    inputSchema: schema(
      { ...COMMON_PROPERTIES, objective: OBJECTIVE_PROPERTY, cap: CAP_PROPERTY, max_concurrency: MAX_CONCURRENCY_PROPERTY },
      ["objective"],
    ),
  },
  kimi_swarm_write: {
    kind: "swarm-write",
    command: ["task", "swarm"],
    write: true,
    summary: "Start parallel Kimi implementation in a disposable worktree off HEAD. The real tree is not edited; the result is a patch to review and apply separately.",
    inputSchema: schema(
      { ...COMMON_PROPERTIES, objective: OBJECTIVE_PROPERTY, cap: CAP_PROPERTY, max_concurrency: MAX_CONCURRENCY_PROPERTY },
      ["objective"],
    ),
  },
};

const JOB_CONTROL_SCHEMA = schema({
  workspace: WORKSPACE_PROPERTY,
  job_id: { type: "string", description: "The UUID returned by an MCP-launched Kimi operation." },
}, ["job_id"]);

export const MCP_TOOL_DEFINITIONS: readonly McpToolDefinition[] = [
  ...Object.entries(OPERATION_SPECS).map(([name, spec]) => ({
    name: name as McpModelToolName,
    description: `${spec.summary} ${START_RESULT_GUIDANCE}`,
    inputSchema: spec.inputSchema,
    annotations: {
      title: name.replaceAll("_", " "),
      readOnlyHint: !spec.write,
      destructiveHint: spec.write,
      idempotentHint: false,
      openWorldHint: true,
    },
  })),
  {
    name: "kimi_job_status",
    description: "Read one MCP-launched job's durable state and phase in the same workspace. This is always an ordinary MCP result, never a task.",
    inputSchema: JOB_CONTROL_SCHEMA,
    annotations: { title: "kimi job status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "kimi_job_result",
    description: "Read the terminal artifact for one MCP-launched job in the same workspace. Failed jobs return isError:true with their artifact; running jobs return JOB_NOT_TERMINAL without changing state.",
    inputSchema: JOB_CONTROL_SCHEMA,
    annotations: { title: "kimi job result", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "kimi_job_cancel",
    description: "Cooperatively cancel one running MCP-launched job in the same workspace. Terminal jobs are a no-op. Cancellation does not roll back edits, and write-swarm still captures its patch before cleanup.",
    inputSchema: JOB_CONTROL_SCHEMA,
    annotations: { title: "kimi job cancel", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

export function isMcpModelToolName(name: string): name is McpModelToolName {
  return Object.hasOwn(OPERATION_SPECS, name);
}

export function buildMcpOperationInvocation(name: McpModelToolName, input: unknown): McpOperationInvocation {
  const spec = OPERATION_SPECS[name];
  const properties = spec.inputSchema.properties as Record<string, unknown>;
  const args = readArguments(input, Object.keys(properties));
  const workspace = optionalString(args, "workspace");
  const argv = [...spec.command];
  appendCommonOptions(argv, args, spec.kind === "pursue" || spec.kind === "swarm" || spec.kind === "swarm-write" ? "safety" : "response");

  switch (spec.kind) {
    case "ask":
    case "rescue": {
      const prompt = args.prompt === undefined ? undefined : requiredNonEmptyString(args, "prompt");
      const fresh = optionalBoolean(args, "fresh") ?? false;
      const resumeLatest = optionalBoolean(args, "resume_latest") ?? false;
      const resume = args.resume === undefined ? undefined : requiredNonEmptyString(args, "resume");
      if (fresh && (resumeLatest || resume !== undefined)) {
        throw invalidArguments("fresh cannot be combined with resume or resume_latest.");
      }
      if (resumeLatest && resume !== undefined) {
        throw invalidArguments("resume and resume_latest are alternatives; choose one.");
      }
      if (resume !== undefined && prompt !== undefined) {
        throw invalidArguments("resume uses the standard continuation instruction and cannot include prompt. Use resume_latest with a new prompt instead.");
      }
      if (prompt === undefined && !resumeLatest && resume === undefined) {
        throw invalidArguments(`${spec.kind} requires prompt unless resume or resume_latest is selected.`);
      }
      if (fresh) argv.push("--fresh");
      if (resumeLatest) argv.push("-r");
      if (resume !== undefined) argv.push("--resume", resume);
      if (prompt !== undefined) argv.push("--", prompt);
      break;
    }
    case "review":
    case "challenge": {
      const base = args.base === undefined ? undefined : requiredNonEmptyString(args, "base");
      const focus = optionalString(args, "focus");
      if (base !== undefined) argv.push("--base", base);
      if (focus !== undefined) argv.push("--", focus);
      break;
    }
    case "pursue": {
      const turns = optionalPositiveInteger(args, "turns");
      if (turns !== undefined) argv.push("--turns", String(turns));
      argv.push("--", requiredNonEmptyString(args, "objective"));
      break;
    }
    case "swarm":
    case "swarm-write": {
      const cap = optionalPositiveInteger(args, "cap");
      const maxConcurrency = optionalPositiveInteger(args, "max_concurrency");
      if (cap !== undefined) argv.push("--cap", String(cap));
      if (maxConcurrency !== undefined) argv.push("--max-concurrency", String(maxConcurrency));
      if (spec.kind === "swarm-write") argv.push("--write");
      argv.push("--", requiredNonEmptyString(args, "objective"));
      break;
    }
  }

  return { operationKind: spec.kind, ...(workspace !== undefined ? { workspace } : {}), argv };
}

export function readJobControlArguments(input: unknown): { workspace?: string; jobId: string } {
  const args = readArguments(input, ["workspace", "job_id"]);
  return {
    ...(optionalString(args, "workspace") !== undefined ? { workspace: optionalString(args, "workspace") } : {}),
    jobId: requiredNonEmptyString(args, "job_id"),
  };
}

function appendCommonOptions(argv: string[], args: Record<string, unknown>, budgetKind: "safety" | "response"): void {
  const budget = optionalString(args, "budget");
  const model = optionalString(args, "model");
  const thinking = optionalString(args, "thinking");
  if (budget !== undefined) {
    parseDurationMs(budget, "--budget", "mcp.args", budgetKind);
    argv.push("--budget", budget);
  }
  if (model !== undefined) argv.push("-m", requiredNonEmptyString(args, "model"));
  if (thinking !== undefined) {
    validateThinkingEffort(thinking, "mcp.args");
    argv.push("--thinking", thinking);
  }
}

function readArguments(input: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (input === undefined) return {};
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalidArguments("Tool arguments must be a JSON object.");
  }
  const args = input as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw invalidArguments(`Unknown argument ${key}. Allowed arguments: ${allowedKeys.join(", ")}.`);
  }
  return args;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalidArguments(`${key} must be a string.`);
  return value;
}

function requiredNonEmptyString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (value === undefined || value.trim().length === 0) throw invalidArguments(`${key} must be a non-empty string.`);
  return value;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw invalidArguments(`${key} must be a boolean.`);
  return value;
}

function optionalPositiveInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw invalidArguments(`${key} must be a positive safe integer.`);
  return value as number;
}

function invalidArguments(message: string): RuntimeError {
  return new RuntimeError("MCP_INVALID_ARGUMENTS", message, "mcp.args");
}
