# runtime/prompts

System prompts used by the local runtime.

- `review-system.md` — review/challenge structured-output prompt
- `ask-system.md` — read-only free-form Q&A prompt
- `rescue-system.md` — delegated task channel; intentionally minimal (a few lines) because rescue output is pass-through prose with no schema to enforce
- `review-gate-system.md` — Stop-hook allow/block prompt
