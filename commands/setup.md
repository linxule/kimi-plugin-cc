---
description: Verify local Kimi companion readiness and manage review-gate state. Writes a managed PreToolUse hook block to ~/.kimi-code/config.toml so kimi-code enforces this plugin's safety contract.
argument-hint: "[--check | --uninstall | --enable-review-gate | --disable-review-gate]"
disable-model-invocation: true
---

Run the companion with any user-supplied flags appended after `setup`:

`${CLAUDE_PLUGIN_ROOT}/scripts/companion.sh setup <args>`

Return the companion stdout verbatim.
