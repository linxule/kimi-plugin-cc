---
name: kimi-swarm-write
description: "Run a write-capable Kimi swarm that edits many disjoint targets in a throwaway worktree and returns a reviewable patch. Use only for explicit parallel edit fan-out requests; the plugin never applies or commits the patch."
---

# Kimi Swarm Write

Forward this request to the local kimi-code companion runtime by shell. Do not use MCP for this skill.

## Invocation

- Resolve the plugin root: prefer `$PLUGIN_ROOT` if the host sets it; otherwise use the directory that CONTAINS the `skills/` directory (i.e. two levels up from this `SKILL.md`).
- Sanity check: `<plugin-root>/scripts/companion.sh` must exist — it is the bundled entrypoint that resolves Node and runs the compiled runtime from `<plugin-root>/dist/`.
- Launch the shell command from the user's current workspace directory so `scripts/companion.sh` captures the intended workspace cwd.
- Run: `PLUGIN_ROOT="<plugin-root>" "<plugin-root>/scripts/companion.sh" task swarm --write <args>`
- If the plugin host provides `PLUGIN_DATA` instead of `CLAUDE_PLUGIN_DATA`, the shell wrapper exports the Claude-compatible alias for the runtime. If neither is set, the wrapper uses a Codex data directory under `$CODEX_HOME/plugins/data/kimi-marketplace-kimi`, `~/.codex/plugins/data/kimi-marketplace-kimi`, or `/tmp/kimi-plugin-cc-codex-data/kimi-marketplace-kimi` in a fully sanitized environment.

## Arguments

Pass through: `[--budget <30m|1h>] [--cap <N>] [--max-concurrency <N>] [-m <model>] <objective>`

## Handling

- Require both many disjoint write targets and explicit parallel fan-out intent.
- Keep `--max-concurrency` conservative, normally 1, unless the user explicitly asks to widen it.
- If the companion reports SWARM_HOOK_NOT_INSTALLED, tell the user to run Claude Code /kimi:setup or Codex $kimi-setup, then retry.
- Return the patch path and companion output verbatim; do not apply the patch unless the user separately asks.
