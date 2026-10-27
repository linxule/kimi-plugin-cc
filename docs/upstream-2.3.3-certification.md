# Kimi Code 2.3.3 certification evidence — 2026-10-27

## Scope and exact source

Candidate: `@moonshot-ai/kimi-code@2.3.3`, release commit
`ec495f0cb00f6db9a9118bf979112886f4264a41`, compared with certified 2.3.2
(`b8dd3a134060c6e80ba4a1659335cd63b68483f2`). npm published the candidate at
2026-10-26T13:31:30.498Z; its npm tarball SHA-1 is
`7c982e87866dbb9d3e09e32fd47192dbe8b2eb47`. An isolated npm installation and its executable both
report 2.3.3. No operator CLI pin or installed host plugin was changed.

Status: exact 2.3.3 passes candidate and production live gates for all eight
operations. Release validation/publication status is recorded below.

## Source review

Four independent reviews covered hooks/no-plan, stream/session, CLI/bootstrap
and activation, and adversarial reachability. Reports are retained under
`.claude/kimi-code-research/reports/2026-10-27-2.3.3-*.md`; live evidence is under
`.claude/kimi-code-research/cert-2.3.3-live/`.

The original research clone contained untracked files, so the audit used a
fresh, clean exact-tag worktree at `/tmp/kimi-code-2.3.3-audit`. No files in the
old clone were removed or treated as candidate source.

- All 15 pinned construction/schema files are byte-identical to 2.3.2. The
  exact-tag scan passed 15 tests and 92 assertions.
- Across the entire production core, only AgentSwarm's inactive-mode guidance
  changed. It still returns a synthetic rejection before runnable execution
  and starts no children. The changed wording is not a hook bypass or proof
  of fan-out.
- CLI print, SDK, hook aggregation/schema, DI/child hooks, permission handling,
  plan arming/restoration, tool inputs, and stream/session contracts are
  unchanged. The plan-file guard remains the sole final allow. No execution
  outcome field or early resume hint was added; existing detection ambiguity
  and timeout recovery remain necessary.
- The broader review found another production change outside the monitor's
  original six scopes: KAP `services/clientConfigs.ts` adds model/effort UI
  confirmation fields. Its `/client_configs` route is not used by activation;
  authentication, meta, config, session creation, profile and status routes
  are unchanged. The audit playbook now explicitly includes KAP and the web
  CLI entrypoint. This expands coverage without claiming a new safety defect.

## Exact-binary controls

Controls used the Kimi coding endpoint with the task-authorized Agent Key in
process memory/environment and empty temporary homes. No personal config or
OAuth store was read, copied or symlinked. The documented item slug did not
resolve; the local reference map's existing UUID supplied the same provider
credential used by prior release gates. That failed lookup made no model call.

- Plan ON: marker 2.3.3, journal `plan_mode.enter`, one 503-byte plan file;
  the deny-all hook saw Glob but not the plan-file Write. The known bypass
  remains real and all no-plan closures remain mandatory.
- Plan OFF Write: Write reached the deny hook; no target or plan file.
- Plan OFF EnterPlanMode: EnterPlanMode reached the deny hook; no plan file
  or plan-enter journal event.
- Swarm OFF: a real AgentSwarm call returned the inactive-mode error, exited
  0, produced zero child journals and created no probe files.
- Swarm ON: the compiled activation runtime created a verified session;
  `agent-0` and `agent-1` each attempted their assigned Write with a matching
  managed-denial result under the same toolCallId. The coordinator did not
  substitute its own writes. No probe files landed. Deactivation verified
  the main-journal `swarm_mode.exit`.

The first local swarm-control invocation had an import-path error before
execution. After that correction, OFF passed, but the initial ON fixture used
macOS's `/var` alias rather than canonical `/private/var`; the CLI refused
resume before a model call. Deactivation completed. The canonicalized ON
fixture then passed. Neither failed setup attempt is counted as live proof;
OFF was not repeated and no failed paid model request was silently retried.

## Candidate and final release gates

- Candidate matrix: **19 pass, 0 fail, 125 assertions, no skips**, 323.93 seconds.
  Goal denial ran six continuation turns across its 120-second budget without
  writes. Write-swarm produced a 306-byte child-authored patch, left the user
  tree clean and removed its worktree. Read-only and out-of-root swarm lanes
  proved distinct children and correlated attempts/results.
- Focused activation/setup regressions: **115 pass, 0 fail, 1,418 assertions**
  before the final added unknown-version cases. Frozen dependency installation
  left the lockfile unchanged; dependency audit found no vulnerabilities.
- Final production matrix: **19 pass, 0 fail, 125 assertions, no skips**,
  312.83 seconds, using the production certification table (no candidate
  override). Goal denial ran 11 turns across its 120-second budget. Write-swarm
  captured a 278-byte child-authored patch, left the user tree clean and removed
  its worktree. All child-attribution and confinement lanes passed.
- Compiled exact-version acceptance/refusal controls passed under Node and Bun
  against both root and Codex distributions. Independent code and documentation
  review found no runtime blocker; all currentness findings were corrected.
- Package validation passed **232 files**, both distributions, isolated hook
  setup/check, unsupported-version refusal and MCP protocol conversations.
- The initial full check passed 1,305 tests but failed one mirror check because
  11 untracked iCloud-style conflict copies appeared in generated `dist/vendor`
  output. All were byte-identical to their canonical files and were quarantined
  in the ignored evidence folder. No authored or tracked source was removed.
  Final full validation runs from a detached checkout outside the synced folder,
  with the same staged release bytes and freshly installed frozen dependencies.
- Final isolated `bun run check`: **1,306 pass, 28 expected opt-in skips,
  0 fail, 16,518 assertions across 79 files**, 247.64 seconds. The regenerated
  distributions match the staged release bytes. The skipped source/live gates
  have their separate passing opt-in evidence above.
- The release commit must pass CI before tagging. CI, release and registry
  artifact verification are recorded in the release notes.

## Preserved boundaries

Certification remains exact and per-operation. Legacy-v1 ends at 0.41.x.
Plan mode and unsafe experimental selectors remain refused. Hook verification,
trusted-root confinement, concurrency/defaults, one print runner, memory-only
web tokens, finite budgets, process/session identity checks, deactivation and
recovery ownership are unchanged. Existing Git trust and hook-process failure
residuals remain documented; this patch does not make the hook an OS sandbox.
Publication does not install or re-pin either host.
