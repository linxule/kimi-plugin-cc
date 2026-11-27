# Upstream compatibility audit playbook

How to verify a new kimi-code release against kimi-plugin-cc without breaking the safety guarantees we ship.

Use this routine for every new exact native-v2 version (`>= 2.8.0`), including patches. Historical pre-2.8.0 certification records are archived at tag `v3.0.0` (including the 2.6.2 bounded-swarm baseline, 2.5.3 full-operation baseline, and 2.3.2 activation design). Plugin 3.1.0 removed `legacy-v1` and all `< 2.8.0` runtime rows.

## Current checkout certification boundary (2026-11-27)

Plugin 3.1.3 uses a rolling compatibility window starting at `>= 2.8.0` and certifies native agent-core-v2 at exact `@moonshot-ai/kimi-code@2.8.0` (release commit `46d9085f37c1b145ccfc82a24387e26aa940e94f`) and `@moonshot-ai/kimi-code@2.8.1` (release commit `62402f173c5a838a1c1f8fa263b637a22486fa39`) for all seven model operations (`ask`, `review`, `challenge`, `rescue`, `pursue`, `swarm`, `swarm-write`). Unlisted plain `2.y.z > 2.8.0` versions run read-only (`ask`, `review`, `challenge`) with a warning and `--environment local` (borrowing mechanics from the highest certified row below them, currently `2.8.1`); write, swarm, `--network`, pre-release/build suffixes, other majors, and all operations under `KIMI_PLUGIN_CC_STRICT_VERSIONS=1` refuse before spawn. Releases `< 2.8.0` and `legacy-v1` are removed and refuse before spawn.

The active checkout certification records are exact `2.8.0` ([2.8.0 record](upstream-2.8.0-certification.md)) and exact `2.8.1` ([2.8.1 record](upstream-2.8.1-certification.md)). Earlier pre-2.8.0 rows (`0.42.0` through `2.7.3`) were retired in 3.1.0; their historical records remain archived at immutable tag `v3.0.0` as prior worked examples and are not active runtime rows or evidence for another version or runtime revision:
- [2.7.3 receipt](https://github.com/linxule/kimi-plugin-cc/blob/v3.0.0/docs/upstream-2.7.3-certification.md) (38 source tests / 533 assertions, 23 stock-binary controls / 138 assertions, candidate and production live matrices each 30 passes / 402 assertions).
- [2.6.2 certification record](https://github.com/linxule/kimi-plugin-cc/blob/v3.0.0/docs/upstream-2.6.2-certification.md) (first bounded-swarm construction; do not treat the unchanged upstream scheduler as fixed).
- [2.5.3 evidence](https://github.com/linxule/kimi-plugin-cc/blob/v3.0.0/docs/upstream-2.5.3-certification.md) (prior full-operation baseline before bounded-swarm).
- [2.3.2 record](https://github.com/linxule/kimi-plugin-cc/blob/v3.0.0/docs/upstream-2.3.2-certification.md) (original host swarm activation design).

The certification basis is the **no-plan construction** (see
[`invariants.md` §1](invariants.md#1-native-v2-safety-contract-the-version-headline)),
not an upstream ordering guarantee. At every reviewed version through 2.7.3 the plan
guard ran before the external hooks and its final allow let a plan-file Write
bypass the hook (confirmed in `dist/main.mjs` at 0.42.0 and by the plan-ON live
control on every audited binary). At 2.8.0 the external hook runs first: the plan
guard is an ordinary `registerHook` hook in a later group, no production code calls
`event.allow()`, and the plan-ON control shows the hook seeing and denying the
plan-file Write (fact 15). MoonshotAI/kimi-code#3431 is still open, so the fix is
observed, not announced. Every no-plan closure stays on for every release,
2.8.0 included; at 2.8.0 the closures are a second layer, not the basis. Certification is per EXACT
version and per operation; a patch release is NOT certified until the three
gates below pass and its version is added to `KIMI_V2_RELEASES`.

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
   Audit and pin in-process session reload routes too (2.3.0: print runner,
   `sessionLookup.ts`, `sessionRunGateService.ts`). Distinguish a new model-reachable
   plan-arming route from concurrent writes to the already-trusted operator
   config/journals; the latter is the explicit provenance §2 residual, not a
   newly proven in-boundary bypass. Do not treat upstream locks as enforcement.
2. **Live control on the exact binary** with an isolated home and deny-all hook.
   Through 2.3.3, use `repro-0391/repro.ts` for plan ON and `repro-clean.ts` for
   plan OFF under `.claude/kimi-code-research/upstream-v2-hook-coverage/`:
   `default_plan_mode = true` must arm plan and its plan-file `Write` must STILL
   bypass the hook; with plan off, ordinary Write and EnterPlanMode attempts must
   both reach the hook and be denied. Exact 2.4.0, 2.4.1, 2.5.0, 2.5.1, 2.5.2 and 2.5.3 cancel the default on fresh
   print and remove EnterPlanMode, so use the revised controls for the
   exact target: `.claude/kimi-code-research/cert-2.4.1-live/` for 2.4.x,
   `.claude/kimi-code-research/cert-2.5.0-live/` for 2.5.0,
   `.claude/kimi-code-research/cert-2.5.1-live/` for 2.5.1,
   `.claude/kimi-code-research/cert-2.5.2-live/` for 2.5.2, and
   `.claude/kimi-code-research/cert-2.5.3-live/` for 2.5.3, and
   `.claude/kimi-code-research/cert-2.8.0-live/` for 2.8.0. Arm an isolated session through
   authenticated KAP profile entry, shut it down, and resume it for plan ON;
   require the ordinary OFF Write denial; force a raw EnterPlanMode call through
   the loopback scripted provider and require `Tool "EnterPlanMode" not found`
   on the same call ID before any hook call, with no plan-enter journal or plan
   file. The plan-ON result depends on the release. Through 2.7.3 the plan-file
   Write must still bypass the hook. At 2.8.0 the hook must see and deny the
   plan-file Write on the same call, with no plan file and no workspace file
   written. The ON bypass disappeared at 2.8.0; #3431 was re-read and the basis
   re-decided: the hook-before-plan order (fact 15) is the basis at 2.8.0, and the
   no-plan closures stay on for every release as a second layer. Relaxing them
   for 2.8.0 is a separate decision. If a later release brings the bypass back,
   or the 2.8.0 control stops showing the denial, treat it as a regression and
   re-audit before adding the row.
   Count payloads for the specific tool, not all calls. Keep OFF probes as
   SEPARATE prompts — a single two-step prompt lets the model stop at the first
   denial and never issue the second call (observed 2026-09-15). A model choosing
   not to call the removed tool is not proof; force the call deterministically.
   **Run every live control and smoke SEQUENTIALLY, and NEVER copy the OAuth token
   stores (`credentials/`, `oauth/`) into a temporary home.** A copy that refreshes
   rotates the refresh token; when the copy is deleted the operator's real store holds
   a revoked grant (`The provided authorization grant is invalid`, fixed only by
   `kimi login`). It happened on 2026-09-15 (two concurrent copies) and again on
   2026-10-15 (one sequential copy whose lifetime spanned a refresh). The legacy
   seeded-home route symlinks those stores, but must not be used without explicit
   authorization. Prefer the dedicated API-authenticated empty test home in
   [Live smoke authentication](ci.md#authentication-and-credential-handling),
   which does not read or link personal config or credential stores.
3. **Real-binary smoke** (Phase 1b) with the v2 lanes green for every operation.
   Before adding a production certification row, set
   `KIMI_PLUGIN_CC_SMOKE_V2_CANDIDATE=<exact-version>` together with
   `KIMI_PLUGIN_CC_KIMI_BIN=<exact-binary>`. The harness refuses a version
   mismatch, selects v2 lanes, and adds only an in-memory test-process
   write-swarm capability row so that command's real gates can run. It does
   not bypass the hook schema, hook installation or no-plan preflight.
   Review and represent a new major's hook schema first. Only after all gates
   pass may the shipped certification table gain the version.

Plugin versions advance independently using ordinary SemVer and may deliberately align with a certified CLI release. A compatible certification update takes the next unused plugin patch unless that alignment is intentional; state the exact CLI version separately and never reuse a published plugin version or tag. Version labels do not replace any certification gate.

Do not reintroduce `legacy-v1` or `< 2.8.0` rows. Do not write a
"plan-file write denied under plan mode" smoke — under the construction that
path is never armed and a green result is the vacuous-precondition failure.

## Bounded swarm certification on stock 2.8.0+

The plugin may prove a hard concurrency bound by construction instead of requiring a particular upstream fix. For exact `2.8.0` and each later certified `2.y.z` row, re-establish all of these together:

1. The canonical hook counts fresh items plus resumed IDs, rejects oversized waves, malformed input, forks (2.8.0 removed `fork` from the schema, so Kimi rejects it before the hook) and fresh singleton waves, and uses an immutable per-spawn width. Unknown/missing bounded-policy state fails closed. Several distinct managed hooks can evaluate the predicate idempotently. The escape monitor receives the same policy/width; native mode-off denial at concurrency one may yield a harmless mismatch, not positive execution evidence.
2. The subprocess environment forces `KIMI_CODE_SWARM_TIMEOUT_MS=2147483647`, overriding ambient and saved short child timeouts. Env zero is ignored. A real short-timeout control must reproduce overlapping retries; its protected counterpart must show no next wave and actual quiescence before test-provider teardown. A stuck child holds the wave until completion or finite whole-job stop.
3. Fresh children have swarm mode off, even with AgentSwarm explicitly exposed in a custom profile. Own-child resume stays in the same fresh session and rejects main or unknown identities. No historical-user-session resume is admitted.
4. Recovery controls run on the unchanged exact binary beyond its 180-second recovery interval, including structured context errors misclassified by the rate-limit matcher. Count raw live turns and held HTTP/tool processes independently of scheduler bookkeeping.
5. Concurrency one uses fresh direct print with no native swarm activation or child journals. Prove delegation denial, read-only Write denial, confined write/patch provenance, unchanged user tree, and terminal cancellation/budget behavior separately from parallel fan-out.
6. Prove native Bash backgrounding requires `TaskList`, `TaskOutput` and `TaskStop` together. The fresh owned parallel session disables `TaskStop` only after activation web shutdown and before print; unsafe paths, replaced identities or existing policy refuse. Reproduce completion-driven child wakeups with explicit backgrounding and automatic timeout detachment as negative controls, then prove the protected path prevents them. The canonical hook separately rejects explicit background Bash.
7. Verify normal-exit as well as cancellation quiescence before artifact/patch capture or test-provider teardown, including a timed-out Bash command with an otherwise surviving descendant. Count OS processes separately from agent turns: an allowed test can start many subprocesses, and individual native Bash timeout is not a descendant barrier between waves. Uncertain owned-process settlement must prevent success.
8. Real-model smoke completes useful bounded waves and single-worker work through the actual canonical runtime. Scripted reissue after a denial proves admission behavior, not model compliance. Preserve all source, no-plan, local-execution, operation, emitted-runtime and repository gates.

The parallel bound counts simultaneous Kimi child-agent turns, excludes the coordinator and OS subprocess counts, and retains the existing trusted-repository-code boundary. The soft lifetime `--cap` never becomes a hard total-count or spend limit. Earlier exact certification rows retain their stated behavior; the construction is not inherited by unreviewed versions.

## When to run

- A new exact native-v2 `@moonshot-ai/kimi-code` version ships, including a patch
- An adversarial finding in a different audit suggests a contract we depend on may have moved
- `kimi_setup({ action: "check" })` or `scripts/companion.sh setup --check` starts reporting uncertified-version warnings for a `2.y.z > 2.8.0` version users are actually running
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

- `NO ACTION` means the exact native-v2 version (`>= 2.8.0`) is already certified for the required operations and no new concern warrants action.
- `CERTIFICATION NEEDED` means the exact native-v2 version is not certified, even if only its patch number changed. Run all three gates above before adding it to `KIMI_V2_RELEASES`.
- `BLOCKER` means missing evidence, operator state, or a possible safety break prevents a conclusion.

A monitor report cannot extend a certification table or authorize publication. The release gate requires a source audit, exact-binary controls and smoke, post-edit review, `bun run check`, and a reviewed diff. Do not reintroduce `legacy-v1` or `< 2.8.0` rows.

Do not skip native-v2 certification because a changelog omits safety-related changes. Diff the source surfaces below and run all three gates for the exact release.

### Forward-scan mode (no release, but `origin/main` moved)

When the routine fires but **nothing new has shipped** — npm `latest`, GitHub `Latest`, and the local binary are all still the version we already verified — do **not** run the full Phase 1 four-agent audit, extend either certification table, or cut a tag. There's no release to certify. Instead run the *forward-scan*: a free look at what the next release will contain.

1. Generate the ten scoped diffs exactly as in Phase 0, but with `NEW='origin/main'` (after `git fetch`) and `PREV` = the last verified tag's referent.
2. Read them yourself in the main thread (no agent dispatch). The same 0-byte signal applies: zero-byte diffs for the before-execute gates (`02`), hooks (`03`), and plan arming (`04`) show those files are unchanged. Bootstrap (`05`), tool/fan-out (`06`), swarm web activation (`07`), shared core execution (`08`), OS/remote/DI boundaries (`09`), and journals and MCP start-up (`10`) can still affect enforcement.
3. Triage the non-empty diffs against the surface table below. Anything internal-only (record types not emitted to `-p` stdout, provider/model plumbing, internal abort-reason propagation) is benign for us; flag only changes to the stream-json **output shape**, argv, or the deny chain.
4. Record a short **forward-scan, not a triggered audit** note under the gitignored `.claude/kimi-code-research/` workspace with the scanned `main` SHA, the per-surface result, a provisional verdict, and the specific items to re-confirm with `bun run smoke:real` when the release actually lands.
5. **No repository commit, no tag, no version bump** — the scanned code is unreleased and will change before shipping.

The forward-scan is the lightweight discharge of the "quarterly drift" trigger above: it catches a contract moving *before* the release forces a turnaround, without spending the full ceremony on code that isn't final.

## What we depend on (the surfaces to audit)

These are the kimi-code surfaces kimi-plugin-cc consumes. If any one breaks, our safety guarantees break.

| Surface | Where in kimi-code (0.42.0, all paths under `packages/agent-core-v2/src` unless noted) | What we depend on | Where in kimi-plugin-cc |
|---|---|---|---|
| `kimi -p` print mode + permission mode | `apps/kimi-code/src/cli/v2/run-v2-print.ts` (entry via `apps/kimi-code/src/cli/run-prompt.ts` → `runV2Print`), `apps/kimi-code/src/cli/options.ts` | v2-only since 0.42.0 (the v1 engine and `KIMI_CODE_LEGACY_FLAG` are gone — the tag scan asserts the selector is absent). `auto` permission mode forced fresh and resumed, `nonInteractive:true`; `--auto/--yolo/--plan` rejected with `-p`; `-r` refuses when the session's recorded cwd ≠ current cwd (`:426`). **Load-bearing audit lesson from 0.33.0:** the selector file changed semantics while `run-prompt.ts` changed only comments — never omit the print-mode entry from the CLI diff. | `runtime/kimi-engine.ts::selectIntendedEngine` (exact-version `NATIVE_V2_CERTIFIED`), `runtime/cli-client.ts` invokes `-p` and requires the `system.version` marker first; safety relies on the hook firing under the no-plan construction |
| Before-execute channel (the ONE place every tool call is gated) | `agent/toolExecutor/beforeToolExecuteEvent.ts`, `agent/toolExecutor/toolExecutorService.ts`, plus the real generic implementation in `packages/core/src/tool/tool-executor.ts`; through 2.7.3 also `packages/core/src/tool/hook-composer.ts` (deleted at 2.8.0), at 2.8.0 the hook registry in `packages/core/src/hook/tool-executor/registry.ts` and `packages/core/src/hook/registry.ts` (agent-core paths may be compatibility re-exports) | Emitter listeners run sequentially in registration order; `veto` wins; `pass` is non-terminal; `event.allow()` is chain-breaking. Through 2.7.3, the sole `.allow()` in the engine + CLI is the plan-file guard (`features/plan/planService.ts`), gated on ACTIVE plan mode, and the subscriber set is exactly permissionGate, toolDedupe, btw, externalHooks, goal, plan, swarm, tower. At 2.8.0, `toolExecutorService.ts` builds the `starting` chain from the literal `[resetHook, legacyHook, ...hooks, internalHook]`, and the registry dispatches in insertion order with no priority. The external PreToolUse listener is registered with `registerLegacyStarting`, so it runs inside `legacyHook`, in an earlier group than every `registerHook` hook. The plan guard is a `registerHook({ starting })` hook that returns `skipPermitting` (`planService.ts`). No production code in `packages/` or `apps/` calls `event.allow()`. The production `skipPermitting` producers are the plan guard (a plan-file-only Write or Edit, and ExitPlanMode after review, which print's non-interactive review denies), the shell command service for user `!` commands only (`turnId === -1`, not reachable from `-p`), and the unreachable translation of an emitter `allow` in `legacyHooks.ts`. One construction site (`session/agentLifecycle/agentLifecycleService.ts`) builds every agent scope, so this order holds for main, subagents and swarm children, fresh and resumed | `tests/audit/v2-tag-scan.test.ts` (allow count, subscriber set, sha256 pins); the no-plan construction in `runtime/native-v2-preflight.ts` + `runtime/hooks/approval-policy.ts` |
| Plan mode arming vectors | `features/plan/planService.ts`, `features/plan/planOps.ts` (durable `plan_mode.enter|cancel|exit`, `plan.revision`), `features/plan/configSection.ts` (`default_plan_mode`), `features/plan/tools/enter-plan-mode/enterPlanModeTool.ts`, `workspace/sessionLifecycle/sessionLifecycleService.ts` (reads the default once in `sessions.create()`), `state/eventDispatcherService.ts` + `state/state.ts` (`restore()` folds ONLY `agents/<id>/wire.jsonl`, by literal `record.type`; fork `snapshotExcluded`) | exactly three arming routes from `-p`: `default_plan_mode` (single user file, no env/argv/project overlay), the `EnterPlanMode` tool, and journal replay on resume. Anything that adds a fourth (a new plan event type, a second restore source, an env binding for the default, a plan field on agent profiles) breaks the construction | `inspectPlanModeConfig` (`CLI_V2_PLAN_MODE_CONFIGURED`, relaxed for non-swarm launches on `print-cancels-plan` rows), hook denial of `EnterPlanMode`/`ExitPlanMode`, `scanSessionJournalsForPlan` (`KIMI_SESSION_PLAN_TAINTED`, tolerating only the cancelled create-time pair on those rows; only Kimi's durable MCP records (`mcp.tools_discovered`, `mcp.server_failed` and `mcp.server_failure_resolved`; 2.8.0 can write discovery there, which a live control observed; the two failure records are admitted from source and unit-tested, not observed live) may sit between the enter and the cancel; any other record or an unparseable line there taints) + proven-lineage resume; all pinned/asserted by the tag scan, and the refusals proven live by smoke lanes 3/3b |
| PreToolUse hook engine | `features/externalHooks/configSection.ts` (strict `{event, matcher?, command, timeout?}`), `features/externalHooks/internal/runHook.ts`, `features/externalHooks/internal/matchHooks.ts`, `features/externalHooks/agent/agentExternalHooksService.ts` (eager, one per agent scope incl. swarm children) | stdin JSON `{hook_event_name, session_id, cwd (process cwd), client_type, session_title, tool_name, tool_input, tool_call_id}`; exit 2 = deny with stderr reason, exit 0 + JSON `permissionDecision:"deny"` = deny, anything else allow; fail-OPEN on spawn error/timeout/abort/bad JSON; 30 s default; empty matcher = all tools; throwing regex matches nothing | `runtime/hooks/approval-hook.ts`, `runtime/hooks/approval-policy.ts`, `runtime/commands/setup.ts` (strict schema validation of every configured hook) |
| Tool result shapes (hook-escape monitor) | `beforeToolExecuteEvent.ts::denyToolExecution`, `toolExecutorService.ts` (`preflightToolCall` rejections, `resolveExecution` throws and synthetic errors settle BEFORE `fireBeforeExecute`; `settleSynthetic 'vetoed'`; `finalizeToolResult` → `onDidExecuteTool`), `toolDedupe/toolDedupeService.ts` (`appendReminder` `\n\n<system-reminder>…</system-reminder>` from the 3rd identical call; through 2.5.3 only, `HANDOFF_VETO_TEXT` on every call attempted in the handoff step that a 12th identical call starts; `KIMI_CODE_REPEAT_BREAKER`), `prompt-render.ts` writeToolResult/stringifyToolOutput | attempted call precedes result; JSON arguments equal hook input (non-plain → `{}`); a vetoed result is the trimmed hook stderr, possibly decorated; NO outcome field — pre-hook rejections (`Tool "X" not found`, `Invalid args for tool "X": …`, `PathSecurityError` messages, and through 2.5.3 `Tool skipped because a previous tool call stopped the turn.`) are indistinguishable from executed output | `runtime/hook-escape.ts` (`carriesDenial`); findings are detection evidence only — re-verify every shape before any move to enforcement |
| Hook **aggregation** across multiple hooks (incl. plugin-contributed) | `features/externalHooks/internal/matchHooks.ts` (`Promise.all`, first block in match order), `features/externalHooks/app/externalHooksRunnerService.ts` (plugin hooks appended and deduped on `cwd\0command`) | **any-block-wins**: an allow never pre-empts a block, so a kimi-code plugin's hook can neither override nor disable ours | implicit — guarantees the managed PreToolUse deny is terminal under coexistence (Claude + Codex host blocks, upstream plugins) |
| Auto-approve policy vs. hook | `agent/permissionGate/permissionGateService.ts` (→ `AutoModeApprovePermissionPolicyService`) | the auto-mode approval uses non-terminal `pass()`, never `allow()`, so it cannot pre-empt the external-hooks listener that runs after it. At 2.8.0 the permission gate runs in the `permitting` phase, after the `starting` phase in which the hook has already decided | implicit — the entire safety model assumes a hook veto beats auto-approve; the tag scan's allow-count invariant covers it |
| Plugin slash commands / command activation | `agent/pluginCommand/`, `agent/plugin/`, `app/plugin/` | activation stays RPC/host-initiated and absent from `-p`; `-p` intercepts exactly one prefix, `/goal` (`apps/kimi-code/src/cli/goal-prompt.ts:43`); a plugin command must never become a model-reachable tool or a permission bypass | read-only commands hard-prefix an instruction line so their prompt never starts with `/goal`; `runtime/commands/pursue.ts` is the only `/goal` producer |
| Tool input schemas the allowlist reads | `agent/tools/os/write/writeTool.ts`, `agent/tools/edit/editTool.ts` (`path`; Write also `mode`), `agent/tools/os/bash/bashTool.ts` (`command`, **`cwd`**, `timeout`, `run_in_background`; `effectiveCwd` asserts NO workspace membership, `:191`) | field names, and the fact that `Bash.cwd` is honoured without an upstream membership check while the hook payload's top-level `cwd` is the process cwd | `runtime/rescue-approval.ts` (`checkApprovedPath`, `checkApprovedDirectory` confines `tool_input.cwd` to the trusted root before the command string); tag scan asserts the field names |
| AgentSwarm / subagents | `features/swarm/tools/agent-swarm/agentSwarmTool.ts`, `features/swarm/agent/swarmService.ts`, scheduler/retry/timeout services, plus `packages/core/src/loop/**` and `packages/core/src/llm/policy/**` | Every child has its own eager managed hook. Review the exact schema, new/resumed entry construction, fresh child swarm-off state, own-session resume and cancellation settlement. Stock recovery can exceed the native scheduler cap; exact 2.6.2/2.6.3/2.7.2/2.7.3/2.8.0 uses the plugin construction above. At 2.8.0 `Agent` and `AgentSwarm` have no `fork` parameter, so a call carrying it fails as invalid arguments before the hook, and a subagent resume that names a `model` is rejected upstream | `runtime/swarm-policy.ts`, canonical approval hook, `cli-client.ts`, `swarm.ts`; prove bounded parallel and direct-worker paths separately |
| Swarm host activation (exact 2.3.2, 2.3.3, 2.4.0, 2.4.1, 2.5.0, 2.5.1, 2.5.2, 2.5.3 and 2.6.2/2.6.3/2.7.2/2.7.3/2.8.0 parallel paths) | Exact CLI `web` ready line and authenticated loopback `/meta`, `/config`, session create, `/environment`, `/profile`, `/shutdown`, plus `/status` through 2.4.1, protocol-v2 WebSocket agent state in 2.5.0/2.5.1/2.5.2/2.5.3, and authenticated direct `subscribe`/`response` state in 2.6.0/2.6.2/2.6.3/2.7.2/2.7.3/2.8.0. Exact 2.7.2/2.7.3/2.8.0 adds ephemeral-token JSON bootstrap and KAP 1.0.0/WebSocket meta proof without the legacy backend field. At 2.8.0 `/meta` also returns `agent_close`, `session_continue` and `home_dir`, and the environment response adds `environment_cwd`; the plugin reads named fields only and ignores them. Review their exact implementations on every new candidate | exact v2/version/auth-bypass checks, explicit or configured default model binding, local environment and expected cwd in 2.5.0/2.5.1/2.5.2/2.5.3/2.6.0/2.6.2/2.6.3/2.7.2/2.7.3/2.8.0, `permission_mode:auto`, plan off, `swarm_mode` enter/exit state and journal evidence, bounded token/response/process handling, `KIMI_CODE_SESSION_IDLE_RECLAIM_MS=0` to disable ambient idle reclamation; no model self-activation substitute and no full RPC runner | `runtime/swarm-activation.ts`; `runtime/commands/swarm.ts` runs one ordinary `kimi -p -r` per swarm job between activation and deactivation, records `preactivated`, requires the same returned session id, includes activation in the finite budget, and refuses success if cleanup fails |
| Experimental features | `packages/agent-core-v2/src/app/flag/` + each feature's `flag.ts` (the flag registry since 2.x; `apps/kimi-code/src/utils/experimental-features.ts` is the vestigial CLI-side shim) (`[experimental]` config table, per-flag `KIMI_CODE_EXPERIMENTAL_*` env, master `KIMI_CODE_EXPERIMENTAL_FLAG`; precedence env → config → master → default). The 2.8.0 registry has four flags: `tower` (default off), `notify_user` (off), `wait_for` (on) and `prompt_prediction` (off). 2.8.0 removed `subagent_fork` and `tool-select`, so `KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK` is ignored there | `tower` is a v2-only feature plugin tasks run without; the master flag enables all experimental flags; a per-flag env value outranks config and the master flag, and the master flag is read only from the process's own environment. Every tool a flag can add is denied by the managed hook under every label, because every label allows a fixed list of tool names | `buildKimiCliEnvironment` sets `KIMI_CODE_EXPERIMENTAL_TOWER=0`/`KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK=0` on every child and drops the master flag from native-v2 children, on certified and uncertified releases alike. On a certified release that is all, silently. On an uncertified native-v2 release (`2.y.z > 2.8.0`) `inspectExperimentalSelectors` finds the switched-on selectors and the launch carries a warning naming them, including the master flag. `CLI_V2_EXPERIMENTAL_UNSAFE` and `CLI_V2_HOOK_ORDER_UNSAFE` refuse only a launch with no plan |
| Execution environment selection | `app/sessionManager/sessionManagerService.ts` (session creation reads `[environments]` declarations only when no explicit local id is given) | an explicit `--environment local` on a fresh print wins over a configured `[environments] default`, and a resume applies the session's stored binding without reading the default | `inspectEnvironmentConfig` accepts `environments.default` only for fresh or resumed non-swarm launches of `local-environment` rows; the journal scan still requires a local, in-root stored binding |
| `WaitFor` (allowed by name) | `agent/tools/task/task-wait/taskWaitTool.ts` and `task-wait.ts`; the task-service or tool-handler methods it calls; `features/goal/injection/goalInjection.ts` | The hook allows `WaitFor` under every label on the ground that it waits on tasks that already exist and cannot start or stop one. A release with a new tool source must be read whole before its hash is added; re-read the methods behind its calls, which are not pinned on older rows | `READ_ONLY_TOOLS` in `runtime/hooks/approval-policy.ts`; `WAIT_FOR_TOOL_SOURCES` and the per-release census in `tests/audit/v2-tag-scan.test.ts` |
| Tools Kimi approves itself (read scope) | `agent/permissionPolicy/policies/default-tool-approve.ts`; input schemas of `Read`, `ReadMediaFile`, `Glob`, `Grep`, `WebSearch`, `FetchURL` | Kimi approves read and web tools without asking in every mode, so the managed hook is the only scope gate; each tool's argument keys and its handling of `~`, relative paths, `kimi-file://` references and the Glob/Grep search root must match what `runtime/read-scope.ts` checks. 2.8.0 adds `agent/permissionPolicy/policies/bash-read-only.ts`, which approves statically read-only Bash in Always Ask mode. It does not matter to the plugin: it runs in the `permitting` phase, after the hook, and print's auto mode never consults it | `SCOPED_READ_KEYS`, `evaluateScopedRead` and `isAllowedFetchUrl` in `runtime/read-scope.ts`; an unknown argument key denies under confinement |
| Stream-json output | `apps/kimi-code/src/cli/prompt-render.ts` (`system.version` FIRST line, `session.resume_hint`, `turn.step.retrying`), `apps/kimi-code/src/cli/goal-prompt.ts` (`goal.summary`) | NDJSON record shapes for assistant/tool/tool_result; `role:"meta", type:"system.version"` is the provenance marker a v2 plan requires first and must equal the probed version; `session.resume_hint` carries the `session_<uuid>` token that round-trips via `-r` | `runtime/stream-json.ts` parser; `runtime/cli-client.ts` provenance gate (`CLI_ENGINE_PROVENANCE_MISMATCH`) and session pinning |
| CLI argv | `apps/kimi-code/src/cli/options.ts` | `-p` (prompt as VALUE), `-r`/`-S`/`--session`, `--output-format stream-json`, `-m`, `--skills-dir` accepted with current semantics; `--agent`/`--agent-file`/`--add-dir` exist and are NEVER passed | `runtime/cli-client.ts::buildArgs`; `runtime/kimi-command.ts::assertPrefixArgsSafe` refuses reserved flags in the launcher prefix |
| Session store layout | `<KIMI_CODE_HOME>/sessions/<workspaceId>/<sessionId>/agents/<agentId>/wire.jsonl` (+ `state.json`, `logs/`) | the journal the preflight scans lives exactly there; a layout change fails closed as `KIMI_SESSION_JOURNAL_UNAVAILABLE` (every v2 resume would refuse) | `scanSessionJournalsForPlan`; smoke lane 3b asserts the real layout |
| Session state + journal shape (timeout recovery) | `packages/agent-core-v2/src/_base/utils/workdir-slug.ts` (`wd_<basename>_<hash12>`), the session `state.json` writer (`{id:"session_<uuid>", version:2, cwd, createdAt(ms), …}`, `createdAt` written at session creation before the first turn), the journal's first user record (`type:"context.append_message"`, `message:{role:"user", content:[{type:"text", text}]}` where one text item is the verbatim `-p` prompt), and `run-v2-print.ts` (`session.resume_hint` only at turn END) | `runtime/session-recovery.ts` matches on exactly these fields; the GOOD failure of a shape change is `session_recovery: none`/`digest_mismatch` on every timeout (recovery silently stops), the BAD one is a shape that still parses but binds differently — re-read the writer each audit; if upstream announces the id at session start (asked as MoonshotAI/kimi-code#4240, filed 2026-10-15), this module becomes a fallback for older certified versions and should then be removed | `recoverSessionIdFromStore`, `firstUserMessageMatches`; `tests/runtime/budget-artifacts.test.ts` recovery lane (mock journal mirrors the real record shape) |
| Auto-update preflight | update check on the `-p` path | a background upgrade must never swap the certified binary under an execution plan | every spawn exports `KIMI_CODE_NO_AUTO_UPDATE=1` and an absolute `KIMI_CODE_HOME` (`runtime/cli-client.ts::buildKimiCliEnvironment`) |
| Process / exit / lifecycle | `apps/kimi-code/src/cli/v2/run-v2-print.ts` and OS-level | stdout = stream-json only; stderr = humans-only; goal exits 0/3/6; SIGTERM lands; process group enumerable | `runtime/cli-client.ts` cancellation; `runtime/background-spawn.ts` |

### Facts the 3.0.0 relaxations rest on

Each relaxation and safety check in plugin 3.0.0 rests on one upstream fact. Re-verify every fact at every new release before adding its row or capability to `runtime/kimi-releases.ts`; if a fact fails, leave the capability off that row so the strict check applies.

1. **Print cancels plan** (`print-cancels-plan`). A fresh `kimi -p` cancels a create-time `default_plan_mode` enter before any turn (`apps/kimi-code/src/cli/v2/run-v2-print.ts`, `plan.cancel()` after `ensureMainAgent`), and the journal records that pair as an id-bearing main-agent `plan_mode.enter` followed by an id-less or same-id `plan_mode.cancel`.
2. **The setting is read only at session creation.** `default_plan_mode` is read inside `sessionLifecycleService.create` (`workspace/sessionLifecycle/sessionLifecycleService.ts`, `DEFAULT_PLAN_MODE_SECTION`), never on resume (`doResume`), with no env, argv or project overlay.
3. **Per-flag env beats config and the master flag.** `app/flag/flagService.ts` resolves a flag from its own `KIMI_CODE_EXPERIMENTAL_<NAME>` variable first, then `[experimental]` config, then the master `KIMI_CODE_EXPERIMENTAL_FLAG`, all read through the process's own environment; `"0"` parses as false. Confirm the tower variable name in `features/tower/flag.ts`. Through 2.7.3 also confirm the subagent-fork variable name in `session/subagent/flag.ts`; 2.8.0 deletes that file and removes the flag, so `KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK` is ignored there and forcing it to `0` is harmless. Check the registry for added or removed flags (`registerFlagDefinition`).
4. **Explicit environment beats the configured default** (`local-environment`). `sessionManagerService.ts` skips `[environments]` declarations when the explicit id is the local id, so `environments.default` is never read on a fresh `--environment local` print. Confirm that `openCreation` is still the only reader of the default and that resume (`doResume`) applies the stored binding instead.
5. **Kimi approves its read and web tools itself.** `default-tool-approve.ts` still lists `Read`, `Grep`, `Glob`, `ReadMediaFile`, `WebSearch` and `FetchURL`, so per-call scope must stay in the hook; re-check each tool's argument keys against `SCOPED_READ_KEYS` and whether `FetchURL` follows redirects.
6. **Workspace trust gates project MCP.** With `require_trust = false`, project MCP servers start outside PreToolUse; the plugin only warns. Re-check that no other setting widens this.

7. **Every hook block runs, and any denial wins.** Kimi runs every configured `PreToolUse` block for each tool call and a denial from any one of them blocks the call (`blockDecision` takes the first block result). Every installed kimi-plugin-cc hook checks every labelled job, and the older-host warning assumes this aggregation.
8. **A hook that exits 0 with no output makes no decision.** At 2.8.0 `resultFromExitCode` in `features/externalHooks/internal/runHook.ts` turns that into a plain allow result, and `blockDecision` in `internal/matchHooks.ts` blocks when any one result blocks, so such a result cannot override another hook's denial. Confirm both still hold.
9. **Hooks inherit the Kimi process environment.** The policy reads `KIMI_PLUGIN_CC_CMD` and the scope variables from the environment the runtime gave the Kimi child; confirm hook commands still receive that environment (at 2.8.0 `runHook.ts` passes the Kimi process environment to every hook command, with any hook-specific variables added on top).
10. **A hook that times out, crashes or cannot be spawned is an allow.** At 2.8.0 `runHook.ts` returns `allowResult` on a spawn failure, a process error and a timeout. This is why every installed hook checks every labelled job, and why the hook denies a labelled call it has not decided within 10 s, below the 15 s installed timeout (`runtime/hooks/hook-timing.ts`). Confirm the failure results and the meaning of the `timeout` key.
11. **Kimi resolves tool paths with `pathe` after `~` expansion.** `resolvePathAccess` in `tool/path-access.ts` expands a leading `~` or `~/` to the home directory (`expandUserPath`) and then resolves with `pathe`, which treats `\x`, `\\host\share` and `C:/x` as absolute and normalises backslashes to `/`, and the default policy (`DEFAULT_WORKSPACE_ACCESS_POLICY`, `guardMode: 'absolute-outside-allowed'`) allows absolute paths outside the workspace. The rescue hook therefore refuses any backslash, NUL, leading `~`, drive-letter prefix or URL scheme in Write/Edit/MultiEdit paths and `Bash.cwd`, and the read scope denies backslash and drive-letter paths and globs. Confirm the resolver, the home expansion and the default policy.
12. **Journals frame lines as the append-log reader does.** At 2.8.0 the reader is `packages/core/src/store/append-log.ts` (`parseLine`), and `persistence/backends/node-fs/appendLogStore.ts` is a thin subclass of it; through 2.7.3 the reader was `appendLogStore.ts` itself. It splits on LF only, strips one trailing CR, skips only empty lines and stops wire replay at the first terminated line that fails to parse. `runtime/kimi-journal.ts` mirrors that framing for the resume plan-taint scan and the swarm activation state; confirm it still matches.
13. **The default hook timeout is 30 seconds and the schema accepts integers 1–600.** `DEFAULT_HOOK_TIMEOUT_SECONDS = 30` in `features/externalHooks/internal/matchHooks.ts` applies when `timeout` is absent, and `features/externalHooks/configSection.ts` accepts `timeout` as an optional integer from 1 to 600. `UPSTREAM_DEFAULT_HOOK_TIMEOUT_S` and `effectiveHookTimeoutS` in `runtime/hooks/hook-timing.ts` mirror both.
14. **Kimi runs the first entry per command.** `runMatchedHooks` in `matchHooks.ts` dedupes matched hooks on cwd plus command, and the first entry wins, so every copy of this host's command must carry an enforcing timeout.
15. **The hook runs before the plan guard (2.8.0).** At 2.8.0 `toolExecutorService.ts` builds the executor's `starting` chain from the literal `[resetHook, legacyHook, ...hooks, internalHook]`, and the registry (`packages/core/src/hook/tool-executor/registry.ts`, `packages/core/src/hook/registry.ts`) dispatches in insertion order. The external PreToolUse listener registers with `registerLegacyStarting` (`features/externalHooks/agent/agentExternalHooksService.ts`), so it runs inside `legacyHook`; the plan guard registers with `registerHook` (`features/plan/planService.ts`), so it runs in the later group; and no production code in `packages/` or `apps/` calls `event.allow()`. A hook denial therefore ends the call before the plan guard is reached, in every agent scope, fresh and resumed. At each release confirm all four: the chain literal, `registerLegacyStarting` for external hooks, `registerHook` for plan, and zero `allow()` callers. If upstream moves external hooks to `registerHook`, the order again depends on construction order and this fact fails. No relaxation rests on this fact yet: every no-plan closure stays on for every release, and through 2.7.3 the fact does not hold.

An uncertified release borrows none of these facts. It borrows only `local-environment` for the `--environment local` argument, which can only narrow where the child runs. Its child still gets the forced-off per-flag variables and no master flag, but fact 3 is unproven there, so switched-on experimental selectors produce a launch warning naming them instead of a silent pass.

## The routine

### Phase 0 — Setup (5 min)

The upstream clone lives at `.claude/kimi-code-research/kimi-code-repo/`. It's gitignored.

**Precondition — the clone must be pristine.** It lives under iCloud Drive, which leaves
conflict copies (`name 2.ts`) that the file-set scan reads as new subscribers (2026-10-14:
`goalService 2.ts` turned the tag scan red). Before any gate run `git status --porcelain`
must be empty and `find . -name '* [0-9].*' -not -path './.git/*' -not -path './node_modules/*'`
must print nothing; delete copies, never audit around them.

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
# Since 2.8.0 the executor's hook registry and its group order live in
# packages/core/src/hook/, and toolSelect registers validating and starting
# hooks of its own.
git diff "$PREV".."$NEW" -- \
  packages/agent-core-v2/src/agent/toolExecutor/ \
  packages/agent-core-v2/src/agent/permissionGate/ \
  packages/agent-core-v2/src/agent/permissionPolicy/ \
  packages/agent-core-v2/src/agent/permissionMode/ \
  packages/agent-core-v2/src/agent/permissionRules/ \
  packages/agent-core-v2/src/agent/toolApproval/ \
  packages/agent-core-v2/src/agent/toolSelect/ \
  packages/core/src/hook/ \
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
# resume bootstraps and only the adversarial pass caught it). The experimental
# flag service and every feature's `flag.ts` belong here too: they decide which
# features a session starts with (fact 3).
git diff "$PREV".."$NEW" -- \
  packages/agent-core-v2/src/index.ts \
  packages/agent-core-v2/src/app/bootstrap/ \
  packages/agent-core-v2/src/app/config/ \
  packages/agent-core-v2/src/app/flag/ \
  packages/agent-core-v2/src/workspace/ \
  ':(exclude)packages/agent-core-v2/src/workspace/sessionLifecycle' \
  ':(glob)packages/agent-core-v2/src/features/*/configSection.ts' \
  ':(glob)packages/agent-core-v2/src/**/flag.ts' \
  > /tmp/kimi-<NEW>-diff/05-session-bootstrap.diff

# The TOOL LAYER (input schemas whose field names the hook allowlist reads:
# Write/Edit `path`, Bash `command` + `cwd`), the fan-out / delegation
# features (swarm, goal, tower, btw, plugin commands, agent profiles) that
# spawn or steer additional tool callers, and the SDK package under the -p path
# (a 0-byte agent-core-v2 diff does NOT cover it). `packages/kaos` was deleted
# upstream in 2.2.0; it was never imported by the CLI app.
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
  > /tmp/kimi-<NEW>-diff/06-tools-fanout-sdk.diff

# Host swarm activation uses the web server without executing browser assets.
# Audit auth/meta/config/session/environment/profile/status/WebSocket state plus their bootstrap dependencies;
# the six print/core scopes alone do not cover this lifecycle.
git diff "$PREV".."$NEW" -- \
  packages/kap-server/src/ \
  apps/kimi-code/src/cli/sub/web/ \
  > /tmp/kimi-<NEW>-diff/07-swarm-web-activation.diff

# The shared executor, loop, tool, and LLM retry implementations moved to
# packages/core in 2.7.0. The seven original scopes miss the real execution
# path and see only compatibility re-exports. Include the SDK replay input too.
git diff "$PREV".."$NEW" -- \
  packages/agent-core-v2/src/agent/loop/ \
  packages/core/src/loop/ \
  packages/core/src/tool/ \
  packages/core/src/llm/policy/ \
  packages/core/src/llm/requester.ts \
  packages/core/src/llm/response.ts \
  packages/core/src/llm/protocol/errors.ts \
  packages/core/src/llm/protocol/rules/status.ts \
  packages/core/src/llm/builtin/protocol/ \
  packages/agent-core-v2/src/llm-adapter/contract/ \
  packages/klient/src/contract/ \
  packages/klient/src/core/facade/ \
  packages/acp-server/src/ \
  packages/node-sdk/src/v2/resume-replay.ts \
  > /tmp/kimi-<NEW>-diff/08-loop-core.diff

# Local execution must remain mandatory. Review alternate OS backends, child
# scope construction, and host declarations even when their diff is empty.
git diff "$PREV".."$NEW" -- \
  packages/agent-core-v2/src/remote/ \
  packages/agent-core-v2/src/os/ \
  packages/agent-core-v2/src/_base/di/ \
  packages/agent-core-v2/src/app/hostsConfig/ \
  > /tmp/kimi-<NEW>-diff/09-os-remote-di.diff

# Journals and the records written at session start. The resume scan mirrors
# the append-log framing (fact 12), which moved to packages/core/src/store/ in
# 2.8.0. MCP servers start through program/ and agent/mcp/; at 2.8.0 their
# discovery records can land between the create-time plan enter and print's
# cancel, which the resume scan must still tolerate.
git diff "$PREV".."$NEW" -- \
  packages/core/src/store/ \
  packages/agent-core-v2/src/persistence/ \
  packages/agent-core-v2/src/program/ \
  packages/agent-core-v2/src/agent/mcp/ \
  > /tmp/kimi-<NEW>-diff/10-journals-and-mcp.diff
```

A 0-byte `03-hooks.diff` is the canonical "hook engine unchanged" signal, and a 0-byte `02` + `04` together mean the before-execute channel and the plan-mode arming vectors — the two surfaces the no-plan construction rests on — are untouched. The other diffs need real reading. `05` is the bootstrap/config surface: non-empty means session construction or on-disk config-load behaviour moved, which decides what state a session starts with before any listener runs — read it even when `01`–`04` are clean. `06` is the tool layer, the fan-out features and the SDK: read it for schema-field renames (the allowlist reads `path`/`command`/`cwd` by name), new tool callers that might not get an eager external-hooks service, and harness-level session/engine changes. `07` covers the authenticated web lifecycle used for swarm activation and recovery; trace changed dependencies even when the specific endpoints are untouched. `08` covers the real executor, loop, tool, and LLM retry implementations, including their `packages/core` homes; never accept a compatibility re-export as proof of their behavior. `09` covers alternate execution backends, host declarations, and child-scope construction that could invalidate local-only execution or per-child eager hooks. `10` covers journal framing and the records MCP start-up writes; read it against `runtime/kimi-journal.ts` and the resume scan's plan-pair tolerance. Whatever the diffs say, the release is uncertified until the tag scan (`tests/audit/v2-tag-scan.test.ts`) is green against the tree with a fresh per-version hash row, the plan-mode-ON live control gives the result gate 2 requires for that release (the bypass through 2.7.3, the hook's denial at 2.8.0), and the per-operation smoke (incl. lane 3b, native-v2 resume) passes.

### Phase 1 — Multi-agent compat review (4 parallel agents)

Dispatch four reviewers in parallel via the Agent tool with `run_in_background: true`. Each gets one surface and produces one report under `.claude/kimi-code-research/reports/NN-upstream-<scope>.md`.

Reviewer 1 — **PreToolUse hook contract** (`general-purpose` agent)
- Question: did the JSON-in / exit-code-out contract change? Did matcher semantics change? Under the no-plan construction, does every executed tool call still pass through our hook?
- For v2, trace production service-registration order and every listener that can call final `event.allow()`. "External hooks are awaited before execution" is insufficient. Verify that no chain-breaking final allow exists other than the plan-file guard under active plan mode (through 2.7.3), or none at all (2.8.0), and that the plugin closes every way to arm plan mode: config, tools, and journal replay. Through 2.7.3 the plan-ON control must reproduce the known bypass; at 2.8.0 it must show the hook denying the plan-file Write. In both cases the plugin must refuse configured or restored plan state before spawning.
- Output: `reports/NN-upstream-<ver>-hook-contract.md`

Reviewer 2 — **Stream-json output** (`general-purpose` agent)
- Question: did NDJSON record shapes change? Is `session.resume_hint` still emitted with the same field name and position in stream? Any new top-level role or meta-type our parser would warn-on?
- Output: `reports/NN-upstream-<ver>-stream-json.md`

Reviewer 3 — **CLI surface** (`general-purpose` agent)
- Question: did our flags survive byte-identical? Any new flags affecting prompt mode? Is auto-approve still hard-coded?
- Output: `reports/NN-upstream-<ver>-cli-surface.md`

Reviewer 4 — **Adversarial** (`general-purpose` agent — avoid delegating to a long-running foreground read call without durable job tracking if a host might drop the turn)
- Brief: "Three other reviewers say COMPAT-PRESERVED. Attack the claim. Find the cases where it breaks. If you can't, earn the conclusion adversarially."
- Output: `reports/NN-upstream-<ver>-adversarial.md`

All four agents must save a structured report to disk and reply with a verdict + short summary. The full report is the deliverable; the chat reply is just a teaser.

Verdicts to use (consistent across reports):
- `COMPAT-PRESERVED` — no action needed
- `COMPAT-AT-RISK` — narrow specific concern flagged, may or may not require code
- `COMPAT-BROKEN` — actual breakage, runtime change required

### Phase 1b — Real-binary smoke

Run the exact candidate with the final implementation under review. Follow the [smoke instructions](ci.md) for isolated binary installation, authentication, and credential handling. Run controls and smoke sequentially. Authentication can use dedicated API credentials or explicitly authorized symlinks to subscription credential stores (never copies); a previous successful run does not prove credentials are still valid.

For a version not yet in the production certification table, use the candidate mode:

```bash
KIMI_PLUGIN_CC_SMOKE_V2_CANDIDATE=<exact-version> \
  KIMI_PLUGIN_CC_KIMI_BIN=<absolute-path-to-exact-binary> \
  KIMI_PLUGIN_CC_SMOKE_HOME=<authorized-test-seed-home> \
  bun run smoke:real
```

The candidate version must match the binary. Candidate mode does not bypass hook-schema review, hook installation, or the no-plan preflight. Review and represent a new major's hook schema before running it.

For native v2 (`>= 2.8.0`), the smoke checks the first-line `system.version` marker against the probed version and exercises every operation in the declared certification scope. It covers hook denials, default-plan refusals, the master experimental flag kept from native-v2 children, native-v2 resume and tainted-journal refusal, `Bash.cwd` confinement, and write-swarm patch capture and cleanup where certified. The real `runRescue` lane must land a confined write and persist operation/version/session/artifact evidence; pursue and swarm-write lineage do not certify rescue. A separate deterministic Bash attempt with absolute out-of-root `cwd` must produce a same-call managed denial and no file. Read the test results to confirm which lanes ran; skipped tests are not passing evidence. On a deliberately narrowed non-swarm row, both swarm command paths must refuse with `v2-swarm-not-certified` before creating a model session, and no other skip is accepted.

Every parallel swarm smoke must prove real children, not just `AgentSwarm` calls, aggregate denials, or a patch. Concurrency-1 controls on `2.8.0+` instead require fresh direct print, no child journals or activation, managed delegation denial, main-agent confinement, patch provenance and cancellation:

- Parallel read-only lanes require distinct child journals, with each assigned Write attempt and its managed denial in that child's own journal and no probe file created.
- Parallel write lanes require distinct child journals containing the assigned edits and a captured patch containing those child-authored changes; a coordinator-only patch fails the proof. Out-of-root lanes likewise require real child journals and the expected rescue denials.
- On parallel paths requiring host activation (exact 2.3.2, 2.3.3, 2.4.0, 2.4.1, 2.5.0, 2.5.1, 2.5.2, 2.5.3 and 2.6.2/2.6.3/2.7.2/2.7.3/2.8.0), run targeted OFF/ON controls too. Direct OFF must produce zero child journals; preactivated ON must produce the distinct children and verify deactivation. Exit 0 is not evidence of fan-out.

The 2.3.2 worked example illustrates why: the initial 15/15 smoke with 84 assertions was rejected as vacuous after its OFF control produced no children. The hardened candidate matrix passed 15/15 with 115 assertions and no skips; final production-mode smoke and the other release gates remain separate requirements.

If authentication fails before a tool call, record an authentication blocker. Do not infer that hook enforcement passed or failed. Obtain authorization before fetching credentials or retrying paid calls. Run the smoke unpiped, or preserve its exit status; a successful `tail` command does not mean the tests passed.

### Phase 2 — Synthesis

Read all four reports and the live results. Save a synthesis to `reports/NN-upstream-<ver>-synthesis.md`.

| Finding | Outcome |
|---|---|
| An already-certified version needs documentation corrections | Documentation update; no certification or version change |
| A new exact native-v2 version passes every gate | Add the production certification row and prepare the next unused plugin patch release with explicit upstream compatibility |
| A deliberately narrowed scope passes every in-scope gate and all exclusion/refusal controls | Add only the proven operation rows, name the exclusions, and prepare the next unused plugin patch with that explicit scope; never imply full-operation certification |
| A gate fails or evidence is incomplete | Keep the candidate uncertified; record the blocker and required follow-up |

A certification-table addition changes runtime routing even when upstream's hook implementation is unchanged. It is not a docs-only checkup. Matching upstream's version number never substitutes for a passing gate.

### Phase 3 — Edits

After all candidate gates pass, add the release's row to `KIMI_V2_RELEASES` in `runtime/kimi-releases.ts`: its exact version, the upstream commit, its scope (`all` or `non-swarm`) and only the capabilities this audit re-proved for it. `NATIVE_V2_CERTIFIED` in `runtime/kimi-engine.ts` and every version-gated branch derive from that row. Then update the per-capability lists in `tests/runtime/kimi-releases.test.ts` one capability at a time; that test is the deliberate second spelling, so a copied row cannot widen a gate unnoticed. Update the exact-version source hashes and assertions in `tests/audit/v2-tag-scan.test.ts` only after reviewing their source changes.

A deliberately narrowed certification must name its excluded operations in the table and contract: excluded swarm modes must refuse before spawn with `v2-swarm-not-certified`, including at the persisted-plan boundary, and its production matrix must replace excluded swarm execution lanes with real command-refusal checks and permit no other skips. Keep `NATIVE_V2_CERTIFIED_VERSIONS` as the all-operation export for automatic full-swarm pins; use `NATIVE_V2_ANY_OPERATION_VERSIONS` for the scoped union and per-operation rows. No unlisted patch is certified by implication.

Update the current compatibility statements in `AGENTS.md`, `docs/invariants.md`, this playbook, and the active `docs/upstream-<version>-certification.md` record. Follow the [release checklist](../AGENTS.md#releasing) for version metadata and the changelog.

Batch source and wording edits before running `bun run build` and `bun run generate:surfaces`. Stage `dist/`, `plugins/kimi-codex/`, `cordis.patch.yml`, and `dsh/index.json`, then run `bun run check`. Never copy personal config or credential stores as an automatic troubleshooting step; use the authentication procedure in [CI and live smoke](ci.md).

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

- Do not run a gate against a clone with conflict copies or uncommitted noise; the file-set scan trusts the tree.
- Do not add a certification row on source reading alone. Record the exact binary, source tag, final implementation, and live gates that passed.
- Do not describe a skipped smoke as a pass. A cloud-prepared change remains smoke-pending until the final tree passes with authorized authentication. The manual GitHub workflow supports API-key authentication; enabling per-push calls is a separate cost decision.
- Do not reuse an earlier green run to cover later behavior changes. Run the affected live lanes against the implementation that will ship.
- Do not certify parallel swarm from an `AgentSwarm` call record, aggregate denial text, a sentinel patch, or exit 0. Require distinct child journals and assigned per-child attempts/results; parallel write lanes must also tie captured changes to those children, and activation versions need direct-OFF/preactivated-ON controls. The explicit concurrency-1 path has separate direct-worker evidence and never substitutes for fan-out proof.
- Do not treat a zero-byte hook diff as proof of the whole construction. Inspect bootstrap, session restoration, tool execution, and child scope creation too.
- Do not assume the hook is the first native-v2 listener. Its enforcement depends on the no-plan construction and the absence of any other chain-breaking final allow.
- Do not skip the review of the plugin edits. Source-audit reports can contain wrong paths, stale assumptions, or claims that the live evidence does not support.
- Do not infer completion from a missing foreground process. Retain job status, artifacts, exit codes, and reports when a reviewer uses the plugin runtime.

## Reference: the 2026-05-27 0.4.0 audit

For a worked example see:
- Commit: `b67263c` (`git show b67263c`)
- Tag: `compat-verified-kimi-code-0.4.0` (`git show compat-verified-kimi-code-0.4.0`)
- Reports (gitignored): `.claude/kimi-code-research/reports/31-upstream-04-hook-contract.md` ... `35-upstream-04-synthesis.md`
