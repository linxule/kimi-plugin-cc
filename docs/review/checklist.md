# Review Checklist

Use this checklist when reviewing the planning bundle or a future implementation.

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
