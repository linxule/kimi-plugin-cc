# runtime/prompts

System prompts used by the local runtime.

- `review-system.md` — review/challenge prompt (markdown prose pass-through; v0.2.3 dropped the structured-output schema)
- `rescue-system.md` — delegated task channel; intentionally minimal (a few lines) because rescue output is pass-through prose with no schema to enforce
- `review-gate-system.md` — Stop-hook allow/block prompt (still structured JSON; review_gate is the only command that parses Kimi output)

`ask` has no system prompt file — the profile inherits Kimi's default and relies on `exclude_tools` in `runtime/agents/ask.yaml` for its read-only enforcement.
