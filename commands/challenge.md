---
description: Run a read-only Kimi challenge review that challenges assumptions and surfaces safer alternatives.
argument-hint: "[--base <ref>] [-m <model>] [--no-thinking] [extra prose]"
disable-model-invocation: true
---

Run the companion with any user-supplied flags appended after `task challenge`:

`${CLAUDE_PLUGIN_ROOT}/scripts/companion.sh task challenge <args>`

Supported flags:

- `--base <ref>` — challenge against a branch/commit diff instead of the working tree
- `-m`, `--model <name>`
- `--thinking` — enable Kimi's extended reasoning (on by default; kept for explicit intent)
- `--no-thinking` — disable Kimi's extended reasoning
- trailing text — adversarial focus or framing to steer the challenge

Challenge runs foreground-synchronously; it does not support `--background` or `--wait`.

Return the companion stdout verbatim.
