---
description: Run a read-only Kimi review over the current working tree changes or a base ref diff.
disable-model-invocation: true
---

Run the companion from the repository root with any user-supplied flags appended after `review`:

`CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-$PWD/runtime/dev-data}" bun run companion -- review <args>`

Return the companion stdout verbatim.
