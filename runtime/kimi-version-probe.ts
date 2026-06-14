// Probe the installed kimi-code CLI version and check it against the
// range kimi-plugin-cc has been tested against.
//
// Why this exists (H6, Codex post-hotfix audit Area 8):
//
//   kimi-code 0.2.0 introduced wire protocol 1.1 and a new "warn-and-
//   replay" code path for sessions from newer protocol versions. A
//   future 0.3.0 could replay an older session with an invisible warning
//   and produce flattened output that silently differs from what our
//   plugin captured originally — see PR #49 (cf2227e) and PR #22
//   (2004aed) in the 0.2.0 changeset. The alpha.5 hotfix exists because
//   *this exact failure mode already happened once* (kimi-code 0.2.0
//   moved the session resume hint from stderr to a stream-json meta
//   record, and our plugin captured nothing until we noticed).
//
//   The defensible posture: probe kimi-code's version at setup time,
//   compare against the range we've actively tested, and emit a stderr
//   warning when the user is outside it. We do NOT block — kimi-code is
//   the user's tool of choice, our plugin sits beside it — but we
//   loud-warn so a silent version drift can't sneak by.
//
//   This is belt-and-suspenders for the alpha.4 `warnIfSessionIdMissing`
//   surface: that warning fires when capture demonstrably fails on a
//   completed job; this one fires before any job runs, on the theory
//   that "you're running a kimi-code we haven't tested" is worth knowing
//   even if the first job happens to work.
//
// What this module is NOT:
//
//   - Not a hard gate. We never refuse to run on version mismatch.
//   - Not a substitute for upstream compatibility testing. The right
//     long-term answer is for kimi-code to advertise wire-protocol
//     compatibility via a stable feature flag or version field in its
//     stream-json output. Until upstream lands that, this is the best
//     signal we can give users.
//   - Not invoked on every spawn. Setup-time check is sufficient — a
//     per-spawn probe would slow every command for no real benefit.

import { spawn } from "node:child_process";

/** Maximum time to wait for `kimi --version` to print and exit. */
const KIMI_VERSION_PROBE_TIMEOUT_MS = 5_000;

/**
 * The range of kimi-code package versions kimi-plugin-cc has been
 * actively tested against. Bump these when a new kimi-code release is
 * verified to work end-to-end (production smoke + full test suite).
 *
 * Versions are matched as `<major>.<minor>` pairs — patch versions are
 * always accepted within a known minor. A version of `0.2.5` is
 * considered tested if `{0, 2}` is in this set.
 *
 * Why store as `{major, minor}` and not a semver range string: avoids a
 * semver parser dependency for a one-off comparison, and the range
 * shape is naturally tied to kimi-code's own release cadence (0.x
 * pre-1.0, minor bumps for behavioral change).
 */
export const KIMI_TESTED_MINORS: ReadonlyArray<{ major: number; minor: number }> = [
  { major: 0, minor: 1 },
  { major: 0, minor: 2 },
  // 0.3 and 0.4 added in v1.0.1 (2026-05-27) after the 4-reviewer audit
  // verified compat through @moonshot-ai/kimi-code@0.4.0. See
  // docs/upstream-compat-audit.md for the playbook and
  // .claude/kimi-code-research/reports/31-35-* for the audit reports.
  // Tag: compat-verified-kimi-code-0.4.0 on commit b67263c.
  { major: 0, minor: 3 },
  { major: 0, minor: 4 },
  // 0.5 added in v1.0.2 (2026-05-28) after a same-day 4-reviewer audit
  // verified compat through @moonshot-ai/kimi-code@0.5.0. The hook
  // engine moved path (agent/hooks/ → session/hooks/) but is
  // byte-identical; run-prompt.ts and rpc/events.ts are byte-identical;
  // the new --auto CLI flag is rejected when combined with -p. See
  // .claude/kimi-code-research/reports/36-40-* for the audit reports.
  // Tag: compat-verified-kimi-code-0.5.0.
  { major: 0, minor: 5 },
  // 0.6 added in v1.0.4 (2026-05-31) after a 4-reviewer audit verified
  // compat through @moonshot-ai/kimi-code@0.6.0, backed by a GREEN
  // real-binary smoke (`bun run smoke:real`) against the installed 0.6.0
  // binary — "tested" is earned end-to-end, not source-reading-only. The
  // hook engine (session/hooks/), policy queue order (policies/index.ts),
  // and CLI argv (options.ts/commands.ts) are byte-identical; the
  // stream-json resume-hint writer is byte-identical. The +17-line
  // run-prompt.ts change is a resume-session workDir guard that runs
  // before permission forcing and cannot fire for the plugin (we always
  // resume from the originating cwd). The permission/index.ts
  // `rpc?.requestApproval` refactor is dead code in -p mode (shadowed by
  // auto-mode-approve at index 4; the hook policy is index 0;
  // requestApproval is always present). See
  // .claude/kimi-code-research/reports/47-51-* for the
  // audit reports. Tag: compat-verified-kimi-code-0.6.0.
  { major: 0, minor: 6 },
  // 0.7 / 0.8 / 0.9 added in v1.0.5 (2026-06-03) after a 4-reviewer audit
  // + an independent cross-model (codex) adversarial pass certified compat
  // through @moonshot-ai/kimi-code@0.9.0, backed by a GREEN real-binary
  // smoke (`bun run smoke:real`) against BOTH the installed 0.8.0 binary
  // and a temp-installed 0.9.0 binary (KIMI_PLUGIN_CC_KIMI_BIN override) —
  // "tested" is earned end-to-end on 0.9.0, not source-reading-only. This
  // was a 3-minor catch-up (61 commits). The safety chain is intact:
  // PreToolCallHookPermissionPolicy is still index 0 (auto-approve index 4);
  // the hook engine (session/hooks/engine.ts, runner.ts) and the
  // policy/stream-json writers are byte-identical 0.6.0→0.9.0. The notable
  // 0.7–0.9 additions are all compat-benign for a `kimi -p` wrapper:
  //   - Permission approval hooks (PermissionRequest/PermissionResult, #336)
  //     are fire-and-forget OBSERVABILITY (fireAndForgetTrigger + void) that
  //     fire only in the rpc.requestApproval/ask branch — dead in -p auto
  //     mode (shadowed by auto-mode-approve), cannot deny.
  //   - Headless goal mode (kimi -p "/goal ...", #270) is double-gated:
  //     experimental flag goal-command (default false, env
  //     KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND) AND a /goal-prefixed prompt.
  //     The plugin's read-only and rescue commands set no
  //     KIMI_CODE_EXPERIMENTAL_* env and never send /goal. (The v1.1
  //     /kimi:pursue command intentionally opts into goal-command per-job
  //     and sends /goal, but every tool call still passes the index-0
  //     PreToolUse hook on every continuation turn — see docs/safety.md.)
  //   - The new deny-all policy is unshift-ed only onto SUBAGENT policy
  //     stacks (a deny, more restrictive) — never the main -p agent.
  //   - New default-approved goal tools (GetGoal/SetGoalBudget/UpdateGoal)
  //     have no fs/git/config side effects; the plugin enforces read-only by
  //     allow-list (deny-by-default), so new upstream tools cannot slip
  //     through. CreateGoal is NOT auto-approved.
  //   - Background auto-upgrade (#334, default on) does not swap the binary
  //     for the plugin's own -p spawns (source forced 'unsupported'); the
  //     out-of-band drift it introduces is exactly what this probe catches.
  // See .claude/kimi-code-research/reports/52-60 for the audit reports.
  // Tag: compat-verified-kimi-code-0.9.0.
  { major: 0, minor: 7 },
  { major: 0, minor: 8 },
  { major: 0, minor: 9 },
  // 0.10 / 0.11 / 0.12 added in v1.1.1 (2026-06-09) after a 4-reviewer audit
  // (+ adversarial pass) certified compat through @moonshot-ai/kimi-code@0.12.0,
  // backed by a GREEN real-binary smoke against the installed 0.12.0 binary
  // (review/challenge/ask/review_gate all hook-denied; the pursue goal-mode
  // safety smoke wrote zero files across a full budget). The safety chain is
  // intact: PreToolCallHookPermissionPolicy is still index 0 (auto-approve
  // index 4); the hook engine (session/hooks/{engine,runner,types}.ts) and the
  // stream-json writer are byte-identical 0.9.0→0.12.0 (03-hooks.diff is 0 bytes
  // across all five tags). Notable 0.10–0.12 changes, all compat-benign for a
  // `kimi -p` wrapper:
  //   - Goal-mode experimental gate REMOVED in 0.12.0 (#569, commit d7407b0):
  //     headless goal mode now triggers on the `/^\/goal(\s|$)/` prompt prefix
  //     ALONE — the KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND env gate is gone (still
  //     present 0.9.0–0.11.0). This WEAKENS the old "double-gated" claim to a
  //     single gate, but the plugin never relied on the env gate: read-only
  //     commands hard-prefix an English instruction line so their trimmed
  //     prompt never starts with `/goal` (cannot enter goal mode), and the
  //     index-0 hook denies every write regardless. /kimi:pursue still sets the
  //     env var per-spawn — now redundant on 0.12 but harmless (unknown
  //     experimental flag ids resolve to undefined) and still required on
  //     0.8–0.11.
  //   - AgentSwarm tool + swarm mode (#424): the new swarm-approve policy sits
  //     at index ~14 (below hook(0)/auto-approve(4)), is approve-only and
  //     double-guarded, and swarmMode.enter() runs INSIDE the tool's execute()
  //     (after the index-0 hook already gated the AgentSwarm call). Swarm
  //     subagents still inherit DenyAllPermissionPolicy (subagent-host.ts:233).
  //   - New `doctor` subcommand + a `program.argument('[args...]')` unknown-
  //     positional error: both unreachable — the plugin passes the prompt as
  //     the VALUE of `-p, --prompt`, never a bare positional.
  // See .claude/kimi-code-research/reports/61-65 for the audit reports.
  // Tag: compat-verified-kimi-code-0.12.0.
  { major: 0, minor: 10 },
  { major: 0, minor: 11 },
  { major: 0, minor: 12 },
  // 0.13 / 0.14 added in v1.2.3 (2026-06-12) after a 4-reviewer audit
  // (+ adversarial pass) certified compat through @moonshot-ai/kimi-code@0.14.1,
  // backed by a GREEN real-binary smoke against the installed 0.14.1 binary
  // (review/challenge/ask/review_gate all hook-denied; pursue goal-mode wrote
  // zero files across a multi-turn budget; the swarm smoke confirmed a spawned
  // swarm subagent's forced write is hook-denied). The safety chain is intact:
  //   - The hook engine (session/hooks/{engine,runner}.ts) and the
  //     pre-tool-call-hook.ts policy are byte-identical 0.12.0→0.14.1; the only
  //     change under session/hooks/ is an additive `Interrupt` event type
  //     (types.ts), inert for a PreToolUse-only consumer.
  //   - The stream-json writer (writeResumeHint/PromptJsonWriter) and the
  //     records/ dir are byte-identical; the goal.summary shape is unchanged
  //     (smoke parsed turnsUsed/tokensUsed/goalId cleanly on 0.14.1).
  //   - CLI argv (options.ts/commands.ts) is byte-identical 0.12.0→0.14.1.
  // PreToolCallHookPermissionPolicy is STILL index 0. Two permission-stack
  // changes, both compat-benign:
  //   - NEW AgentSwarmExclusiveDenyPermissionPolicy at index 1 (#643):
  //     a pure DENY that fires only on multi/mixed-AgentSwarm batches
  //     ("first non-undefined wins" → it can never pre-empt the index-0 hook).
  //     It enforces "one AgentSwarm per response, alone in its batch" — a
  //     behavioral refinement for /kimi:swarm coordinators, not a write surface.
  //   - REMOVED CwdOutsideFileWriteAskPermissionPolicy: this was an `ask`
  //     policy sitting AFTER auto-mode-approve, so it was already dead in `-p`
  //     auto mode. Its removal opens zero new write surface — the plugin owns
  //     workspace confinement via rescue-approval.ts, never kimi's cwd-ask.
  //   NB: the new index-1 deny shifts AutoModeApprovePermissionPolicy from
  //   index 4 (its position 0.6.0–0.12.0) to index 5 in 0.14.1. The STRUCTURAL
  //   invariant is unchanged — every policy between the index-0 hook and the
  //   first approve is a DENY, so nothing approves before the hook denies.
  // Other 0.13/0.14 additions are off our `-p` path: a new packages/protocol/
  // REST+WebSocket control API (a separate transport — run-prompt.ts does not
  // import it; `-p` stdout stays the direct PromptJsonWriter), session-lifecycle
  // changes that only HELP our cancellation story (active-turn cancel on close +
  // BACKGROUND_KEEP_ALIVE_ON_EXIT default flipped true→false), an `alwaysThinking`
  // model-capability flag (read-only detection, the H5 thinking-control knob is
  // still upstream-blocked), a SIGHUP cleanup handler (exit 129; SIGTERM still
  // exits 143 and runs cleanup — our SIGTERM→SIGKILL reaping is unaffected), and
  // a new builtin `import-from-cc-codex` skill (not a plugin surface).
  // See .claude/kimi-code-research/reports/72-76 for the audit reports.
  // Tag: compat-verified-kimi-code-0.14.1.
  { major: 0, minor: 13 },
  { major: 0, minor: 14 },
  // 0.14.2 (patch, 2026-06-13) verified COMPAT-PRESERVED within the already-
  // listed {0,14} — no array change needed (membership is minor-level).
  // The 0.14.1→0.14.2 diff leaves our surfaces 0-byte: the permission policy
  // queue (PreToolCallHookPermissionPolicy still index 0), the hook engine
  // (session/hooks/), and the stream-json writer + records/ are all unchanged,
  // and the AgentSwarm tool name is unchanged. The patch is a repo-wide
  // `.md`→`.md?raw` bundler-import migration + a Bash-tool stdout/stderr
  // streaming `onUpdate` callback (observability; approval path untouched) + a
  // run-prompt.ts config-diagnostics line written to STDERR (humans-only) +
  // removal of three `!promptMode`-gated CLI conflict checks (dead in `-p`).
  // Backed by a GREEN `bun run smoke:real` on the operator's auto-upgraded
  // 0.14.2 binary (review/challenge/ask/review_gate hook-denied; pursue
  // goal-mode wrote zero files; swarm subagent write hook-denied).
  // Tag: compat-verified-kimi-code-0.14.2.
  // 0.14.3 (patch, 2026-06-14) verified COMPAT-PRESERVED within the already-
  // listed {0,14} — no array change needed. All four scoped diffs
  // (@moonshot-ai/kimi-code@0.14.2..0.14.3) are 0-byte: run-prompt.ts +
  // options.ts/commands.ts, the permission policy queue
  // (PreToolCallHookPermissionPolicy still index 0), the hook engine, and
  // records/ + session/. The entire patch is one TUI change — PR #713,
  // "Refresh provider model metadata before opening the model picker": the
  // interactive `/model` slash command (tui/commands/config.ts +
  // dispatch.ts) now calls a new `refreshOAuthProviderModels()` (a scoped
  // 'oauth' variant added to tui/controllers/auth-flow.ts +
  // tui/utils/refresh-providers.ts) with a 2s timeout before opening the
  // picker. None of it is on the `-p` headless path (refreshAllProviderModels
  // is invoked only from the TUI auth-flow controller; the sole reference
  // outside tui/ is a JSDoc mention in cli/sub/provider.ts, the `kimi
  // provider` subcommand we never invoke, which doesn't call it; the new
  // `scope` param is optional, defaulting to 'all'). Backed by a GREEN `bun run
  // smoke:real` on the operator's 0.14.3 binary (7 pass / 0 fail;
  // review/challenge/ask/review_gate hook-denied; pursue goal-mode wrote
  // zero files; swarm subagent write hook-denied).
  // Tag: compat-verified-kimi-code-0.14.3.
];

export interface KimiVersionProbeOk {
  readonly kind: "ok";
  /** Verbatim version string from `kimi --version` (e.g. `"0.2.0"`). */
  readonly version: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** True when {major, minor} appears in KIMI_TESTED_MINORS. */
  readonly inTestedRange: boolean;
}

export interface KimiVersionProbeFailed {
  readonly kind: "failed";
  /** Why the probe didn't return a usable version. */
  readonly reason: string;
}

export type KimiVersionProbeResult = KimiVersionProbeOk | KimiVersionProbeFailed;

/**
 * Spawn `<kimi-bin> --version` and parse the output. Never throws;
 * failures resolve to `{kind: "failed", reason}` so callers can decide
 * the policy. The kimi binary path defaults to bare `kimi` (PATH
 * lookup); callers that need an explicit absolute path should pass it.
 *
 * Output contract: kimi-code 0.1.x and 0.2.x both write a single line
 * like `0.2.0` (sometimes with leading "v") to stdout and exit 0. We
 * tolerate either form and any trailing whitespace.
 */
export async function probeKimiVersion(options: {
  kimiBin?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<KimiVersionProbeResult> {
  const bin = options.kimiBin ?? "kimi";
  const timeoutMs = options.timeoutMs ?? KIMI_VERSION_PROBE_TIMEOUT_MS;
  return await new Promise<KimiVersionProbeResult>((resolve) => {
    let settled = false;
    const settle = (result: KimiVersionProbeResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ["--version"], {
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      settle({
        kind: "failed",
        reason: `spawn failed: ${(err as Error).message}`,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // best effort
      }
      settle({ kind: "failed", reason: `\`${bin} --version\` timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      settle({
        kind: "failed",
        reason: `spawn error: ${err.message}`,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.trim() !== "" ? stderr.trim() : `exit ${code}`;
        settle({
          kind: "failed",
          reason: `\`${bin} --version\` failed: ${detail}`,
        });
        return;
      }
      const parsed = parseVersionLine(stdout);
      if (parsed === undefined) {
        settle({
          kind: "failed",
          reason: `could not parse \`${bin} --version\` output: ${JSON.stringify(stdout.slice(0, 80))}`,
        });
        return;
      }
      settle({
        kind: "ok",
        version: parsed.raw,
        major: parsed.major,
        minor: parsed.minor,
        patch: parsed.patch,
        inTestedRange: isInTestedRange(parsed.major, parsed.minor),
      });
    });
  });
}

/**
 * Parse a `kimi --version` stdout into a structured version. Accepts
 * bare semver (`0.2.0`), `v`-prefixed (`v0.2.0`), and trailing
 * pre-release / build metadata (`0.2.0-beta.1`, `0.2.0+sha.abc`). The
 * major/minor/patch numbers are the leading three components only —
 * pre-release / build metadata is preserved in `raw` but doesn't
 * affect the tested-range check.
 *
 * Returns undefined when the leading line doesn't look like a version.
 */
export function parseVersionLine(stdout: string): {
  raw: string;
  major: number;
  minor: number;
  patch: number;
} | undefined {
  const firstLine = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (firstLine === undefined) return undefined;
  const trimmed = firstLine.trim().replace(/^v/, "");
  const match = trimmed.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  if (match === null) return undefined;
  return {
    raw: trimmed,
    major: Number.parseInt(match[1]!, 10),
    minor: Number.parseInt(match[2]!, 10),
    patch: Number.parseInt(match[3]!, 10),
  };
}

export function isInTestedRange(major: number, minor: number): boolean {
  return KIMI_TESTED_MINORS.some((entry) => entry.major === major && entry.minor === minor);
}

/**
 * The newest `{major, minor}` in the tested set — the known-good upper bound
 * (H9). Set-membership in `isInTestedRange` already warns for anything outside
 * the tested range; this lets the warning distinguish the COMMON case (a kimi
 * release NEWER than our last compat audit — likely fine but unverified) from a
 * below/gap version, which is the more suspicious shape.
 */
export function maxTestedMinor(): { major: number; minor: number } {
  return KIMI_TESTED_MINORS.reduce((max, entry) =>
    entry.major > max.major || (entry.major === max.major && entry.minor > max.minor)
      ? entry
      : max,
  );
}

/**
 * Format a user-facing warning line for an out-of-range version probe.
 * Includes the canonical "not a block, just a heads up" framing so the
 * caller agent doesn't misinterpret this as fatal.
 */
export function formatVersionOutOfRangeWarning(probe: KimiVersionProbeOk, pluginVersion: string): string {
  const tested = KIMI_TESTED_MINORS.map((entry) => `${entry.major}.${entry.minor}.x`).join(", ");
  const max = maxTestedMinor();
  const aboveMax =
    probe.major > max.major || (probe.major === max.major && probe.minor > max.minor);
  const lines = [
    `WARNING: kimi-code version ${probe.version} is outside the range kimi-plugin-cc ${pluginVersion} was tested against (${tested}).`,
  ];
  if (aboveMax) {
    // H9: the known-good upper bound. Above it = a release newer than our last
    // compat audit — usually fine, but unverified (and the case the version
    // probe exists to flag when out-of-band auto-upgrade drifts the binary).
    lines.push(
      `  This is NEWER than the newest version we have tested (${max.major}.${max.minor}.x) — likely fine, but unverified; kimi-code behaviors may have changed since our last compatibility audit.`,
    );
  }
  lines.push(
    `  The plugin will still run, but a silent breakage may exist for behaviors that changed in your version.`,
    `  If something looks off (missing session ids, malformed records, hook bypasses), check the kimi-code changelog`,
    `  for changes since the last tested range and report mismatches via the plugin issue tracker.`,
  );
  return lines.join("\n");
}
