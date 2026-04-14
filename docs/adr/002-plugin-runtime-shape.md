# ADR 002: Mirror Codex's thin-plugin, rich-runtime split

- Status: accepted
- Date: 2026-04-14

## Decision

`kimi-plugin-cc` will mirror the Codex plugin's architectural split:

- a thin Claude-facing plugin layer
- a richer local runtime that owns transport, jobs, persistence, and rendering

## Context

The Codex plugin is not just a set of slash commands. Its plugin layer is mostly policy and routing, while a local runtime owns:

- transport to the agent backend
- job persistence
- status/result/cancel behavior
- review execution
- cleanup hooks

To achieve the same quality bar with Kimi, `kimi-plugin-cc` should not push lifecycle logic into command markdown or rely on shell-only wrappers.

## Rationale

This split has four advantages:

1. Claude command files stay deterministic and easy to audit.
2. The Kimi transport can evolve without rewriting plugin-facing UX.
3. Job state has one owner, which simplifies status/result/cancel semantics.
4. Review and rescue can share runtime primitives while enforcing different policies.

## Consequences

- Command markdown files should only route into a stable companion entrypoint.
- The runtime must define stable subcommands such as `setup`, `review`, `task`, `status`, `result`, and `cancel`.
- Job persistence, Kimi session ids, and event logs live in a plugin-owned state directory.
- The rescue subagent should remain a thin forwarder into the same runtime, not a second orchestrator.

## Rejected option

### Put lifecycle logic in command markdown

Rejected because it makes behavior harder to test, harder to evolve, and more inconsistent across commands.
