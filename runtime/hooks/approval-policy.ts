import { BOUNDED_SWARM_POLICY, evaluateSwarmWaveInput } from "../swarm-policy.js";

// Pure decision logic for the kimi-code PreToolUse hook. The entry script owns
// stdin/stdout/exit semantics so callers can test this policy without mocking
// process IO.
//
// `kimi -p` hard-codes `permission: 'auto'`, and PreToolUse fires before
// permission rules, so this hook is load-bearing for read-only commands.
// Unknown command labels fail closed to READ_ONLY_TOOLS. An absent
// KIMI_PLUGIN_CC_CMD means out-of-plugin use and remains unrestricted.

export interface HookInput {
  hook_event_name?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_call_id?: unknown;
}

export interface HookDecision {
  decision: "allow" | "deny";
  /** Required when `decision === "deny"`; surfaced to kimi-code on stderr. */
  reason?: string;
}

/**
 * Tools considered read-only across review/challenge/review_gate/rescue.
 *
 * Includes kimi-code's own local-read defaults (`Read`, `Grep`, `Glob`)
 * plus a few additional read-safe tools the runtime auto-allows
 * (`ReadMediaFile`, `TaskList`, `TaskOutput`). Excludes network
 * operations (`WebSearch`, `FetchURL`) since review-style commands
 * should stay on the local repo — adding them would silently broaden
 * the safety contract for what is documented as a local-only review.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Grep",
  "Glob",
  "ReadMediaFile",
  "TaskList",
  "TaskOutput",
]);

/**
 * Exact tool name for kimi-code's parallel fan-out. Every spawned subagent
 * inherits KIMI_PLUGIN_CC_CMD. On native v2, each agent has its own eager
 * external-hooks service, so this same hook denies subagent writes. Legacy v1
 * separately relies on PreToolCallHookPermissionPolicy at policy index 0 for
 * every agent. The singular `Agent` tool remains denied: only the AgentSwarm
 * fan-out surface is allowlisted.
 */
const AGENT_SWARM_TOOL = "AgentSwarm";
/**
 * agent-core-v2's ONLY chain-breaking final allow is the plan-file guard, and
 * it fires only while plan mode is ACTIVE. Native v2 is therefore certified on
 * the invariant that plan mode is never armed in a plugin-managed session:
 * `default_plan_mode` is refused pre-spawn (runtime/native-v2-preflight.ts),
 * plan-tainted sessions are never resumed, and the model-reachable entry tool
 * is denied HERE for every label. ExitPlanMode is denied too so the deny set
 * is explicit rather than a side effect of the read-only allowlists.
 */
const PLAN_MODE_TOOLS: ReadonlySet<string> = new Set(["EnterPlanMode", "ExitPlanMode"]);

/**
 * Rescue evaluator supplied by the entry script. Async because the allowlist
 * performs `lstat`/`realpath` to detect symlink escapes and resolve paths
 * against the trusted workspace root.
 */
export type RescueEvaluator = (
  workspaceRoot: string,
  toolName: string,
  toolInput: unknown,
) => Promise<HookDecision>;

export interface PolicyContext {
  /**
   * Value of the KIMI_PLUGIN_CC_CMD env var as set by `cli-client.ts`
   * when spawning kimi. Undefined means kimi was invoked outside the
   * plugin (e.g., the user running `kimi -p` directly) and the hook
   * must NOT impose plugin-specific restrictions.
   */
  commandLabel?: string;
  /** Trusted executionPlan.operationKind, overlaid on every child spawn. */
  operationKind?: string;
  /** Plugin-owned exact-version admission policy; absent only for older paths. */
  swarmPolicy?: string;
  /** Trusted maximum fresh plus resumed entries in one AgentSwarm call. */
  swarmWaveSize?: string;
  /**
   * When `commandLabel === "rescue"` and this is undefined, the policy falls
   * back to allowing only READ_ONLY_TOOLS and denying everything else.
   */
  rescueEvaluator?: RescueEvaluator;
  /**
   * Trusted workspace root for write-capable labels, from the
   * KIMI_PLUGIN_CC_WORKSPACE_ROOT env the plugin exports on the spawn. Rescue
   * and pursue use the job cwd; swarm-write uses its ephemeral worktree. Writes
   * are confined to THIS path via the rescue evaluator, never the hook payload
   * `cwd`, so upstream payload derivation cannot change the trust boundary.
   * Undefined means write tools are denied (fail-closed misconfiguration).
   */
  trustedWorkspaceRoot?: string;
}

/**
 * Recognized command labels. Sole source of truth; keep in sync with
 * the strings emitted by `runCliPrompt` callers in
 * `runtime/commands/*.ts`.
 */
const KNOWN_LABELS = new Set<string>([
  "ask",
  "review",
  "challenge",
  "review_gate",
  "rescue",
  "swarm",
  "swarm-write",
]);

export async function decideHookOutcome(input: HookInput, ctx: PolicyContext): Promise<HookDecision> {
  const result = decideHookOutcomePure(input, ctx);
  if (!("evaluator" in result)) return result;
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";

  if (ctx.rescueEvaluator !== undefined) {
    return await ctx.rescueEvaluator(result.workspaceRoot, toolName, input.tool_input);
  }
  if (READ_ONLY_TOOLS.has(toolName)) return { decision: "allow" };
  return {
    decision: "deny",
    reason: `kimi-plugin-cc safety hook: ${ctx.commandLabel} evaluator not configured; tool "${toolName}" denied as a safety default.`,
  };
}

export function decideHookOutcomePure(
  input: HookInput,
  ctx: PolicyContext,
): HookDecision | { evaluator: "rescue"; workspaceRoot: string } {
  const label = typeof ctx.commandLabel === "string" ? ctx.commandLabel : undefined;
  // Out-of-plugin context: any kimi process spawned without our env var
  // is direct user usage. The hook MUST NOT restrict it.
  if (label === undefined || label.length === 0) {
    return { decision: "allow" };
  }

  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";

  if ((label === "swarm" || label === "swarm-write") &&
    (ctx.swarmPolicy !== undefined || ctx.swarmWaveSize !== undefined)) {
    if (toolName === AGENT_SWARM_TOOL) {
      return evaluateSwarmWaveInput(input.tool_input, ctx.swarmPolicy, ctx.swarmWaveSize);
    }
    if (toolName === "Agent") {
      return {
        decision: "deny",
        reason: "kimi-plugin-cc safety hook: singular Agent delegation is denied for bounded swarm jobs.",
      };
    }
    const args = input.tool_input;
    if (toolName === "Bash" && typeof args === "object" && args !== null &&
      (args as Record<string, unknown>).run_in_background === true) {
      return {
        decision: "deny",
        reason: "kimi-plugin-cc safety hook: run commands in the foreground; explicit background commands are disabled for bounded swarm execution.",
      };
    }
  }

  if (PLAN_MODE_TOOLS.has(toolName)) {
    return {
      decision: "deny",
      reason:
        `kimi-plugin-cc safety hook: tool "${toolName}" is denied for plugin-managed sessions because agent-core-v2 plan-file writes can bypass later external hooks; native plan mode is never armed in plugin-managed sessions.`,
    };
  }

  if (["GetGoal", "UpdateGoal", "CreateGoal", "SetGoalBudget"].includes(toolName)) {
    // Pursue keeps the rescue write boundary, but must be able to inspect and
    // terminally settle its existing goal. Never allow creating/reactivating a
    // goal or changing its budget through this metadata-only exception.
    if (toolName === "SetGoalBudget" && label === "rescue" && ctx.operationKind === "pursue") {
      return {
        decision: "deny",
        reason: `kimi-plugin-cc safety hook: tool "SetGoalBudget" is denied. The outer plugin wall-clock budget already applies; continue the current goal without retrying SetGoalBudget or changing its budget.`,
      };
    }
    const args = input.tool_input;
    const objectArgs = typeof args === "object" && args !== null && !Array.isArray(args) &&
      (Object.getPrototypeOf(args) === Object.prototype || Object.getPrototypeOf(args) === null);
    const keys = objectArgs ? Reflect.ownKeys(args) : [];
    const validArgs = objectArgs && (
      (toolName === "GetGoal" && keys.length === 0) ||
      (toolName === "UpdateGoal" && keys.length === 1 && keys[0] === "status" &&
        ((args as { status?: unknown }).status === "complete" || (args as { status?: unknown }).status === "blocked"))
    );
    if (label === "rescue" && ctx.operationKind === "pursue" &&
      typeof ctx.trustedWorkspaceRoot === "string" && ctx.trustedWorkspaceRoot.trim().length > 0 && validArgs) {
      return { decision: "allow" };
    }
    return {
      decision: "deny",
      reason: `kimi-plugin-cc safety hook: tool "${toolName}" requires a pursue run with a trusted workspace root and exact terminal goal metadata arguments; goal creation, reactivation, and budget changes are denied.`,
    };
  }

  switch (label) {
    case "ask":
    case "review":
    case "challenge":
    case "review_gate":
      // Read-only narrative surfaces share READ_ONLY_TOOLS. They run as
      // non-interactive subprocesses, so interactive tool prompts cannot
      // substitute for this allowlist.
      if (READ_ONLY_TOOLS.has(toolName)) {
        return { decision: "allow" };
      }
      return {
        decision: "deny",
        reason: denyReadOnlyMessage(label, toolName),
      };

    case "swarm":
      // The coordinator may launch AgentSwarm; every subagent inherits this
      // label and is evaluated by the same hook, so only READ_ONLY_TOOLS plus
      // AgentSwarm are allowed and the singular Agent stays denied. This adds
      // no direct tool-write permission within the repository/Git trust
      // boundary: read-only Git context commands still trust repository Git
      // configuration and can execute configured helpers. Exact 2.6.2 waves
      // pass the admission guard above; fresh children cannot activate swarm
      // mode. Older paths retain their inherited scheduler limitations.
      if (READ_ONLY_TOOLS.has(toolName) || toolName === AGENT_SWARM_TOOL) {
        return { decision: "allow" };
      }
      return {
        decision: "deny",
        reason: denySwarmMessage(toolName,
          ctx.swarmPolicy === BOUNDED_SWARM_POLICY && ctx.swarmWaveSize === "1"),
      };

    case "swarm-write": {
      // Write-capable fan-out runs in an ephemeral worktree. AgentSwarm and the
      // read-only set are allowed; the singular Agent is denied. Every other
      // tool goes through the rescue evaluator scoped to the plugin-exported
      // KIMI_PLUGIN_CC_WORKSPACE_ROOT, never the payload cwd, so an in-process
      // subagent cannot move the trust boundary or forge its root. A missing
      // root fails closed for writes.
      if (READ_ONLY_TOOLS.has(toolName) || toolName === AGENT_SWARM_TOOL) {
        return { decision: "allow" };
      }
      const workspaceRoot =
        typeof ctx.trustedWorkspaceRoot === "string" ? ctx.trustedWorkspaceRoot : "";
      if (workspaceRoot.length === 0) {
        return {
          decision: "deny",
          reason:
            `kimi-plugin-cc safety hook: swarm-write received no trusted workspace root; tool "${toolName}" denied. ` +
            "This is a plugin misconfiguration — writes are refused rather than risk the user's working tree.",
        };
      }
      return { evaluator: "rescue", workspaceRoot };
    }

    case "rescue": {
      const workspaceRoot =
        typeof ctx.trustedWorkspaceRoot === "string" ? ctx.trustedWorkspaceRoot : "";
      if (workspaceRoot.length === 0) {
        if (READ_ONLY_TOOLS.has(toolName)) return { decision: "allow" };
        return {
          decision: "deny",
          reason:
            `kimi-plugin-cc safety hook: rescue received no trusted workspace root; tool "${toolName}" denied. ` +
            "This is a plugin misconfiguration — writes are refused rather than trusting hook payload cwd.",
        };
      }
      return { evaluator: "rescue", workspaceRoot };
    }

    default:
      if (KNOWN_LABELS.has(label)) {
        return {
          decision: "deny",
          reason: `kimi-plugin-cc safety hook: command label "${label}" has no policy branch.`,
        };
      }
      // Unknown label: fail closed to READ_ONLY_TOOLS only.
      if (READ_ONLY_TOOLS.has(toolName)) {
        return { decision: "allow" };
      }
      return {
        decision: "deny",
        reason:
          `kimi-plugin-cc safety hook: unrecognized command label "${label}"; tool "${toolName}" denied as a safety default.`,
      };
  }
}

function denyReadOnlyMessage(label: string, toolName: string): string {
  const tool = toolName.length > 0 ? toolName : "<unspecified>";
  return [
    `kimi-plugin-cc safety hook: ${label} is read-only.`,
    `Tool "${tool}" is denied — use Read, Grep, or Glob to inspect the workspace instead.`,
    "If you need to mutate state, the user must invoke /kimi:rescue (write-capable) rather than this command.",
  ].join(" ");
}

function denySwarmMessage(toolName: string, singleWorker: boolean): string {
  const tool = toolName.length > 0 ? toolName : "<unspecified>";
  if (singleWorker) {
    return [
      "kimi-plugin-cc safety hook: swarm with concurrency 1 is a read-only review.",
      `Tool "${tool}" is denied — use Read, Grep, or Glob to inspect the workspace.`,
      "Complete the review yourself; delegation is denied.",
      "Return your findings in a markdown report.",
    ].join(" ");
  }
  return [
    "kimi-plugin-cc safety hook: swarm is a read-only parallel review.",
    `Tool "${tool}" is denied — every subagent may use Read, Grep, or Glob to inspect the workspace,`,
    "and the coordinator may use AgentSwarm to fan out, but no write, edit, or shell operations are permitted.",
    "Consolidate the subagents' findings into a markdown report instead.",
  ].join(" ");
}
