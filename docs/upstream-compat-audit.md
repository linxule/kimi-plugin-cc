# Upstream compatibility audit playbook

How to verify a new kimi-code release against kimi-plugin-cc without breaking the safety guarantees we ship.

Use this routine for every new exact native-v2 version, including patches. The 2.1.0/2.1.1 certification is the current worked example. Earlier audits remain useful historical evidence, but their legacy-v1 minor-version rules do not apply to native v2.

## Current certified boundary (2026-09-24)

The plugin certifies **native agent-core-v2 at exact `@moonshot-ai/kimi-code@0.42.0`,
`0.43.0`, `0.43.1`, `2.0.0`, `2.0.1`, `2.0.2`, `2.1.0` and `2.1.1`** (release commits `6954d2c8bf94a5c7fc29cc6ae35b15d042cc4dcb`,
`ffa94fae854dedf594919acbea280d98cbe8e14e`, `75ac010bcb2050338444455de8328492d152c919`,
`1b89e4b039f052d10f258464413b2047acca12ba`, `caf7d4e2fef06967280b325da06e44a4b0516eba`,
`9d07f634be94ebeb1deba2f55d247807cf729315`,
`52437299ff78de3d0aff7f38f054e5eb20c512e5`,
`f67e6398fb3210ad8ace970e2dfd5bcc984ed61f`)
for all eight operations, and legacy-v1 through 0.41.x for an explicitly pinned binary.
The most recent worked example is the 2026-09-24 exact 2.1.0/2.1.1 certification
(plugin 2.0.6; [certification evidence](upstream-2.1-certification.md)).
0.42.0 removed `packages/agent-core` and `KIMI_CODE_LEGACY_FLAG` (#3542; not in
its changelog): `kimi -p` is v2 unconditionally, so the v1 pin is inert there.

The certification basis is the **no-plan construction** (see
[`native-v2-certification-provenance.md` §2](native-v2-certification-provenance.md#2-native-v2-entry-gate)),
not an upstream ordering guarantee — plan still registers before external
hooks at every certified version through 2.1.1 (confirmed in `dist/main.mjs` at 0.42.0 and by the
plan-ON live control on every certified binary). Certification is per EXACT
version and per operation; a patch release is NOT certified until the three
gates below pass and its version is appended to `NATIVE_V2_CERTIFIED`.

**Re-verify each release (all three, in this order):**

1. **Mechanized tag scan.** Clone the exact tag and run
   `KIMI_CODE_SOURCE_TAG_DIR=<clone> bun test tests/audit/v2-tag-scan.test.ts`.
   It fails on a missing per-version hash row — read the diff of
   `beforeToolExecuteEvent.ts` and `planService.ts`, then add the row. Any
   other red (a second `.allow()`, a new before-execute subscriber, a new
   `enter()` caller, a changed config section, a new executor entry point,
   changed tool field names) is a human re-audit, not a pin update. The scan
   cannot see semantic regressions: also read every NEW subscriber's
   statements, check for tools with side effects in `resolveExecution`, grep
   `os/backends/` for a non-local runtime selector, and diff `_base/di/**`
   (scope units, cascade engine, instantiation service) for changes to child
   scope creation or singleton-vs-scoped resolution — the swarm-subagent
   "own eager external-hooks service" claim rests on that subsystem.
2. **Live control on the exact binary** (`repro-0391/repro.ts` = plan ON and
   `repro-0391/repro-clean.ts` = plan OFF, both under
   `.claude/kimi-code-research/upstream-v2-hook-coverage/`; isolated seeded home,
   deny-all hook; run `PATH=<exact-binary-dir>:$PATH bun <script>`): with
   `default_plan_mode = true` the plan-file `Write` must STILL bypass the hook
   (if it stops bypassing, upstream may have shipped the ordering fix — re-read
   #3431 and re-decide the basis); with plan mode off, an ordinary `Write` and
   an `EnterPlanMode` attempt must both reach the hook and be denied. Count
   payloads for the specific tool, not all calls. `repro-clean.ts` sends the two
   probes as SEPARATE prompts — a single two-step prompt lets the model stop at
   the first denial and never issue the second call (observed 2026-09-15).
   **Run every live control and smoke SEQUENTIALLY.** Before any run, arrange dedicated test authentication or obtain an explicit
   exception for temporary credential copies as described in [Live smoke authentication](ci.md#authentication-and-credential-handling). The harness can copy the managed OAuth credentials; two copies refreshing concurrently
   invalidated the operator's grant on 2026-09-15 (`The provided authorization
   grant is invalid`, fixed by `kimi login`).
3. **Real-binary smoke** (Phase 1b) with the v2 lanes green for every operation.
   Before adding a production certification row, set
   `KIMI_PLUGIN_CC_SMOKE_V2_CANDIDATE=<exact-version>` together with
   `KIMI_PLUGIN_CC_KIMI_BIN=<exact-binary>`. The harness refuses a version
   mismatch, selects v2 lanes, and adds only an in-memory test-process
   write-swarm capability row so that command's real gates can run. It does
   not bypass the hook schema, hook installation or no-plan preflight.
   Review and represent a new major's hook schema first. Only after all gates
   pass may the shipped certification table gain the version.

Plugin versions advance independently using ordinary SemVer. A compatible
certification update takes the next unused plugin patch and states the exact CLI
version separately; never reuse a published plugin version or tag. Version labels
do not replace any certification gate.

Do not extend `KIMI_TESTED_MINORS` (legacy table) past 0.41. Do not write a
"plan-file write denied under plan mode" smoke — under the construction that
path is never armed and a green result is the vacuous-precondition failure.

## When to run

- A new exact native-v2 `@moonshot-ai/kimi-code` version ships, including a patch
- An adversarial finding in a different audit suggests a contract we depend on may have moved
- The `/kimi:setup` version probe starts firing "outside tested range" warnings for a version users are actually running
- Quarterly even if none of the above triggered, just to catch silent drift

> **kimi-code self-upgrades by default since 0.8.0** (PR #334, `autoInstall: true`). The installed binary is now *fluid* — a user's interactive TUI can silently move ahead of the verified range out-of-band (the plugin's own `-p` spawns never swap the binary, but they then run against whatever the TUI upgraded to). Expect this trigger to fire more often than the old "user manually updated" cadence. Don't assume `kimi --version` today is the same as last week. (Worked example of a 3-minor catch-up: the 2026-06-03 0.7→0.9 audit, reports 52-60.)

### Daily monitor reports

A Codex daily cron monitors `@moonshot-ai/kimi-code` upstream drift for this
repo and writes local continuity reports under
`.claude/kimi-code-research/daily-monitor/`. The whole `.claude/` tree is
gitignored, so these reports are not release artifacts and should not be staged.

Before starting a new upstream audit or release catch-up:

1. Read `.claude/kimi-code-research/daily-monitor/LATEST.md` if present.
2. Read the most recent 3-5 dated reports matching
   `.claude/kimi-code-research/daily-monitor/YYYY-MM-DD-*.md`.
3. Carry forward unresolved blockers, follow-up checks, and prior uncertainty.
4. If today's evidence contradicts an earlier monitor judgement, state the
   correction explicitly in the new report or release handoff.

Monitor statuses are operational signals, not certifications:

- `NO ACTION` means the exact native-v2 version is already certified for the required operations, or an explicitly pinned legacy version is within its tested range, and no new concern warrants action.
- `PATCH CHECKUP` applies only to a newer patch inside an already-tested legacy-v1 minor. It cannot certify a native-v2 patch.
- `CERTIFICATION NEEDED` means the exact native-v2 version is not certified, even if only its patch number changed. Run all three gates above before adding it to `NATIVE_V2_CERTIFIED`.
- `BLOCKER` means missing evidence, operator state, or a possible safety break prevents a conclusion.

A monitor report cannot extend a certification table or authorize publication. The release gate requires a source audit, exact-binary controls and smoke, post-edit review, `bun run check`, and a reviewed diff. Do not extend the legacy `KIMI_TESTED_MINORS` table past 0.41.

Do not skip native-v2 certification because a changelog omits safety-related changes. Diff the source surfaces below and run all three gates for the exact release.

### Forward-scan mode (no release, but `origin/main` moved)

When the routine fires but **nothing new has shipped** — npm `latest`, GitHub `Latest`, and the local binary are all still the version we already verified — do **not** run the full Phase 1 four-agent audit, extend either certification table, or cut a tag. There's no release to certify. Instead run the *forward-scan*: a free look at what the next release will contain.

1. Generate the six scoped diffs exactly as in Phase 0, but with `NEW='origin/main'` (after `git fetch`) and `PREV` = the last verified tag's referent.
2. Read them yourself in the main thread (no agent dispatch). The same 0-byte signal applies: zero-byte diffs for the before-execute gates (`02`), hooks (`03`), and plan arming (`04`) show those files are unchanged. Bootstrap (`05`) and tool/fan-out (`06`) changes can still affect enforcement.
3. Triage the non-empty diffs against the surface table below. Anything internal-only (record types not emitted to `-p` stdout, provider/model plumbing, internal abort-reason propagation) is benign for us; flag only changes to the stream-json **output shape**, argv, or the deny chain.
4. Log a one-bullet entry in `ROADMAP-TO-GA.md`'s Post-GA audit log dated and explicitly marked **"forward-scan, not a triggered audit"**, with the scanned `main` SHA, the per-surface result, a provisional verdict, and the specific items to re-confirm with `bun run smoke:real` when the release actually lands.
5. **No commit beyond the log bullet, no tag, no version bump** — the scanned code is unreleased and will change before shipping. (The 2026-06-01 entry is the worked example.)

The forward-scan is the lightweight discharge of the "quarterly drift" trigger above: it catches a contract moving *before* the release forces a turnaround, without spending the full ceremony on code that isn't final.

## What we depend on (the surfaces to audit)

These are the kimi-code surfaces kimi-plugin-cc consumes. If any one breaks, our safety guarantees break.

| Surface | Where in kimi-code (0.42.0, all paths under `packages/agent-core-v2/src` unless noted) | What we depend on | Where in kimi-plugin-cc |
|---|---|---|---|
| `kimi -p` print mode + permission mode | `apps/kimi-code/src/cli/v2/run-v2-print.ts` (entry via `apps/kimi-code/src/cli/run-prompt.ts` → `runV2Print`), `apps/kimi-code/src/cli/options.ts` | v2-only since 0.42.0 (the v1 engine and `KIMI_CODE_LEGACY_FLAG` are gone — the tag scan asserts the selector is absent). `auto` permission mode forced fresh and resumed, `nonInteractive:true`; `--auto/--yolo/--plan` rejected with `-p`; `-r` refuses when the session's recorded cwd ≠ current cwd (`:426`). **Load-bearing audit lesson from 0.33.0:** the selector file changed semantics while `run-prompt.ts` changed only comments — never omit the print-mode entry from the CLI diff. | `runtime/kimi-engine.ts::selectIntendedEngine` (exact-version `NATIVE_V2_CERTIFIED`), `runtime/cli-client.ts` invokes `-p` and requires the `system.version` marker first; safety relies on the hook firing under the no-plan construction |
| Before-execute channel (the ONE place every tool call is gated) | `agent/toolExecutor/beforeToolExecuteEvent.ts`, `agent/toolExecutor/toolExecutorService.ts` (`prepareToolCall` → `fireBeforeExecute`) | listeners run sequentially in registration order; `veto` wins; `pass` is non-terminal; `event.allow()` is chain-breaking. **Invariant:** the sole `.allow()` in the engine + CLI is the plan-file guard (`features/plan/planService.ts`), gated on ACTIVE plan mode, and the subscriber set is exactly permissionGate, toolDedupe, btw, externalHooks, goal, plan, swarm, tower | `tests/audit/v2-tag-scan.test.ts` (allow count, subscriber set, sha256 pins); the no-plan construction in `runtime/native-v2-preflight.ts` + `runtime/hooks/approval-policy.ts` |
| Plan mode arming vectors | `features/plan/planService.ts`, `features/plan/planOps.ts` (durable `plan_mode.enter|cancel|exit`, `plan.revision`), `features/plan/configSection.ts` (`default_plan_mode`), `features/plan/tools/enter-plan-mode/enterPlanModeTool.ts`, `workspace/sessionLifecycle/sessionLifecycleService.ts` (reads the default once in `sessions.create()`), `state/eventDispatcherService.ts` + `state/state.ts` (`restore()` folds ONLY `agents/<id>/wire.jsonl`, by literal `record.type`; fork `snapshotExcluded`) | exactly three arming routes from `-p`: `default_plan_mode` (single user file, no env/argv/project overlay), the `EnterPlanMode` tool, and journal replay on resume. Anything that adds a fourth (a new plan event type, a second restore source, an env binding for the default, a plan field on agent profiles) breaks the construction | `inspectPlanModeConfig` (`CLI_V2_PLAN_MODE_CONFIGURED`), hook denial of `EnterPlanMode`/`ExitPlanMode`, `scanSessionJournalsForPlan` (`KIMI_SESSION_PLAN_TAINTED`) + proven-lineage resume; all pinned/asserted by the tag scan and proven live by smoke lanes 3/3b |
| PreToolUse hook engine | `features/externalHooks/configSection.ts` (strict `{event, matcher?, command, timeout?}`), `features/externalHooks/internal/runHook.ts`, `features/externalHooks/internal/matchHooks.ts`, `features/externalHooks/agent/agentExternalHooksService.ts` (eager, one per agent scope incl. swarm children) | stdin JSON `{hook_event_name, session_id, cwd (process cwd), client_type, session_title, tool_name, tool_input, tool_call_id}`; exit 2 = deny with stderr reason, exit 0 + JSON `permissionDecision:"deny"` = deny, anything else allow; fail-OPEN on spawn error/timeout/abort/bad JSON; 30 s default; empty matcher = all tools; throwing regex matches nothing | `runtime/hooks/approval-hook.ts`, `runtime/hooks/approval-policy.ts`, `runtime/commands/setup.ts` (strict schema validation of every configured hook) |
| Hook **aggregation** across multiple hooks (incl. plugin-contributed) | `features/externalHooks/internal/matchHooks.ts` (`Promise.all`, first block in match order), `features/externalHooks/app/externalHooksRunnerService.ts` (plugin hooks appended and deduped on `cwd\0command`) | **any-block-wins**: an allow never pre-empts a block, so a kimi-code plugin's hook can neither override nor disable ours | implicit — guarantees the managed PreToolUse deny is terminal under coexistence (Claude + Codex host blocks, upstream plugins) |
| Auto-approve policy vs. hook | `agent/permissionGate/permissionGateService.ts` (→ `AutoModeApprovePermissionPolicyService`) | the auto-mode approval uses non-terminal `pass()`, never `allow()`, so it cannot pre-empt the external-hooks listener that runs after it | implicit — the entire safety model assumes a hook veto beats auto-approve; the tag scan's allow-count invariant covers it |
| Plugin slash commands / command activation | `agent/pluginCommand/`, `agent/plugin/`, `app/plugin/` | activation stays RPC/host-initiated and absent from `-p`; `-p` intercepts exactly one prefix, `/goal` (`apps/kimi-code/src/cli/goal-prompt.ts:43`); a plugin command must never become a model-reachable tool or a permission bypass | read-only commands hard-prefix an instruction line so their prompt never starts with `/goal`; `runtime/commands/pursue.ts` is the only `/goal` producer |
| Tool input schemas the allowlist reads | `agent/tools/os/write/writeTool.ts`, `agent/tools/edit/editTool.ts` (`path`; Write also `mode`), `agent/tools/os/bash/bashTool.ts` (`command`, **`cwd`**, `timeout`, `run_in_background`; `effectiveCwd` asserts NO workspace membership, `:191`) | field names, and the fact that `Bash.cwd` is honoured without an upstream membership check while the hook payload's top-level `cwd` is the process cwd | `runtime/rescue-approval.ts` (`checkApprovedPath`, `checkApprovedDirectory` confines `tool_input.cwd` to the trusted root before the command string); tag scan asserts the field names |
| AgentSwarm / subagents | `features/swarm/tools/agent-swarm/agentSwarmTool.ts` (`'AgentSwarm'`, strict schema), `features/swarm/agent/swarmService.ts`; `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` (unset = no cap) | children run in-process in a child DI scope sharing the session workspace with their OWN eager external-hooks service — every child tool call fires the hook; no deny-all path on the swarm route; `fork` gated by `subagent_fork` | `runtime/commands/swarm.ts` always exports the concurrency cap (4 read / 1 write); the `swarm`/`swarm-write` hook labels; worktree confinement via `KIMI_PLUGIN_CC_WORKSPACE_ROOT` |
| Experimental features | `apps/kimi-code/src/utils/experimental-features.ts` (`[experimental]` config table, per-flag `KIMI_CODE_EXPERIMENTAL_*` env, master `KIMI_CODE_EXPERIMENTAL_FLAG`; precedence env → config → master → default) | `tower` and `subagent_fork` are v2-only features outside the certified profile; the master flag enables all of them | `inspectExperimentalSelectors` (`CLI_V2_EXPERIMENTAL_UNSAFE`) + `assertNoUnsafeExperimentalSelector` (`CLI_V2_HOOK_ORDER_UNSAFE`) refuse before spawn |
| Stream-json output | `apps/kimi-code/src/cli/prompt-render.ts` (`system.version` FIRST line, `session.resume_hint`, `turn.step.retrying`), `apps/kimi-code/src/cli/goal-prompt.ts` (`goal.summary`) | NDJSON record shapes for assistant/tool/tool_result; `role:"meta", type:"system.version"` is the provenance marker a v2 plan requires first and must equal the probed version; `session.resume_hint` carries the `session_<uuid>` token that round-trips via `-r` | `runtime/stream-json.ts` parser; `runtime/cli-client.ts` provenance gate (`CLI_ENGINE_PROVENANCE_MISMATCH`) and session pinning |
| CLI argv | `apps/kimi-code/src/cli/options.ts` | `-p` (prompt as VALUE), `-r`/`-S`/`--session`, `--output-format stream-json`, `-m`, `--skills-dir` accepted with current semantics; `--agent`/`--agent-file`/`--add-dir` exist and are NEVER passed | `runtime/cli-client.ts::buildArgs`; `runtime/kimi-command.ts::assertPrefixArgsSafe` refuses reserved flags in the launcher prefix |
| Session store layout | `<KIMI_CODE_HOME>/sessions/<workspaceId>/<sessionId>/agents/<agentId>/wire.jsonl` (+ `state.json`, `logs/`) | the journal the preflight scans lives exactly there; a layout change fails closed as `KIMI_SESSION_JOURNAL_UNAVAILABLE` (every v2 resume would refuse) | `scanSessionJournalsForPlan`; smoke lane 3b asserts the real layout |
| Auto-update preflight | update check on the `-p` path | a background upgrade must never swap the certified binary under an execution plan | every spawn exports `KIMI_CODE_NO_AUTO_UPDATE=1` and an absolute `KIMI_CODE_HOME` (`runtime/cli-client.ts::buildEnv`) |
| Process / exit / lifecycle | `apps/kimi-code/src/cli/v2/run-v2-print.ts` and OS-level | stdout = stream-json only; stderr = humans-only; goal exits 0/3/6; SIGTERM lands; process group enumerable | `runtime/cli-client.ts` cancellation; `runtime/background-spawn.ts` |

## The routine

### Phase 0 — Setup (5 min)

The upstream clone lives at `.claude/kimi-code-research/kimi-code-repo/`. It's gitignored.

```bash
cd .claude/kimi-code-research/kimi-code-repo
git fetch --tags origin
git checkout '@moonshot-ai/kimi-code@<NEW_VERSION>'
git describe --tags --always  # confirm
```

Generate scoped diffs against the previous audited version (use the exact source tag recorded in the previous certification report):

```bash
mkdir -p /tmp/kimi-<NEW>-diff
PREV='@moonshot-ai/kimi-code@<PREV_VERSION>'
NEW='@moonshot-ai/kimi-code@<NEW_VERSION>'

git diff "$PREV".."$NEW" -- \
  apps/kimi-code/src/cli/run-prompt.ts \
  apps/kimi-code/src/cli/v2/ \
  apps/kimi-code/src/cli/prompt-render.ts \
  apps/kimi-code/src/cli/goal-prompt.ts \
  apps/kimi-code/src/cli/options.ts \
  apps/kimi-code/src/cli/commands.ts \
  apps/kimi-code/src/utils/experimental-features.ts \
  apps/kimi-code/test/cli/ \
  > /tmp/kimi-<NEW>-diff/01-cli-print-mode.diff

# The before-execute channel is the ONE place every tool call is gated, and
# the permission gate is the auto-approve policy that must stay non-terminal
# (`pass()`, never `allow()`). Also scopes the permission mode/rules/approval
# services that decide what the gate does.
git diff "$PREV".."$NEW" -- \
  packages/agent-core-v2/src/agent/toolExecutor/ \
  packages/agent-core-v2/src/agent/permissionGate/ \
  packages/agent-core-v2/src/agent/permissionPolicy/ \
  packages/agent-core-v2/src/agent/permissionMode/ \
  packages/agent-core-v2/src/agent/permissionRules/ \
  packages/agent-core-v2/src/agent/toolApproval/ \
  > /tmp/kimi-<NEW>-diff/02-before-execute-and-gates.diff

git diff "$PREV".."$NEW" -- \
  packages/agent-core-v2/src/features/externalHooks/ \
  > /tmp/kimi-<NEW>-diff/03-hooks.diff

# Plan-mode arming vectors + the restore-folding source. A change here is a
# change to the no-plan construction itself: the plan guard's final allow, the
# durable plan event types (`planOps.ts` — the journal scan keys on their
# prefixes), `default_plan_mode` (`configSection.ts`, read once in
# `sessions.create()` in sessionLifecycle), and what `restore()` folds.
git diff "$PREV".."$NEW" -- \
  packages/agent-core-v2/src/features/plan/ \
  packages/agent-core-v2/src/state/ \
  packages/agent-core-v2/src/workspace/sessionLifecycle/ \
  > /tmp/kimi-<NEW>-diff/04-plan-and-restore.diff

# Session/feature BOOTSTRAP: feature registration order (`index.ts`), the
# config loader (`app/bootstrap/`, `app/config/`), and every feature's
# `configSection.ts`. A non-empty 05 means session construction or on-disk
# config-load behaviour moved — exactly the surface that decides what state a
# session starts with before any listener runs (the 0.19.1 lesson: an
# unconditional project-local config read was wired into BOTH create and
# resume bootstraps and only the adversarial pass caught it).
git diff "$PREV".."$NEW" -- \
  packages/agent-core-v2/src/index.ts \
  packages/agent-core-v2/src/app/bootstrap/ \
  packages/agent-core-v2/src/app/config/ \
  packages/agent-core-v2/src/workspace/ \
  ':(exclude)packages/agent-core-v2/src/workspace/sessionLifecycle' \
  ':(glob)packages/agent-core-v2/src/features/*/configSection.ts' \
  > /tmp/kimi-<NEW>-diff/05-session-bootstrap.diff

# The TOOL LAYER (input schemas whose field names the hook allowlist reads:
# Write/Edit `path`, Bash `command` + `cwd`), the fan-out / delegation
# features (swarm, goal, tower, btw, plugin commands, agent profiles) that
# spawn or steer additional tool callers, and the SDK/kaos packages under the
# -p path (a 0-byte agent-core-v2 diff does NOT cover them).
git diff "$PREV".."$NEW" -- \
  packages/agent-core-v2/src/agent/tools/ \
  packages/agent-core-v2/src/features/swarm/ \
  packages/agent-core-v2/src/features/goal/ \
  packages/agent-core-v2/src/features/tower/ \
  packages/agent-core-v2/src/features/btw/ \
  packages/agent-core-v2/src/agent/plugin/ \
  packages/agent-core-v2/src/agent/pluginCommand/ \
  packages/agent-core-v2/src/app/plugin/ \
  packages/agent-core-v2/src/app/agentProfileCatalog/ \
  packages/node-sdk/src \
  packages/kaos/src \
  > /tmp/kimi-<NEW>-diff/06-tools-fanout-sdk.diff
```

A 0-byte `03-hooks.diff` is the canonical "hook engine unchanged" signal, and a 0-byte `02` + `04` together mean the before-execute channel and the plan-mode arming vectors — the two surfaces the no-plan construction rests on — are untouched. The other diffs need real reading. `05` is the bootstrap/config surface: non-empty means session construction or on-disk config-load behaviour moved, which decides what state a session starts with before any listener runs — read it even when `01`–`04` are clean. `06` is the tool layer, the fan-out features and the SDK: read it for schema-field renames (the allowlist reads `path`/`command`/`cwd` by name), new tool callers that might not get an eager external-hooks service, and harness-level session/engine changes. Whatever the diffs say, the release is uncertified until the tag scan (`tests/audit/v2-tag-scan.test.ts`) is green against the tree with a fresh per-version hash row, the plan-mode-ON live control still shows the bypass, and the per-operation smoke (incl. lane 3b, native-v2 resume) passes.

### Phase 1 — Multi-agent compat review (4 parallel agents)

Dispatch four reviewers in parallel via the Agent tool with `run_in_background: true`. Each gets one surface and produces one report under `.claude/kimi-code-research/reports/NN-upstream-<scope>.md`.

Reviewer 1 — **PreToolUse hook contract** (`general-purpose` agent)
- Question: did the JSON-in / exit-code-out contract change? Did matcher semantics change? Under the no-plan construction, does every executed tool call still pass through our hook?
- For v2, trace production service-registration order and every listener that can call final `event.allow()`. "External hooks are awaited before execution" is insufficient. Verify that active plan mode remains the only chain-breaking final allow and that the plugin closes every way to arm it: config, tools, and journal replay. The plan-ON control must reproduce the known bypass; the plugin must refuse configured or restored plan state before spawning.
- Output: `reports/NN-upstream-<ver>-hook-contract.md`

Reviewer 2 — **Stream-json output** (`general-purpose` agent)
- Question: did NDJSON record shapes change? Is `session.resume_hint` still emitted with the same field name and position in stream? Any new top-level role or meta-type our parser would warn-on?
- Output: `reports/NN-upstream-<ver>-stream-json.md`

Reviewer 3 — **CLI surface** (`general-purpose` agent)
- Question: did our flags survive byte-identical? Any new flags affecting prompt mode? Is auto-approve still hard-coded?
- Output: `reports/NN-upstream-<ver>-cli-surface.md`

Reviewer 4 — **Adversarial** (`general-purpose` agent — the `kimi:kimi-challenge` subagent is risky for this because its foreground job can disappear)
- Brief: "Three other reviewers say COMPAT-PRESERVED. Attack the claim. Find the cases where it breaks. If you can't, earn the conclusion adversarially."
- Output: `reports/NN-upstream-<ver>-adversarial.md`

All four agents must save a structured report to disk and reply with a verdict + short summary. The full report is the deliverable; the chat reply is just a teaser.

Verdicts to use (consistent across reports):
- `COMPAT-PRESERVED` — no action needed
- `COMPAT-AT-RISK` — narrow specific concern flagged, may or may not require code
- `COMPAT-BROKEN` — actual breakage, runtime change required

### Phase 1b — Real-binary smoke

Run the exact candidate with the final implementation under review. Follow the [smoke instructions](ci.md) for isolated binary installation, authentication, and credential handling. Run controls and smoke sequentially. Authentication can use dedicated API credentials or an explicitly authorized temporary copy of subscription credentials; a previous successful run does not prove credentials are still valid.

For a version not yet in the production certification table, use the candidate mode:

```bash
KIMI_PLUGIN_CC_SMOKE_V2_CANDIDATE=<exact-version> \
  KIMI_PLUGIN_CC_KIMI_BIN=<absolute-path-to-exact-binary> \
  KIMI_PLUGIN_CC_SMOKE_HOME=<authorized-test-seed-home> \
  bun run smoke:real
```

The candidate version must match the binary. Candidate mode does not bypass hook-schema review, hook installation, or the no-plan preflight. Review and represent a new major's hook schema before running it.

For native v2, the smoke checks the first-line `system.version` marker against the probed version and exercises every operation. It covers hook denials, default-plan and experimental-selector refusals, native-v2 resume and tainted-journal refusal, `Bash.cwd` confinement, and write-swarm patch capture and cleanup. Pinned legacy binaries use the legacy lanes and must not emit the v2 provenance marker. Read the test results to confirm which lanes ran; skipped tests are not passing evidence.

If authentication fails before a tool call, record an authentication blocker. Do not infer that hook enforcement passed or failed. Obtain authorization before fetching credentials or retrying paid calls. Run the smoke unpiped, or preserve its exit status; a successful `tail` command does not mean the tests passed.

### Phase 2 — Synthesis

Read all four reports and the live results. Save a synthesis to `reports/NN-upstream-<ver>-synthesis.md`.

| Finding | Outcome |
|---|---|
| An already-certified version needs documentation corrections | Documentation update; no certification or version change |
| A new exact native-v2 version passes every gate | Add the production certification row and prepare the next unused plugin patch release with explicit upstream compatibility |
| A gate fails or evidence is incomplete | Keep the candidate uncertified; record the blocker and required follow-up |

A certification-table addition changes runtime routing even when upstream's hook implementation is unchanged. It is not a docs-only checkup. Matching upstream's version number never substitutes for a passing gate.

### Phase 3 — Edits

After all candidate gates pass, update `NATIVE_V2_CERTIFIED` through its version list in `runtime/kimi-engine.ts`. Keep the legacy table capped at 0.41. Update the exact-version source hashes and assertions in `tests/audit/v2-tag-scan.test.ts` only after reviewing their source changes.

Update the current compatibility statements in `AGENTS.md`, `docs/invariants.md`, `docs/native-v2-status.md`, and this playbook. Record evidence and residual risks in the provenance guide and roadmap audit log. Follow the [release checklist](../AGENTS.md#releasing) for version metadata and the changelog.

Batch source and wording edits before running `bun run build` and `bun run generate:surfaces`. Stage the generated root and Codex distributions, then run `bun run check`. Never copy personal config or credential stores as an automatic troubleshooting step; use the authentication procedure in [CI and live smoke](ci.md).

### Phase 4 — Multi-reviewer pass on the audit commit

The audit reports reviewed kimi-code. The reviewers in this phase review **your edits** to confirm they accurately reflect the audit.

Dispatch two reviewers in parallel:

1. **code-reviewer** agent on the working-tree diff — checks for correctness, cross-references the report citations, flags overclaims or wrong file paths
2. **general-purpose** agent doing "doc fidelity" — verifies every factual claim in the docs is supported by a specific report; checks numerical claims; flags marketing language

Apply must-fix findings before commit. Nits are at your discretion.

> Why not use `code-reviewer` for both: independence. The fidelity audit specifically grades the writing against the source reports, which is a different question than the code-reviewer's "is this commit correct."

### Phase 5 — Commit and publish

Install frozen dependencies before building; confirm `bun run check` passed
and review the final diff. Stage only intended files, including regenerated
distributions. Within the user's authorization, commit and push, wait for
that commit's CI to pass, then tag and publish. Do not substitute an existing
local dependency directory for lockfile-clean validation.

For a certification release, follow the [release checklist](../AGENTS.md#releasing). Use the next unused plugin patch, independently of the upstream version, and state the exact certified CLI version in the notes. Write release notes to a file and pass it to `gh release create --notes-file`.

Documentation corrections do not need a new version or a compatibility tag. Historical `compat-verified-kimi-code-*` tags record earlier legacy-v1 audits; they do not certify new native-v2 versions.

## Anti-patterns

- Do not add a certification row on source reading alone. Record the exact binary, source tag, final implementation, and live gates that passed.
- Do not describe a skipped smoke as a pass. A cloud-prepared change remains smoke-pending until the final tree passes with authorized authentication. The manual GitHub workflow supports API-key authentication; enabling per-push calls is a separate cost decision.
- Do not reuse an earlier green run to cover later behavior changes. Run the affected live lanes against the implementation that will ship.
- Do not treat a zero-byte hook diff as proof of the whole construction. Inspect bootstrap, session restoration, tool execution, and child scope creation too.
- Do not assume the hook is the first native-v2 listener. Its enforcement depends on the no-plan construction and the absence of any other chain-breaking final allow.
- Do not skip the review of the plugin edits. Source-audit reports can contain wrong paths, stale assumptions, or claims that the live evidence does not support.
- Do not infer completion from a missing foreground process. Retain job status, artifacts, exit codes, and reports when a reviewer uses the plugin runtime.

## Reference: the 2026-05-27 0.4.0 audit

For a worked example see:
- Commit: `b67263c` (`git show b67263c`)
- Tag: `compat-verified-kimi-code-0.4.0` (`git show compat-verified-kimi-code-0.4.0`)
- Reports (gitignored): `.claude/kimi-code-research/reports/31-upstream-04-hook-contract.md` ... `35-upstream-04-synthesis.md`
- Roadmap audit log: `ROADMAP-TO-GA.md` § "Post-GA audit log"
