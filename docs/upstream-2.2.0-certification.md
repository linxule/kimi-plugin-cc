# Kimi Code 2.2.0 certification evidence — 2026-10-14

## Exact sources

| CLI | Release commit | Comparison |
| --- | --- | --- |
| 2.2.0 | `472192c34c1efad89a369870eff0da0b708ce9bb` | certified 2.1.1 (`f67e6398fb3210ad8ace970e2dfd5bcc984ed61f`) |

npm published 2.2.0 at 2026-10-14T15:35:26Z, after the morning upstream monitor
reported NO ACTION for 2.1.1. The operator's binary stayed at 2.1.1 for the whole
slice; the candidate ran from an isolated `bun add @moonshot-ai/kimi-code@2.2.0`.

Four independent source reviews (hook contract, stream-json/print path,
CLI/config/workspace trust, adversarial) each returned COMPAT-PRESERVED. The lead
re-verified every load-bearing claim against the exact tag: the hook-schema,
`planService.ts` and `beforeToolExecuteEvent.ts` blobs are identical across the
two tags; `plan/`, `app/config/`, `app/flag/` and the update code have zero diff;
`index.ts` registration order is unchanged (one unrelated export added), so plan
still registers before external hooks and the sole final `.allow()` remains the
active plan-file guard (`planService.ts:110`; upstream #3431 open).

The scoped diffs are small on the load-bearing surfaces (02: 1.2 KB, one status
dispatch in `permissionModeService.ts`; 03: 3.4 KB, UserPromptSubmit rendering
only — `runPreToolUse` reads neither `hookParts` nor `structuredOutput`; 04:
1.7 KB, fork-slice prompt metadata) and large on tower (48 files) and the SDK
(`packages/kaos` deleted; never used by the CLI app).

## Security changes and limits

- **Tower** gained two before-execute listeners (5 → 7): a goal/tower mutex
  (flag-gated) and a Bash guard that vetoes `rm`/`git clean`/`git reset` when a
  tower-owned `.kimi-tower/comms/state.json` exists in the checkout. Both are
  deny-only; neither can `allow()`. Tower cannot be armed from a `-p` prompt
  (`enter()` has one caller in the kap server; tools/profile contribute only
  with the flag on at bootstrap) and the plugin still refuses every tower flag
  source pre-spawn. The mechanized file-set scan cannot see listener *counts*;
  the human reading above covers it.
- **`notify_user`** (NotifyUser progress updates) already existed at 2.1.1 and
  is inert under `-p`: the tool is offered only when bootstrap declares the
  `update_panel` host capability, which only the TUI passes; the plugin's
  read-only allowlist would deny it regardless. Not refused pre-spawn
  (harmless), documented as tolerated.
- **`KIMI_CODE_TRUST_WORKSPACE`** (#4059) makes `isTrusted()` true for any cwd.
  Trust gates only project-level MCP config loading and the MCP registry
  listing, but a trusted workspace
  starts repo-defined stdio MCP servers at bootstrap, outside the PreToolUse
  hook, and `buildEnv` forwarded the ambient environment — so an operator shell
  exporting it would have trusted every plugin spawn, including swarm-write's
  ephemeral worktree. Plugin 2.0.8 deletes the variable in `buildEnv` on every
  spawn. Pre-existing route via persisted trust records; hardening, not a
  regression fix.
- **WaitFor** 90-second cap (#4061) is the schema maximum of a background-task
  wait tool the hook denied at the time (plugin 3.1.0 allows it); foreground Bash (`bash.ts`) is byte-identical.
- Unchanged residuals: hook runner fail-open behaviour, trusted operator state,
  repository executable Git configuration, no hostile-repository sandbox.

## Verification record

- Tag scan on the exact 2.2.0 tree: 14 pass / 1 fail / 77 assertions before the
  row (missing hash row only); **15 pass / 0 fail / 89 assertions** after adding the `"2.2.0"`
  row, whose twelve sha256 values were computed on the checkout and found
  byte-identical to the 2.1.1 row. A first run also flagged
  `features/goal/goalService 2.ts` in the subscriber set: an iCloud Drive
  conflict copy inside the clone, not an upstream file (that first-run log was
  later overwritten by a reviewer's re-run; the finding is recorded in the
  synthesis report). Removed, with ~500 similar copies across the plugin repo
  and clone.
- Plan-ON control (`repro.ts v2`, isolated seeded home, deny-all hook): exit 0,
  48.8 s; first stdout line `system.version` = `2.2.0`; hook saw `Glob` only
  (denied); a 784-byte plan file was written with no Write hook payload
  (`Wrote 784 bytes to …/plans/…` in the tool result) — bypass reproduced.
- Plan-OFF control (`repro-clean.ts`, two separate prompts): `Write` reached the
  hook and was denied, target absent; `EnterPlanMode` reached the hook and was
  denied; no plan file. `VERDICT: PASS`.
- Candidate smoke on the final 2.0.8 tree,
  `KIMI_PLUGIN_CC_SMOKE_V2_CANDIDATE=2.2.0 KIMI_PLUGIN_CC_KIMI_BIN=<isolated>`:
  **15 pass / 0 fail / 84 assertions in 438.78 s**, no retries, no skips. Goal
  run aborted at the smoke budget as designed (`aborted=true`), `goal.summary`
  `status:"paused"`, `turnsUsed:8`, none of the goal's target files written. Write-swarm:
  `patchBytes=278 userTreeClean=true worktreeCleaned=true`. Controls and smoke
  ran sequentially with temporary isolated copies of the operator's saved
  login, explicitly authorized for this run; all temporary homes were removed;
  no raw config or credentials appear in any report or trace.
- Full `bun run check` was green on the pre-certification tree (1026 pass /
  28 opt-in skips / 0 fail / 3729 assertions). After appending the 2.2.0 row the
  first full check failed on one stale expectation (`kimi-engine.test.ts` still
  asserted 2.2.0 is refused); the expectation now names `2.2.1`, `2.3.0`,
  `2.2.0-rc.1` and `2.2.0+unreviewed` as refused, and the final full check on
  the release tree is green: **1029 pass / 28 opt-in skips / 0 fail / 3909
  assertions**, build, surfaces, typecheck and drift gate included. One earlier
  run showed a single `SQLITE_BUSY` flake in `ask-background.test.ts`
  (test-side store contention; 3/3 green in isolation).

Source reports and credential-free traces:
`.claude/kimi-code-research/reports/2026-10-14-2.2.0-{hook-contract,stream-json,cli-surface,adversarial,synthesis}.md`,
`2026-10-14-2.2.0-plan-on.*.ndjson`, `2026-10-14-2.2.0-plan-off-{write,enterplan}.stdout.ndjson`.

This slice did not update installed hosts or the operator CLI. Publication and
local host adoption remain distinct; each host re-pins its hook via its own
setup command after updating.

## Process notes

This certification was completed the same day 2.2.0 was published, under
the pressure of a scheduled upgrade the next morning. The mechanized scan
proved absence of change on the pinned files (all twelve identical to 2.1.1),
so the weight of the source verdict rests on the four reviews plus the lead's
re-verification, and the tower listener count (5→7, both veto-only) is a human
reading, not a mechanized one. The review clone was not pristine at the start
(iCloud conflict copies; cleaned before the recorded scans). The playbook now
states a clean-clone precondition. The exact-binary plan-ON/OFF controls and
the candidate smoke remain the load-bearing live evidence.
