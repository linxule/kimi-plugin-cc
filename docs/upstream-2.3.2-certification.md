# Kimi Code 2.3.2 certification evidence — 2026-10-25

## Scope and exact source

Candidate: `@moonshot-ai/kimi-code@2.3.2`, release commit
`b8dd3a134060c6e80ba4a1659335cd63b68483f2`, compared with certified 2.3.1
(`684bae9ea6a437f3bae98bba1dcb797a917d500b`). GitHub published the release at
2026-10-25T07:59:14Z; npm published it at 2026-10-25T08:01:23.373Z. The npm
tarball SHA-1 is `2ede3545600b05172060e7b2b15b28ebb3521850`. A separately
installed binary and its package both report 2.3.2. The operator's CLI and host
plugin pins were not changed.

Status: certified for all eight operations. The exact-tag scan, plan controls,
activation prototype, hardened candidate matrix, final production smoke, full
repository validation, package validation, and independent reviews passed.
Release CI and registry publication remain pending. The initial superficially
green swarm result is explicitly rejected below.

## Source review

The exact source clone was clean and contained no conflict copies. Twenty-two
files changed. Four independent reviews covered the no-plan/hook construction,
stream-json, CLI/config/bootstrap, and adversarial reachability. Their reports
and synthesis are retained locally under
`.claude/kimi-code-research/reports/2026-10-25-2.3.2-*.md`.

- The 15 load-bearing hook, plan, restore, schema, and print-mode files are
  byte-identical to 2.3.1. The tag scan passes **15 tests, 0 failures, 92
  assertions** after adding the reviewed 2.3.2 hash row.
- The sole final `event.allow()` remains the active plan-file guard. No new
  plan-arming vector, external-hook schema change, or stream execution-outcome
  field was found.
- Upstream PR [#4384](https://github.com/MoonshotAI/kimi-code/pull/4384)
  intentionally requires active swarm mode before AgentSwarm execution and
  explicitly removes self-activation from `kimi -p`. PR
  [#4386](https://github.com/MoonshotAI/kimi-code/pull/4386) separately limits
  unsolicited delegation. These are behavior changes, not a PreToolUse bypass.
- An inactive AgentSwarm result settles before the external hook without
  executing a tool body or starting children. Under labels that deny AgentSwarm,
  that is another pre-hook synthetic rejection in the existing detection-only
  ambiguity class, not positive execution evidence.

## Non-vacuous plan controls

The controls used the exact isolated binary, empty isolated seed homes, a
deny-all hook, and an explicitly authorized Agent Key only in process
environment through the documented `op-agent` route. No personal config or
OAuth store was read or copied.

- Plan ON: first stream marker 2.3.2; journal contains `plan_mode.enter`; one
  740-byte plan file was written; the hook saw Glob and no plan-file Write.
- Plan OFF ordinary Write: first marker 2.3.2; Write reached the deny hook and
  no target or plan file exists.
- Plan OFF EnterPlanMode: first marker 2.3.2; the tool reached the deny hook
  and no plan file exists.

## Why the first smoke result was rejected

The unchanged candidate harness reported **15 pass / 84 assertions**. That is
not accepted as swarm certification. Source reviewers had already shown that a
rejected AgentSwarm still produces a tool-call record and that a coordinator
can produce the denial or patch itself.

A dedicated OFF control made the false-green concrete: exact 2.3.2 returned
`Swarm mode is off`, created **zero child journals**, created no probe files,
and still exited 0. Exit status, an AgentSwarm record, aggregate denial text,
and a sentinel patch therefore do not establish fan-out.

## Host-activated swarm design and proof

Upstream preserves supported host activation through its local API. The
plugin's exact-version activation lifecycle:

1. Start the execution plan's exact CLI as `web --no-open --host 127.0.0.1
   --port 0 --log-level error`, with the same operation, trusted-root, model,
   thinking, concurrency, home, and no-auto-update environment as print.
2. Require authenticated `/meta` to report backend v2, exact 2.3.2, and
   `dangerous_bypass_auth:false`. The ready bearer token remains in memory and
   never enters logs, job records, errors, or prompts.
3. Create the session at the real swarm/worktree cwd. Bind explicit `-m` or the
   effective default; the `KIMI_MODEL_*` environment model binds as
   `__kimi_env_model__`. The only field consumed from the secrets-redacted
   `/config` projection is `default_model`.
4. Set `swarm_mode:true` and `permission_mode:auto`; verify `/status` also has
   plan mode off and the expected model. Shut the server down, then resume the
   same job through the ordinary `kimi -p` runner.
5. After print, use a second bounded lifecycle to set swarm false and verify a
   new main-journal `swarm_mode.exit`.

The job records `kimi_session_id_source = "preactivated"` before model spawn,
and the returned print session must match. Activation consumes the operation
budget; phase remains `turn-running`, so the MCP attachment contract is
unchanged. Cancellation aborts the owned lifecycle and never starts a fresh
cleanup server. Cleanup failure prevents completion and retains raw output,
structured diagnostics, and the write worktree. Older certified versions stay
on direct print without activation processes.

A standalone ON control produced `agent-0` and `agent-1`, each with its
assigned Write and the managed denial in its own wire journal. No probe files
landed, and cleanup journaled `swarm_mode.exit`. Earlier attempts that omitted
model binding or used the raw model alias failed before tool execution; they
are setup evidence only.

## Verification completed before review fixes

- Frozen dependency install: no changes.
- Exact-tag scan: **15 pass, 0 fail, 92 assertions**.
- Activation and command orchestration: **35 pass, 0 fail, 159 assertions**
  over real Node mock-web processes and loopback REST, including early-parent
  and graceful-shutdown survivors, SIGKILL escalation, cancellation, mismatch,
  budget accounting, and cleanup recovery. A compiled lifecycle with two
  surviving descendants also passed under Node.
- Existing focused runtime suites: **142 pass**. Timeout/session recovery:
  **41 pass**. Engine and setup: **97 pass, 1,305 assertions**.
- Targeted live read swarm, write swarm, and out-of-root swarm all passed with
  actual child journals, child-attributed denials or writes, and cleanup.
- Hardened full candidate matrix: **15 pass, 0 fail, 115 assertions, no skips**
  in 298.74 seconds. Pursue paused at its 120-second budget without writes;
  write-swarm captured a 278-byte patch, left the user tree/HEAD clean, and
  removed its worktree. Every swarm lane required distinct child journals and
  correlated assigned writes/results rather than aggregate output.

## Independent review and completed hardening

Claude and Codex both reviewed the implementation read-only. Their findings
were addressed and independently verified before the final live gate:

- A parent web exit was incorrectly treated as complete process-tree teardown.
  This was independently reproduced by Codex. Descendant identities are now
  retained through readiness, REST activity, and shutdown; early-parent and
  graceful-shutdown survivors are reaped, with SIGKILL escalation and bounded
  quiescence regressions.
- Command orchestration now has direct tests for activation identity, resume
  handoff, mismatch cleanup, budget/cancel behavior, and cleanup failure. Phase
  remains `turn-running`, preserving the MCP attachment contract.
- Cancellation/cleanup now avoids a fresh server after cancellation, persists
  engine evidence before cleanup, includes `cleanup_error` and available raw
  output in structured failure details, and preserves the write worktree when
  cleanup is unverified.
- Smoke evidence must correlate each assigned Write/Edit `path` and
  `toolCallId` with its own result. Unrelated denials cannot certify an escape
  attempt. Successful Edit results (`Replaced`) are accepted alongside Write
  (`Wrote`). Extra helper children do not cause a false failure by themselves.
- Additional fail-closed activation cases cover non-manual/tainted journals,
  SIGKILL escalation, status/model/version mismatches, and composite
  activation/cleanup failures.
- A second adversarial round found duplicate activation rollback, missing
  print-timeout cleanup, masked nonzero-print failures, and process/group
  recovery loss. `runSwarm` now solely owns one bounded deactivation attempt;
  preactivation only reports session/process uncertainty. Print/session errors
  stay primary, failure recovery has a two-second cancellation-aware bound, and
  both identity-bearing and process/group failures preserve write worktrees.
- A further process-lifecycle review reproduced a late-fork survivor, activation
  timeout reclassification during recovery, and cancellation hiding an established
  print failure. Process groups are now rechecked after teardown, unproven groups
  are not signalled, the activation timer is disarmed before recovery, and
  cancellation retains the primary print diagnostics. A real late-fork regression
  proves unknown survivors produce unverified cleanup rather than false quiescence.
  A same-PID/start-token process that changes PGID also remains active and is not
  a validated signal target; its teardown reproduction returns unverified with
  zero signals. Root loss requires a previously observed matching identity;
  first-missing roots and actual probe errors/timeouts remain unverified. An
  unsafe root-exit override was rejected after review reproduced an uncaptured
  detached descendant in another PGID. Reparenting and PGID moves preserve the current verified identity for
  revalidation rather than dropping it as an empty snapshot.

A test-only prohibition on all coordinator Bash was corrected after a live
run showed harmless `wc`/`od` verification. The substantive requirement remains
child-authored edits and per-call evidence, not an invented second shell
policy. Final re-review, production-mode smoke, and repository/package gates
are recorded below only after they complete.

## Final production validation and publication

- Final lifecycle and process regressions: **58 pass, 0 fail, 284 assertions**,
  including real late-fork and changed-PGID evidence, missing-root probes,
  timeout-cleanup success and failure, cancellation during print/recovery,
  primary-error preservation, post-mutation identity retention, and process/group
  uncertainty.
- Final production-mode smoke: **19 pass, 0 fail, 125 assertions in 296.67
  seconds**, including the 15 live lanes and four offline evidence fixtures,
  with no skipped live lanes. Pursue paused at its 120-second budget without
  writes; write-swarm captured a 278-byte patch, left the user tree/HEAD clean,
  and removed its worktree. Every swarm lane used per-call child evidence.
- Final full `bun run check`: **1,268 pass, 28 opt-in skips, 0 fail, 16,055
  assertions across 78 files** in 274.88 seconds. Frozen dependencies and
  `bun audit` passed with no vulnerabilities.
- Package validation: **224 files**, both compiled distributions, isolated
  hook setup/check, and unsupported-version refusal. Compiled controls passed
  normal-survivor cleanup, late-fork uncertainty, and changed-PGID uncertainty.
- Independent final re-review is complete: Claude reports no blockers and Codex
  independently returned RESOLVED on the changed-PGID reproduction and the full
  capture/refresh/teardown path. Release commit `06a0a47f2b34dffb8dd71e7ce93646212e74ed19`
  passed [CI run 40236704464](https://github.com/linxule/kimi-plugin-cc/actions/runs/40236704464);
  the annotated `v2.4.1` tag and [release](https://github.com/linxule/kimi-plugin-cc/releases/tag/v2.4.1)
  are live. [Publish run 40237085945](https://github.com/linxule/kimi-plugin-cc/actions/runs/40237085945)
  passed. npm `latest` is 2.4.1 with 224 files and SHA-1
  `77fe6daaa0f23750cc9b5d857bdbdd5107a7d4ce`; the registry tarball is
  byte-identical to the CI artifact. Fresh registry and CI-artifact installs
  passed isolated setup/check for both hosts. Final closeout CI remains pending.
  No host installation or CLI pin change is implied by this record.
