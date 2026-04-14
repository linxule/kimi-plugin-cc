---
description: Cancel an active background Kimi job for the current repository.
disable-model-invocation: true
---

Run the companion from the repository root with any user-supplied flags appended after `cancel`:

`CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-$PWD/runtime/dev-data}" bun run companion -- cancel <args>`

Return the companion stdout verbatim.
