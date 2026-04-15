# Kimi Plugin for Claude Code

Canonical product and technical spec for a Codex-grade Claude Code plugin backed by Kimi CLI.

## Summary

`kimi-plugin-cc` is a Claude Code plugin that gives Kimi the same role inside Claude Code that `codex-plugin-cc` gives Codex. The target is not a thin subprocess wrapper or an MCP sidecar. The target is a **plugin-native experience** with a thin Claude-facing shell and a richer local runtime that owns Kimi Wire sessions, background jobs, output rendering, and review-vs-rescue safety boundaries.

The design is intentionally **Wire-first**:

- Kimi Wire is the primary runtime transport
- print mode exists only as a fallback for probing or temporary compatibility
- ACP is not the primary integration layer

## Product goals

- Match the Codex plugin's mental model inside Claude Code
- Keep the Claude plugin shell thin and deterministic
- Use the local Kimi CLI the user already has installed
- Treat review as truly read-only
- Treat rescue as explicitly write-capable
- Persist jobs and Kimi sessions so `status`, `result`, `cancel`, and resume feel real

## Non-goals

- Not a generic Kimi bridge for every CLI feature
- Not a Kimi MCP server for Claude
- Not a browser or web UI project
- Not a full approval proxy for arbitrary Kimi capabilities beyond the plugin contract
- Not an implementation repo yet
- Not a fourth capability tier between read-only and rescue: read-only channels are `ask` or review, write-capable work is rescue

## User-facing surface

### Slash commands

- `/kimi:setup`
- `/kimi:ask`
- `/kimi:review`
- `/kimi:adversarial-review`
- `/kimi:rescue`
- `/kimi:status`
- `/kimi:result`
- `/kimi:cancel`

### Claude subagent

- `kimi:rescue`

Subagent role:

- proactively delegate substantial Kimi rescue work from the main Claude thread
- decide whether the task fits the rescue profile before forwarding
- choose foreground vs background based on task size
- return the resulting `job_id` so the main thread can poll `status` or `result`

The subagent remains a thin forwarder into the shared runtime, but it is not a blind wrapper.

### Claude skill

- `kimi-review`

Explicit non-goal:

- there is no `kimi-ask` skill in v1; `ask` is explicit user intent, not a proactive auto-discovery behavior

### Review gate

- opt-in only
- enabled and disabled via `/kimi:setup`
- implemented as a `Stop` hook later in v1
- persisted in plugin config, not session-scoped, in v1

## Command contracts

### `/kimi:setup`

Purpose:

- verify `kimi` is installed
- verify the runtime responds
- verify the current authentication/config state is usable
- report review gate state
- manage review gate enable/disable

Flags:

- `--enable-review-gate`
- `--disable-review-gate`

Output:

- short readiness summary
- any blocking setup issues
- recommended next step
- review-gate enable state is stored in plugin config and persists until changed
- setup fails loudly if `${CLAUDE_PLUGIN_DATA}` is unavailable or unwritable

### `/kimi:review`

Purpose:

- run a read-only Kimi review against working tree changes or a branch diff

Flags:

- `--base <ref>`
- `-m, --model <name>`
- `--thinking`
- `--no-thinking`

Defaults:

- target is working tree changes unless `--base` is passed
- phase 1b/2 scope is git-only target selection (working-tree diff or branch diff); file-diff and PR-target modes are deferred
- working-tree review is repo-wide; subdirectory-scoped review is not supported in v1
- review runs foreground-synchronously in v1 — background review is deferred
- review always uses a fresh isolated Kimi session

Behavior:

- no file writes
- no shell execution
- structured findings output only

### `/kimi:ask`

Purpose:

- provide an unframed conversational channel to Kimi without review posture, structured findings, or delegated task framing

Flags:

- `-m, --model <name>`
- `-r`
- `--resume <job-id-or-session-id>`
- `--fresh`
- `--thinking`
- `--no-thinking`
- free-text question after flags

Parsing rule:

- the companion parses known flags and their values first
- `--` explicitly terminates flag parsing
- after the first non-flag token that is not consumed as a flag value, the remaining tokens are preserved verbatim as the prompt

Defaults:

- ask uses a fresh session by default; `-r` chains the latest ask session
- ask runs foreground-synchronously in v1
- ask does not support `--background` or `--wait` in v1

Behavior:

- read-only only
- no structured JSON contract
- returns free-form prose

### `/kimi:adversarial-review`

Purpose:

- run a read-only, steerable review that challenges design decisions, risk assumptions, and alternative approaches

Flags:

- same as `/kimi:review`
- free-text focus after flags

Parsing rule:

- the companion parses known flags and their values first
- `--` explicitly terminates flag parsing
- after the first non-flag token that is not consumed as a flag value, the remaining tokens are preserved verbatim as focus text

Behavior:

- same target selection as review
- different prompt contract
- still read-only
- foreground-synchronous like review; no background support in v1

### `/kimi:rescue`

Purpose:

- delegate investigation or implementation to Kimi through a persistent plugin-managed session

Flags:

- `--background`
- `--wait`
- `-r`
- `--resume <job-id-or-session-id>`
- `--fresh`
- `-m, --model <name>`
- `--thinking`
- `--no-thinking`

Behavior:

- may read files, edit files, and run commands
- persists a Kimi session id per rescue flow
- `-r` resumes the latest rescue session for the repo and may include a new prompt
- `--resume <job-id-or-session-id>` resumes a specific rescue session without a new prompt payload
- defaults to continuing the latest rescue session for the repo when the request clearly implies continuation and `--fresh` is not present
- background start responses must include `job_id` and `command_type`

### `/kimi:status`

Purpose:

- show active and recent plugin-managed jobs for the current repository

Behavior:

- default view shows the latest job for the current `repo_id`
- optional job id shows a more detailed view
- optional `--type <review|adversarial_review|rescue|review_gate|ask>` narrows lookup within the current `repo_id`

### `/kimi:result`

Purpose:

- return the final stored result for a completed job

Behavior:

- default returns the latest finished job
- optional job id returns an exact job
- includes the linked Kimi session id when available
- optional `--type <review|adversarial_review|rescue|review_gate|ask>` narrows lookup within the current `repo_id`

### `/kimi:cancel`

Purpose:

- stop an active background job

Behavior:

- requests a graceful cancellation through the Kimi runtime first
- escalates to process termination if needed
- leaves a consistent final job state

## Architecture

### Runtime shape

The repo is structured around two layers:

- **Claude plugin layer**
  - command markdown files
  - rescue subagent definition
  - hook declarations
  - plugin manifest
- **Local runtime layer**
  - Kimi Wire client
  - job store
  - prompt/rendering logic
  - result parsing
  - cancellation and resume logic

This mirrors the shape of `codex-plugin-cc`, where the plugin shell is mostly policy and routing while the executable runtime owns transport and state.

### Main flow

```text
Slash command -> companion entrypoint -> runtime command -> Kimi Wire session -> job store -> rendered result
```

### Process topology

V1 uses **one dedicated Kimi Wire process per plugin job**.

Implications:

- no job shares a live Wire connection with another job
- foreground review and background rescue can run concurrently because they do not share a session bus
- the Kimi one-active-turn-per-connection constraint is contained to a single job
- `cancel` only affects the targeted job's Wire process and worker, not unrelated jobs

The runtime does not implement a shared broker or multi-job pooled Kimi process in v1.

### Concurrency policy

V1 imposes no explicit cap on concurrent jobs.

- concurrency is bounded only by OS and process limits
- because jobs do not share a Wire connection, one job cannot monopolize another job's active turn slot
- future throttling can be added later without changing the public command surface

### Why Wire is primary

Wire is Kimi's native bidirectional protocol surface for:

- prompt submission
- streamed events
- approvals
- plan mode negotiation
- replay
- cancellation
- session restoration

That makes it the closest Kimi equivalent to Codex's app-server path.

### Why print mode is not primary

Print mode is deliberately not the default runtime because:

- it is non-interactive
- useful non-trivial print-mode flows effectively require YOLO
- it pushes too much lifecycle interpretation into text parsing
- it weakens cancellation, steering, and approval handling

Print mode remains a fallback only for setup/probing or emergency compatibility.

## Safety model

### Review profile

`review` and `adversarial-review` use a dedicated restricted Kimi **agent-file profile** with:

- no write tools
- no shell tools
- no nested agents
- no external tools
- no background task tools
- `AskUserQuestion` off by default

Read-only behavior is enforced by agent/tool policy, not by instruction wording alone.

### Ask profile

`ask` uses a minimal read-only **agent-file profile** that inherits from Kimi's default and excludes write, shell, nested-agent, background, and external tools.

Rules:

- no injected evaluation stance
- no delegated task framing
- no structured-output requirement
- read-only behavior is enforced by agent/tool policy, not by instruction wording alone

### Rescue profile

`rescue` uses a separate Kimi **agent-file profile** with:

- read tools enabled
- write tools enabled
- shell enabled
- external tools disabled by default
- custom system prompt and exclusions versioned in this repo

Notes:

- profiles are authored as YAML files under `runtime/agents/` and loaded with `--agent-file`
- the plugin does not rely on built-in `--agent` presets directly, because prompts and restrictions must be versioned in-repo
- Kimi subagents are upstream-constrained from nesting `Agent`; the plugin treats that as a runtime fact, not a configurable policy

### Approval policy

The companion runtime owns Kimi approval responses.

- Wire taxonomy: `ApprovalRequest` is a Wire **request** (requires a client response), while `ApprovalResponse` is a Wire **event** (fire-and-forget notification of the decision). The runtime replies to `ApprovalRequest` inbound; it never produces `ApprovalResponse` itself
- because `--agent-file` cannot pre-declare selective auto-approvals, all approval-response logic is implemented in the Wire client per `command_type`
- `review`, `adversarial-review`, `ask`, and `review_gate` do not forward Kimi approvals to Claude; unexpected approval requests are rejected and the job fails
- `rescue` auto-approves file edits only when every target path resolves under the current workspace root, avoids symlink escape, and does not touch `.git/`
- `rescue` does not blanket-auto-approve shell commands
- `rescue` shell approvals are allowed only for this conservative v1 allowlist of local inspection, check, and test commands:
  - `git status`, `git diff`, `git show`, `git log`, `git grep`, `git blame`
  - `rg`, `grep`, `ls`, `cat`, `find`, `pwd`
  - direct check tools: `tsc --noEmit`, `pyright`, `mypy`, `ruff`, `biome check`, `eslint`, `cargo check`, `cargo clippy`, `go build`, `go vet`
  - test and build entry points: `pytest`, `python -m pytest`, `npm test`, `pnpm test`, `yarn test`, `bun test`, `uv run pytest`
  - package-manager script entry points: `bun run <script>`, `npm run <script>`, `pnpm run <script>`, `yarn run <script>`, `uv run <script>`, `cargo <subcommand>`, `go <subcommand>`
- for package-manager script entry points, the runtime rejects script names or subcommands on a stop list:
  - `start`, `dev`, `serve`, `watch`, `deploy`, `publish`, `release`, `preview`, `run`, `install`
- check tools are allowed only in their read-only modes: the runtime rejects invocations containing `--fix`, `--write`, `-w`, `--apply`, `--in-place`, or a standalone `-i` flag, because those modes mutate files outside the file-edit approval path
- `find` is allowed only for traversal: the runtime rejects `find` invocations containing `-exec`, `-execdir`, or `-delete`, since those turn traversal into arbitrary command execution
- pipelines are allowed only when every stage is itself on the read-only, check, or test allowlist, and the pipeline uses only read-only plumbing commands such as `head`, `tail`, `wc`, `sort`, `uniq`, `awk`, or `sed` without `-i`
- `rescue` rejects redirection, command substitution, backgrounding, or shell chaining
- `rescue` rejects network, destructive, or repo-mutating shell commands, including `curl`, `wget`, `ssh`, `scp`, `rm`, `chmod`, `chown`, `git push`, `git pull`, `git reset`, and branch-changing `git checkout`
- `rescue` rejects external tools and any capability not covered by the rescue profile
- the plugin does not implement a second interactive approval proxy between Kimi and Claude in v1

Known limitation:

- rescue cannot surface one-time approval prompts to the user for commands outside the allowlist; this is a known limitation of the external companion runtime integration and is revisited alongside the deferred pass-through architecture option

Git ceremony:

- git mutation is out of scope for rescue in v1
- rescue may read git state, but it may not stage, commit, create or switch branches, stash, rewrite history, push, pull, or reset
- the main Claude thread or the user is responsible for branch setup and commit workflow around a rescue run
- the intended workflow is: prepare the branch, dispatch rescue for file-only edits and bounded checks, review the result, then handle commit/push in the main thread

Deferred architecture option:

- v1 enforces rescue safety via a companion-side allowlist instead of routing through Claude Code's own permission model
- true pass-through would require the companion to have an IPC path back into the Claude session to invoke Claude's Write/Edit/Bash tools, which current Claude Code does not expose to detached plugin subprocesses
- as a consequence, v1 inherits the same class of friction seen in Codex-style delegated runs: the rescue capability surface is invisible to the main Claude thread until runtime rejection, and the user cannot grant one-time approvals for commands outside the allowlist
- a v2 evaluation should revisit this as the path to more Claude-native ergonomics, likely via a foreground-only or interactive pass-through mode

## Session model

### Review sessions

- always fresh
- never resume prior review state
- isolated from rescue state

### Ask sessions

- always fresh in v1
- client-assigned session id for uniform runtime bookkeeping
- not persisted for reuse in v1
- if future resume support is added, it should mirror rescue semantics rather than invent a new session model

### Rescue sessions

- persistent per plugin-managed rescue flow
- linked to the current repository
- resumable through job metadata and stored Kimi session ids

### Session id acquisition

The plugin assigns rescue and ask session ids client-side.

Strategy:

1. when starting a fresh rescue or ask run, the companion generates a UUID
2. it passes that UUID to Kimi via `--session <id>` at launch
3. it persists the session id to the job record before opening the Wire connection

Rules:

- rescue jobs always have a non-null `kimi_session_id`
- review jobs may keep `kimi_session_id = null`
- ask uses rescue-grade session persistence: client-assigned UUIDs, running-session guards, and fail-fast on resume-not-found
- rescue resume is only available for jobs or sessions with a non-null stored session id
- phase-1 implementation must re-verify that current Kimi CLI still supports "create new if not found" semantics for `--session <id>`

## Job model

Plugin-managed jobs are the source of truth for:

- `status`
- `result`
- `cancel`

### Job states

- `running`
- `completed`
- `failed`
- `cancelled`

### Required job fields

- `job_id`
- `repo_id`
- `command_type`
- `created_at`
- `updated_at`
- `cwd`
- `model`
- `thinking`
- `background`
- `pid`
- `kimi_pid`
- `status`
- `kimi_session_id`
- `agent_profile`
- `prompt_digest`
- `summary`
- `final_output_path`
- `stream_log_path`
- `error`

### Field semantics

- `job_id`: plugin-generated stable identifier unique within the job store
- `repo_id`: stable hash of git common-dir plus current worktree root; if not in git, hash the realpath of `cwd`
- `command_type`: one of `review`, `adversarial_review`, `rescue`, `review_gate`, `ask`
- `pid`: background worker process id when a worker exists, otherwise `null`
- `kimi_pid`: Kimi Wire child process id when a live process exists, otherwise `null`
- `summary`: short status-safe summary string; may be empty only before the first meaningful runtime event
- `final_output_path`: path to the rendered markdown artifact returned by `result`; `null` until terminal rendering succeeds
- `stream_log_path`: path to the raw Kimi Wire event log captured for replay/debugging; required once the job starts
- `error`: structured object or `null`; when non-null it contains at least `code`, `message`, and `stage`

### Storage

Use a plugin-owned SQLite job store plus file-backed artifacts.

Paths:

- primary root: `${CLAUDE_PLUGIN_DATA}/kimi-plugin-cc/`
- database: `state.db`
- rendered outputs: `artifacts/`
- raw Wire logs: `logs/`

Concurrency model:

- SQLite is the source of truth for job metadata and state transitions
- raw logs and rendered artifacts are append/write-once files referenced from the database
- SQLite runs in WAL mode with a configured `busy_timeout`
- no ad hoc JSON file state store in v1

### State transitions

- `running` -> `completed`: final result renders successfully and output artifacts persist
- `running` -> `failed`: runtime, transport, parse, or execution failure produces a terminal error
- `running` -> `cancelled`: explicit user cancellation succeeds and the runtime confirms a terminal cancel state

Terminal states:

- `completed`
- `failed`
- `cancelled`

Rules:

- jobs never leave a terminal state
- `cancel` against a terminal job is a no-op with an informational response
- `result` reads terminal jobs only
- `status` may read jobs in any state
- `cancelled` means the active turn stopped; the rescue session may still remain resumable if a session id was acquired

## Public runtime interfaces

The runtime must expose stable companion subcommands:

- `setup`
- `ask`
- `review`
- `task`
- `status`
- `result`
- `cancel`

These commands are the bridge from Claude command markdown to the local runtime. The plugin shell does not reimplement lifecycle logic.

## Output schemas

### Review output

```json
{
  "summary": "string",
  "verdict": "approve|concern|block",
  "findings": [
    {
      "severity": "low|medium|high",
      "confidence": "low|medium|high",
      "title": "string",
      "file": "string",
      "start_line": 123,
      "end_line": 125,
      "body": "string",
      "suggested_fix": "string|null"
    }
  ]
}
```

Rules:

- review commands must produce structured output
- parse failure is a failure
- malformed output never becomes a fake empty review
- `findings` may be empty only when `verdict` is `approve`
- `file`, `start_line`, and `body` are required for every finding
- `end_line` defaults to `start_line` when omitted
- `suggested_fix` is optional and may be `null`
- one finding maps to one file only; multi-file issues must be split into multiple findings
- `confidence` is required for every finding

Enforcement path:

- the prompt contract requires the final assistant message to be a single JSON object with no prose wrapper and no code fences
- the runtime buffers text `ContentPart` payloads emitted after the last `ToolResult` of the turn
- the buffered text is committed only when `TurnEnd` is received
- as of Kimi 1.30.0 `TurnEnd` is emitted even when a turn exits via cancellation or step interruption, so a missing `TurnEnd` should be rare in practice; the runtime still treats a missing `TurnEnd` as hard malformed failure (defensive, fail-closed, Wire is labeled experimental)
- if the committed final text is not valid JSON matching the schema, the review fails immediately
- v1 does not perform a second model repair pass for malformed output

### Rescue output

```json
{
  "status": "success|partial|blocked",
  "summary": "string",
  "changes": [
    {
      "file": "string",
      "action": "create|edit|delete",
      "description": "string"
    }
  ],
  "commands_run": [
    {
      "command": "string",
      "exit_code": 0,
      "note": "string"
    }
  ],
  "tests": [
    {
      "name": "string",
      "status": "passed|failed|not-run",
      "details": "string"
    }
  ],
  "followups": ["string"]
}
```

Rules:

- rescue may still surface raw output when the final summary is incomplete
- the plugin should preserve final transcript artifacts for auditability

Enforcement path:

- rescue also requests a final single JSON object
- if rescue JSON is malformed, the job still lands as `completed` with `error` set and raw output attached; the parse failure is explicit in job metadata and rendered output (`JobStatus` is only `running | completed | failed | cancelled` — there is no dedicated `partial` state)

### Ask output

`ask` has no JSON schema.

Rules:

- ask returns free-form prose
- the rendered result is a markdown artifact containing the final prose response
- the runtime still uses transport-level completion rules rather than shape validation

Enforcement path:

- the runtime buffers text `ContentPart` payloads emitted after the last `ToolResult` of the turn
- the buffered text is committed only when `TurnEnd` is received
- as of Kimi 1.30.0 `TurnEnd` is emitted even when a turn exits via cancellation or step interruption; the runtime still treats a missing `TurnEnd` as hard failure rather than returning a partial buffer (defensive, fail-closed, Wire is labeled experimental)

## Review gate

Review gate is part of v1, but not phase 1.

Requirements:

- disabled by default
- persisted in plugin config
- implemented as a `Stop` hook
- runs a targeted Kimi review of Claude's previous response
- on explicit high-confidence failure output, it prevents Claude from stopping and injects corrective context for a follow-up turn
- degrades safely if the Kimi runtime is unavailable

### Review gate contract

The review gate uses a dedicated structured result schema:

```json
{
  "decision": "ALLOW|BLOCK",
  "confidence": "low|medium|high",
  "summary": "string",
  "issues": [
    {
      "title": "string",
      "body": "string",
      "severity": "low|medium|high"
    }
  ]
}
```

Blocking rule:

- only prevent stop when `decision` is `BLOCK` and `confidence` is `high`
- all other outputs are treated as allow-with-warning or runtime degradation

Hook prompt context:

- the Claude response that is about to stop
- the user request that the Claude response answered
- the current working directory and repository root
- no write-capable tools

Timeout budget:

- default review-gate runtime budget is 8 seconds
- review-gate runs use `--no-thinking` and a small review-capable model by default
- timeout is treated as allow-with-warning and logged as a degraded review-gate run

Malformed output rule:

- malformed or partial review-gate output never hard-blocks the user silently
- it becomes an informational warning and is logged as a failed review-gate job

## Phasing

### Phase 0

- planning bundle
- review artifacts
- repo skeleton

### Phase 1

- setup
- ask
- review
- adversarial review
- companion/runtime shell
- Kimi Wire client foundation
- `kimi-review` Claude skill

### Phase 2

- rescue
- background jobs
- result/status/cancel
- rescue session persistence

### Phase 3

- review gate
- runtime hardening
- richer rendering and replay tooling

## Defaults and assumptions

- this repo is a new standalone project
- Node.js + TypeScript is the implementation stack
- Kimi Wire is primary; print mode is fallback only
- the planning bundle is the only deliverable in this phase
- AI review happens before implementation begins

## Rescue resume defaults

Resume behavior is repo-scoped and deterministic:

- `--fresh` always starts a new rescue session and ignores recent session history
- explicit `--resume <job-id>` or `--resume <session-id>` takes precedence over all heuristics
- `-r` resumes the latest rescue job for the current `repo_id`
- without `-r`, `--resume`, or `--fresh`, the plugin auto-resumes only when the user intent clearly implies continuation, such as "continue", "resume", "keep going", "apply the top fix", or "dig deeper"
- otherwise the plugin starts a fresh rescue session

Resolution order:

1. explicit `--fresh`
2. explicit `--resume <job-id|session-id>`
3. explicit `-r`
4. intent-based auto-resume heuristic
5. fresh session
