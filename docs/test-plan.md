# Test Plan

This document defines implementation acceptance criteria ahead of coding.

## Setup

Scenarios:

- Kimi binary missing
- Kimi binary present but runtime probe fails
- authentication missing or unusable
- healthy runtime and auth state
- review gate currently disabled
- review gate currently enabled

Expected outcomes:

- setup reports the correct readiness state
- setup failures are actionable
- review gate state is clearly surfaced
- review gate enable/disable persists in plugin config

## Review

Scenarios:

- working tree review with no `--base`
- branch diff review with `--base`
- foreground review
- background review
- challenge review with steering text
- malformed review or challenge output from Kimi (rescue is pass-through as of 0.1.7 and has no malformed state)
- review finding with a single-line location
- review finding with a multi-line range
- attempted multi-file finding in one item
- two independent review jobs launched concurrently
- review receives an unexpected approval request
- review finding without confidence
- interrupted review turn without `TurnEnd`

Expected outcomes:

- review is read-only
- review never shells out through Kimi
- challenge review preserves the same read-only guarantee
- malformed output is surfaced as failure, not converted into a fake clean review
- multi-file issues are split into separate findings
- missing `end_line` defaults to `start_line`
- missing per-finding confidence fails schema validation
- concurrent jobs do not share a live Wire connection
- unexpected approval requests are rejected and fail the job
- interrupted turns do not parse partial buffers

## Ask

Scenarios:

- foreground ask with a simple question
- ask with explicit `--thinking`
- ask with explicit `--no-thinking`
- ask with `-m` model override
- ask with free-text question containing `--` sentinel
- ask attempts write
- ask attempts shell
- ask receives an unexpected approval request
- ask turn interrupted without `TurnEnd`
- ask visible via `/kimi:status --type ask`
- ask visible via `/kimi:result --type ask`

Expected outcomes:

- ask is read-only
- ask profile blocks prohibited capabilities
- ask produces free-form prose output, not JSON
- unexpected approval requests fail the job
- interrupted ask turns do not parse partial buffers
- job-store lookup by type works for `ask`

## Rescue

Scenarios:

- foreground rescue
- background rescue
- rescue resume
- rescue with explicit session id resume
- rescue with explicit job id resume
- rescue fresh run
- rescue auto-resume on continuation wording
- rescue fresh start when no continuation wording is present
- rescue with linked Kimi session id persisted
- rescue that edits files
- cancelled rescue with acquired session id
- rescue receives a write approval request
- rescue starts with a client-generated session id passed via `--session`
- rescue receives an allowlisted shell approval request
- rescue receives a non-allowlisted shell approval request
- rescue attempts to edit a file outside workspace root via `..` traversal
- rescue attempts to edit a file through a symlink that resolves outside workspace root
- rescue attempts to write inside `.git/`
- rescue edits `.gitignore` at repo root
- rescue final output is empty or whitespace-only (0.1.7 — pass-through fallback)
- rescue summary derives from the first meaningful line of the raw output (0.1.7 — `firstMeaningfulLine`)
- rescue `phase` column transitions through queued → worker-running → turn-running → done on success (0.1.7)
- rescue `phase` column lands on `failed` when the rescue hits an approval rejection or a runtime error (0.1.7)
- rescue `phase` column lands on `cancelled` when the rescue is cancelled in-flight or force-cancelled after worker termination (0.1.7)
- `JobStore` upgrades a 0.1.3-shaped database to the 0.1.7 schema idempotently (new `phase` column, `PRAGMA table_info(jobs)` guard)

Expected outcomes:

- rescue can write when delegated
- rescue job state is persisted correctly
- status/result reflect rescue progress and completion accurately
- resume precedence follows the resolution order defined in the spec
- rescue auto-approves permitted workspace-local file edits only
- rescue output is pass-through prose, not schema-validated JSON (0.1.7)
- empty rescue output renders the fallback artifact `"Kimi did not return a final message."` and falls back to the fixed summary `"Rescue did not return a final message."`, with `status` still `completed`
- `summary` is written exactly twice per rescue run (at job creation from the shortened prompt, then overwritten on completion with `firstMeaningfulLine(rawOutput)`); transient lifecycle telemetry lives in `phase`, never in `summary`
- rescue auto-approves only allowlisted local shell commands
- non-allowlisted shell commands are rejected explicitly
- cancelled rescue remains terminal as a job but may still expose a resumable Kimi session id
- path traversal writes are rejected
- symlink-escape writes are rejected
- writes inside `.git/` are rejected
- edits to repo-root `.gitignore` are allowed

## Status, Result, Cancel

Scenarios:

- no active jobs
- active running job
- completed job
- failed job
- cancelled job
- explicit job id lookup
- concurrent background jobs
- status with `--type`
- result with `--type`

Expected outcomes:

- status reflects job source of truth
- result returns the latest or selected job
- cancel leaves a consistent final job state
- linked Kimi session id is surfaced when available
- terminal jobs do not transition again after completion, failure, or cancellation
- cancelling one job does not affect unrelated jobs
- status and result support repo-scoped recovery after context compaction

## Review gate

Scenarios:

- gate disabled
- gate enabled and review returns allow
- gate enabled and review returns explicit block
- gate enabled and review returns block with medium confidence
- gate enabled and Kimi runtime unavailable
- gate enabled and review output malformed
- gate enabled and review times out
- gate prevents stop but does not retract the already-generated assistant message

Expected outcomes:

- disabled gate never triggers
- enabled gate prevents stop only on `BLOCK` plus `high` confidence
- unavailable runtime degrades safely
- malformed output does not silently hard-block without explanation
- timeout becomes allow-with-warning

## Safety boundaries

Scenarios:

- review agent attempts write
- review agent attempts shell
- rescue agent writes file
- rescue agent runs shell

Expected outcomes:

- review profile blocks prohibited capabilities
- rescue profile allows delegated capabilities
- behavior is enforced by agent/tool policy, not only prompt wording
