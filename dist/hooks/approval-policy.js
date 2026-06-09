// Pure decision logic for the kimi-code PreToolUse hook.
//
// Why this module exists separately from the entry script:
//
//   The hook script (approval-hook.ts) handles stdin / stdout / exit
//   semantics. This module is a pure function — easy to unit-test, easy
//   to import from the entry script and from PR 3's rescue dispatcher
//   without forcing those callers to mock stdin.
//
// Why the hook is load-bearing for safety:
//
//   kimi-code's `kimi -p` mode hard-codes `permission: 'auto'` and
//   registers an auto-approve handler that allows every tool. The
//   PreToolUse hook fires BEFORE permission rules (verified in
//   agent-core/src/agent/turn/index.ts:436-458). For read-only commands
//   (review/challenge/review_gate/ask), the hook is the only mechanism
//   that overrides -p's auto-approve and enforces the safety contract
//   advertised by /kimi:review, /kimi:challenge, etc.
//
// Fail-closed posture:
//
//   Unknown command labels deny anything but Read/Grep/Glob. A
//   KIMI_PLUGIN_CC_CMD env var someone forgot to set is the "out of
//   plugin context" case (treated as allow); a label we don't recognize
//   is the "stale config / misconfigured caller" case (treated as deny
//   by default).
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
 * kimi-code's parallel fan-out tool (PR #424, 0.12.0). Its exact tool_name
 * string is `AgentSwarm` (verified against
 * packages/agent-core/src/tools/builtin/collaboration/agent-swarm.ts:87,
 * `readonly name = 'AgentSwarm' as const`). The `/kimi:swarm` (read-only)
 * label allowlists THIS tool so the parent agent can launch the swarm; every
 * spawned subagent inherits the same KIMI_PLUGIN_CC_CMD label and fires THIS
 * hook at permission policy index 0 (kimi-code
 * createPermissionDecisionPolicies puts PreToolCallHookPermissionPolicy at
 * index 0 for ALL agents — no sub-vs-main branch — so a subagent's write is
 * denied exactly like a single-turn review's). The singular `Agent` tool is
 * deliberately NOT allowlisted: swarm is specifically the fan-out surface.
 */
const AGENT_SWARM_TOOL = "AgentSwarm";
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
]);
export async function decideHookOutcome(input, ctx) {
    const label = typeof ctx.commandLabel === "string" ? ctx.commandLabel : undefined;
    // Out-of-plugin context: any kimi process spawned without our env var
    // is direct user usage. The hook MUST NOT restrict it.
    if (label === undefined || label.length === 0) {
        return { decision: "allow" };
    }
    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    switch (label) {
        case "ask":
        case "review":
        case "challenge":
        case "review_gate":
            // /kimi:ask is documented and dispatched as a read-only narrative
            // surface (see agents/kimi-ask.md: "do not implement anything Kimi
            // describes"). PR 2 initially trusted kimi-code's `permission:auto`
            // for ask on the assumption the user was watching every tool call,
            // but `/kimi:ask` runs as a non-interactive subprocess via
            // companion.sh — the user never sees individual tool prompts. PR 4
            // reviewers flagged this contradiction; ask now shares the
            // read-only allowlist with review/challenge/review_gate.
            if (READ_ONLY_TOOLS.has(toolName)) {
                return { decision: "allow" };
            }
            return {
                decision: "deny",
                reason: denyReadOnlyMessage(label, toolName),
            };
        case "swarm":
            // /kimi:swarm — read-only PARALLEL fan-out. The parent agent must be
            // allowed to call AgentSwarm (else the swarm never launches and the
            // hook silently breaks the feature). Every spawned subagent inherits
            // THIS "swarm" label and fires THIS hook at policy index 0, so a
            // subagent's Write/Edit/Bash is denied exactly like a single-turn
            // review's — read-only swarm opens ZERO new write surface. Allow only
            // the read-only set plus AgentSwarm; deny everything else (including the
            // singular `Agent` tool — swarm is the fan-out surface, not arbitrary
            // delegation). Nested AgentSwarm calls from a subagent are allowed and
            // bounded by the command's wall-clock budget (the only new risk is
            // cost, not writes).
            if (READ_ONLY_TOOLS.has(toolName) || toolName === AGENT_SWARM_TOOL) {
                return { decision: "allow" };
            }
            return {
                decision: "deny",
                reason: denySwarmMessage(toolName),
            };
        case "rescue":
            if (ctx.rescueEvaluator !== undefined) {
                const workspaceRoot = typeof input.cwd === "string" && input.cwd.length > 0
                    ? input.cwd
                    : process.cwd();
                return await ctx.rescueEvaluator(workspaceRoot, toolName, input.tool_input);
            }
            // Stub for callers that didn't inject the evaluator (e.g.,
            // tests that exercise only the policy function). Allow
            // Read/Grep/Glob and friends; deny everything else. The
            // production entry script wires the real evaluator from
            // runtime/rescue-approval.ts.
            if (READ_ONLY_TOOLS.has(toolName)) {
                return { decision: "allow" };
            }
            return {
                decision: "deny",
                reason: `kimi-plugin-cc safety hook: rescue evaluator not configured; tool "${toolName}" denied as a safety default.`,
            };
        default:
            if (KNOWN_LABELS.has(label)) {
                // Should be unreachable — every entry in KNOWN_LABELS has its
                // own branch above. If you see this, add the case.
                return {
                    decision: "deny",
                    reason: `kimi-plugin-cc safety hook: command label "${label}" has no policy branch.`,
                };
            }
            // Unknown label. Be conservative; only allow Read/Grep/Glob.
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
