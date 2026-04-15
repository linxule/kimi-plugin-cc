#!/usr/bin/env bash
set -euo pipefail

# Entry point for slash commands. Launches the compiled Node runtime from the plugin root so
# that runtime dependencies resolve against the plugin's node_modules, while preserving the
# user's working directory via KIMI_PLUGIN_CC_WORKSPACE_CWD.
#
# Required env: CLAUDE_PLUGIN_ROOT (set by Claude Code when the plugin is installed).
# When running from the repo checkout, CLAUDE_PLUGIN_ROOT is unset — default to the script's
# parent directory so `bun run` style local invocation still works.

: "${CLAUDE_PLUGIN_ROOT:=$(cd "$(dirname "$0")/.." && pwd)}"
export KIMI_PLUGIN_CC_WORKSPACE_CWD="${KIMI_PLUGIN_CC_WORKSPACE_CWD:-$PWD}"

NODE_BIN="${KIMI_PLUGIN_CC_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "${NODE_BIN}" ]; then
  echo "kimi-plugin-cc: unable to locate 'node'. Install Node >= 18.18 or set KIMI_PLUGIN_CC_NODE_BIN to an absolute path." >&2
  exit 127
fi

cd "${CLAUDE_PLUGIN_ROOT}"
exec "${NODE_BIN}" dist/companion.js "$@"
