// Timing shared by the installed managed block and the hook entry script.
//
// kimi-code reads a hook that times out as ALLOW, so the hook must decide (or
// deny) before kimi-code's timeout expires. The installed timeout, the shortest
// timeout an entry may have and still count as enforcing, and the decision
// deadline all derive from HOOK_TIMEOUT_S so they cannot drift.
/** `timeout` (seconds) written into every managed PreToolUse block. */
export const HOOK_TIMEOUT_S = 15;
/**
 * Fail-closed deadline for a labelled call, counted from hook start and
 * covering stdin read plus policy evaluation. The margin absorbs Node startup
 * and module load, which kimi-code's timeout counts but this timer does not.
 */
export const HOOK_DECISION_DEADLINE_MS = HOOK_TIMEOUT_S * 1000 - 5_000;
/**
 * kimi-code's timeout (seconds) for a [[hooks]] entry with no `timeout` key:
 * `DEFAULT_HOOK_TIMEOUT_SECONDS` in agent-core-v2 `externalHooks/internal/
 * matchHooks.ts`, 30 in every certified source through 2.8.0. Each compat
 * audit re-verifies it.
 */
export const UPSTREAM_DEFAULT_HOOK_TIMEOUT_S = 30;
/**
 * The timeout kimi-code applies to an entry's raw `timeout` value: the
 * upstream default when absent, the integer itself within upstream's 1-600
 * schema, otherwise `null` (not provably enforcing).
 */
export function effectiveHookTimeoutS(value) {
    if (value === undefined)
        return UPSTREAM_DEFAULT_HOOK_TIMEOUT_S;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 600)
        return null;
    return value;
}
/**
 * True when kimi-code waits at least `HOOK_TIMEOUT_S` for the hook, so the
 * fail-closed deadline below fires before upstream's timeout-as-allow.
 */
export function hookTimeoutEnforces(value) {
    const effective = effectiveHookTimeoutS(value);
    return effective !== null && effective >= HOOK_TIMEOUT_S;
}
/**
 * Test-only delay before the policy decision (milliseconds, or `hang` for a
 * promise that never settles). It can only push a decision into the
 * fail-closed deadline, and buildKimiCliEnvironment deletes it on every spawn,
 * so it never reaches a job's hook.
 */
export const HOOK_TEST_DELAY_ENV = "KIMI_PLUGIN_CC_HOOK_TEST_DELAY_MS";
