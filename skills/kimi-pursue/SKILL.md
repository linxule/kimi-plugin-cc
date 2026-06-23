---
name: kimi-pursue
description: "Run Kimi's autonomous goal mode for an explicitly requested hands-off multi-turn objective. This is write-capable and budget-bounded; use only when the user explicitly asks Kimi to pursue an objective autonomously."
---

# Kimi Pursue

Forward this request to the local kimi-code companion runtime by shell. Do not use MCP for this skill.

## Invocation

- Resolve the plugin root from this skill source path: use the parent directory of the `skills/` directory that contains this `SKILL.md`. If `PLUGIN_ROOT` is already set, use that value.
- Launch the shell command from the user's current workspace directory so `scripts/companion.sh` captures the intended workspace cwd.
- Run: `PLUGIN_ROOT="<plugin-root>" "<plugin-root>/scripts/companion.sh" task pursue <args>`
- If the plugin host provides `PLUGIN_DATA` instead of `CLAUDE_PLUGIN_DATA`, the shell wrapper exports the Claude-compatible alias for the runtime. If neither is set, the wrapper uses a Codex data directory under `$CODEX_HOME/plugins/data/kimi-marketplace-kimi`, `~/.codex/plugins/data/kimi-marketplace-kimi`, or `/tmp/kimi-plugin-cc-codex-data/kimi-marketplace-kimi` in a fully sanitized environment.

## Arguments

Pass through: `[--budget <30m|1h>] [--turns <N>] [-m <model>] <objective>`

## Handling

- Require explicit hands-off autonomy intent; single bounded fixes belong to `kimi-rescue`.
- Always keep a finite `--budget`; never background this command.
- Surface terminal goal statuses exactly as the companion reports them.
