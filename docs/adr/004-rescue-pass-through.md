# ADR 004: Rescue is pass-through prose, not structured JSON

- Status: accepted
- Date: 2026-04-15
- Shipped in: 0.1.7

## Decision

`/kimi:rescue` stores and renders Kimi's raw final output verbatim. It does not impose a JSON schema on the model, does not parse structured fields, and does not re-render them into markdown. The job `summary` derives from `firstMeaningfulLine(rawOutput)` with an empty-output fallback. A new nullable `phase TEXT` column in the jobs schema holds transient lifecycle telemetry so `summary` stays stable as the semantic result field.

This codifies a broader architectural principle for the plugin: **the plugin owns transport, session, workspace, tool scope, approval policy, and job lifecycle; Kimi owns content, reasoning, and prose.** Prompt files should only exist for information that cannot be expressed via `exclude_tools` in the agent YAML, the companion's approval allowlist, per-call schema injection, or Kimi's own default behavior.

The principle applies to `rescue` in 0.1.7, probably to `ask` in 0.1.8, and explicitly **does not** apply to `review`, `challenge`, or `review-gate` — those have real structured-output contracts that Claude's main thread consumes programmatically.

## Context

Through phase 2 and 3, rescue was implemented by mirroring review's pattern: force the model to emit a JSON object matching a fixed schema (`status`, `summary`, `changes`, `commands_run`, `tests`, `followups`), parse the JSON with a handwritten validator, then render it back to markdown via 60+ lines of bespoke conversion loops. A lenient parse-failure policy (`partial` status with `error` set and raw output preserved) papered over the cases where the model drifted from the schema.

During the 0.1.6 post-ship audit, a direct comparison against the Codex plugin's equivalent surfaced the asymmetry:

- Codex's `renderTaskResult` (`scripts/lib/render.mjs`) is **4 lines** of pass-through: ensure trailing newline on `rawOutput`, fall back to a failure message if empty.
- Codex's `codex task` command has **zero system prompt file** — it trusts codex CLI's default task behavior entirely. The `prompts/` directory contains only `adversarial-review.md` and `stop-review-gate.md`.
- Codex derives task summaries from `firstMeaningfulLine(rawOutput, fallback)` — literally the first non-empty trimmed line of the raw output.

Rescue's output semantics are *"narrative work log → prose for human reading,"* not *"findings → structured data for programmatic consumption."* The plugin had cargo-culted review's schema-first shape without questioning whether it fit rescue's purpose. User reaction on discovering this: *"lmao!! why did we do this."*

This is the same failure mode documented in the memory note on shape-vs-invariant fidelity (the 0.1.5 ask session resume "monkeypatch" pattern): when mirroring another system, copying the surface shape without enumerating the invariants produces structural look-alikes that fail on the thing the original exists to do.

## The cross-calibrated consult

Before committing to the deletion, the refactor plan was stress-tested by both Kimi (via `/kimi:ask`, read-only) and Codex (via save-plan-then-paste to Codex desktop). The consult surfaced three load-bearing caveats that shaped the final shape of the refactor:

1. **Don't go zero-prompt; go minimal-prompt.** Kimi's own introspection warned that its default `--wire` behavior, while directionally correct (prose-first, non-interactive), is not perfectly disciplined — it may occasionally lead with a contextual framing sentence, hedge on ambiguous requests, or produce preambles. A very short sub-invocation hint is "probably load-bearing for consistency." Zero prompts is betting on implementation details of an experimental protocol that can change.

2. **The `summary` field is currently overloaded.** Codex caught that rescue.ts was writing to `summary` at least 5 times per run — at creation, at each phase transition, and at completion — with intermediate writes clobbering the semantic summary with transient phase text. Under `firstMeaningfulLine`, those intermediate writes become actively broken. The fix is structural: either stop overwriting `summary` with phase text, or split `status_text` from `summary` in the schema. The ADR chooses the latter: add a nullable `phase` column.

3. **Empty-output policy must be explicit.** Pass-through doesn't eliminate degenerate cases (empty rawOutput, whitespace-only, turn finishes but no final prose). Codex task has a fallback message (*"Codex did not return a final message."*); rescue needs its Kimi equivalent (*"Kimi did not return a final message."*).

Kimi additionally flagged a version-stability concern: explicit system prompts pin behavior across Kimi CLI upgrades. Under the ADR's Model B framing, rescue's output format becomes a function of whatever the installed Kimi CLI default is — an upgrade could shift it without any plugin-side code change. Mitigation: the 0.1.7 ship includes `scripts/smoke-rescue-drift.sh`, an operator-run drift detection script that asserts Kimi's actual post-refactor behavior against the assumptions.

## Empirical verification before deletion

Before committing to removing `system_prompt_path` from `runtime/agents/rescue.yaml`, five real rescue tasks were run with the prompt stripped to observe Kimi's default `--wire` behavior under `extend: default`:

1. **Focused factual inspection** (summarize `runtime/kimi-launch.ts` in 4 sentences) — clean direct prose, no preamble, ideal `firstMeaningfulLine` output.
2. **Moderate specificity** (explain the allowlist architecture in 5-6 sentences) — same, clean, no hedging.
3. **Diagnostic** (find a bug in `runtime/commands/rescue.ts`) — clean lead, produced a real bug finding on its own (resource leak in `executeRescueJob`).
4. **Open-ended improvement** (improve error handling) — committed interpretation, no hedging, 7 themed findings — but led with a substantive framing sentence (*"Based on my read-through of [files], here are the changes..."*), which is serviceable as a `firstMeaningfulLine` summary but not ideal.
5. **Ambiguous scope with shell** (check coverage gaps) — **FAILED**: Kimi tried `ls -la tests/runtime/ && ls -la tests/wire/` and the approval allowlist rejected the `&&` compound syntax.

Run 5 was the decisive finding. Without the current `rescue-system.md`'s implicit steering toward "bounded local shell checks," Kimi reaches for more natural multi-command shell patterns that trip the companion's allowlist. This is not a Kimi failure — it's an interaction between Kimi's defaults and the plugin's strict allowlist — but it does mean a minimal sub-invocation prompt is necessary.

## The minimal prompt

The 7-line opinionated `rescue-system.md` was replaced with three empirically-justified lines:

1. *"You are a delegated sub-invocation running inside the kimi-plugin-cc rescue profile. Commit to an interpretation of the task without asking clarifying questions; your output will be read by Claude and relayed to the user."* (addresses non-interactive commitment — defensive against a theoretical risk that didn't trigger in 5 runs but is a known Kimi pattern)
2. *"Begin your response with a one-line summary of the outcome or finding, then elaborate in prose."* (addresses run 4's framing-sentence problem, improves `firstMeaningfulLine` quality)
3. *"Use single-command shell invocations. The companion's approval allowlist rejects `&&`, `||`, pipes, subshells, and backticks — compound shell syntax will fail the rescue."* (addresses run 5's actual allowlist failure)

Nothing redundant with `exclude_tools`, nothing prescribing output format beyond "one-line summary then prose," nothing duplicating Kimi's default behavior.

## Consequences

- **Rescue code is simpler**: -519 lines in `runtime/commands/rescue.ts`, `runtime/render.ts`, `runtime/schemas/rescue-output.ts` (deleted), `runtime/parsing.ts`, and the rescue test fixtures. `renderRescueArtifact` collapses from 60+ lines of handwritten markdown conversion to 7 lines of pass-through with empty-output fallback.
- **`summary` is clean**: written exactly twice per rescue run — at creation (seeded from `shorten(prompt, 120)`) and at completion (overwritten with `firstMeaningfulLine(rawOutput)`). All transient phase telemetry moves to the new `phase` column.
- **`phase` is new**: nullable `TEXT` column in the jobs schema. Idempotent migration guarded by `PRAGMA table_info(jobs)`. Values written by rescue: `queued`, `starting`, `worker-spawned`, `worker-running`, `turn-running`, `done`. Other commands do not currently write `phase`.
- **Parse failure policy is simplified**: rescue has no malformed state under pass-through. The §Parse failure policy section of `docs/spec.md` no longer needs a rescue-specific lenient rule.
- **Version stability has a known gap**: if a future Kimi CLI release changes the default `--wire` agent behavior, rescue's output could shift silently. Mitigation: `scripts/smoke-rescue-drift.sh` is manually run after Kimi CLI upgrades to detect drift. Not wired into CI because real CI does not have Kimi installed.
- **Terminal `phase` on failed/cancelled rows is imperfect**: shared terminal-job helpers (`markJobFailed`, `markJobCancelled`) do not yet accept a `phase` parameter, so a failed rescue row keeps its last in-flight phase value (e.g. `worker-running`) instead of getting a rescue-specific terminal phase. This is cosmetic and tracked as a followup.
- **Only rescue is affected in 0.1.7**: `ask` is a 0.1.8 candidate with the same shape; `review`, `challenge`, and `review-gate` are **explicitly excluded** from this ADR because they have genuine structured-output contracts with Claude's main thread.

## Non-goals

- Changing `review`, `challenge`, or `review-gate`. Their schemas are command contracts, not cargo-cult.
- Widening the rescue approval allowlist. The run-5 finding ("Kimi tries compound shell") is addressed by the minimal prompt line, not by loosening the allowlist. Allowlist widening is a separate decision.
- Eliminating all prompt files globally. `review-gate-system.md` in particular carries genuine plugin-specific blocking policy that cannot be encoded as tool exclusion, and stays.
- Introducing a Claude-permission pass-through for rescue. That remains deferred to v2 per ADR 002 and the spec's §Approval policy section.
