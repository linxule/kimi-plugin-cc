# Research Notes: Codex Plugin for Claude Code

These are synthesized notes from `openai/codex-plugin-cc`, focused on decisions that shape `kimi-plugin-cc`.

## Key findings

- The Codex plugin is a thin Claude-facing layer over a richer local runtime.
- The transport path is not ACP. It uses `codex app-server`, optionally through a broker.
- Jobs are first-class and persisted, rather than inferred ad hoc from a child process.
- `status`, `result`, and `cancel` read from the plugin-owned state model.
- The rescue subagent is intentionally a thin forwarder into the shared runtime.
- Codex plugin review gate is opt-in, session-scoped, and implemented through hooks plus an explicit allow/block contract.
- Review and challenge are separated on purpose: one is fixed-shape review, the other is steerable.

## Why it matters here

`kimi-plugin-cc` should copy the **shape**, not the transport details:

- thin plugin layer
- richer runtime owner
- first-class jobs
- explicit review/rescue split
- review gate as later v1 functionality

Intentional divergence:

- Codex's review gate is session-scoped; `kimi-plugin-cc` chooses persistent plugin-config state instead

## Source references

- `README.md` in `openai/codex-plugin-cc`
- `plugins/codex/scripts/lib/app-server.mjs`
- `plugins/codex/scripts/codex-companion.mjs`
- `plugins/codex/scripts/lib/state.mjs`
- `plugins/codex/scripts/lib/job-control.mjs`
- `plugins/codex/agents/codex-rescue.md`
