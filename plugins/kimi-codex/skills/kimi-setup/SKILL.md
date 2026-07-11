---
name: kimi-setup
description: "Verify local Kimi companion readiness and manage the kimi-code PreToolUse hook plus optional review gate state. Use when explicitly requested to install, check, enable, disable, or uninstall the integration. Codex and Claude Code share one ~/.kimi-code/config.toml but each own a host-scoped block, so $kimi-setup here does not disturb Claude Code's /kimi:setup (and vice-versa)."
---

# Kimi Setup

Forward this request to the local kimi-code companion runtime by shell. Do not use MCP for this skill.

## Invocation

- Resolve the plugin root: prefer `$PLUGIN_ROOT` if the host sets it; otherwise use the directory that CONTAINS the `skills/` directory (i.e. two levels up from this `SKILL.md`).
- Sanity check: `<plugin-root>/scripts/companion.sh` must exist — it is the bundled entrypoint that resolves Node and runs the compiled runtime from `<plugin-root>/dist/`.
- Launch the shell command from the user's current workspace directory so `scripts/companion.sh` captures the intended workspace cwd.
- Run: `PLUGIN_ROOT="<plugin-root>" "<plugin-root>/scripts/companion.sh" setup <args>`
- If the plugin host provides `PLUGIN_DATA` instead of `CLAUDE_PLUGIN_DATA`, the shell wrapper exports the Claude-compatible alias for the runtime. If neither is set, the wrapper uses a Codex data directory under `$CODEX_HOME/plugins/data/kimi-marketplace-kimi`, `~/.codex/plugins/data/kimi-marketplace-kimi`, or `/tmp/kimi-plugin-cc-codex-data/kimi-marketplace-kimi` in a fully sanitized environment.

## Arguments

Pass through: `[--check | --uninstall [--all] | --enable-review-gate | --disable-review-gate]`

## Handling

- Run setup from the user's workspace so the companion records the intended workspace cwd.
- Use `--check` for read-only verification and `--uninstall` only when explicitly requested. `--uninstall` removes only this host's block; `--uninstall --all` removes every host's block from the shared config.
- Setup validates the complete shared TOML and every configured hook under a serialized lock. If it reports invalid foreign config, surface that failure; do not bypass it or claim the managed block is safe in isolation.
- Report setup stdout verbatim because it contains hook and probe status.
