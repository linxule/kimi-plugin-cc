# Kimi Code 2.1.0 and 2.1.1 certification evidence — 2026-09-24

Plugin 2.0.6 certifies exact Kimi Code 2.1.0 and 2.1.1 for all eight
native-v2 operations under the unchanged no-plan construction. Production
rows were added only after each candidate passed all source and live gates.

## Exact sources

| CLI | Release commit | Comparison |
| --- | --- | --- |
| 2.1.0 | `52437299ff78de3d0aff7f38f054e5eb20c512e5` | certified 2.0.2 (`9d07f634be94ebeb1deba2f55d247807cf729315`) |
| 2.1.1 | `f67e6398fb3210ad8ace970e2dfd5bcc984ed61f` | both 2.1.0 and certified 2.0.2 |

The morning monitor identified 2.1.0. The release follow-through found
2.1.1 published at 07:24 UTC the same day, so both exact versions receive
separate source and live gates. A patch does not inherit certification.

Four independent source reviews cover hooks, stream records, CLI/config,
and adversarial confinement. Both candidates preserve the no-plan
construction: the sole final allow remains the active plan-file guard,
with the same config, tool and wire-journal arming routes. Hook schema,
aggregation, registration order and child DI scopes are unchanged.
The new tower before-execute listener only vetoes AgentSwarm while tower
is active; the plugin refuses tower before spawn. It adds no final allow.

Print-mode argv, auto/noninteractive behavior, first-line `system.version`,
resume hints and goal summaries are unchanged. Internal timing metadata and
durable subagent lifecycle records do not enter print-mode stdout or add a
plan restore source. Forked sessions now preserve the source title kind,
consistent with the plugin's title-preservation behavior.

## Security changes and limits

2.1.0 adds realpath checks inside file-tool execution, hardens internal Git
invocations, gates project additional directories on workspace trust and
disables watchers by default. 2.1.1 removes much of this hardening and
restores watchers. The affected Git, project-directory and file-tool paths
return to the certified 2.0.2 behavior. Certification of 2.1.1 must not be
read as retaining 2.1.0's added protections.

The plugin continues to enforce direct write paths and Bash cwd against its
trusted root, independent of upstream additional directories. It gates tool
calls, not every internal subprocess. Explorer Git-context collection can
run `git status` and `git log` outside the child tool hook; repository
configuration can execute a helper there even in read-only swarm. A local
Git-only fixture confirmed `core.fsmonitor` execution and its suppression
with 2.1.0's `-c core.fsmonitor=false`. This is a trust-boundary demonstration,
not an end-to-end Kimi exploit test. See [safety limits](safety.md#what-this-safety-story-does-not-cover).

The active-plan bypass remains tracked by upstream issue #3431. Hook runner
fail-open behavior, the hook-to-write path race, trusted operator state and
repository executable configuration remain residual assumptions. The release
does not introduce a hostile-repository sandbox.

## Verification record

- Each exact source tag scan: 15 passed, 89 assertions. All twelve pinned
  construction/schema files match the previously reviewed 2.0.2 bytes.
- Candidate schema tests accept additive, version-sensitive hook events only
  on exact reviewed versions with matching components. Future versions,
  prereleases, build suffixes, mismatched components and malformed hook entries remain refused.
- Emitted root and Codex JavaScript schema checks under Node: 48 assertions
  passed, including malformed-entry and mismatch refusals.
- The API-key route did not complete 1Password access and made no model
  calls. The user then explicitly authorized using the saved machine login.
  Live authentication uses temporary isolated subscription-authentication
  copies under the CI guidance; controls and smoke run sequentially, clean
  temporary homes and stop the batch on failure. No raw config or credentials
  are printed in reports.

Pre-certification `bun run check`: 905 passed, 28 opt-in skips, zero failures,
3,159 assertions. Frozen dependencies, build, types, surfaces and drift passed.
`bun audit` reported no vulnerabilities. Final release validation is recorded below.

Exact 2.1.0 controls passed: the first stream record identified 2.1.0 in
all three runs; plan-ON denied Glob and wrote a 319-byte plan without a Write
hook payload; plan-OFF Write and EnterPlanMode each reached the deny hook,
with no target or plan file. Its candidate smoke passed all 15 tests with
84 assertions, zero failures or skips, in 540.02 seconds. No live retry ran.
Exact 2.1.1 controls also passed, each with a matching first-line version
marker. Plan-ON wrote a 585-byte plan without a Write hook payload; Glob and
an unsolicited ExitPlanMode attempt reached the deny hook. The separate
plan-OFF Write and EnterPlanMode probes were denied, with no target or plan
file. Its candidate smoke passed all 15 tests with 84 assertions, zero failures
or skips, in 492.32 seconds. No live retry ran.

Each smoke proved forced write denials under all four read-only labels,
pre-spawn plan/experimental refusals, native-v2 resume and journal-taint
refusal, goal-run no-file behavior, real read-swarm child denials, both pursue
terminal status paths, a 278-byte write-swarm patch with a clean original
checkout and removed worktree, and an out-of-root denial. The timed goal
runs establish aggregate denial and no target files, not a separately
counted denial on every continuation turn. The raw plan-ON traces were
also checked for successful Write results matching the plan paths.

All six control homes were removed. The smoke harness left no smoke homes
or test worktrees behind. This test batch did not mutate personal
configuration or install host updates. These bounded checks do not establish exhaustive compaction,
crashed-turn recovery or hostile-repository sandboxing.

Local source reports are retained under
`.claude/kimi-code-research/reports/2026-09-24-2.1-{hook-contract,stream-json,cli-surface,adversarial}.md`.
The dirty original checkout is preserved; release work is isolated in a
separate Git worktree. This task did not update installed plugins or the
operator binary. The final operator probe reports 2.1.0, whereas the morning monitor recorded 2.0.2; the
source of that intervening change was not determined. Publication and local
host adoption remain distinct.

## Final release validation

With both production rows and plugin 2.0.6 metadata in place, `bun run check`
passed: 905 tests, 28 opt-in skips, zero failures, 3,194 assertions, 65.33
seconds. The opt-in tag scans and live lanes passed separately as above.
Build, typecheck, generated surfaces and distribution drift checks passed.
Additional emitted root/Codex certification-map and version checks under Node
passed 50 assertions. Frozen dependencies and `bun audit` were clean.

The final runtime diff only extends exact-version schema acceptance and the
per-operation certification rows; permission policy and preflight logic are
unchanged. Both distribution mirrors were regenerated from source.

Both final independent reviews passed with no remaining actionable findings.
The code review checked emitted routing, version metadata and source hashes;
the documentation review checked the six control traces and both smoke logs.
