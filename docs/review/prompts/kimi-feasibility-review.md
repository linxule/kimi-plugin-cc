# Kimi Feasibility Review Prompt

Review this repository against current official Kimi CLI documentation.

Focus on:

- whether the Wire-first architecture matches documented Kimi capabilities
- whether session restore, approvals, replay, and plan mode are represented correctly
- whether the plugin is assuming unsupported transport behavior
- whether read-only review and write-capable rescue are enforceable with custom agent policies

Call out:

- any claims that are not grounded in docs
- any part of the command design that conflicts with Kimi runtime semantics
- any missing fallback or failure-mode handling
