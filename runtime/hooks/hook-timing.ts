// Timing shared by the installed managed block and the hook entry script.
//
// kimi-code reads a hook that times out as ALLOW, so the hook must decide (or
// deny) before the installed timeout expires. Both values derive from one
// constant so they cannot drift.

/** `timeout` (seconds) written into every managed PreToolUse block. */
export const HOOK_TIMEOUT_S = 15;

/**
 * Fail-closed deadline for a labelled call, counted from hook start and
 * covering stdin read plus policy evaluation. The margin absorbs Node startup
 * and module load, which kimi-code's timeout counts but this timer does not.
 */
export const HOOK_DECISION_DEADLINE_MS = HOOK_TIMEOUT_S * 1000 - 5_000;

/**
 * Test-only delay before the policy decision (milliseconds, or `hang` for a
 * promise that never settles). It can only push a decision into the
 * fail-closed deadline, and buildKimiCliEnvironment deletes it on every spawn,
 * so it never reaches a job's hook.
 */
export const HOOK_TEST_DELAY_ENV = "KIMI_PLUGIN_CC_HOOK_TEST_DELAY_MS";
