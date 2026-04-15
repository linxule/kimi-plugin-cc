---
description: Ask Kimi (an independent model) for a read-only second-pair-of-eyes review of a working tree diff or branch diff. Use when Claude has already inspected a change once and wants a cross-model review perspective, when the change spans multiple files or has design or risk implications, or when the user explicitly asks for another reviewer.
---

# kimi-review

Use this skill when Claude Code should proactively ask Kimi for a read-only second-pass review of a working tree diff or branch diff.

## Purpose

This skill makes the plugin feel more native in Claude Code agent workflows by turning Kimi review into a discoverable collaborator behavior rather than only a slash command the agent must remember to call.

## Trigger guidance

Prefer this skill when:

- Claude has already inspected the change once and wants a second reviewer
- the change spans multiple files or has design or risk implications worth an extra pass
- the user explicitly asks for another review perspective

Do not use this skill when:

- the task is an implementation or delegation request better served by `/kimi:rescue`
- the user wants a challenge review; prefer `/kimi:challenge`
- the user wants only the main Claude thread's judgment

## Expected behavior

- invoke `/kimi:review` in read-only mode
- preserve the plugin's structured JSON review contract and surface findings, not implementation
- prefer working-tree review by default; use `--base <ref>` when the user clearly wants branch-diff review
- keep the call thin: pass the user's target or focus text through, then summarize the returned findings for the main thread without rewriting them into implementation work

## Operating guidance

When this skill triggers:

- keep the request read-only; if the user wants edits or shell work, switch to `/kimi:rescue` instead of stretching review
- preserve any explicit focus text after the command flags
- if Kimi returns no findings, report that explicitly rather than implying the review was skipped

## Output handling

- treat malformed review output as a hard failure and surface that failure
- keep multi-file issues split into separate findings if you restate them
- do not convert Kimi review into a patch plan unless the user asks for follow-up implementation
