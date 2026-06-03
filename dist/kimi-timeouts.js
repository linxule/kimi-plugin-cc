// Per-command response-budget constants for the v1.0 cli-client path.
//
// v0.4 also exposed startup / initialize timeouts plus a generic
// `withTimeout` helper. Those existed because the Wire transport had a
// three-phase lifecycle (spawn → initialize → prompt). The v1.0
// subprocess transport collapses spawn + prompt into a single
// `runCliPromptWithBudget` call (see `runtime/cli-client.ts`), and
// startup failures surface as CLI_SPAWN_FAILED / CLI_PROCESS_ERROR —
// not as separate timeouts. So only the per-command response budgets
// remain.
// Budgets are sized for thinking-on workflow (the default since v1.0).
// kimi-code spends real wallclock on extended reasoning before emitting
// the first assistant record; pre-alpha.4 budgets (300s/600s) were sized
// against the non-thinking path and timed out in production smoke
// testing under default flags. Raised to 900/1800/1800 so a real
// thinking-on review/rescue session has headroom; review-gate stays at
// 8s because it fires inside Claude Code's Stop hook and is forced to
// thinking-off in its own caller.
/** Ask budget. Conversational; thinking-on free-form reasoning. */
export const KIMI_ASK_PROMPT_TIMEOUT_MS = 900_000;
/** Review/challenge budget. Thinking-on single-turn analysis over the workspace. */
export const KIMI_REVIEW_PROMPT_TIMEOUT_MS = 1_800_000;
/** Rescue budget. Thinking-on multi-step apply/test/verify loops. */
export const KIMI_RESCUE_PROMPT_TIMEOUT_MS = 1_800_000;
/**
 * Pursue (autonomous goal mode) DEFAULT wall-clock ceiling when the user
 * passes no `--budget`. This is the ONLY hard bound on an autonomous goal —
 * headless goal create sets no token/turn budget (only the model, via
 * SetGoalBudget, or this AbortController stops the loop). Larger than the
 * single-turn rescue budget (a goal spans multiple continuation turns) but
 * deliberately finite. Overridable per-job via `--budget` (parsed to ms in
 * parsePursueArgs). See runtime/commands/pursue.ts and docs/safety.md.
 */
export const KIMI_PURSUE_DEFAULT_BUDGET_MS = 2_700_000; // 45 minutes
/**
 * Review-gate budget. Fires inside Claude Code's Stop hook so any value
 * above the user's perceptible wait makes the gate feel broken.
 *
 * kimi-code 0.1.1 has no per-spawn CLI flag for thinking control
 * (Round 2 multi-agent review caught this — emitting `--no-thinking`
 * triggers an unknown-option crash). The 8s budget assumes the user
 * has either `default_thinking = false` or `[thinking].mode = "off"`
 * in `~/.kimi-code/config.toml`, OR a non-thinking-capable model
 * selected for review-gate (via KIMI_PLUGIN_CC_REVIEW_GATE_MODEL).
 * Under thinking-on the gate will time out — the gate is fail-open on
 * timeout by design, so the worst case is the gate becomes
 * always-allow. See docs/safety.md.
 */
export const KIMI_REVIEW_GATE_TIMEOUT_MS = 8_000;
export function isTimeoutCode(code) {
    return (code === "TIMEOUT" ||
        code === "STARTUP_TIMEOUT" ||
        code === "INITIALIZE_TIMEOUT" ||
        code === "RESPONSE_TIMEOUT");
}
