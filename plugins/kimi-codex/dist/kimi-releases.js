/**
 * Exact kimi-code releases certified under the >= 2.8.0 rolling compatibility window.
 *
 * Certifying a release adds one row here (plus its evidence document and its
 * tag-scan row). Every version-gated branch in the runtime asks this table
 * through `resolveKimiRelease` (directly or via `kimiReleaseHas`); none spells
 * a version list of its own.
 *
 * Rolling Compatibility Window:
 * - Certified floor is exact Kimi Code 2.8.0. Releases below 2.8.0 (legacy-v1
 *   and pre-2.8.0 v2 releases) are unsupported and refuse before spawn.
 * - Unlisted plain 2.y.z releases strictly above 2.8.0 borrow the argv
 *   mechanics of the highest certified row below them (`local-environment`) for
 *   read-only operations (`ask`, `review`, `challenge`) with a warning; write
 *   and swarm operations require an exact certified row.
 *
 * This module imports nothing. The per-tool-call hook and config verifier
 * load it, and neither may pull in the engine.
 */
const BASELINE = Object.freeze([
    "hook-schema",
    "web-preactivation",
    "print-cancels-plan",
    "local-environment",
    "agent-state",
    "modern-ws-control",
    "bounded-swarm",
    "web-json-ready",
]);
/** Ascending. Order is visible in error messages and in the exported version arrays. */
export const KIMI_V2_RELEASES = Object.freeze([
    { version: "2.8.0", commit: "46d9085f", scope: "all", capabilities: BASELINE },
    { version: "2.8.1", commit: "62402f17", scope: "all", capabilities: BASELINE },
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
let smokeCandidateRelease;
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
 * Test-process-only registration for candidate smoke runs against an unreleased
 * or pre-certification `2.y.z` binary strictly above the floor. Never mutates
 * `KIMI_V2_RELEASES` and reads no environment variables.
 */
export function registerSmokeCandidateReleaseForTests(version) {
    const triple = versionTriple(version);
    const floor = versionTriple(KIMI_V2_RELEASES[0].version);
    if (triple === null || triple[0] !== 2 || floor === null || compareTriples(triple, floor) < 0) {
        throw new Error(`Invalid smoke candidate release version: ${version}`);
    }
    if (KIMI_V2_RELEASES.some((release) => release.version === version)) {
        return () => { };
    }
    const registered = Object.freeze({
        version,
        commit: "00000000",
        scope: "all",
        capabilities: BASELINE,
    });
    smokeCandidateRelease = registered;
    return () => {
        if (smokeCandidateRelease === registered)
            smokeCandidateRelease = undefined;
    };
}
/**
 * The single answer to "which row's mechanics apply, and is it certified".
 * An exact row resolves to itself. Otherwise only a plain `2.y.z` (or `>= 2.8.0`
 * rolling-window major 2 release) strictly newer than the floor (`2.8.0`)
 * borrows the highest row at or below it; releases below the floor, pre-release
 * and build-suffixed versions, other majors, and `strict` resolve to null.
 */
export function resolveKimiRelease(version, options = {}) {
    if (typeof version !== "string")
        return null;
    const exact = KIMI_V2_RELEASES.find((release) => release.version === version);
    if (exact !== undefined)
        return { release: exact, certified: true };
    if (smokeCandidateRelease !== undefined && smokeCandidateRelease.version === version) {
        return { release: smokeCandidateRelease, certified: true };
    }
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
