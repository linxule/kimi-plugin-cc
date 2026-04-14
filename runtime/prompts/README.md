# runtime/prompts

System prompts used by the local runtime.

- `review-system.md` — review/challenge structured-output prompt
- `rescue-system.md` — delegated task channel; intentionally minimal (a few lines) because rescue output is pass-through prose with no schema to enforce
- `review-gate-system.md` — Stop-hook allow/block prompt

`ask` has no system prompt file — the profile inherits Kimi's default and relies on `exclude_tools` in `runtime/agents/ask.yaml` for its read-only enforcement.
