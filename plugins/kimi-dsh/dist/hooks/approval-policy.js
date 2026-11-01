// Pure decision logic for the kimi-code PreToolUse hook. The entry script owns
// stdin/stdout/exit semantics so callers can test this policy without mocking
// process IO.
//
// `kimi -p` hard-codes `permission: 'auto'`, and PreToolUse fires before
// permission rules, so this hook is load-bearing for read-only commands.
// Unknown command labels fail closed to READ_ONLY_TOOLS. An absent
// KIMI_PLUGIN_CC_CMD means out-of-plugin use and remains unrestricted.
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
export const READ_ONLY_TOOLS = new Set([
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
const PLAN_MODE_TOOLS = new Set(["EnterPlanMode", "ExitPlanMode"]);
/**
 * Recognized command labels. Sole source of truth; keep in sync with
 * the strings emitted by `runCliPrompt` callers in
 * `runtime/commands/*.ts`.
 */
const KNOWN_LABELS = new Set([
    "ask",
    "review",
    "challenge",
    "review_gate",
    "rescue",
    "swarm",
    "swarm-write",
]);
export async function decideHookOutcome(input, ctx) {
    const result = decideHookOutcomePure(input, ctx);
    if (!("evaluator" in result))
        return result;
    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    if (ctx.rescueEvaluator !== undefined) {
        return await ctx.rescueEvaluator(result.workspaceRoot, toolName, input.tool_input);
    }
    if (READ_ONLY_TOOLS.has(toolName))
        return { decision: "allow" };
    return {
        decision: "deny",
        reason: `kimi-plugin-cc safety hook: ${ctx.commandLabel} evaluator not configured; tool "${toolName}" denied as a safety default.`,
    };
}
export function decideHookOutcomePure(input, ctx) {
    const label = typeof ctx.commandLabel === "string" ? ctx.commandLabel : undefined;
    // Out-of-plugin context: any kimi process spawned without our env var
    // is direct user usage. The hook MUST NOT restrict it.
    if (label === undefined || label.length === 0) {
        return { decision: "allow" };
    }
    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    if (PLAN_MODE_TOOLS.has(toolName)) {
        return {
            decision: "deny",
            reason: `kimi-plugin-cc safety hook: tool "${toolName}" is denied for plugin-managed sessions because agent-core-v2 plan-file writes can bypass later external hooks; native plan mode is never armed in plugin-managed sessions.`,
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
        const validArgs = objectArgs && ((toolName === "GetGoal" && keys.length === 0) ||
            (toolName === "UpdateGoal" && keys.length === 1 && keys[0] === "status" &&
                (args.status === "complete" || args.status === "blocked")));
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
            // configuration and can execute configured helpers. Nested AgentSwarm
            // calls remain allowed, with their cost bounded by the command budget.
            if (READ_ONLY_TOOLS.has(toolName) || toolName === AGENT_SWARM_TOOL) {
                return { decision: "allow" };
            }
            return {
                decision: "deny",
                reason: denySwarmMessage(toolName),
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
            const workspaceRoot = typeof ctx.trustedWorkspaceRoot === "string" ? ctx.trustedWorkspaceRoot : "";
            if (workspaceRoot.length === 0) {
                return {
                    decision: "deny",
                    reason: `kimi-plugin-cc safety hook: swarm-write received no trusted workspace root; tool "${toolName}" denied. ` +
                        "This is a plugin misconfiguration — writes are refused rather than risk the user's working tree.",
                };
            }
            return { evaluator: "rescue", workspaceRoot };
        }
        case "rescue": {
            const workspaceRoot = typeof ctx.trustedWorkspaceRoot === "string" ? ctx.trustedWorkspaceRoot : "";
            if (workspaceRoot.length === 0) {
                if (READ_ONLY_TOOLS.has(toolName))
                    return { decision: "allow" };
                return {
                    decision: "deny",
                    reason: `kimi-plugin-cc safety hook: rescue received no trusted workspace root; tool "${toolName}" denied. ` +
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
                reason: `kimi-plugin-cc safety hook: unrecognized command label "${label}"; tool "${toolName}" denied as a safety default.`,
            };
    }
}
function denyReadOnlyMessage(label, toolName) {
    const tool = toolName.length > 0 ? toolName : "<unspecified>";
    return [
        `kimi-plugin-cc safety hook: ${label} is read-only.`,
        `Tool "${tool}" is denied — use Read, Grep, or Glob to inspect the workspace instead.`,
        "If you need to mutate state, the user must invoke /kimi:rescue (write-capable) rather than this command.",
    ].join(" ");
}
function denySwarmMessage(toolName) {
    const tool = toolName.length > 0 ? toolName : "<unspecified>";
    return [
        "kimi-plugin-cc safety hook: swarm is a read-only parallel review.",
        `Tool "${tool}" is denied — every subagent may use Read, Grep, or Glob to inspect the workspace,`,
        "and the coordinator may use AgentSwarm to fan out, but no write, edit, or shell operations are permitted.",
        "Consolidate the subagents' findings into a markdown report instead.",
    ].join(" ");
}
