---
description: Review a GitHub pull request with Kimi, optionally posting one summary comment.
argument-hint: "[--budget <30m|1h|90s>] [--post-comment] [-m <model>] [--thinking <effort>] <owner/repo#123|PR URL|#123> [focus]"
disable-model-invocation: true
---

Run the companion with user-supplied arguments after `review-pr`:

`${CLAUDE_PLUGIN_ROOT}/scripts/companion.sh review-pr <args>`

Examples:

- `${CLAUDE_PLUGIN_ROOT}/scripts/companion.sh review-pr owner/repo#123`
- `${CLAUDE_PLUGIN_ROOT}/scripts/companion.sh review-pr --post-comment https://github.com/owner/repo/pull/123`
- `${CLAUDE_PLUGIN_ROOT}/scripts/companion.sh review-pr '#123' Focus on concurrency`

The command requires the authenticated GitHub CLI (`gh`). A bare number or `#123` uses the current repository. It fetches the PR metadata and diff without using the local checkout as review evidence. Title, body, and diff are treated as untrusted data, and large content is bounded with any coverage gap reported. Kimi returns ordinary review prose; it does not produce inline comments or a formal GitHub approve/request-changes review.

`--post-comment` is the only way to publish. It posts one issue-summary comment after the review completes successfully and appends the comment URL. Without it, the command never writes to GitHub. A posting failure can leave the completed local review artifact available through `result <jobId>`.

Other options:

- `--thinking <off|low|medium|high>` (also `--thinking=<effort>`) requests effort for this process; support depends on the selected provider/model.
- `--budget <dur>` sets the wall-clock ceiling (default 30m; maximum 24h).
- `-m`, `--model <name>` selects a configured model alias.
- trailing text supplies an optional review focus; use `--` before flag-shaped focus text.

Review runs foreground-synchronously. `--base`, `--background`, and `--wait` are unsupported. Return companion stdout verbatim and do not post separately.
