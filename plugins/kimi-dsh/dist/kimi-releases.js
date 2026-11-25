/**
 * Exact kimi-code releases certified for native v2: one row per release.
 *
 * Certifying a release adds one row here (plus its evidence document, its
 * tag-scan row and the hash-pinned host surfaces). Every version-gated branch
 * in the runtime asks this table through `resolveKimiRelease` (directly or via
 * `kimiReleaseHas`); none spells a version list of its own.
 *
 * Certification is by exact version string: upstream ships behavioural changes
 * in patch releases, so a new release is certified for nothing until its row
 * exists. `resolveKimiRelease` lets an unlisted plain 2.x borrow the argv
 * mechanics of the highest row below it for read-only operations; it never
 * borrows the hook schema, a swarm capability or a per-release relaxation.
 *
 * This module imports nothing. The per-tool-call hook and the config verifier
 * load it, and neither may pull in the engine.
 */
// Rows share these arrays, so each is frozen: a mutated preset would change every row using it.
const preset = (...capabilities) => Object.freeze(capabilities);
const NONE = preset();
const HOOK_SCHEMA = preset("hook-schema");
const WEB = preset(...HOOK_SCHEMA, "web-preactivation");
const WEB_CANCEL = preset(...WEB, "print-cancels-plan");
const LOCAL = preset(...WEB_CANCEL, "local-environment", "agent-state");
const MODERN_WS = preset(...LOCAL, "modern-ws-control");
const BOUNDED = preset(...MODERN_WS, "bounded-swarm");
const JSON_READY = preset(...BOUNDED, "web-json-ready");
/** Ascending. Order is visible in error messages and in the exported version arrays. */
export const KIMI_V2_RELEASES = Object.freeze([
    { version: "0.42.0", commit: "6954d2c8", scope: "all", capabilities: NONE },
    { version: "0.43.0", commit: "ffa94fae", scope: "all", capabilities: NONE },
    { version: "0.43.1", commit: "75ac010b", scope: "all", capabilities: NONE },
    { version: "2.0.0", commit: "1b89e4b0", scope: "all", capabilities: HOOK_SCHEMA },
    { version: "2.0.1", commit: "caf7d4e2", scope: "all", capabilities: HOOK_SCHEMA },
    { version: "2.0.2", commit: "9d07f634", scope: "all", capabilities: HOOK_SCHEMA },
    { version: "2.1.0", commit: "52437299", scope: "all", capabilities: HOOK_SCHEMA },
    { version: "2.1.1", commit: "f67e6398", scope: "all", capabilities: HOOK_SCHEMA },
    { version: "2.2.0", commit: "472192c3", scope: "all", capabilities: HOOK_SCHEMA },
    { version: "2.3.0", commit: "b5e28fd6", scope: "all", capabilities: HOOK_SCHEMA },
    { version: "2.3.1", commit: "684bae9e", scope: "all", capabilities: HOOK_SCHEMA },
    { version: "2.3.2", commit: "b8dd3a13", scope: "all", capabilities: WEB },
    { version: "2.3.3", commit: "ec495f0c", scope: "all", capabilities: WEB },
    { version: "2.4.0", commit: "f26e4d91", scope: "all", capabilities: WEB_CANCEL },
    { version: "2.4.1", commit: "2c73f3f5", scope: "all", capabilities: WEB_CANCEL },
    { version: "2.5.0", commit: "41c34143", scope: "all", capabilities: LOCAL },
    { version: "2.5.1", commit: "1b02030d", scope: "all", capabilities: LOCAL },
    { version: "2.5.2", commit: "1c142a00", scope: "all", capabilities: LOCAL },
    { version: "2.5.3", commit: "5af9942e", scope: "all", capabilities: LOCAL },
    // Swarm is refused on 2.6.0; its web flags support candidate integration only.
    { version: "2.6.0", commit: "740d6c0b", scope: "non-swarm", capabilities: MODERN_WS },
    { version: "2.6.2", commit: "6a8493df", scope: "all", capabilities: BOUNDED },
    { version: "2.6.3", commit: "b0de2fbd", scope: "all", capabilities: BOUNDED },
    { version: "2.7.2", commit: "56145f84", scope: "all", capabilities: JSON_READY },
    { version: "2.7.3", commit: "a8f643ad", scope: "all", capabilities: JSON_READY },
]);
/**
 * Mechanics an uncertified release borrows from its row: only the fresh-print
 * argv (`--environment local`, which can only narrow where it runs).
 * Everything else (hook schema, swarm, web lifecycle, and every per-release
 * relaxation) stays exact, because each rests on behaviour proven for that
 * release only.
 */
const BORROWABLE_CAPABILITIES = new Set([
    "local-environment",
]);
const PLAIN_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
function versionTriple(version) {
    const match = PLAIN_VERSION.exec(version);
    return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}
function compareTriples(left, right) {
    for (let index = 0; index < 3; index += 1) {
        if (left[index] !== right[index])
            return left[index] - right[index];
    }
    return 0;
}
/**
 * The single answer to "which row's mechanics apply, and is it certified".
 * An exact row resolves to itself. Otherwise only a plain `2.y.z` newer than
 * the lowest 2.x row borrows the highest row at or below it; pre-release and
 * build-suffixed versions, other majors and `strict` resolve to null.
 */
export function resolveKimiRelease(version, options = {}) {
    if (typeof version !== "string")
        return null;
    const exact = KIMI_V2_RELEASES.find((release) => release.version === version);
    if (exact !== undefined)
        return { release: exact, certified: true };
    if (options.strict === true)
        return null;
    const triple = versionTriple(version);
    if (triple === null || triple[0] !== 2)
        return null;
    let borrowed;
    let lowest;
    for (const release of KIMI_V2_RELEASES) {
        const row = versionTriple(release.version);
        if (row === null || row[0] !== 2)
            continue;
        if (lowest === undefined || compareTriples(row, lowest) < 0)
            lowest = row;
        if (compareTriples(row, triple) <= 0 &&
            (borrowed === undefined || compareTriples(row, versionTriple(borrowed.version)) > 0)) {
            borrowed = release;
        }
    }
    if (lowest === undefined || borrowed === undefined || compareTriples(triple, lowest) <= 0)
        return null;
    return { release: borrowed, certified: false };
}
/**
 * True when the version's resolved row has the capability: exact rows report
 * their own list; an uncertified version only the borrowable mechanics.
 */
export function kimiReleaseHas(version, capability) {
    const resolved = resolveKimiRelease(version);
    if (resolved === null)
        return false;
    if (!resolved.certified && !BORROWABLE_CAPABILITIES.has(capability))
        return false;
    return resolved.release.capabilities.includes(capability);
}
/** True only when this exact certified row has the capability; borrowed rows never qualify. */
export function kimiCertifiedReleaseHas(version, capability) {
    const resolved = resolveKimiRelease(version);
    return resolved !== null && resolved.certified && resolved.release.capabilities.includes(capability);
}
/** Exact versions with the capability, ascending. */
export function kimiVersionsWith(capability) {
    return KIMI_V2_RELEASES
        .filter((release) => release.capabilities.includes(capability))
        .map((release) => release.version);
}
/** Exact versions certified with the scope, ascending. */
export function kimiVersionsInScope(scope) {
    return KIMI_V2_RELEASES.filter((release) => release.scope === scope).map((release) => release.version);
}
/** "a, b, c or d": the wording refusal and setup messages use to offer a choice of versions. */
export function formatVersionChoice(versions) {
    if (versions.length <= 1)
        return versions.join("");
    return `${versions.slice(0, -1).join(", ")} or ${versions.at(-1)}`;
}
