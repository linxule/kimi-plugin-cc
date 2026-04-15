# commands

Claude Code slash command markdown. Each file is thin — it routes through `scripts/companion.sh` to the Node runtime under `runtime/`.

- `setup.md` — verify local Kimi and manage review-gate state
- `ask.md` — free-form read-only Q&A
- `review.md` — structured read-only review
- `challenge.md` — challenge read-only review
- `rescue.md` — write-capable rescue with session persistence
- `status.md` / `result.md` / `cancel.md` — job lifecycle commands

All command bodies are one-liner invocations of `${CLAUDE_PLUGIN_ROOT}/scripts/companion.sh <subcommand> <args>` so the runtime can be extended without re-editing markdown.
