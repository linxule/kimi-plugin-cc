// Which host's PreToolUse hook decides for a plugin job.
//
// Claude Code, Codex and DSH each install a managed block in the one shared
// kimi-code config, and kimi-code runs every block's hook for every tool call:
// any deny wins. The launching runtime exports its own hook's identity on every
// model spawn, and a hook abstains for a job another host launched, so only the
// launching host's (verified, byte-exact) hook decides.
//
// Identity is derived from the hook SCRIPT PATH on both sides, never from
// `resolveHostId`: a hook process can only see its own path, while the
// marker id honours `KIMI_PLUGIN_CC_HOST_ID` (DSH pins `dsh`), which a hook
// could never reproduce. Both sides `path.resolve` the path first because Node
// resolves `argv[1]` the same way and the `host-<sha1>` form hashes spelling.
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { hostIdFromHookScript } from "./install-paths.js";
export const JOB_HOST_ENV = "KIMI_PLUGIN_CC_JOB_HOST";
/** The launching host's verified hook script path, exported with JOB_HOST_ENV. */
export const JOB_HOOK_ENV = "KIMI_PLUGIN_CC_JOB_HOOK";
/** Exactly the ids `hostIdFromHookScript` can produce. */
const JOB_HOST_RE = /^(?:claude-code|codex|host-[0-9a-f]{16})$/;
/** The job host id for a hook script path, as both runtime and hook compute it. */
export function jobHostForHookScript(hookScriptPath) {
    return hostIdFromHookScript(path.resolve(hookScriptPath));
}
/**
 * Every id this hook process may be known by: each spelling of its own script
 * path, plus its realpath. Extra ids can only make the hook enforce more often.
 */
export function ownHookHostIds(scriptPaths) {
    const ids = new Set();
    for (const candidate of scriptPaths) {
        if (candidate === undefined || candidate.length === 0)
            continue;
        try {
            ids.add(jobHostForHookScript(candidate));
        }
        catch {
            // An underivable spelling adds nothing; the others still count.
        }
        try {
            ids.add(jobHostForHookScript(realpathSync(candidate)));
        }
        catch {
            // A missing realpath adds nothing.
        }
    }
    return [...ids];
}
/**
 * True only when ALL hold: the job names a well-formed host that is not this
 * hook's own; the job hook is an absolute path whose derived id equals that
 * host (the two variables cannot disagree); and that path is a regular file
 * right now. Anything else, including any stat error or an unknown own
 * identity, enforces.
 *
 * The existence check restores the old every-host enforcement when the
 * launching host's version-stamped script disappears mid-job (a plugin update),
 * because its hook then fails to spawn, which kimi-code reads as allow. It does
 * not cover the launching block being edited out of the config while its
 * script still exists: kimi-code only drops that hook on a hooks reload.
 */
export function hookAbstainsForJob(jobHost, jobHook, ownHostIds, isRegularFile = regularFileNow) {
    if (jobHost === undefined || !JOB_HOST_RE.test(jobHost))
        return false;
    if (ownHostIds.length === 0 || ownHostIds.includes(jobHost))
        return false;
    if (jobHook === undefined || !path.isAbsolute(jobHook))
        return false;
    try {
        if (jobHostForHookScript(jobHook) !== jobHost)
            return false;
        return isRegularFile(jobHook);
    }
    catch {
        return false;
    }
}
function regularFileNow(file) {
    try {
        return statSync(file).isFile();
    }
    catch {
        return false;
    }
}
