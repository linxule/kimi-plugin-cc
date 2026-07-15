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
export const KIMI_TESTED_MINORS = [
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
    //     subagents use the STANDARD permission stack (hook at index 0, NO
    //     deny-all): the lone DenyAllPermissionPolicy.unshift in subagent-host.ts
    //     is inside startBtw() (the side-question/"btw" path), NOT the swarm spawn
    //     path (re-verified against the 0.18.0 checkout 2026-06-20 during the v1.4
    //     write-swarm build — earlier notes here mis-cited it as "inherit
    //     deny-all"). So a `coder` swarm subagent's write IS gated solely by our
    //     index-0 hook — which is exactly what makes /kimi:swarm --write possible.
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
    // 0.15 (new minor, 2026-06-16) verified COMPAT-PRESERVED — added to the
    // tested set because crossing the 0.14→0.15 minor boundary fired the H9
    // "newer than tested max" probe warning (the operator's binary auto-upgraded
    // to 0.15.0 out-of-band, PR #334 drift). All four scoped diffs
    // (@moonshot-ai/kimi-code@0.14.3..0.15.0) leave our load-bearing surfaces
    // 0-byte, re-confirmed independently by `git diff` byte-count (not just
    // report 78): permission/ (PreToolCallHookPermissionPolicy STILL index 0,
    // AgentSwarmExclusiveDenyPermissionPolicy still index 1), the hook engine
    // (agent + session hooks/), run-prompt.ts, and cli commands.ts/options.ts.
    // The only changed scoped surface is records/ + session/ (~5.3 KB), all
    // internal persistence/plumbing off the -p path: PR #786 drops
    // app_version/resumed from the persisted .records/ metadata artifact (NOT
    // the -p stdout stream — that writer is the byte-identical PromptJsonWriter),
    // a SessionSkillRegistry rename (#784), and a static model-capability lookup
    // (#776). 0.15.0 also adds an ADDITIVE `transport:'sse'` MCP config variant
    // (config/schema.ts) the plugin never writes, plus TUI/system-prompt churn.
    // Backed by a GREEN `bun run smoke:real` on the operator's 0.15.0 binary
    // (report 78: 7 pass / 0 fail; review/challenge/ask/review_gate hook-denied;
    // pursue goal-mode wrote zero files, goal.summary parsed cleanly
    // turnsUsed:2 tokensUsed:51199; swarm subagent write hook-denied).
    // See .claude/kimi-code-research/reports/78-upstream-0150-surface.md.
    // Tag: compat-verified-kimi-code-0.15.0.
    { major: 0, minor: 15 },
    // 0.16 (new minor, 2026-06-17) verified COMPAT-PRESERVED — the operator's
    // binary auto-upgraded 0.15.0→0.16.0 within a day (PR #334 drift), re-firing
    // the H9 "newer than tested max" probe warning. permission/, the hook engine
    // (agent + session hooks/), and run-prompt.ts are 0-byte vs 0.15.0
    // (independent `git diff` byte-count). The only CLI argv change registers a
    // new `kimi vis` subcommand (a visualization server) — off the -p path; our
    // -p/-r/--output-format/-m/--skills-dir flags are untouched. The records/ +
    // session/ + replay/ + agent/ changes (a compaction refactor, a new
    // llm-request-logger, replay-build additions) are internal and off the -p
    // stdout stream our parser reads. Backed by a GREEN `bun run smoke:real` on
    // the operator's 0.16.0 binary (7 pass / 0 fail; review/challenge/ask/
    // review_gate hook-denied; pursue goal-mode wrote zero files, goal.summary
    // parsed cleanly turnsUsed:2 tokensUsed:52211; swarm subagent write denied).
    // Tag: compat-verified-kimi-code-0.16.0.
    { major: 0, minor: 16 },
    // 0.17 / 0.18 added in v1.2.6 (2026-06-19) — the 0.16.0→0.18.0 jump
    // (0.17.0/0.17.1/0.18.0) verified COMPAT-PRESERVED by a reproduced
    // source-level audit. The operator's binary auto-upgraded past the tested
    // 0.16 max (PR #334 drift), firing the H9 "newer than tested max" probe
    // warning. The safety chain is intact:
    //   - 03-hooks.diff is 0 bytes (BOTH agent/hooks/ AND session/hooks/) and
    //     pre-tool-call-hook.ts is 0-byte 0.16.0→0.18.0 — the hook engine and the
    //     policy that wires our PreToolUse hook in are byte-identical.
    //   - PreToolCallHookPermissionPolicy is STILL index 0,
    //     AgentSwarmExclusiveDenyPermissionPolicy still index 1, and
    //     AutoModeApprovePermissionPolicy still index 5 (the first approve; every
    //     policy between the index-0 hook and it is a DENY). The ONLY permission
    //     change is a NEW GoalStartReviewAskPermissionPolicy (#839, "guided goal
    //     authoring") inserted at index ~10 (AFTER auto-mode-approve): an `ask`
    //     gated to a MODEL-ISSUED CreateGoal in NON-auto mode (it returns early
    //     when permission.mode === 'auto'), so it is triple-dead on the `-p` auto
    //     path and is an `ask` that cannot approve a write. It does not affect
    //     /kimi:pursue, which uses the /goal COMMAND path, runs auto, and is
    //     governed by the index-0 hook on every turn.
    //   - options.ts is BYTE-IDENTICAL (argv intact: -p/-r/--output-format/-m/
    //     --skills-dir; --auto/--yolo/--plan still rejected with -p). run-prompt.ts
    //     changes ONLY in a telemetry refactor (the `started` event moved into
    //     harness `sessionStartedProperties`); the permission-forcing chain
    //     (permission:'auto', forcePromptPermission, installHeadlessHandlers) and
    //     the stream-json writer (PromptJsonWriter/resume_hint/goal.summary) are
    //     unchanged.
    // Off-path additions (all benign for a `kimi -p` wrapper):
    //   - A new `kimi server`/`kimi web` subcommand stack (#625, "Kimi web app +
    //     daemon gateway") — like `vis`/`doctor`, never invoked; the plugin passes
    //     the prompt as the VALUE of `-p`, never a bare positional.
    //   - Session ARCHIVE (#625): an `archived` flag + archive()/includeArchive in
    //     the session store + rpc core-api (the surface the Kimi web UI lists/
    //     archives sessions through). The plugin owns its OWN SQLite job store and
    //     never reads kimi's session list — off our path.
    //   - OAuth-error fidelity (provider-manager throws the original error instead
    //     of re-wrapping every failure as loginRequired) — off the -p stdout shape;
    //     an expired token still surfaces as auth.login_required (the smoke's
    //     operator-auth false-alarm note in docs/upstream-compat-audit.md holds).
    //   - git-context process disposal + a turn-counter restore fix
    //     (records/index.ts, the record-RESTORE path) — both off the -p stdout
    //     stream our parser reads.
    //   - NEW in 0.18.0: KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY (#888) — an opt-in
    //     HARD cap on concurrent AgentSwarm subagents. /kimi:swarm now sets it from
    //     --cap (v1.2.6); older binaries ignore the unknown env var.
    // SMOKE: the 0.16.0→0.18.0 source audit was prepared in a cloud session with
    // no kimi binary, so its Phase 1b smoke was deferred. It was then run locally
    // against the operator's installed 0.18.0 binary before merge — GREEN, 7 pass
    // / 0 fail: review/challenge/ask/review_gate forced writes hook-denied; pursue
    // multi-turn goal wrote zero files (`goal.summary` parsed cleanly turnsUsed:2);
    // a spawned swarm subagent's forced write hook-denied. Six-reviewer + adversarial
    // re-verification all returned CONFIRMED-SAFE (the new --cap → env wiring round-
    // trips safely across 19 edge inputs; identical positive-integer validator).
    // Tag: compat-verified-kimi-code-0.18.0.
    { major: 0, minor: 17 },
    { major: 0, minor: 18 },
    // 0.19 (new minor, 2026-06-23) verified COMPAT-PRESERVED — added to the
    // tested set in v1.5.1 because crossing the 0.18→0.19 minor fired the H9
    // "newer than tested max" probe warning (the operator's binary auto-upgraded
    // 0.18.0→0.19.1 out-of-band, PR #334 drift). Backed by a GREEN
    // `bun run smoke:real` on the operator's 0.19.1 binary (9 pass / 0 fail):
    // review/challenge/ask/review_gate forced writes hook-denied; pursue
    // multi-turn goal wrote zero files (`goal.summary` parsed cleanly
    // turnsUsed:2 tokensUsed:73631); a spawned read-only swarm subagent's forced
    // write hook-denied; and BOTH write-swarm assertions held on 0.19.1 — a
    // `coder` subagent's edits landed only in the throwaway worktree
    // (patchBytes=306, userTreeClean=true) and an out-of-trusted-root absolute
    // write was hook-denied. The safety chain is intact:
    //   - 03-hooks.diff is 0 bytes (BOTH agent/hooks/ AND session/hooks/) —
    //     the hook engine is byte-identical 0.18.0→0.19.1.
    //   - The permission policy queue (policies/index.ts) is BYTE-IDENTICAL:
    //     PreToolCallHookPermissionPolicy STILL index 0,
    //     AgentSwarmExclusiveDenyPermissionPolicy index 1,
    //     AutoModeApprovePermissionPolicy index 5 (first approve; every policy
    //     between the index-0 hook and it is a DENY). `permission:'auto'` is
    //     still hard-coded in run-prompt.ts createSession.
    // The minor that bumped 0.18→0.19.0 is #812 "workspace add-dir support"
    // (commit c0eeca2): a new repeatable --add-dir <dir> flag, additionalDirs
    // plumbed through Session, and GitCwdWriteApprovePermissionPolicy widened to
    // approve writes within cwd OR any additional dir. Compat-benign for the
    // plugin — but NOT because additionalDirs is empty (see the CORRECTION
    // below). The real reasons:
    //   - GitCwdWriteApprovePermissionPolicy is the ONLY permission consumer of
    //     additionalDirs (git-cwd-write-approve.ts:26 is the sole
    //     getAdditionalDirs() call in agent/permission/), and it sits at index 17
    //     — the last approve before FallbackAsk (the tail at index 18), BELOW
    //     AutoModeApprovePermissionPolicy (index 5). On the `-p` auto path
    //     auto-approve decides first for anything the index-0 hook did not deny,
    //     so GitCwdWriteApprove is STRUCTURALLY UNREACHABLE → its add-dir
    //     widening is dead for us regardless of what additionalDirs contains.
    //   - Read-only commands: the index-0 hook denies every write before any
    //     approve policy runs. Write commands (rescue/pursue/swarm-write): the
    //     index-0 hook confines to a SINGLE root via rescue-approval.ts, which
    //     never reads additionalDirs — the upstream widening cannot leak into our
    //     allowlist. The 0.19.1 smoke proves it empirically (write-swarm
    //     userTreeClean=true; an out-of-trusted-root write hook-denied).
    //   - isWithinWorkspace with additionalDirs=[] is byte-for-byte the old
    //     isWithinDirectory(cwd) (path-access.ts:159-163 checks workspaceDir then
    //     loops the list), so even in the non-`-p` modes where GitCwdWriteApprove
    //     DOES run, the empty-list case is unchanged.
    // CORRECTION to an earlier mental model: additionalDirs is NOT guaranteed
    // empty for a plugin `-p` spawn even with no --add-dir. #812 also wired an
    // UNCONDITIONAL read of the project-local <root>/.kimi-code/local.toml
    // `[workspace] additional_dir` into BOTH the -p create AND resume bootstraps
    // (rpc/core-impl.ts:238 createSessionWithOverrides + :363
    // resumeSessionWithOverrides, via config/workspace-local.ts; both ABSENT at
    // 0.18.0). So getAdditionalDirs() can be non-empty whenever such a file
    // exists in the repo — but per the reasons above that changes no approve/deny
    // decision on our path. (Swarm `coder` subagents inherit the coordinator's
    // additionalDirs; the same index-0 hook gating applies.)
    // Other 0.18.0→0.19.1 changes are off the `-p` path: #963 (commit 4292ae9)
    // adds a new `turn.ended` terminal `reason:'filtered'` (provider content
    // filter) surfaced as a human string — a new failure REASON, not a new
    // stdout record SHAPE, so the role-keyed stream-json parser is unaffected;
    // #821 (detach-to-background) was already triaged in the forward-scans; and
    // 0.19.1 over 0.19.0 is ci/ACP/kimi-web-UI only (0-byte load-bearing diff —
    // its #992 `fix(acp)` only re-routes the workspace-local read's kaos handle).
    // NEXT-AUDIT NOTE: the workspace-local additional_dir auto-load is LIVE on
    // the -p path NOW (shipped 0.19.0/#812, not a future risk). It stays
    // hook-bound for us, but the "plugin never passes --add-dir ⟹ additionalDirs
    // empty" assumption is broken upstream — re-confirm each audit that the
    // index-0 hook still pre-empts GitCwdWriteApprove, and consider a defensive
    // assert/scrub if a future minor lets additionalDirs reach a policy ABOVE our
    // hook. See .claude/kimi-code-research/reports/85-upstream-0191-surface.md.
    // Tag: compat-verified-kimi-code-0.19.1.
    { major: 0, minor: 19 },
    // 0.20 (new minor, 2026-06-26) verified COMPAT-PRESERVED — the operator's
    // binary auto-upgraded 0.19.2→0.20.0 (PR #334 drift), crossing the 0.19→0.20
    // minor and firing the H9 "newer than tested max" probe warning. (npm went
    // straight 0.19.2→0.20.0; no 0.19.3. 0.19.1→0.19.2 was already 0-byte on all
    // load-bearing surfaces — report 86 — so the 0.19.1..0.20.0 diff below loses
    // no signal.) The safety chain is intact, re-verified by `git diff … | wc -c`:
    //   - 02-permission.diff is 0 bytes AND 03-hooks.diff is 0 bytes (BOTH
    //     agent/hooks/ AND session/hooks/) — the permission policy queue and the
    //     hook engine are byte-identical 0.19.1→0.20.0.
    //   - policies/index.ts, pre-tool-call-hook.ts, run-prompt.ts, options.ts, and
    //     agent/records/ are ALL 0-byte. PreToolCallHookPermissionPolicy STILL
    //     index 0, AgentSwarmExclusiveDeny index 1, AutoModeApprove index 5 (the
    //     first approve; every policy between the index-0 hook and it is a DENY).
    //     `permission:'auto'` still hard-coded in run-prompt.ts.
    //   - A broad-sweep risk scan over EVERY file changed OUTSIDE the five scoped
    //     diffs found ZERO new permission/approval decisions anywhere outside the
    //     (0-byte) permission+hooks dirs, and no swarm-subagent spawn/permission
    //     change — so read/write-swarm `coder` subagents are still gated solely by
    //     the index-0 hook.
    // Notable 0.20.0 changes, all compat-benign for a `kimi -p` wrapper:
    //   - #1040 AGENTS.md-oversized `warning` agent event: SWALLOWED on -p
    //     (run-prompt.ts:495 `case 'warning': return;` — no stdout.write, shared
    //     with subagent.*/compaction.*/goal.updated). Invisible to our role-keyed
    //     runtime/stream-json.ts parser; reaches only the RPC getSessionWarnings
    //     accessor (TUI/kimi-web) + the logger.
    //   - #1065 Write auto-creates missing parent dirs (ensureParentDirectory
    //     recursive mkdir on ENOENT). The `path` field name is INTACT
    //     (WriteInputSchema = z.object({ path, content }); Bash still `command`),
    //     so rescue-approval.ts::extractFilePath is unaffected (the v1.4.1 lesson).
    //     mkdir runs on the parent of an ALREADY-hook-approved path → can only
    //     create dirs INSIDE a path the index-0 hook approved; no workspace escape.
    //   - #1062 tool-result budget: adds a `truncated` flag to tool-result CONTENT
    //     (loop/tool-call.ts normalizeToolResult), NOT the serialized record SHAPE
    //     (records/ + run-prompt.ts 0-byte). It ALSO persists tool results >50,000
    //     chars to `<agent.homedir>/tool-results/<stem>-<uuid>.txt`
    //     (agent/turn/tool-result-budget.ts, homedir = this.agent.homedir = the
    //     KIMI home, NOT the workspace cwd) — a kimi-internal artifact off the
    //     user's tree, same class as ~/.kimi-code/logs/. Does NOT touch the user
    //     tree → no violation of "read-only commands write zero files in the repo".
    //   - commands.ts `-C`→`-c` continue rename (+ hidden `-C` alias): off our flag
    //     set (-p/-r/--output-format/-m/--skills-dir); run-prompt.ts/options.ts 0-byte.
    //   - NEW RPC runShellCommand/cancelShellCommand (CoreAPI/SessionAPI): a
    //     HOST-initiated shell exec (TUI `!command` / kimi-web) that calls
    //     bash.resolveExecution().execute() DIRECTLY, bypassing the permission
    //     stack + PreToolUse hook. NOT model-reachable: it is not a model tool
    //     (absent from the tool registry) and absent from installHeadlessHandlers /
    //     the whole apps/kimi-code/src/cli/ -p path. The plugin spawns `kimi -p`
    //     and never opens an RPC channel → unreachable. WATCH (next audit):
    //     re-confirm it stays RPC/TUI-only and never reaches the -p headless path
    //     or the model tool registry — it is the first permission-bypassing
    //     shell-exec in agent-core.
    //   - forcePluginSessionStartReminder resume override (rpc/core-impl.ts): set
    //     ONLY via reloadSession (the /reload RPC flow). The plugin's -p -r resume
    //     uses plain harness.resumeSession → never set; appendPluginSessionStart
    //     Reminder cannot fire on our path. config/ is 0-byte (the 0.19.0/#812
    //     workspace-local additional_dir auto-load is unchanged; GitCwdWriteApprove,
    //     its sole consumer at index 17, stays dead below auto-approve on -p).
    //   - kimi server/web daemon stack (cli/sub/server/* — access-urls, networks,
    //     rotate-token, daemon lifecycle): a separate transport, never invoked; the
    //     new stdout.writes there are off the -p path.
    // SMOKE: NOT run for this certification. `bun run smoke:real` against the
    // operator's 0.20.0 binary went RED on a provider 403 "usage limit for this
    // billing cycle" — records:[] on every label, the model never issued a single
    // tool call (0 hook-bypasses observed). This is the operator-billing-state
    // false-alarm class (cf. the auth.login_required note in
    // docs/upstream-compat-audit.md), NOT a compat break — a true break shows the
    // model ATTEMPTING a write and the hook NOT denying. The operator elected to
    // certify on the source audit (manual byte-level + multi-agent re-audit) and
    // skip the quota-blocked smoke; re-run `bun run smoke:real` once quota refreshes
    // to earn the end-to-end proof. See
    // .claude/kimi-code-research/reports/88-upstream-0200-surface.md.
    // Tag: compat-verified-kimi-code-0.20.0.
    // 0.20.1 / 0.20.2 (patches, 2026-06-27 / 2026-06-29) verified COMPAT-PRESERVED
    // within the already-listed {0,20} — no array change (membership is minor-level;
    // H9 stays silent). 02-permission.diff 0-byte (PreToolCallHookPermissionPolicy
    // still index 0, AutoModeApprove index 5); agent/records/ 0-byte (stream-json
    // shape unchanged); run-prompt.ts permission/writer chain unchanged (only
    // telemetry property renames, #1184). The hook engine DID change — #1127 "support
    // hooks in plugins" (0.20.1): rpc/core-impl.ts create+resume now merge enabled
    // kimi-code PLUGIN manifest hooks into the -p session hook list ([...config.hooks,
    // ...plugins.enabledHooks()]). Compat-benign: engine aggregation is any-block-wins
    // (session/hooks/engine.ts blockDecision = first action:'block' wins; an allow
    // never pre-empts a block), so a plugin hook can only ADD denials, never override
    // our managed PreToolUse deny. Our config.toml managed block is unaffected: the
    // config HookDefSchema is .strict(), so the new per-hook cwd/env fields are
    // programmatic/plugin-only (no config-injection vector). NEW load-bearing
    // invariant: hook AGGREGATION semantics (we are no longer the sole -p hook) —
    // re-verify blockDecision stays find-first-block each audit. Off-path: #1170/#1186
    // Anthropic-protocol/betaApi transport plumbing (config protocol/betaApi alias
    // fields + provider-manager; off the -p stdout shape + permission stack), #1125
    // upgrade->update alias, #1129/#1156 compaction cap, #1128 server --allowed-host.
    // 0.20.0 runShellCommand/cancelShellCommand RPC WATCH discharged (still RPC/TUI-
    // only, unreachable from kimi -p). SMOKE: GREEN on 0.20.2 — `bun run smoke:real`
    // 9 pass / 0 fail (2026-06-29) on the operator's 0.20.2 binary: review/challenge/
    // ask/review_gate forced writes hook-denied; pursue multi-turn goal wrote zero
    // files (goal.summary parsed cleanly turnsUsed:2 tokensUsed:85770); a read-only
    // swarm subagent's forced write hook-denied; and BOTH write-swarm assertions held
    // (coder edits confined to the throwaway worktree, patchBytes=334,
    // userTreeClean=true; an out-of-trusted-root absolute write hook-denied). The
    // earlier report-88 0.20.0 quota block (provider 403 "usage limit") was the
    // operator-billing-state false alarm, now cleared — the {0,20} line is end-to-end
    // proven on 0.20.2. Tag: compat-verified-kimi-code-0.20.2.
    // See .claude/kimi-code-research/reports/89, 90, 91-upstream-020x-surface.md.
    { major: 0, minor: 20 },
    // 0.21 (new minor, 2026-07-01) verified COMPAT-PRESERVED — the operator's
    // binary auto-upgraded to 0.21.1 (PR #334 drift), crossing the 0.20→0.21
    // minor and firing the H9 "newer than tested max" probe warning. Report 93's
    // source audit found the two load-bearing surfaces byte-identical across the
    // full 0.20.2→0.21.1 span: 02-permission.diff 0 bytes (hook still index 0,
    // AutoModeApprove still index 5, every policy between is a DENY) and
    // 03-hooks.diff 0 bytes (hook engine and any-block-wins aggregation intact).
    // Also 0-byte: options.ts (argv), agent/records/ (stream-json shape),
    // workspace-local.ts (additional_dir auto-load unchanged), and
    // tools/builtin/file/{write,edit}.ts (`path` field intact). run-prompt.ts
    // still hard-codes permission:'auto' and installHeadlessHandlers; its only
    // scoped change is a cleanup timeout (#1233) after resume_hint/goal.summary
    // flush, which helps process reaping.
    // New 0.21.0 surfaces are compat-benign for a `kimi -p` wrapper:
    //   - #1204 plugin slash commands are RPC/host-initiated, absent from the
    //     cli/ -p path, not model tools, and macro-expand into prompt text that
    //     still goes through the index-0 hook. They are main-agent-only; swarm
    //     coders do not receive them. NEXT-AUDIT: re-confirm activation stays
    //     off the -p path and never becomes a model tool.
    //   - The thinking-effort/model-catalog refactor is provider config plumbing
    //     the plugin does not set or consume. H5 opportunity, not a risk.
    //   - Compaction rework and record migrations are internal replay/history
    //     changes; the live PromptJsonWriter + agent/records/ shape is unchanged.
    //   - The 0.20.0 runShellCommand/cancelShellCommand RPC WATCH is discharged
    //     again: still RPC/TUI-only, absent from cli/, and unreachable from kimi -p.
    // Backed by a GREEN `bun run smoke:real` on the operator's 0.21.1 binary
    // (2026-07-01): 9 pass / 0 fail. review/challenge/ask/review_gate forced
    // writes hook-denied; pursue goal mode wrote zero files and parsed
    // goal.summary (turnsUsed:2 tokensUsed:57595); a read-only swarm subagent's
    // forced write was hook-denied; write-swarm kept coder edits in the throwaway
    // worktree (patchBytes=334, userTreeClean=true, worktreeCleaned=true); and an
    // out-of-trusted-root absolute write was hook-denied. Reports:
    // .claude/kimi-code-research/reports/93-upstream-021-surface.md and
    // 93-upstream-021-adversarial.md. Tag: compat-verified-kimi-code-0.21.1.
    { major: 0, minor: 21 },
    // 0.22 (new minor, 2026-07-05) verified COMPAT-PRESERVED through
    // @moonshot-ai/kimi-code@0.22.3 after report 94's source-only 0.22.0 scan and
    // report 95's incremental 0.22.0→0.22.3 scan. Hook engine remained unchanged
    // (03-hooks.diff 0 bytes); policy order stayed hook-first with
    // PreToolCallHookPermissionPolicy at index 0 and AutoModeApprove at index 5;
    // Write/Edit still use `path`, Bash still uses `command`, and AgentSwarm still
    // uses the standard stack. New 0.22.x surfaces are compat-benign for this
    // `kimi -p` wrapper: prompt-mode background-drain runs after assistant output
    // flush and remains bounded by the plugin's AbortController budgets; shell
    // output caps affect huge tool-result content only; image originals are stored
    // under Kimi session state, not the user worktree; model/thinking/provider
    // config changes do not touch permissions; server auth-bypass flags remain
    // off the `-p` path. Backed by a GREEN `bun run smoke:real` against a
    // temp-installed 0.22.3 binary (2026-07-05): 9 pass / 0 fail. Read-only labels
    // denied forced writes; pursue wrote zero files and parsed goal.summary
    // (turnsUsed:2 tokensUsed:93029); read-only swarm denied a spawned subagent
    // write; write-swarm confined coder edits to the throwaway worktree
    // (patchBytes=334, userTreeClean=true, worktreeCleaned=true); and an
    // out-of-trusted-root absolute write was hook-denied. Reports:
    // .claude/kimi-code-research/reports/94-upstream-0220-surface.md and
    // 95-upstream-0223-surface.md. Tag: compat-verified-kimi-code-0.22.3.
    { major: 0, minor: 22 },
    // 0.23 (new minor, 2026-07-07) verified COMPAT-PRESERVED through
    // @moonshot-ai/kimi-code@0.23.1 in report 96 plus a GREEN temp-binary
    // smoke (9 pass / 0 fail). Hook engine remained unchanged (03-hooks.diff
    // 0 bytes); policy order stayed hook-first with PreToolCallHookPermissionPolicy
    // at index 0 and AutoModeApprove at index 5; `kimi -p` still writes the same
    // stream-json records plus session.resume_hint/goal.summary; Write/Edit still
    // use `path`; plugin hooks remain merged any-block-wins; AgentSwarm read and
    // write-smoke confinement both held. New 0.23.x surfaces are compat-benign:
    // `select_tools` is an upstream default-approved MCP schema disclosure tool,
    // but our hook still denies unknown tools before default approval and the
    // smoke passed without broadening READ_ONLY_TOOLS; observability wire records,
    // session workDir/index repair, thinking-keep defaults, and workspace-skill
    // listing do not change the plugin's hook or stdout contract. Report:
    // .claude/kimi-code-research/reports/96-upstream-0231-surface.md. Tag:
    // compat-verified-kimi-code-0.23.1.
    // 0.23.2 (patch, 2026-07-08) verified COMPAT-PRESERVED within the already-
    // listed {0,23}: scoped 0.23.1→0.23.2 diffs changed only `run-prompt.ts`
    // cleanup/exit behavior and `session/hooks/runner.ts` Windows spawn UX.
    // `02-permission.diff` stayed 0 bytes (hook still index 0; first approve
    // still index 5), `05-session-bootstrap.diff` stayed 0 bytes, and the
    // non-empty `04-wire-records.diff` was only the same `session/hooks/runner.ts`
    // hunk re-included by the broader `session/` scope — no
    // session.resume_hint/goal.summary/output-shape drift. The 0.23.2
    // `run-prompt.ts` change (#1483) keeps the cleanup timeout ref'd so a
    // failed headless `-p` run cannot drain the event loop and exit 0 before the
    // rejection propagates; this is exit-code correctness, not a permission or
    // writer change. The hook-runner change (#1466) adds `windowsHide:true` to
    // hook child-process spawn options, eliminating flashing console windows on
    // Windows without altering stdin JSON shape, exit-2-as-deny semantics, or
    // any-block-wins aggregation. Backed by a GREEN temp-binary `bun run
    // smoke:real` on 0.23.2 (2026-07-08): 9 pass / 0 fail. Read-only labels
    // denied forced writes; pursue wrote zero files and parsed goal.summary;
    // read-only swarm denied a spawned subagent write; write-swarm confined
    // coder edits to the throwaway worktree (patchBytes=306, userTreeClean=true,
    // worktreeCleaned=true); and an out-of-trusted-root absolute write was
    // hook-denied. Report:
    // .claude/kimi-code-research/daily-monitor/2026-07-08-upstream-monitor.md.
    // Tag: compat-verified-kimi-code-0.23.2.
    // 0.23.3/0.23.4 (patches, 2026-07-09) verified COMPAT-PRESERVED within the
    // already-listed {0,23}: scoped 0.23.2→0.23.4 diffs left permission and both
    // hook trees byte-identical (`02-permission.diff` and `03-hooks.diff` both 0
    // bytes). Hook ordering remains PreToolCallHookPermissionPolicy index 0 and
    // AutoModeApprove index 5; aggregation remains any-block-wins; Bash still
    // uses `command`, Write/Edit still use `path`, and AgentSwarm subagents still
    // use the standard permission stack. The load-bearing `run-prompt.ts` change
    // (#1516) makes `kimi -p "/goal ..."` wait across continuation turns until
    // the goal is terminal instead of resolving after the first completed turn.
    // `permission:'auto'`, `installHeadlessHandlers`, PromptJsonWriter,
    // session.resume_hint, and goal.summary shapes remain intact. The non-empty
    // `04-wire-records.diff` is internal provider-auth/media projection/session
    // plumbing, not new stdout NDJSON; the non-empty `05-session-bootstrap.diff`
    // adds owner-scoped `[image]` limits without changing additionalDirs, hook
    // merging, or permission construction. The 0.23.3 provider-auth patch now
    // surfaces the upstream 401 reason as PROVIDER_AUTH_ERROR instead of falsely
    // demanding relogin; it does not affect tool or hook execution. Backed by a
    // GREEN temp-binary `bun run smoke:real` on exact 0.23.4 (2026-07-09):
    // 9 pass / 0 fail. Read-only labels denied forced writes; pursue ran to its
    // two-minute budget across continuation turns with no file written;
    // read-only swarm denied a spawned subagent write; write-swarm confined coder
    // edits to the throwaway worktree (patchBytes=278, userTreeClean=true,
    // worktreeCleaned=true); and an out-of-trusted-root absolute write was
    // hook-denied. Report:
    // .claude/kimi-code-research/daily-monitor/2026-07-09-upstream-monitor.md.
    // Tag: compat-verified-kimi-code-0.23.4.
    // 0.23.5 (patch, 2026-07-11) verified COMPAT-PRESERVED within the already-
    // listed {0,23} at released tag commit 352a4492. Permission, both hook trees,
    // and session bootstrap stayed byte-identical (`02-permission.diff`,
    // `03-hooks.diff`, and `05-session-bootstrap.diff` all 0 bytes), so hook-first
    // ordering, any-block-wins aggregation, field names, and create/resume config
    // loading remain intact. `04-wire-records.diff` only adds the internal
    // `media-stripped` projection type. The load-bearing change is additive
    // `PromptJsonWriter` metadata: `role:"meta", type:"turn.step.retrying"` on
    // provider retry events. v1.8.0 models its exact shape, normalizes it, and
    // filters it from consumer records while retaining malformed-shape diagnostics.
    // The post-change exact-0.23.5 `bun run smoke:real` was GREEN (2026-07-11):
    // 9 pass / 0 fail in 229.56s. Read-only labels denied forced writes; pursue
    // ran to its full two-minute budget with no file written; read-only swarm
    // spawned coder subagents whose writes were denied; write-swarm confined edits
    // to the throwaway worktree (patchBytes=334, userTreeClean=true,
    // worktreeCleaned=true); and an out-of-trusted-root absolute write was denied.
    // Report: .claude/kimi-code-research/daily-monitor/2026-07-11-upstream-monitor.md.
    // Tag: compat-verified-kimi-code-0.23.5.
    // 0.23.6 (patch, 2026-07-12) verified COMPAT-PRESERVED within the already-
    // listed {0,23} at released tag commit b5c236d0. Permission and both hook
    // trees stayed byte-identical (`02-permission.diff` and `03-hooks.diff` were
    // 0 bytes): hook-first order, any-block-wins aggregation, Bash.command,
    // Write.path, and Edit.path remain intact. `run-prompt.ts` now keeps `-p`
    // alive while a goal is active or cron work is pending and optionally across
    // background-task steering; the plugin does not enable steer mode and its
    // mandatory AbortController budgets remain the outer bound. Upstream also
    // makes subagent timeout configurable and raises its default to two hours,
    // without changing AgentSwarm's standard permission stack; plugin budgets
    // and hard concurrency caps still bound every swarm run. The provider
    // capability rename from select_tools to dynamically_loaded_tools is
    // internal tool-disclosure plumbing, not a permission or stdout-shape change.
    // Exact-0.23.6 `bun run smoke:real` was GREEN (2026-07-12): 9 pass / 0 fail
    // in 274.55s. Read-only labels denied forced writes; pursue ran to its full
    // two-minute budget with no file written; read-only swarm denied a spawned
    // subagent write; write-swarm stayed confined (patchBytes=306,
    // userTreeClean=true, worktreeCleaned=true); and an out-of-root absolute
    // write was hook-denied after a real AgentSwarm dispatch. Report:
    // .claude/kimi-code-research/daily-monitor/2026-07-12-upstream-monitor.md.
    // Tag: compat-verified-kimi-code-0.23.6.
    { major: 0, minor: 23 },
    // 0.24.2 (minor, 2026-07-15) verified COMPAT-PRESERVED across the cumulative
    // 0.23.6→0.24.2 release delta. The default v1 permission and live
    // session/hooks surfaces are 0-byte diffs: PreToolCallHook remains index 0,
    // AutoModeApprove remains the first approve at index 5, aggregation remains
    // any-block-wins, and Bash.command / Write.path / Edit.path are unchanged.
    // The large prompt-mode refactor keeps the explicit argv and v1 auto-mode
    // contract intact. A truthy ambient KIMI_CODE_EXPERIMENTAL_FLAG now selects
    // native agent-core-v2; source tracing confirmed its strict configured-hook
    // schema, configured+plugin hook merge, snake_case tool payload, awaited
    // pre-execution deny, and per-agent hook service. A targeted exact-v2 review
    // smoke denied a forced write. V2 also emits role:"meta",
    // type:"system.version" before normal output; the parser tolerates it as one
    // non-fatal diagnostic, keeps it out of records/onRecord, and still pins the
    // terminal session.resume_hint, so explicit modeling is optional polish.
    // Upstream print mode now defaults background completion to steering and its
    // own task timeouts can be unbounded, but the plugin's finite budgets,
    // concurrency caps, and identity-safe cancellation teardown remain outer
    // bounds. The complete exact-0.24.2 v1 `bun run smoke:real` was GREEN:
    // 9 pass / 0 fail, 39 assertions in 261.33s. Read-only labels denied writes;
    // pursue wrote no file through its full two-minute budget; read swarm denied
    // a subagent write; write-swarm stayed confined (patchBytes=278,
    // userTreeClean=true, worktreeCleaned=true); and the out-of-root write was
    // denied. Phase-1 reports: 97-100; synthesis: 101. Tag:
    // compat-verified-kimi-code-0.24.2.
    { major: 0, minor: 24 },
];
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
export async function probeKimiVersion(options) {
    const bin = options.kimiBin ?? "kimi";
    const timeoutMs = options.timeoutMs ?? KIMI_VERSION_PROBE_TIMEOUT_MS;
    return await new Promise((resolve) => {
        let settled = false;
        const settle = (result) => {
            if (settled)
                return;
            settled = true;
            resolve(result);
        };
        let child;
        try {
            child = spawn(bin, ["--version"], {
                env: options.env,
                stdio: ["ignore", "pipe", "pipe"],
            });
        }
        catch (err) {
            settle({
                kind: "failed",
                reason: `spawn failed: ${err.message}`,
            });
            return;
        }
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        const timer = setTimeout(() => {
            try {
                child.kill("SIGTERM");
            }
            catch {
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
export function parseVersionLine(stdout) {
    const firstLine = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
    if (firstLine === undefined)
        return undefined;
    const trimmed = firstLine.trim().replace(/^v/, "");
    const match = trimmed.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
    if (match === null)
        return undefined;
    return {
        raw: trimmed,
        major: Number.parseInt(match[1], 10),
        minor: Number.parseInt(match[2], 10),
        patch: Number.parseInt(match[3], 10),
    };
}
export function isInTestedRange(major, minor) {
    return KIMI_TESTED_MINORS.some((entry) => entry.major === major && entry.minor === minor);
}
/**
 * The newest `{major, minor}` in the tested set — the known-good upper bound
 * (H9). Set-membership in `isInTestedRange` already warns for anything outside
 * the tested range; this lets the warning distinguish the COMMON case (a kimi
 * release NEWER than our last compat audit — likely fine but unverified) from a
 * below/gap version, which is the more suspicious shape.
 */
export function maxTestedMinor() {
    return KIMI_TESTED_MINORS.reduce((max, entry) => entry.major > max.major || (entry.major === max.major && entry.minor > max.minor)
        ? entry
        : max);
}
/**
 * Format a user-facing warning line for an out-of-range version probe.
 * Includes the canonical "not a block, just a heads up" framing so the
 * caller agent doesn't misinterpret this as fatal.
 */
export function formatVersionOutOfRangeWarning(probe, pluginVersion) {
    const tested = KIMI_TESTED_MINORS.map((entry) => `${entry.major}.${entry.minor}.x`).join(", ");
    const max = maxTestedMinor();
    const aboveMax = probe.major > max.major || (probe.major === max.major && probe.minor > max.minor);
    const lines = [
        `WARNING: kimi-code version ${probe.version} is outside the range kimi-plugin-cc ${pluginVersion} was tested against (${tested}).`,
    ];
    if (aboveMax) {
        // H9: the known-good upper bound. Above it = a release newer than our last
        // compat audit — usually fine, but unverified (and the case the version
        // probe exists to flag when out-of-band auto-upgrade drifts the binary).
        lines.push(`  This is NEWER than the newest version we have tested (${max.major}.${max.minor}.x) — likely fine, but unverified; kimi-code behaviors may have changed since our last compatibility audit.`);
    }
    lines.push(`  The plugin will still run, but a silent breakage may exist for behaviors that changed in your version.`, `  If something looks off (missing session ids, malformed records, hook bypasses), check the kimi-code changelog`, `  for changes since the last tested range and report mismatches via the plugin issue tracker.`);
    return lines.join("\n");
}
