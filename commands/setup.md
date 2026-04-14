---
description: Verify local Kimi companion readiness and manage review-gate state.
disable-model-invocation: true
---

Run the companion from the repository root with any user-supplied flags appended after `setup`:

`CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-$PWD/runtime/dev-data}" bun run companion -- setup <args>`

Return the companion stdout verbatim.
