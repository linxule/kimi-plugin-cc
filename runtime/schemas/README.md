# runtime/schemas

Structured output contracts for commands whose output is schema-validated.

- `review-gate-output.ts` — Stop-hook allow/block decision schema

Review, challenge, ask, and rescue all use pass-through prose output: Kimi's raw final output is stored verbatim and rendered as-is, with no schema, no parser, and no renderer transformation. The plugin still owns transport, session, workspace, tool scope, approval policy, and job lifecycle; Kimi owns content, reasoning, and prose. (Pre-v0.2.3, review/challenge enforced a structured JSON schema — that was removed because it interacted poorly with Kimi's extended-thinking finalization path and added no real consumer value. Only `review_gate` retains a schema, because the Stop hook makes programmatic decisions on `decision` and `confidence`.)
