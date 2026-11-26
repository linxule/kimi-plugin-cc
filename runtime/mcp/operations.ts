import { RuntimeError } from "../errors.js";
import type { KimiOperationKind } from "../kimi-engine.js";
import { kimiVersionsWith } from "../kimi-releases.js";
import { MAX_SESSION_REFERENCES, parseDurationMs, SESSION_REFERENCE_ID_MAX, validateThinkingEffort } from "../parsing.js";
import type { JobStatus } from "../types.js";

export type McpModelOperation = KimiOperationKind;
export type McpModelToolName = "kimi_read" | "kimi_write";
export type McpJobToolName = "kimi_job";
export type McpSetupToolName = "kimi_setup";
export type McpToolName = McpModelToolName | McpJobToolName | McpSetupToolName;

export type McpReadMode = "ask" | "review" | "challenge" | "swarm";
export type McpWriteMode = "rescue" | "pursue" | "swarm_patch";
export type McpJobAction = "list" | "status" | "result" | "wait" | "cancel" | "replay" | "recover_swarm";
export type McpSetupAction = "check" | "models" | "install" | "install_kimi" | "repair_sessions";

export interface McpToolDefinition {
  name: McpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

export interface McpOperationInvocation {
  operationKind: McpModelOperation;
  workspace?: string;
  wait: boolean;
  waitTimeoutMs?: number;
  argv: string[];
}

export interface McpJobControlArgs {
  action: McpJobAction;
  workspace?: string;
  jobId?: string;
  statusFilter?: JobStatus;
  limit?: number;
  waitMs?: number;
  apply?: boolean;
}

export interface McpSetupArgs {
  action: McpSetupAction;
  workspace?: string;
  apply?: boolean;
  all?: boolean;
}

const DEFAULT_WAIT_TIMEOUT_MIN_MS = 1_000;
const MAX_WAIT_TIMEOUT_MS = 86_400_000;

const WORKSPACE_PROPERTY = {
  type: "string",
  description: "Absolute workspace directory. Required when the host does not configure a default.",
} as const;
const MODEL_PROPERTY = {
  type: "string",
  description: "Configured Kimi model alias. Omit to use the default model; never guess an alias.",
} as const;
const THINKING_PROPERTY = {
  type: "string",
  description: "Per-run thinking-effort request (off, low, medium, high). Not observable on the wire.",
} as const;
const BUDGET_PROPERTY = {
  type: "string",
  description: "Finite duration such as 30m, 1h, or 90s; bare numbers mean minutes. Maximum 24h.",
} as const;
const WAIT_PROPERTIES = {
  wait: {
    type: "boolean",
    description: "Wait for completion and return the result directly (default true on standard calls; set false to get job_id immediately for parallel fan-out).",
  },
  wait_timeout_ms: {
    type: "integer",
    minimum: DEFAULT_WAIT_TIMEOUT_MIN_MS,
    maximum: MAX_WAIT_TIMEOUT_MS,
    description: "Maximum milliseconds this call waits before returning a running handle (job keeps running in background; poll with kimi_job).",
  },
} as const;
const REFERENCE_PROPERTIES = {
  referenced_sessions: {
    type: "array",
    items: { type: "string" },
    description: "Up to 8 earlier job IDs or Kimi session IDs whose main logs Kimi may consult.",
  },
} as const;

const COMMON_PROPERTIES = {
  workspace: WORKSPACE_PROPERTY,
  model: MODEL_PROPERTY,
  thinking: THINKING_PROPERTY,
  budget: BUDGET_PROPERTY,
  ...WAIT_PROPERTIES,
} as const;

const READ_SCHEMA = schema({
  mode: {
    type: "string",
    enum: ["ask", "review", "challenge", "swarm"],
    description: "ask (default): explain/investigate; review: defect review of diff; challenge: adversarial design critique; swarm: read-only parallel fan-out.",
  },
  prompt: {
    type: "string",
    description: "User question, review focus, or swarm objective, preserved verbatim. Required for ask (unless resume is set) and swarm.",
  },
  ...COMMON_PROPERTIES,
  base: {
    type: "string",
    description: "Git base ref for review/challenge (committed branch diff; incompatible with uncommitted=true).",
  },
  uncommitted: {
    type: "boolean",
    description: "Review uncommitted/untracked working-tree changes (default for review/challenge; incompatible with base).",
  },
  resume: {
    type: "string",
    description: "Resume session for ask: \"last\" (latest repo session, may pair with prompt) or a job/session ID (no prompt).",
  },
  read_roots: {
    type: "array",
    items: { type: "string" },
    description: "Additional absolute directories Kimi may read outside workspace.",
  },
  network: {
    type: "boolean",
    description: "Enable web search and URL fetch (file reads remain confined to workspace + read_roots). Default false.",
  },
  cap: {
    type: "integer",
    minimum: 1,
    maximum: 25,
    description: "Soft hint for total swarm subagent count.",
  },
  max_concurrency: {
    type: "integer",
    minimum: 1,
    maximum: 16,
    description: `Maximum simultaneous swarm workers on Kimi Code ${kimiVersionsWith("bounded-swarm").join("/")}+ (1 runs directly).`,
  },
  ...REFERENCE_PROPERTIES,
});

const WRITE_SCHEMA = schema({
  mode: {
    type: "string",
    enum: ["rescue", "pursue", "swarm_patch"],
    description: "rescue (default): bounded workspace edit/fix; pursue: autonomous multi-turn goal; swarm_patch: parallel edits in isolated worktree returning a git patch without modifying the real tree.",
  },
  prompt: {
    type: "string",
    description: "Task objective or edit instruction, preserved verbatim. Never mutates Git.",
  },
  ...COMMON_PROPERTIES,
  resume: {
    type: "string",
    description: "Resume session for rescue: \"last\" or a job/session ID.",
  },
  cap: {
    type: "integer",
    minimum: 1,
    maximum: 25,
    description: "Soft hint for total swarm_patch subagent count.",
  },
  max_concurrency: {
    type: "integer",
    minimum: 1,
    maximum: 16,
    description: "Maximum simultaneous swarm_patch workers (default 1 runs directly).",
  },
  ...REFERENCE_PROPERTIES,
});

const JOB_SCHEMA = schema(
  {
    action: {
      type: "string",
      enum: ["list", "status", "result", "wait", "cancel", "replay", "recover_swarm"],
      description: "Job lifecycle action to run in this workspace.",
    },
    job_id: {
      type: "string",
      description: "Job UUID. Required for replay and recover_swarm; optional for status/result/wait/cancel (defaults to latest repo job).",
    },
    workspace: WORKSPACE_PROPERTY,
    status_filter: {
      type: "string",
      enum: ["running", "completed", "failed", "cancelled"],
      description: "Filter jobs returned by action=list.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description: "Maximum jobs to return for action=list (default 20).",
    },
    wait_ms: {
      type: "integer",
      minimum: 100,
      maximum: 600_000,
      description: "Poll duration in ms for action=wait (default 30000).",
    },
    apply: {
      type: "boolean",
      description: "Apply cleanup and patch capture during recover_swarm (default false previews only).",
    },
  },
  ["action"],
);

const SETUP_SCHEMA = schema({
  action: {
    type: "string",
    enum: ["check", "models", "install", "install_kimi", "repair_sessions"],
    description: "check (default): verify PreToolUse hook & binary; models: list configured model aliases; install: write/repair hook; install_kimi: install newest certified CLI; repair_sessions: preview/repair Kimi session titles.",
  },
  workspace: WORKSPACE_PROPERTY,
  apply: {
    type: "boolean",
    description: "Write repaired session previews during repair_sessions (default false previews only).",
  },
  all: {
    type: "boolean",
    description: "Scope repair_sessions across all repositories.",
  },
});

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

export const MCP_TOOL_DEFINITIONS: readonly McpToolDefinition[] = [
  {
    name: "kimi_read",
    description:
      "Run a read-only Kimi operation (ask, review, challenge, or parallel read-only swarm). Waits for prose by default on standard tool calls; set wait=false to return job_id immediately.",
    inputSchema: READ_SCHEMA,
    annotations: {
      title: "kimi read",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "kimi_write",
    description:
      "Run a workspace-confined write operation: rescue (single-turn edit/test), pursue (autonomous multi-turn goal), or swarm_patch (isolated worktree producing a git patch without modifying the working tree).",
    inputSchema: WRITE_SCHEMA,
    annotations: {
      title: "kimi write",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "kimi_job",
    description: "Inspect, await, cancel, replay, or recover Kimi jobs in the workspace.",
    inputSchema: JOB_SCHEMA,
    annotations: {
      title: "kimi job",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "kimi_setup",
    description: "Verify or install the Kimi PreToolUse safety hook, list configured models, install a certified Kimi CLI binary, or repair session titles.",
    inputSchema: SETUP_SCHEMA,
    annotations: {
      title: "kimi setup",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
];

export function isMcpModelToolName(name: string): name is McpModelToolName {
  return name === "kimi_read" || name === "kimi_write";
}

export function buildMcpOperationInvocation(name: McpModelToolName, input: unknown): McpOperationInvocation {
  const allowedKeys = Object.keys((name === "kimi_read" ? READ_SCHEMA : WRITE_SCHEMA).properties as Record<string, unknown>);
  const args = readArguments(input, allowedKeys);
  const workspace = optionalString(args, "workspace");
  const wait = optionalBoolean(args, "wait") ?? true;
  const waitTimeoutMs = optionalBoundedInteger(args, "wait_timeout_ms", DEFAULT_WAIT_TIMEOUT_MIN_MS, MAX_WAIT_TIMEOUT_MS);

  if (name === "kimi_read") {
    const mode = readMode(args);
    const kind: McpModelOperation = mode;
    const argv = mode === "ask" ? ["ask"] : mode === "review" ? ["review"] : ["task", mode];
    appendCommonOptions(argv, args, mode === "swarm" ? "safety" : "response");
    appendScopeOptions(argv, args);
    appendReferenceOptions(argv, args);

    const base = args.base === undefined ? undefined : requiredNonEmptyString(args, "base");
    const uncommitted = optionalBoolean(args, "uncommitted");
    const resume = args.resume === undefined ? undefined : requiredNonEmptyString(args, "resume");
    const cap = optionalBoundedInteger(args, "cap", 1, 25);
    const maxConcurrency = optionalBoundedInteger(args, "max_concurrency", 1, 16);
    const prompt = optionalString(args, "prompt");

    if (mode !== "review" && mode !== "challenge" && (base !== undefined || uncommitted !== undefined)) {
      throw invalidArguments(`base and uncommitted are only valid for mode "review" or "challenge" (got ${mode}).`);
    }
    if (base !== undefined && uncommitted === true) {
      throw invalidArguments("base and uncommitted=true are mutually exclusive.");
    }
    if ((mode === "review" || mode === "challenge") && uncommitted === false && base === undefined) {
      throw invalidArguments('uncommitted=false requires a base ref for mode "review" or "challenge".');
    }
    if (mode !== "ask" && resume !== undefined) {
      throw invalidArguments(`resume is only valid for mode "ask" (got ${mode}).`);
    }
    if (mode !== "swarm" && (cap !== undefined || maxConcurrency !== undefined)) {
      throw invalidArguments(`cap and max_concurrency are only valid for mode "swarm" (got ${mode}).`);
    }

    switch (mode) {
      case "ask": {
        const cleanPrompt = prompt === undefined ? undefined : requiredNonEmptyString(args, "prompt");
        if (resume === "last") {
          argv.push("-r");
          if (cleanPrompt !== undefined) argv.push("--", cleanPrompt);
        } else if (resume !== undefined) {
          if (cleanPrompt !== undefined) {
            throw invalidArguments('resume with a job/session ID uses the continuation prompt and cannot include prompt; use resume="last" to pair with a new prompt.');
          }
          argv.push("--resume", resume);
        } else {
          argv.push("--", requiredNonEmptyString(args, "prompt"));
        }
        break;
      }
      case "review":
      case "challenge": {
        if (base !== undefined) argv.push("--base", base);
        if (prompt !== undefined && prompt.trim().length > 0) argv.push("--", prompt);
        break;
      }
      case "swarm": {
        if (cap !== undefined) argv.push("--cap", String(cap));
        if (maxConcurrency !== undefined) argv.push("--max-concurrency", String(maxConcurrency));
        argv.push("--", requiredNonEmptyString(args, "prompt"));
        break;
      }
    }

    return {
      operationKind: kind,
      ...(workspace !== undefined ? { workspace } : {}),
      wait,
      ...(waitTimeoutMs !== undefined ? { waitTimeoutMs } : {}),
      argv,
    };
  }

  // kimi_write
  const mode = writeMode(args);
  const kind: McpModelOperation = mode === "swarm_patch" ? "swarm-write" : mode;
  const argv = mode === "swarm_patch" ? ["task", "swarm"] : ["task", mode];
  appendCommonOptions(argv, args, mode === "rescue" ? "response" : "safety");

  const resume = args.resume === undefined ? undefined : requiredNonEmptyString(args, "resume");
  const cap = optionalBoundedInteger(args, "cap", 1, 25);
  const maxConcurrency = optionalBoundedInteger(args, "max_concurrency", 1, 16);
  const prompt = optionalString(args, "prompt");

  if (mode === "pursue" && args.referenced_sessions !== undefined) {
    throw invalidArguments('referenced_sessions is not supported for mode "pursue".');
  }
  appendReferenceOptions(argv, args);
  if (mode !== "rescue" && resume !== undefined) {
    throw invalidArguments(`resume is only valid for mode "rescue" (got ${mode}).`);
  }
  if (mode !== "swarm_patch" && (cap !== undefined || maxConcurrency !== undefined)) {
    throw invalidArguments(`cap and max_concurrency are only valid for mode "swarm_patch" (got ${mode}).`);
  }

  if (mode === "rescue") {
    const cleanPrompt = prompt === undefined ? undefined : requiredNonEmptyString(args, "prompt");
    if (resume === "last") {
      argv.push("-r");
      if (cleanPrompt !== undefined) argv.push("--", cleanPrompt);
    } else if (resume !== undefined) {
      if (cleanPrompt !== undefined) {
        throw invalidArguments('resume with a job/session ID cannot include prompt; use resume="last" to pair with a new prompt.');
      }
      argv.push("--resume", resume);
    } else {
      argv.push("--fresh", "--", requiredNonEmptyString(args, "prompt"));
    }
  } else if (mode === "pursue") {
    argv.push("--", requiredNonEmptyString(args, "prompt"));
  } else {
    if (cap !== undefined) argv.push("--cap", String(cap));
    if (maxConcurrency !== undefined) argv.push("--max-concurrency", String(maxConcurrency));
    argv.push("--write", "--", requiredNonEmptyString(args, "prompt"));
  }

  return {
    operationKind: kind,
    ...(workspace !== undefined ? { workspace } : {}),
    wait,
    ...(waitTimeoutMs !== undefined ? { waitTimeoutMs } : {}),
    argv,
  };
}

export function readJobControlArguments(input: unknown): McpJobControlArgs {
  const args = readArguments(input, Object.keys(JOB_SCHEMA.properties as Record<string, unknown>));
  const action = requiredEnum<McpJobAction>(
    args,
    "action",
    ["list", "status", "result", "wait", "cancel", "replay", "recover_swarm"],
  );
  const workspace = optionalString(args, "workspace");
  const jobId = args.job_id === undefined ? undefined : requiredNonEmptyString(args, "job_id");
  const statusFilter = args.status_filter === undefined
    ? undefined
    : requiredEnum<JobStatus>(args, "status_filter", ["running", "completed", "failed", "cancelled"]);
  const limit = optionalBoundedInteger(args, "limit", 1, 100);
  const waitMs = optionalBoundedInteger(args, "wait_ms", 100, 600_000);
  const apply = optionalBoolean(args, "apply");

  if (action !== "list" && (statusFilter !== undefined || limit !== undefined)) {
    throw invalidArguments('status_filter and limit are only valid for action "list".');
  }
  if (action !== "wait" && waitMs !== undefined) {
    throw invalidArguments('wait_ms is only valid for action "wait".');
  }
  if (action !== "recover_swarm" && apply !== undefined) {
    throw invalidArguments('apply is only valid for action "recover_swarm".');
  }
  if ((action === "replay" || action === "recover_swarm") && jobId === undefined) {
    throw invalidArguments(`job_id is required for action "${action}".`);
  }

  return {
    action,
    ...(workspace !== undefined ? { workspace } : {}),
    ...(jobId !== undefined ? { jobId } : {}),
    ...(statusFilter !== undefined ? { statusFilter } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(waitMs !== undefined ? { waitMs } : {}),
    ...(apply !== undefined ? { apply } : {}),
  };
}

export function readSetupArguments(input: unknown): McpSetupArgs {
  const args = readArguments(input, Object.keys(SETUP_SCHEMA.properties as Record<string, unknown>));
  const actionRaw = optionalString(args, "action") ?? "check";
  const validActions: readonly McpSetupAction[] = ["check", "models", "install", "install_kimi", "repair_sessions"];
  if (!validActions.includes(actionRaw as McpSetupAction)) {
    throw invalidArguments(`action must be one of ${validActions.join(", ")}.`);
  }
  const action = actionRaw as McpSetupAction;
  const workspace = optionalString(args, "workspace");
  const apply = optionalBoolean(args, "apply");
  const all = optionalBoolean(args, "all");
  if (action !== "repair_sessions" && (apply !== undefined || all !== undefined)) {
    throw invalidArguments('apply and all are only valid for action "repair_sessions".');
  }
  return {
    action,
    ...(workspace !== undefined ? { workspace } : {}),
    ...(apply !== undefined ? { apply } : {}),
    ...(all !== undefined ? { all } : {}),
  };
}

function readMode(args: Record<string, unknown>): McpReadMode {
  const raw = optionalString(args, "mode") ?? "ask";
  if (raw !== "ask" && raw !== "review" && raw !== "challenge" && raw !== "swarm") {
    throw invalidArguments('kimi_read mode must be one of "ask", "review", "challenge", "swarm".');
  }
  return raw;
}

function writeMode(args: Record<string, unknown>): McpWriteMode {
  const raw = optionalString(args, "mode") ?? "rescue";
  if (raw !== "rescue" && raw !== "pursue" && raw !== "swarm_patch") {
    throw invalidArguments('kimi_write mode must be one of "rescue", "pursue", "swarm_patch".');
  }
  return raw;
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

/** Type checks only: the companion parser and read-scope resolver own every scope rule. */
function appendScopeOptions(argv: string[], args: Record<string, unknown>): void {
  const readRoots = args.read_roots;
  if (readRoots !== undefined) {
    if (!Array.isArray(readRoots) || readRoots.some((root) => typeof root !== "string")) {
      throw invalidArguments("read_roots must be an array of strings.");
    }
    for (const root of readRoots) argv.push("--read-root", root);
  }
  if (optionalBoolean(args, "network") === true) argv.push("--network");
}

function appendReferenceOptions(argv: string[], args: Record<string, unknown>): void {
  const references = args.referenced_sessions;
  if (references === undefined) return;
  if (!Array.isArray(references) || references.some((reference) => typeof reference !== "string")) {
    throw invalidArguments("referenced_sessions must be an array of strings.");
  }
  const unique = [...new Set(references as string[])];
  if (unique.length > MAX_SESSION_REFERENCES) {
    throw invalidArguments(`referenced_sessions accepts at most ${MAX_SESSION_REFERENCES} distinct sessions; got ${unique.length}.`);
  }
  if (unique.some((reference) => reference.length > SESSION_REFERENCE_ID_MAX)) {
    throw invalidArguments(`referenced_sessions ids are at most ${SESSION_REFERENCE_ID_MAX} characters.`);
  }
  for (const reference of unique) argv.push("--reference-session", reference);
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

function requiredEnum<T extends string>(args: Record<string, unknown>, key: string, values: readonly T[]): T {
  const value = args[key];
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw invalidArguments(`${key} must be one of ${values.join(", ")}.`);
  }
  return value as T;
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

function optionalBoundedInteger(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw invalidArguments(`${key} must be an integer between ${min} and ${max}.`);
  }
  return value as number;
}

function invalidArguments(message: string): RuntimeError {
  return new RuntimeError("MCP_INVALID_ARGUMENTS", message, "mcp.args");
}
