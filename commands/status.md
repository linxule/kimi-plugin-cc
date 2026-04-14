---
description: Show the latest or selected plugin-managed Kimi job for the current repository.
disable-model-invocation: true
---

Run the companion from the repository root with any user-supplied flags appended after `status`:

`CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-$PWD/runtime/dev-data}" bun run companion -- status <args>`

Return the companion stdout verbatim.
