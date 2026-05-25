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
 * Rescue evaluator signature. PR 3 wires
 * `runtime/rescue-approval.ts::evaluateRescueHookRequest` into the
 * entry script via this hook. Async because the rescue allowlist
 * performs `lstat` / `realpath` to detect symlink escape and resolve
 * relative paths against the workspace root.
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
  /**
   * Rescue evaluator. PR 2 left this undefined; PR 3 wires it from
   * the entry script. When `commandLabel === "rescue"` and this is
   * undefined, the policy falls back to a deny-by-default stub.
   */
  rescueEvaluator?: RescueEvaluator;
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
]);

export async function decideHookOutcome(
  input: HookInput,
  ctx: PolicyContext,
): Promise<HookDecision> {
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
        reason:
          `kimi-plugin-cc safety hook: rescue evaluator not configured; tool "${toolName}" denied as a safety default.`,
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
