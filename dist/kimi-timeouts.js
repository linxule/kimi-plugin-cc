// Per-command response budgets leave room for thinking-capable workflows;
// per-run effort is only a request. Ask/review default to 30 minutes and rescue
// to 45 minutes for repo-wide work.
/** Ask budget. Conversational; thinking-on free-form reasoning. */
export const KIMI_ASK_PROMPT_TIMEOUT_MS = 1_800_000; // 30 minutes
/** Review/challenge budget. Thinking-on single-turn analysis over the workspace. */
export const KIMI_REVIEW_PROMPT_TIMEOUT_MS = 1_800_000;
/** Rescue budget. Thinking-on multi-step apply/test/verify loops. */
export const KIMI_RESCUE_PROMPT_TIMEOUT_MS = 2_700_000; // 45 minutes
/**
 * Pursue (autonomous goal mode) DEFAULT wall-clock ceiling when the user
 * passes no `--budget`. This is the ONLY hard bound on an autonomous goal —
 * headless goal create sets no token/turn budget, and the managed hook denies
 * SetGoalBudget. The same duration as
 * the single-turn rescue default, but a safety ceiling rather than a patience
 * knob. Deliberately finite. Overridable per-job via `--budget` (parsed to ms in
 * parsePursueArgs). See runtime/commands/pursue.ts and docs/safety.md.
 */
export const KIMI_PURSUE_DEFAULT_BUDGET_MS = 2_700_000; // 45 minutes
/**
 * Swarm (read-only parallel fan-out) DEFAULT wall-clock ceiling when the user
 * passes no `--budget`. Read-only swarm opens no write surface, so the only new
 * risk is cost/runaway from repeated model work. This AbortController bounds
 * the whole job; `--cap` remains a soft lifetime-count hint. A bounded-swarm release also
 * bounds wave cardinality and prevents child timeouts from overlapping waves;
 * a requested concurrency of one runs a direct worker. Sized like the single-turn
 * review budget — a swarm fans review work out in parallel within one process,
 * so 30m of wall-clock is generous headroom. Overridable per-job via `--budget`
 * (parsed to ms in parseSwarmArgs). See runtime/commands/swarm.ts and
 * docs/safety.md.
 */
export const KIMI_SWARM_DEFAULT_BUDGET_MS = 1_800_000; // 30 minutes
export function isTimeoutCode(code) {
    return (code === "TIMEOUT" ||
        code === "STARTUP_TIMEOUT" ||
        code === "INITIALIZE_TIMEOUT" ||
        code === "RESPONSE_TIMEOUT");
}
