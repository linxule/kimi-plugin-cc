#!/usr/bin/env bash
# scripts/smoke-rescue-drift.sh — manual drift detection for rescue under minimal prompt.
#
# Purpose: catch behavioral regressions in Kimi's --wire default agent behavior that
# would break pass-through rescue (introduced in 0.1.7). Run manually after:
#   - upgrading Kimi CLI
#   - changing runtime/prompts/rescue-system.md
#   - suspected upstream drift
#
# This script is NOT wired into `bun run check` because real CI does not have Kimi
# installed or authenticated. It is operator-invoked only.
#
# Exit codes: 0 = pass, 1 = fail with diagnostic on stderr.

set -euo pipefail

cd "$(dirname "$0")/.."

PROMPT="In one sentence, describe what this repository is for based on README.md. Do not edit any files."

echo "Running rescue drift check..." >&2
OUTPUT=$(./scripts/companion.sh task rescue "$PROMPT" 2>&1)

# 1. Rescue must complete cleanly (not partial, not failed, not approval-rejected).
if ! echo "$OUTPUT" | grep -q "Status: completed"; then
  echo "FAIL: rescue did not report Status: completed" >&2
  echo "$OUTPUT" >&2
  exit 1
fi

# 2. No approval rejection — indicates Kimi tried compound shell syntax (&&, pipes, etc.)
#    that the allowlist blocks. This is the run-5 failure mode from the 0.1.7 verification.
if echo "$OUTPUT" | grep -q "APPROVAL_REJECTED"; then
  echo "FAIL: approval allowlist rejected Kimi's tool usage — possible drift in default shell style" >&2
  echo "$OUTPUT" >&2
  exit 1
fi

# 3. Extract the raw final output block and verify it is substantive.
RAW=$(echo "$OUTPUT" | sed -n '/^## Raw Final Output/,/^```$/p' | sed '1,2d;$d')
if [ -z "$RAW" ]; then
  echo "FAIL: empty raw final output" >&2
  echo "$OUTPUT" >&2
  exit 1
fi

RAW_LEN=${#RAW}
if [ "$RAW_LEN" -lt 40 ]; then
  echo "FAIL: raw final output suspiciously short ($RAW_LEN chars): $RAW" >&2
  exit 1
fi

# 4. First meaningful line must not look like a clarifying question.
FIRST=$(echo "$RAW" | awk 'NF {print; exit}')
if echo "$FIRST" | grep -qiE '(could you clarify|which do you mean|what exactly|\?$)'; then
  echo "FAIL: rescue asked a clarifying question — drift in non-interactive commit behavior" >&2
  echo "First line: $FIRST" >&2
  exit 1
fi

echo "PASS: rescue drift check clean." >&2
echo "First line: $FIRST" >&2
exit 0
