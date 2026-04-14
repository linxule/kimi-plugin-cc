# Kimi Wire Protocol Integration

How the plugin consumes the Kimi Wire protocol. Source lives in this directory.

## Transport

JSON-RPC over stdio: the plugin spawns `kimi --wire` as a child process,
writes JSON-RPC requests to stdin, reads JSON-RPC responses and events from stdout.
See `client.ts` for the low-level read/write loop.

## Lifecycle

1. **start** — spawn the `kimi` process with `--wire --session <id>`
2. **initialize** — exchange capabilities (`client.ts`)
3. **prompt** — send the user prompt; Kimi streams events back
4. **TurnEnd** — Kimi signals the turn is complete
5. **close** — graceful shutdown (SIGTERM, then SIGKILL after timeout)

## Turn capture

`turn-capture.ts` buffers text `ContentPart` payloads after the last
`ToolResult` of the turn and commits the buffer on `TurnEnd`. Interrupted
turns (no `TurnEnd`) are treated as malformed rather than parsing partial data.

## Approval dispatcher

`approval-dispatcher.ts` is the policy hook for inbound `ApprovalRequest`
messages. Policy varies by command type:
- **review / ask / challenge / review_gate** — auto-approve read-only tools; reject everything else
- **rescue** — allowlist-based evaluation via `rescue-approval.ts` (file edits scoped to workspace root; shell commands against a conservative allowlist)

## Connection model

One Wire connection per job. Kimi's one-turn-per-connection limit means each
plugin job owns its own process. Cancellation blast radius is local to that job.
