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

import { realpathSync } from "node:fs";
import path from "node:path";

import { hostIdFromHookScript } from "./install-paths.js";

export const JOB_HOST_ENV = "KIMI_PLUGIN_CC_JOB_HOST";

/** Exactly the ids `hostIdFromHookScript` can produce. */
const JOB_HOST_RE = /^(?:claude-code|codex|host-[0-9a-f]{16})$/;

/** The job host id for a hook script path, as both runtime and hook compute it. */
export function jobHostForHookScript(hookScriptPath: string): string {
  return hostIdFromHookScript(path.resolve(hookScriptPath));
}

/**
 * Every id this hook process may be known by: each spelling of its own script
 * path, plus its realpath. Extra ids can only make the hook enforce more often.
 */
export function ownHookHostIds(scriptPaths: ReadonlyArray<string | undefined>): string[] {
  const ids = new Set<string>();
  for (const candidate of scriptPaths) {
    if (candidate === undefined || candidate.length === 0) continue;
    try {
      ids.add(jobHostForHookScript(candidate));
    } catch {
      // An underivable spelling adds nothing; the others still count.
    }
    try {
      ids.add(jobHostForHookScript(realpathSync(candidate)));
    } catch {
      // A missing realpath adds nothing.
    }
  }
  return [...ids];
}

/**
 * True only when the job names a well-formed host that is not this hook's own.
 * An absent, empty or malformed value, or an unknown own identity, enforces.
 */
export function hookAbstainsForJob(
  jobHost: string | undefined,
  ownHostIds: readonly string[],
): boolean {
  if (jobHost === undefined || !JOB_HOST_RE.test(jobHost)) return false;
  if (ownHostIds.length === 0) return false;
  return !ownHostIds.includes(jobHost);
}
