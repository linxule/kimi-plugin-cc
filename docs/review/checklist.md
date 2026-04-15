# Review Checklist

Use this checklist when reviewing the planning bundle, a shipped release, or an in-flight change to the runtime. The bundle shipped in phases 0–3b in April 2026; current behaviour is captured in [spec.md](../spec.md), [CLAUDE.md](../../CLAUDE.md), and the ADRs. The questions below apply both to reviewing the original plan and to reviewing ongoing changes against the shipped state.

## 0.1.7 Model B invariant (post-rescue-refactor)

- Does the change respect the ownership split from [ADR 004](../adr/004-rescue-pass-through.md)? (The plugin owns transport, session, workspace, tool scope, approval policy, and job lifecycle; Kimi owns content, reasoning, and prose.)
- For a rescue-touching change: is `summary` still written only at creation and completion, with transient lifecycle telemetry routed to `phase`?
- For a new system prompt or prompt edit: is every line justified by something that cannot be expressed via `exclude_tools`, the approval allowlist, per-call schema injection, or Kimi's default behavior?
- For a new command: is its output shape explicitly either structured (JSON with schema, parser, and renderer) or pass-through prose? Avoid the middle ground that produced the 0.1.7 refactor.
- If the change widens the rescue shell allowlist, is the scope narrowly justified against `project_rescue_allowlist_gaps` in memory? Any allowance of `&&`, pipes, or subshells must be deliberate.
- If the change touches `runtime/jobs.ts` terminal helpers (`markJobFailed`, `markJobCancelled`): is the new terminal `phase` value consistent with the rescue-only scope (other commands should not grow `phase` semantics without a conscious extension)?

## Architecture

- Does the design clearly mirror the Codex plugin's thin-plugin, rich-runtime split?
- Is Kimi Wire justified as the primary transport with current-doc support?
- Are runtime ownership boundaries explicit for transport, jobs, parsing, and rendering?
- Are any product or architecture decisions still left to the implementer?

## Safety

- Is read-only review enforced by tool policy rather than prompt wording alone?
- Is rescue clearly separated as write-capable?
- Are session reuse rules explicit enough to avoid review/rescue state contamination?
- Does the review gate fail safe when runtime conditions are degraded?

## UX parity

- Does the command surface match the Codex-style mental model?
- Are status/result/cancel semantics built around first-class jobs rather than ad hoc process checks?
- Is the rescue subagent correctly scoped as a thin forwarder?
- Is review vs challenge intentionally separated?

## Runtime feasibility

- Does the Wire client contract cover initialize, prompt, approvals, cancel, replay, and session restore?
- Are Kimi session persistence and approval persistence accounted for?
- Are background jobs and final result rendering defined without relying on unsupported protocol assumptions?

## Spec completeness

- Are command flags and defaults concrete?
- Are job state fields concrete?
- Are output schemas concrete?
- Are review prompts/checkpoints sufficient for another AI agent to audit the design?
