---
description: Run a read-only adversarial Kimi review that challenges assumptions and alternatives.
disable-model-invocation: true
---

Run the companion from the repository root with any user-supplied flags appended after `task adversarial-review`:

`CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-$PWD/runtime/dev-data}" bun run companion -- task adversarial-review <args>`

Return the companion stdout verbatim.
