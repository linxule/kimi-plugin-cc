# runtime

Local runtime implementation for `kimi-plugin-cc`.

Current checkpoint surface (1b):

- `companion.ts`: stable entrypoint for `setup`, `review`, `task`, `ask`, `status`, `result`, `cancel`
- `commands/setup.ts`: live setup probe against `kimi --wire`
- `commands/review.ts`: foreground read-only review and adversarial-review execution
- `commands/ask.ts`: foreground read-only ask execution
- `commands/rescue.ts`: foreground/background write-capable rescue execution
- `wire/client.ts`: stdio JSON-RPC Wire client with `initialize`, `prompt`, and `cancel`
- `wire/event-buffer.ts`: collects `ContentPart` text by step and commits only on `TurnEnd`
- `wire/approval-dispatcher.ts`: policy hook for inbound `ApprovalRequest` handling
- `job-store.ts`: SQLite-backed job state in WAL mode

Current behavior:

- `setup` is implemented and verifies plugin-data writability plus a live Wire prompt round-trip
- `review` and `task adversarial-review` run through the read-only review profile and validate the fixed JSON schema
- `ask` runs through the read-only ask profile and returns final prose only
- `task rescue` runs through the write-capable rescue profile with a companion-side approval allowlist
- `status`, `result`, and `cancel` read the SQLite job store as the source of truth
- raw Wire traffic can be logged to a file for replay/debugging
- unknown Wire event types are tolerated and ignored unless a command explicitly consumes them
- the companion executes on Node via `tsx`, while Bun remains the package manager and test runner

Subdirectories:

- `agents/`: Kimi agent profiles, including the read-only review/ask profiles and the write-capable rescue profile
- `prompts/`: system and user prompt templates
- `schemas/`: structured output contracts
- `dev-data/`: repo-local stand-in for `${CLAUDE_PLUGIN_DATA}` during development
