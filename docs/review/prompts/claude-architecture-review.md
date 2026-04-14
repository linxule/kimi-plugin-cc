# Claude Architecture Review Prompt

Review this repository as a Claude Code plugin architecture review.

Focus on:

- whether the design genuinely matches the quality bar of `openai/codex-plugin-cc`
- whether the thin-plugin, rich-runtime split is clean and testable
- whether the rescue subagent role is correctly constrained
- whether review gate semantics are realistic and safe

Call out:

- missing decisions
- architectural overreach
- hidden runtime coupling
- any places where the design is pretending Kimi works like Codex when it does not
