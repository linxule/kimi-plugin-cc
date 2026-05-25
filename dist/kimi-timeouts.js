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
/** Ask budget. Conversational; allow a long answer + tool detours. */
export const KIMI_ASK_PROMPT_TIMEOUT_MS = 300_000;
/** Review/challenge budget. Single-turn analysis over the workspace. */
export const KIMI_REVIEW_PROMPT_TIMEOUT_MS = 600_000;
/**
 * Review-gate budget. Fires inside Claude Code's Stop hook so any value
 * above the user's perceptible wait makes the gate feel broken.
 */
export const KIMI_REVIEW_GATE_TIMEOUT_MS = 8_000;
export function isTimeoutCode(code) {
    return (code === "TIMEOUT" ||
        code === "STARTUP_TIMEOUT" ||
        code === "INITIALIZE_TIMEOUT" ||
        code === "RESPONSE_TIMEOUT");
}
