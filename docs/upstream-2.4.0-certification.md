# Kimi Code 2.4.0 certification evidence — 2026-10-29

## Status and exact source

**Exact CLI 2.4.0 is certified for all eight operations by plugin 2.4.4.** Both
expanded 21-test matrices and the final clean repository, package and compiled
controls passed, including real rescue and deterministic Bash.cwd evidence in
candidate and production-table modes. Independent code review returned APPROVE,
and documentation closeout found no remaining blocker. CI, commit, push, tag,
publication, installed-host rollout and operator CLI pin changes were not
performed in this certification slice.

Candidate: `@moonshot-ai/kimi-code@2.4.0`, release commit
`f26e4d91ef8d5d233f6c20b42a150f96924d4f5e`, compared with certified 2.3.3
(`ec495f0cb00f6db9a9118bf979112886f4264a41`). npm published the candidate at
2026-10-28T11:50:24.885Z; its npm tarball SHA-1 is
`15edfa6775eb64e110235edf1c695a2042305498`. A temporary isolated npm
installation and its executable both report 2.4.0. The exact source audit used a
clean checkout at `/tmp/kimi-code-2.4.0-audit`.

## Source review

Codex's 2026-10-29 monitor supplied seven scoped diffs as leads. The certification
review also covered the load-bearing files outside those scopes, session
manager/activity changes, DI and OS backends, wire reload/migrations, KAP
activation dependencies, and the complete two-commit production delta. Four
independent source reviews returned **COMPAT-PRESERVED**, conditional on the
separate live gates: [hook/no-plan](../.claude/kimi-code-research/reports/2026-10-29-2.4.0-hook-contract.md),
[stream/session](../.claude/kimi-code-research/reports/2026-10-29-2.4.0-stream-json.md),
[CLI/activation](../.claude/kimi-code-research/reports/2026-10-29-2.4.0-cli-surface.md),
and [adversarial](../.claude/kimi-code-research/reports/2026-10-29-2.4.0-adversarial.md).
The main-thread synthesis is retained at
`.claude/kimi-code-research/reports/2026-10-29-2.4.0-source-synthesis.md`.

- The exact-tag scan passed **15 tests and 96 assertions**. The plan-file guard
  remains the sole production final allow. Executor/subscriber order, hook
  schema/aggregation, eager child hooks, Write/Edit `path`, Bash `command`/`cwd`,
  stream shapes, CLI argv, and AgentSwarm behavior remain compatible.
- Plan entry is now main-agent-only and `EnterPlanMode` is removed. Fresh print
  sessions cancel `default_plan_mode`; resumed plan sessions stay active. The
  plugin retains its config preflight, Enter/ExitPlanMode deny policy, and
  every-agent journal-taint refusal rather than relying on upstream's fresh-print
  cancellation.
- Mutable replay applies to context memory, not plan state. Restore still reads
  restorable and journal views of the same `wire.jsonl`; no second durable plan
  source or plan-producing wire migration was found. `wireService.ts` adds
  append-error logging only.
- Workspace/session leases and idle reclamation change lifecycle ownership, not
  the restore source or tool-hook route. KAP removes terminal and consolidates
  interaction routes, while the fields and endpoints used by plugin activation
  remain present. New durable MCP failure records use the same agent journal;
  KAP interaction `outcome` projections do not alter print records or supply
  tool-execution outcomes. DI scope creation and AgentSwarm's implementation are
  unchanged.

## Exact-binary controls

Controls used a task-authorized dedicated Agent Key in process memory/environment
and empty isolated homes, except the forced removed-tool control, which used a
loopback scripted provider and a dummy key. No personal config or OAuth store was
read, copied, or symlinked. All controls ran sequentially. Raw evidence is under
`.claude/kimi-code-research/cert-2.4.0-live/`.

- **Plan ON:** an authenticated loopback session was explicitly placed in plan
  mode, shut down cleanly, and resumed with a deny-all hook. The exact 2.4.0
  marker and `plan_mode.enter` were present. Glob reached the deny hook; an
  **848-byte** plan file was written without a plan-Write hook invocation. The
  workspace remained empty.
- **Plan OFF Write:** Write reached the managed hook and was denied on the same
  call ID. No target file or plan state was created.
- **Removed EnterPlanMode:** the offered tools included Write but not
  EnterPlanMode. A scripted provider forced `call_enter_forced`; the exact binary
  returned `Tool "EnterPlanMode" not found` on that ID before any hook call and
  returned the rejection to the provider. No plan state or files appeared. This
  is the 2.4.0 replacement for the older hook-denied EnterPlanMode control, not a
  claim that the removed tool reached the hook.
- **Swarm OFF:** a real AgentSwarm call returned the inactive-mode result with
  zero child journals and no probe files.
- **Swarm ON:** compiled activation produced `agent-0` and `agent-1`; each child
  attempted its assigned Write with a matching managed-denial result under the
  same toolCallId. The coordinator did not substitute writes, no probes landed,
  and deactivation verified `swarm_mode.exit`.

The exact 2.4.0 web server exited cleanly in **6.743 seconds**, beyond the prior
5-second process-close bound. The runtime therefore allows **15 seconds** for
graceful shutdown while preserving the bounded REST, ready, journal,
cancellation, identity, and kill/quiescence checks. It also sets
`KIMI_CODE_SESSION_IDLE_RECLAIM_MS=0` for plugin-owned lifecycle processes. An
ON control with the parent value set to **1 ms** still produced both children and
verified deactivation. Focused activation passed **34 tests and 125 assertions**;
the post-row setup/engine/activation set passed **137 tests and 2,043
assertions**. The separate lifecycle set passed **132 tests and 412 assertions**.
The earlier source-recognition set passed **155 tests and 2,179 assertions**.

### Invalid setup attempts, not accepted as evidence

- The first plan arming attempt stopped at the old 5-second shutdown bound before
  any print/model call. Cleanup left no candidate process.
- The first completed ON prompt followed the 6.743-second clean shutdown, but a
  recorder name collision prevented stdout and exit status from being saved. Its
  partial artifacts are preserved and are not counted as a passing control; a
  fresh explicitly identified ON run supplied the accepted evidence above.
- The real-model EnterPlanMode OFF prompt emitted no tool call because the model
  correctly reported the tool unavailable. Its saved checks fail the required
  attempt/rejection preconditions. The deterministic loopback forced-call
  control supplies the accepted evidence instead, without another paid request.
- The first expanded candidate matrix passed 20 of 21 tests but failed the real
  rescue content assertion because it required a trailing newline. The confined
  write was correct, and Bash.cwd passed. The assertion was changed to compare
  trimmed content; that run is not accepted as a passing matrix.
- The next candidate run also passed 20 of 21 tests but exposed a second fixture
  error: the shared Git fixture intentionally starts with a modified `src.ts`,
  while the assertion expected only the new rescue file in `git status`. The
  check now requires that pre-existing edit and `HEAD` to remain unchanged and
  allows only the requested file as a new status entry. Neither failed attempt
  counts as certification evidence; the fresh successful matrix is documented
  below, and the expanded production matrix remains a separate gate.

## Candidate and final release gates

- Expanded candidate matrix (`candidate-4-smoke.log`): **21 pass, 0 fail, 154
  assertions, no skips**, 440.82 seconds. Real `runRescue` landed the confined
  sentinel, preserved the pre-existing `src.ts` edit and `HEAD`, added no other
  status entries, and persisted operation/version/engine/session/artifact
  evidence. The absolute out-of-root Bash.cwd call received its exact same-call
  denial and created no file. Goal denial ran seven continuation turns without
  writes. Write-swarm produced a 278-byte child-authored patch, left the user
  tree clean, removed its worktree, and denied the out-of-root write.
- Expanded production matrix (`final-2-production-smoke.log`) using the
  production certification table with the candidate override explicitly unset:
  **21 pass, 0 fail, 154 assertions, no skips**, 431.51 seconds. Real rescue and
  deterministic Bash.cwd passed the same confinement and provenance assertions.
  Goal denial ran eleven continuation turns without writes. Write-swarm captured
  a 278-byte child-authored patch, left the user tree clean, and removed its
  worktree.
- Frozen dependency installation left the lockfile unchanged; `bun audit` found
  no vulnerabilities. Post-row focused setup/engine/activation checks passed
  **137 tests and 2,043 assertions**. The separate shutdown/lifecycle set passed
  **42 tests and 153 assertions** with 15 expected opt-in skips.
- Final full repository check (`check-final-3.log`): **1,312 pass, 30 expected
  opt-in skips, 0 fail, 16,838 assertions across 79 files**, 306.75 seconds. The
  skipped source/live gates have their separate passing opt-in evidence above.
- A package attempt contained 243 files, including 11 ignored sync-conflict
  copies under root `dist/vendor`; it is rejected as release evidence. The
  strengthened package gate refuses that filename class, proven by
  `package-conflict-negative.log`. The clean rebuild and final package
  (`package-final-3.log`) passed with **232 files**, both compiled distributions,
  isolated hook setup/check, version refusal, and modern/legacy MCP checks.
- Final compiled acceptance/refusal controls (`compiled-node-final-3.log` and
  `compiled-bun-final-3.log`) passed under Node and Bun against both root and
  Codex distributions: every operation accepts exact 2.4.0 and its normalized
  `v` form; 2.4.1, prereleases, build metadata, and mismatched hook-schema
  components refuse.
- Independent reviews: final code review returned **APPROVE** with no remaining
  P0/P1/P2 blocker. Documentation closeout found no remaining blocker after the
  four evidence links were corrected and the §4/§5 amendment scope was recorded.
  Reports are retained at `.claude/kimi-code-research/reports/2026-10-29-2.4.4-code-review-final.md`
  and `.claude/kimi-code-research/reports/2026-10-29-2.4.4-doc-closeout.md`.
  CI, commit, push, tag, publication and installed-host rollout were not
  performed in this certification slice.

## Preserved boundaries

Certification remains exact and per-operation. Legacy-v1 ends at 0.41.x. Plan
mode and unsafe experimental selectors remain refused. Hook verification,
trusted-root confinement, concurrency/defaults, one print runner, memory-only web
tokens, finite budgets, process/session identity checks, deactivation and
recovery ownership are unchanged. Existing Git trust and hook-process failure
residuals remain documented; this release does not make the hook an OS sandbox.
Publication does not install or re-pin either host.
