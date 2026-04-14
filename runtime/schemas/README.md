# runtime/schemas

Structured output contracts for commands whose output is schema-validated.

- `review-output.ts` — review / challenge finding schema (one-file-per-finding)
- `review-gate-output.ts` — Stop-hook allow/block decision schema

Rescue is deliberately absent. As of 0.1.7, rescue output is pass-through prose: Kimi's raw final output is stored verbatim and rendered as-is, with no schema, no parser, and no renderer transformation. The plugin still owns transport, session, workspace, tool scope, approval policy, and job lifecycle; Kimi owns content, reasoning, and prose.
