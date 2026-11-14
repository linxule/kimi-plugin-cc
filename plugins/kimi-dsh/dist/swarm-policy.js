export const SWARM_POLICY_ENV = "KIMI_PLUGIN_CC_SWARM_POLICY";
export const SWARM_WAVE_SIZE_ENV = "KIMI_PLUGIN_CC_SWARM_WAVE_SIZE";
export const BOUNDED_SWARM_POLICY = "bounded-waves/1";
// Native retry timeouts can return a wave before its child work settles. This
// valid upstream timer exceeds the plugin's finite <=24h job deadline, so only
// terminal whole-job cancellation can interrupt a wave. Environment 0 is ignored.
export const SWARM_CHILD_TIMEOUT_MS = 2_147_483_647;
export function usesBoundedSwarmPolicy(plan) {
    return plan.intendedEngine === "native-v2" && plan.kimiVersion === "2.6.2" &&
        (plan.operationKind === "swarm" || plan.operationKind === "swarm-write");
}
function plainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function nonemptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}
const SWARM_INPUT_KEYS = new Set([
    "description", "subagent_type", "prompt_template", "items", "fork", "resume_agent_ids", "model",
]);
/** Stateless admission; repeated host hooks cannot consume or refund slots. */
export function evaluateSwarmWaveInput(input, policy, waveSize) {
    const deny = (reason) => ({
        decision: "deny",
        reason: `kimi-plugin-cc safety hook: AgentSwarm denied: ${reason}`,
    });
    if (policy !== BOUNDED_SWARM_POLICY)
        return deny("missing or unrecognized swarm policy.");
    const width = typeof waveSize === "string" && /^[1-9][0-9]*$/.test(waveSize)
        ? Number(waveSize) : NaN;
    if (!Number.isSafeInteger(width) || width < 1)
        return deny("missing or invalid trusted wave size.");
    if (width === 1) {
        return deny("concurrency 1 uses one worker directly; complete the task yourself without delegation.");
    }
    if (!plainObject(input))
        return deny("arguments must be an object.");
    if (Reflect.ownKeys(input).some((key) => typeof key !== "string" || !SWARM_INPUT_KEYS.has(key))) {
        return deny("unrecognized arguments.");
    }
    if (!nonemptyString(input.description))
        return deny("description must be a nonempty string.");
    for (const key of ["subagent_type", "prompt_template"]) {
        if (input[key] !== undefined && !nonemptyString(input[key]))
            return deny(`${key} must be a nonempty string.`);
    }
    if (input.model !== undefined && typeof input.model !== "string")
        return deny("model must be a string.");
    if (input.fork !== undefined && input.fork !== false)
        return deny("forked subagents are not supported.");
    if (input.items !== undefined && (!Array.isArray(input.items) || !input.items.every(nonemptyString))) {
        return deny("items must be an array of nonempty strings.");
    }
    if (input.resume_agent_ids !== undefined && (!plainObject(input.resume_agent_ids) ||
        Reflect.ownKeys(input.resume_agent_ids).some((key) => typeof key !== "string" ||
            !nonemptyString(key) || !nonemptyString(input.resume_agent_ids[key])))) {
        return deny("resume_agent_ids must map nonempty agent IDs to nonempty prompts.");
    }
    const fresh = Array.isArray(input.items) ? input.items.length : 0;
    const resumed = plainObject(input.resume_agent_ids) ? Object.keys(input.resume_agent_ids).length : 0;
    const total = fresh + resumed;
    if (total === 0)
        return deny("a wave must contain at least one new or resumed entry.");
    if (total > width) {
        return deny(`wave has ${total} new and resumed entries, exceeding the limit ${width}; split the work into sequential waves of at most ${width} entries and wait for each wave to finish.`);
    }
    if (fresh === 1 && resumed === 0) {
        return deny("fresh-only waves require at least two entries; regroup targets into disjoint entries within the wave limit, or resume an existing child for the remaining work.");
    }
    return { decision: "allow" };
}
