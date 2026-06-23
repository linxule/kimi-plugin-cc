---
name: kimi-swarm
description: "Run a read-only parallel Kimi review fan-out across many independent targets. Use only for explicit broad fan-out requests where one subagent per target is the point."
---

# Kimi Swarm

Forward this request to the local kimi-code companion runtime by shell. Do not use MCP for this skill.

## Invocation

- Resolve the plugin root from this skill source path: use the parent directory of the `skills/` directory that contains this `SKILL.md`. If `PLUGIN_ROOT` is already set, use that value.
- Launch the shell command from the user's current workspace directory so `scripts/companion.sh` captures the intended workspace cwd.
- Run: `PLUGIN_ROOT="<plugin-root>" "<plugin-root>/scripts/companion.sh" task swarm <args>`
- If the plugin host provides `PLUGIN_DATA` instead of `CLAUDE_PLUGIN_DATA`, the shell wrapper exports the Claude-compatible alias for the runtime.

## Arguments

Pass through: `[--budget <30m|1h>] [--cap <N>] [--max-concurrency <N>] [-m <model>] <objective>`

## Handling

- Require many independent review targets plus explicit fan-out intent.
- Pass finite budget and concurrency bounds; default to foreground unless the user explicitly asks to detach.
- Return the consolidated companion report verbatim.
