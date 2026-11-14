# Native v2 status — 2026-11-14

## Exact 2.6.2 bounded swarm certification

Plugin 2.6.2 adds a plugin-owned construction on stock CLI 2.6.2: bounded waves for concurrency at least two and a direct single-worker path for concurrency one. The canonical hook counts fresh plus resumed entries, rejects forks, invalid input and fresh singleton waves, and shares immutable policy/width with the escape monitor. The swarm-child timeout exceeds the finite job budget, so a stuck child holds its wave until completion or whole-job stop. Fresh parallel sessions disable native `TaskStop` after activation shutdown and before print to close Bash backgrounding and completion-driven child wakeups; the hook also denies explicit background Bash. Nesting stays off for fresh children. Normal exit and cancellation require owned-process quiescence before artifact or patch capture. The bound counts simultaneous Kimi child turns, not OS subprocesses; individual Bash timeouts do not establish descendant quiescence between waves.

**Exact CLI 2.6.2 is certified for all eight operations** on final runtime `b69a416d8588ed12239148ccc9f120e3dbfe0dcb`: 23 stock-binary controls / 138 assertions, 30 live-provider tests / 386 assertions, 1,767 full-suite passes / 23,008 assertions, and 130 Linux-host passes / 832 assertions. Source, package, consumer-security and independent-review gates pass. The [certification record](upstream-2.6.2-certification.md) retains the first failed Linux CI, the later intermediate CI pass and final correction evidence. Release CI, tagging and publication remain pending. Stock CLI source and binary remain unchanged, including the upstream recovery defect.

Plugin 2.5.9 previously certified the six non-swarm operations on exact 2.6.2. Its source scan, candidate smoke, scoped production matrix and publication evidence remain preserved in the certification record. That history is not rewritten. Exact 2.6.1 and 2.6.3 remain untested; older full-operation rows retain the disclosed recovery limitation.

## Exact 2.6.0 non-swarm scope

Plugin 2.5.8 certifies exact CLI 2.6.0 for review, challenge, ask, rescue, review gate and pursue only. Read-only swarm and write swarm are excluded and refuse before model spawn with `v2-swarm-not-certified`; neither falls back to legacy-v1. This boundary also applies to persisted plans and every host transport. Setup reports the narrowed scope. The production-table matrix passed **23 tests with 170 assertions in 241.67 seconds**, with exactly the three excluded swarm execution lanes skipped and both real command-refusal checks passing. The [2.6.0 certification record](upstream-2.6.0-certification.md) owns the exact-binary evidence.

The exclusion is load-bearing: upstream rate-limit recovery can exceed `maxConcurrency` (two active attempts at cap 1 and five at cap 4). The candidate protocol/executor integration and the full 24-test candidate matrix passed, but those results do not certify production swarm use on 2.6.0. The older full-operation rows through exact 2.5.3 retain their inherited limitation; certified 2.6.2 uses the separate construction above. `NATIVE_V2_CERTIFIED_VERSIONS` remains the all-operation export for automatic full-swarm pins; `NATIVE_V2_ANY_OPERATION_VERSIONS` owns the scoped union, so full-swarm pin selection does not select non-swarm-only 2.6.0. The upstream correction is tracked in [issue #4926](https://github.com/MoonshotAI/kimi-code/issues/4926); certifying swarm on a later release requires fresh bound controls and full-scope matrices.

Plugin 2.5.7 certifies exact CLI 2.5.3 for all eight operations
(`5af9942e9fb789b6a1530830575b3768499932e9`). Candidate and production matrices
each passed 24 tests with 201 assertions and no skips in 349.07 and 406.19
seconds, including real rescue, deterministic Bash.cwd denial, resume/plan-taint
refusal, both swarm modes, child-authored patch capture, and out-of-root denial.
Earlier certified versions, including exact 2.5.0, 2.5.1 and 2.5.2, remain supported; the
[runtime table](../runtime/kimi-engine.ts) is the exact routing authority.
Legacy-v1 remains limited to pinned binaries through 0.41.x. Publication does
not update installed hosts or the operator's CLI pin.

The exact-tag scan passed 18 tests with 153 assertions; all 40 pinned source
files are byte-identical to 2.5.2. Upstream 2.5.3 changes steering/transcript
healing, agent-loop turn handling, MCP stdio startup diagnostics and Windows
process spawning; the executor, hooks, plan, print, environment and WebSocket
pins are unchanged. Plan OFF denied an ordinary Write; armed plan ON wrote a
1,417-byte plan file without a plan-Write hook. A deterministic forced
EnterPlanMode call was rejected before the hook. Direct swarm OFF produced
no children; preactivated ON produced two children with managed denials and
verified deactivation, including the idle-reclaimer override. Both matrices
captured a 278-byte child-authored patch with a clean user tree and removed
worktree. Repository and package evidence is recorded separately in the
[2.5.3 certification record](upstream-2.5.3-certification.md).

Exact CLI 2.3.2, 2.3.3, 2.4.0, 2.4.1, 2.5.0, 2.5.1, 2.5.2 and 2.5.3 require host-preactivated swarm
sessions. Short-lived authenticated loopback lifecycles bracket one ordinary
`kimi -p -r` runner. Exact 2.5.0/2.5.1/2.5.2/2.5.3 replaces removed `/status` with protocol-v2
WebSocket main-agent state, requiring unique request IDs, an accepted
subscription, and the latest frame through intentional bounded close. It also
pins `environment_id:"local"` and the expected cwd before either profile mutation.
Remote defaults, disabled workspace trust, and resumed nonlocal or wrong-root
bindings refuse before spawn. Fresh 2.5.0/2.5.1/2.5.2/2.5.3/2.6.0/2.6.2 print selects `--environment local`;
resume never receives that flag; the environment preflight rejects any persisted nonlocal or wrong-root metadata/binding, while older sessions without environment records do not fail this check merely for lacking them.
Tokens remain in memory, activation consumes the finite budget, graceful shutdown
retains the 15-second allowance, and unverified cleanup prevents success.

Parallel swarm evidence requires distinct child journals and each assigned
Write/Edit path correlated with its own toolCallId/result. A tool-call record,
exit 0, aggregate denial or coordinator-only patch is insufficient for fan-out.
The exact-2.6.2 concurrency-1 path instead requires fresh direct-worker provenance,
no child journals or activation, delegation denials, confinement and cancellation. The 2.5.3 OFF
control created no children; ON produced two children with managed denials and
verified deactivation, including with parent idle reclamation set to 1 ms. A
separate evidence-preserving out-of-root control correlated two child Writes with
rescue denials and created no files.

Exact 2.4.0, 2.4.1, 2.5.0, 2.5.1, 2.5.2, 2.5.3, 2.6.0 and 2.6.2 remove EnterPlanMode and cancel default plan mode on
fresh print; deterministic forced calls reject before the hook with no plan
state. Resumed plan sessions remain possible, so every-agent journal refusal
stays mandatory. Stream records still lack execution outcomes, and session hints
remain late, so detection ambiguity and timeout recovery are unchanged.
Publication does not update installed hosts or the operator's CLI pin. Plugin and
CLI versions advance independently; their numbers are not certification evidence.

For the earlier 2.4.1 certification and publication record, see
[the 2.4.1 evidence](upstream-2.4.1-certification.md).

> **2.3.2 (certified 2026-10-25, plugin 2.4.1; retained by 2.4.2):** this release
> introduced the bounded host activation lifecycle and child-attributed swarm
> proof. The initial superficially green swarm run was rejected as vacuous;
> the hardened candidate and final production gates passed before publication.
> See [the complete historical record](upstream-2.3.2-certification.md).

> **2.3.1 (certified 2026-10-23, plugin 2.3.1; retained by 2.4.0):** the exact
> tag scan, plan-ON/OFF controls and full candidate smoke passed (15/15, no
> skips). Plugin 2.4.0 also added the shared MCP transport. Workspace trust and
> session locking changed without adding a plan-arming vector or a print-mode
> takeover path. See [evidence and limits](upstream-2.3.1-certification.md).

> **2.3.0 (certified 2026-10-22, plugin 2.2.2):** the reload path rereads trusted
> operator journals; the earlier monitor's fix-first conclusion was corrected,
> not hidden by a speculative runtime guard. Structured occupied-session errors
> retain their diagnostic reason. See [evidence](upstream-2.3.0-certification.md).

> **2.2.0 (certified 2026-10-14):** source scan, controls and 15/15 smoke
> passed; `KIMI_CODE_TRUST_WORKSPACE` is stripped from child environments.
> See [evidence](upstream-2.2.0-certification.md).

> **2.1.0 / 2.1.1 (certified 2026-09-24, plugin 2.0.6):** both exact versions
> passed their own source scan, plan-ON/OFF controls and complete sequential
> candidate smoke under the unchanged no-plan construction. The active
> plan-file bypass persists. Version 2.1.1 rolls back much of 2.1.0's path/Git
> hardening to 2.0.2 behavior; trusted repository Git configuration remains an
> explicit boundary. See [evidence and limits](upstream-2.1-certification.md).

> **2.0.2 (certified 2026-09-20, plugin 2.0.4):** exact source `9d07f634`
> retains the no-plan construction and unchanged hook schema. Four source
> reviews, the 15-test tag scan, plan-ON/OFF controls and all 15 candidate
> smoke tests passed, with no live retries. The production matrix includes
> exact 2.0.2 for all eight operations. Installed hosts remain unchanged.
> See [certification evidence](upstream-2.0.2-certification.md).

> **2.0.1 (certified 2026-09-19, plugin 2.0.3):** exact release `caf7d4e2`
> preserves the no-plan construction. The reviewed same-wire restore API and
> exact hook schema pass the updated tag scan (15/15). Plan-ON reproduced the
> bypass; plan-OFF denied Write and EnterPlanMode. All 15 candidate smoke tests
> passed without retries, including pursue completion/blocked status and swarm
> confinement. Plugin versions now advance independently from upstream.
> See [certification evidence and limitations](upstream-2.0.1-certification.md).


> **2.0.0 (certified 2026-09-17, plugin 2.0.0):** the exact release
> `1b89e4b0` preserves the no-plan construction and hook schema. The changed
> wire flush targets the same agent journal; swarm eviction/rebuild uses the
> normal lifecycle and eager hooks. Tag scan: 15/15. Plan-ON reproduced the
> bypass; plan-OFF denied Write and EnterPlanMode. Full smoke: 12 passed and
> one failed because the coordinator never fanned out. After clarifying the
> negative-test fixture prompt, that case passed a targeted retry, including
> the unchanged fan-out/no-escape assertions and the surfaced denial reason.
> The production matrix now includes exact 2.0.0 for all eight operations.
> Plugin certification releases now use the upstream version number.

> **0.43.0 / 0.43.1 (certified 2026-09-15, plugin v1.10.3):** every fact below re-verified
> on both exact tags. All seven load-bearing files are byte-identical between 0.43.0 and
> 0.43.1; `beforeToolExecuteEvent.ts`, `planService.ts`, `planOps.ts`, `config/toml.ts` and
> `wire-scan.ts` are byte-identical to 0.42.0. The two that changed are the restore refactor
> (`state/eventDispatcherService.ts`, `state/state.ts`): patch-history undo became in-memory
> state snapshots, and `restore()` now folds `wire.readRestorable()` (the undo/branch-filtered
> view of the SAME `agents/<id>/wire.jsonl`, `wire/tree/fork.ts::restorableChain`, a pure
> in-memory filter) before `wire.readJournal()`. No second on-disk restore source, so the
> plugin's raw journal taint scan stays a strict superset of what a resume can replay. The
> plan-ON live control reproduces the bypass on both binaries (hook saw `Glob` only, plan
> file written); the plan-OFF control shows `Write` and `EnterPlanMode` both hook-denied.

kimi-code **0.42.0** (commit `6954d2c8bf94a5c7fc29cc6ae35b15d042cc4dcb`) removed the
legacy agent-core-v1 package and `KIMI_CODE_LEGACY_FLAG` (#3542, not mentioned in
its changelog). `kimi -p` is native v2 unconditionally. The plugin's forced-v1 pin
is therefore inert on 0.42.0, and the plan-before-external-hooks ordering the
plugin refused since v1.9.4 is still present — now confirmed in the shipped
bundle, not only in source (`registerFeature(PlanFeature)` precedes
`registerFeature(ExternalHooksFeature)` in `dist/main.mjs`).

Since kimi-plugin-cc 1.10.0, every operation supports native v2 under the
[amended entry gate](native-v2-certification-provenance.md#2-native-v2-entry-gate):
the engine's only chain-breaking final allow is provably never armed in a
plugin-managed session, and every executed tool call passes the managed hook.

## The construction, at exact 0.42.0

- The sole `event.allow()` in `agent-core-v2/src` + `apps/kimi-code/src` is the plan-file
  guard, `features/plan/planService.ts:110`, gated by `if (plan === null) return;` (`:104`).
  It fires only while plan mode is ACTIVE, and only for a Write/Edit whose every write access
  string-equals the plan path under `<KIMI_CODE_HOME>/sessions/…/plans/<id>.md` (`:238-240`,
  `:259-270`; `..` collapsed by `pathe.normalize`, no realpath).
- Plan mode arms from a `kimi -p` session in exactly three ways:
  1. `default_plan_mode = true` — or any spelling the loader's `snakeToCamel` maps to the
     `defaultPlanMode` domain (`app/config/toml.ts`; the `[experimental]` table keeps raw keys) —
     in the single user `config.toml`, read once inside
     `sessions.create()` (`sessionLifecycleService.ts:221-227`; no env, argv or project overlay;
     `printDefaults.ts` leaves it alone). **Closed pre-spawn** by
     `runtime/native-v2-preflight.ts::inspectPlanModeConfig` (`CLI_V2_PLAN_MODE_CONFIGURED`).
  2. The `EnterPlanMode` tool (`enterPlanModeTool.ts:38`), an ordinary tool: nothing
     final-allows it and the auto-approve policy uses non-terminal `pass()`. **Closed** by the
     managed hook (`approval-policy.ts` denies `EnterPlanMode`/`ExitPlanMode` for every label).
     Confirmed live on 0.42.0: the hook saw the call and denied it; no plan file.
  3. Resume of a session whose agent journal holds a durable `plan_mode.enter` record
     (`planOps.ts:20`, replayed active `:84-93`; `doResume` never exits plan). `restore()` folds
     ONLY `agents/<agentId>/wire.jsonl` (`eventDispatcherService.ts:776-826`; `rehydrateStates`
     reloads blobs only; fork excludes plan state, `state.ts:72`). **Closed** by resuming only
     proven native-v2 plugin lineage after a raw journal scan
     (`scanSessionJournalsForPlan` → `KIMI_SESSION_PLAN_TAINTED`). Confirmed live on 0.42.0
     (smoke lane 3b, `tests/runtime/real-binary-smoke.test.ts`): a fresh run's real
     `sessions/<ws>/<session>/agents/main/wire.jsonl` is found where the scan looks; the `-r`
     resume re-emits `system.version` first, keeps the same session id and is still hook-denied
     on a write; and a `plan_mode.enter` record appended to that journal makes the next resume
     refuse before any process is created (the journal does not grow).
- Not reachable from `-p`: kap-server `sessionAgentConfig` (`kimi web/server` only), the TUI
  `/plan` command (`-p` intercepts only `/goal`), `--plan` (rejected with `-p`), agent profiles
  (no plan field; builtin `plan` profile excludes `EnterPlanMode`), subagents/AgentSwarm/`Agent`/
  fork/tower (fresh scope, empty journal), undo (kap only).
- Every execution passes `prepareToolCall` → `fireBeforeExecute` (`toolExecutorService.ts:415`);
  MCP tools share the registry; each subagent gets its own eager external-hooks service. A hook
  veto beats the auto-approve gate. Hook contract unchanged: strict
  `{event, matcher?, command, timeout?}`, exit 2 = deny, first block wins, fail-open on runner
  errors.

Live evidence (2026-09-09, isolated seeded home, deny-all hook, plan mode off): an ordinary
`Write` and an `EnterPlanMode` attempt both reached the hook and were denied. With plan mode
ON (monitor control), the plan-file `Write` bypasses the hook in both unflagged and
`KIMI_CODE_LEGACY_FLAG=1` runs — the refusal is load-bearing and the flag is inert.

## Other 0.42.0 facts the plugin now depends on

- `Bash` accepts `cwd`; `effectiveCwd = view.resolve(args.cwd ?? view.workDir)` (`bashTool.ts:191`)
  asserts no workspace membership, and the hook payload's top-level `cwd` is the process cwd —
  the rescue allowlist reads `tool_input.cwd` and confines it to the trusted root.
- `-r` refuses when the session's recorded cwd differs from the current cwd
  (`run-v2-print.ts:426-432`).
- `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` caps normal launches on 0.18.0+, but **unset = no
  cap**; the plugin always exports it (4 read / 1 write). Reviewed 2.5.3/2.6.0/2.6.2 sources can
  exceed the requested cap during rate-limit recovery, so this is not an unconditional peak
  or write-serialization guarantee. See `docs/safety.md` for the current limitation.
- The update preflight runs on the `-p` path; every spawn exports `KIMI_CODE_NO_AUTO_UPDATE=1`.
- `[experimental]` config alone can enable `tower`/`subagent_fork`; the preflight refuses them
  (`CLI_V2_EXPERIMENTAL_UNSAFE`) alongside the master `KIMI_CODE_EXPERIMENTAL_FLAG`.
- `system.version` is always the first stream-json line; a native-v2 plan REQUIRES it and it
  must equal the probed version (`CLI_ENGINE_PROVENANCE_MISMATCH` otherwise).
- Write/Edit still use `path`; a new singular `Agent` tool exists and stays denied.

## What this does not claim

- Not "the hook precedes every final allow". Upstream documents no ordering contract; the
  construction is re-proven per certified tag by `tests/audit/v2-tag-scan.test.ts` plus the
  plan-ON live control, and certification is exact-version (`0.42.0`), per operation. The scan
  sha256-pins not only the allow gate and plan guard but the restore-folding source
  (`state/eventDispatcherService.ts`, `state/state.ts`) and the plan event classes
  (`features/plan/planOps.ts`, asserting the durable type set is exactly
  `plan_mode.enter|cancel|exit` + `plan.revision` — the prefixes the journal scan keys on —
  and that `restore()` folds by literal `record.type`), so a future patch that widens what
  `restore()` loads or renames a plan event — the closures the journal taint scan depends on —
  fails the audit loudly instead of silently outflanking `scanSessionJournalsForPlan`.
- The upstream hook runner still fails open on its own internal errors; allowed repo test/build
  commands still execute repo code. Unchanged from v1.
- Native plan mode, tower, subagent fork, Remote Control, `--add-dir` are out of scope and
  refused or never passed.

## Upstream follow-up

[#3431](https://github.com/MoonshotAI/kimi-code/issues/3431) stays open as the preferred end
state (a released external-hook-before-every-final-allow guarantee would let the gate return to
its original form and permit native plan mode). The reference fix needs a rebase onto 0.42.0.
