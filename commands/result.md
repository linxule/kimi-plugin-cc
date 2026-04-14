---
description: Return the stored rendered result for the latest or selected terminal Kimi job.
disable-model-invocation: true
---

Run the companion from the repository root with any user-supplied flags appended after `result`:

`CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-$PWD/runtime/dev-data}" bun run companion -- result <args>`

Return the companion stdout verbatim.
