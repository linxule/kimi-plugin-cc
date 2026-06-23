#!/usr/bin/env bash
set -euo pipefail

# Entry point for the Claude Code/Codex Stop hook. Same cwd/env dance as companion.sh —
# launches the compiled Node runtime from the plugin root while preserving the user's
# workspace cwd, and honors KIMI_PLUGIN_CC_NODE_BIN so sanitized-PATH environments still work.

: "${CLAUDE_PLUGIN_ROOT:=${PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}}"
export CLAUDE_PLUGIN_ROOT
export PLUGIN_ROOT="${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
if [ -z "${CLAUDE_PLUGIN_DATA:-}" ] && [ -n "${PLUGIN_DATA:-}" ]; then
  export CLAUDE_PLUGIN_DATA="${PLUGIN_DATA}"
fi
if [ -z "${PLUGIN_DATA:-}" ] && [ -n "${CLAUDE_PLUGIN_DATA:-}" ]; then
  export PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}"
fi
export KIMI_PLUGIN_CC_WORKSPACE_CWD="${KIMI_PLUGIN_CC_WORKSPACE_CWD:-$PWD}"

NODE_BIN="${KIMI_PLUGIN_CC_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "${NODE_BIN}" ]; then
  echo "kimi-plugin-cc: unable to locate 'node'. Install Node >= 22.5 or set KIMI_PLUGIN_CC_NODE_BIN to an absolute path." >&2
  exit 127
fi

NODE_VERSION_OUT="$("${NODE_BIN}" --version 2>/dev/null || true)"
NODE_MAJOR="$(printf '%s\n' "${NODE_VERSION_OUT}" | sed -En 's/^v([0-9]+)\..*/\1/p')"
NODE_MINOR="$(printf '%s\n' "${NODE_VERSION_OUT}" | sed -En 's/^v[0-9]+\.([0-9]+)\..*/\1/p')"
if [ -z "${NODE_MAJOR}" ] || [ -z "${NODE_MINOR}" ] || [ "${NODE_MAJOR}" -lt 22 ] || \
   { [ "${NODE_MAJOR}" -eq 22 ] && [ "${NODE_MINOR}" -lt 5 ]; }; then
  echo "kimi-plugin-cc requires Node >= 22.5.0 (node:sqlite is a built-in, introduced in 22.5). Found: ${NODE_VERSION_OUT:-unknown}. Upgrade Node or set KIMI_PLUGIN_CC_NODE_BIN to a qualifying binary." >&2
  exit 127
fi

cd "${CLAUDE_PLUGIN_ROOT}"
exec "${NODE_BIN}" dist/hooks/review-gate-stop.js
