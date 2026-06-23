---
name: kimi-challenge
description: "Run a read-only adversarial Kimi challenge review that questions assumptions, design choices, and tradeoffs. Use when the user wants pushback on whether the approach is right, not a defect-only review."
---

# Kimi Challenge

Forward this request to the local kimi-code companion runtime by shell. Do not use MCP for this skill.

## Invocation

- Resolve the plugin root from this skill source path: use the parent directory of the `skills/` directory that contains this `SKILL.md`. If `PLUGIN_ROOT` is already set, use that value.
- Launch the shell command from the user's current workspace directory so `scripts/companion.sh` captures the intended workspace cwd.
- Run: `PLUGIN_ROOT="<plugin-root>" "<plugin-root>/scripts/companion.sh" task challenge <args>`
- If the plugin host provides `PLUGIN_DATA` instead of `CLAUDE_PLUGIN_DATA`, the shell wrapper exports the Claude-compatible alias for the runtime. If neither is set, the wrapper uses a Codex data directory under `$CODEX_HOME/plugins/data/kimi-marketplace-kimi`, `~/.codex/plugins/data/kimi-marketplace-kimi`, or `/tmp/kimi-plugin-cc-codex-data/kimi-marketplace-kimi` in a fully sanitized environment.

## Arguments

Pass through: `[--base <ref>] [-m <model>] [extra prose]`

## Handling

- Preserve the user's adversarial framing as trailing focus text.
- Do not pass background/wait flags; the runtime rejects them for challenge.
- Return companion stdout verbatim without softening the challenge framing.
