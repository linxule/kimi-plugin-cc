# Research Notes: Kimi CLI and Wire

These are synthesized notes from official Kimi CLI docs that materially affect plugin design.

## Key findings

- Print mode is not a good primary transport for a Codex-grade plugin because it is non-interactive and non-trivial automation effectively requires YOLO.
- Wire is the right low-level transport for rich local integration: it supports initialize, prompt, event streaming, approvals, cancel, replay, and plan-mode negotiation.
- Wire is documented as experimental and should be treated as a moving interface that must be re-verified at implementation start.
- A single Wire connection supports one active turn at a time, so job concurrency should be modeled as one Kimi process/connection per job.
- Wire is stateful. Final result rendering has to be reconstructed from turn events rather than treated as a single synchronous reply object.
- Wire does not document a guaranteed server-assigned session id; client-assigned ids via `--session <id>` are the safer basis for rescue resume.
- Session state persists across restores, including approval decisions and plan mode state.
- `steer` is a live-turn correction tool, not a substitute for the main command flow.
- Custom agent files and tool restrictions make it feasible to enforce read-only review and write-capable rescue with different profiles.

## Why it matters here

`kimi-plugin-cc` should:

- use Wire as the primary transport
- keep review sessions fresh and isolated
- persist rescue session ids in the job model
- enforce safety at the agent/tool policy level
- design `status` and `result` around events plus stored session/job state

## Source references

- Kimi CLI docs for Wire mode
- Kimi CLI docs for the `kimi` command
- Kimi CLI docs for sessions and context
- Kimi CLI docs for agents and subagents
