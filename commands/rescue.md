---
description: Run a write-capable Kimi rescue against the current repository with optional background execution and resume behavior.
disable-model-invocation: true
---

Run the companion from the repository root with any user-supplied flags appended after `task rescue`:

`CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-$PWD/runtime/dev-data}" bun run companion -- task rescue <args>`

Return the companion stdout verbatim.
