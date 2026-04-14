---
description: Ask Kimi a read-only question in free-form prose mode.
disable-model-invocation: true
---

Run the companion from the repository root with any user-supplied flags appended after `ask`:

`CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-$PWD/runtime/dev-data}" bun run companion -- ask <args>`

Return the companion stdout verbatim.
