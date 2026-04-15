#!/usr/bin/env bash
set -euo pipefail

# Entry point for the Claude Code Stop hook. Same cwd/env dance as companion.sh — launches
# the compiled Node runtime from the plugin root while preserving the user's workspace cwd,
# and honors KIMI_PLUGIN_CC_NODE_BIN so sanitized-PATH environments still work.

: "${CLAUDE_PLUGIN_ROOT:=$(cd "$(dirname "$0")/.." && pwd)}"
export KIMI_PLUGIN_CC_WORKSPACE_CWD="${KIMI_PLUGIN_CC_WORKSPACE_CWD:-$PWD}"

NODE_BIN="${KIMI_PLUGIN_CC_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "${NODE_BIN}" ]; then
  echo "kimi-plugin-cc: unable to locate 'node'. Install Node >= 18.18 or set KIMI_PLUGIN_CC_NODE_BIN to an absolute path." >&2
  exit 127
fi

cd "${CLAUDE_PLUGIN_ROOT}"
exec "${NODE_BIN}" dist/hooks/review-gate-stop.js
