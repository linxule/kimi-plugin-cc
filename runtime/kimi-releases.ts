/**
 * Exact kimi-code releases certified for native v2: one row per release.
 *
 * Certifying a release adds one row here (plus its evidence document, its
 * tag-scan row and the hash-pinned host surfaces). Every version-gated branch
 * in the runtime asks this table through `kimiReleaseHas`; none spells a
 * version list of its own.
 *
 * Matching is by exact version string. Nothing here is a range: upstream ships
 * behavioural changes in patch releases, so a new release has no capability
 * until its row says so.
 *
 * This module imports nothing. The per-tool-call hook and the config verifier
 * load it, and neither may pull in the engine.
 */

/** Which operations a release is certified for. */
export type KimiReleaseScope = "all" | "non-swarm";

/**
 * Upstream behaviours the runtime branches on. Each is a separate upstream
 * fact, re-proven per release, even where two currently cover the same rows.
 */
export type KimiReleaseCapability =
  /** Reviewed major-2 hook schema for version-sensitive events. Not an execution certification. */
  | "hook-schema"
  /** Loopback `kimi web` preactivation lifecycle for swarm. */
  | "web-preactivation"
  /** `--environment local` on a fresh print, and the local binding on a web session. */
  | "local-environment"
  /** Swarm status read from WebSocket agent state instead of REST `/status`. */
  | "agent-state"
  /** Direct WebSocket subscribe, without the legacy hello/subscribe control. */
  | "modern-ws-control"
  /** Plugin-owned bounded waves, or one direct worker at concurrency 1. */
  | "bounded-swarm"
  /** `kimi web --json` ready line and authenticated meta check. */
  | "web-json-ready";

export interface KimiRelease {
  readonly version: string;
  /** Upstream commit the certification was made against. */
  readonly commit: string;
  readonly scope: KimiReleaseScope;
  readonly capabilities: readonly KimiReleaseCapability[];
}

// Rows share these arrays, so each is frozen: a mutated preset would change every row using it.
const preset = (...capabilities: KimiReleaseCapability[]): readonly KimiReleaseCapability[] =>
  Object.freeze(capabilities);
const NONE = preset();
const HOOK_SCHEMA = preset("hook-schema");
const WEB = preset(...HOOK_SCHEMA, "web-preactivation");
const LOCAL = preset(...WEB, "local-environment", "agent-state");
const MODERN_WS = preset(...LOCAL, "modern-ws-control");
const BOUNDED = preset(...MODERN_WS, "bounded-swarm");
const JSON_READY = preset(...BOUNDED, "web-json-ready");

/** Ascending. Order is visible in error messages and in the exported version arrays. */
export const KIMI_V2_RELEASES: readonly KimiRelease[] = Object.freeze([
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
  { version: "2.4.0", commit: "f26e4d91", scope: "all", capabilities: WEB },
  { version: "2.4.1", commit: "2c73f3f5", scope: "all", capabilities: WEB },
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
] satisfies KimiRelease[]);

/** True when this exact release has the capability. Unknown versions have none. */
export function kimiReleaseHas(
  version: string | null | undefined,
  capability: KimiReleaseCapability,
): boolean {
  return KIMI_V2_RELEASES.some(
    (release) => release.version === version && release.capabilities.includes(capability),
  );
}

/** Exact versions with the capability, ascending. */
export function kimiVersionsWith(capability: KimiReleaseCapability): readonly string[] {
  return KIMI_V2_RELEASES
    .filter((release) => release.capabilities.includes(capability))
    .map((release) => release.version);
}

/** Exact versions certified with the scope, ascending. */
export function kimiVersionsInScope(scope: KimiReleaseScope): readonly string[] {
  return KIMI_V2_RELEASES.filter((release) => release.scope === scope).map((release) => release.version);
}

/** "a, b, c or d": the wording refusal and setup messages use to offer a choice of versions. */
export function formatVersionChoice(versions: readonly string[]): string {
  if (versions.length <= 1) return versions.join("");
  return `${versions.slice(0, -1).join(", ")} or ${versions.at(-1)}`;
}
