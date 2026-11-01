# Kimi companion runtime

The Kimi companion runtime powers all seven ask, review, challenge, rescue, pursue, swarm, and swarm-write operations for Claude Code, Codex, and DeepSeek Harness. Each model job starts a local `kimi -p --output-format stream-json` subprocess, with per-command safety hooks and an optional review gate. DSH providers launch the same compiled companion through the host's managed subprocess service rather than adding an ACP transport.

Native agent-core-v2 is certified only at the exact CLI versions listed in `kimi-engine.ts`. Legacy-v1 remains available for explicitly pinned versions in `KIMI_TESTED_MINORS`, through 0.41.x. See [engine certification](../docs/native-v2-certification-provenance.md) for the per-operation matrix.

## Commands

The dispatcher in `companion.ts` exposes:

- `setup` to install or check the current host's hook, uninstall it, or manage the review gate
- `setup --models [--json]` to list configured models without contacting a provider or exposing credentials
- `review` and `task challenge` to review changes without write tools
- `ask` to answer repository questions, with a fresh session by default and explicit resume support
- `task rescue` to make workspace changes under the rescue allowlist
- `task pursue` to run an experimental goal with a finite time budget and the rescue policy
- `task swarm` to run a read-only parallel review
- `task swarm --write` to prepare a patch in a temporary Git worktree without applying it
- `status`, `result`, and `cancel` to manage stored jobs
- `mcp` to serve the seven model operations and MCP job controls over stdio
- `mcp-child <job-uuid>` as the private fixed-ID companion launched by that server
- `replay <job-id>` to render a stored stream log again

## Main modules

| Module | Responsibility |
| --- | --- |
| `companion.ts` | Dispatch companion subcommands |
| `dsh/` | Register all seven DSH providers and human commands, isolate host state, and manage subprocess lifecycles |
| `mcp/` | Define typed tools, frame stdio, negotiate tasks, supervise fixed-ID children, and bind job ownership |
| `cli-client.ts` | Build the child environment and arguments, parse output, enforce provenance, and cancel the process tree |
| `kimi-engine.ts` | Select a certified engine and persist the execution plan |
| `native-v2-preflight.ts` | Refuse plan-mode settings, unsafe experimental selectors, and unsafe resume journals |
| `stream-json.ts` | Parse assistant, tool, and metadata records |
| `cli-cancellation.ts` | Connect cancellation signals to running commands |
| `background-spawn.ts` | Start detached ask and rescue workers |
| `kimi-command.ts` | Resolve the CLI binary and validate launcher prefix arguments |
| `kimi-errors.ts` and `kimi-timeouts.ts` | Classify CLI failures and set response budgets |
| `hooks/approval-policy.ts` | Allow or deny each managed tool call |
| `hooks/approval-hook.ts` | Run the hook installed in Kimi's configuration |
| `hooks/install.ts` and `hooks/config-safety.ts` | Verify hooks and serialize configuration changes |
| `rescue-approval.ts` | Check write paths, shell commands, and the trusted workspace root |
| `job-store.ts` and `jobs.ts` | Store job state, enforce terminal states, and reconcile stale workers |
| `render.ts` | Render live and replayed results consistently |

## Runtime behavior

Every model command verifies the current host's hook before spawning the Kimi CLI. The review gate skips visibly if enforcement is unavailable. Native-v2 sessions also pass the independent no-plan checks before the Kimi CLI spawn and at the spawn boundary.

MCP launches attach only after cancellation handlers are installed, with a 60-second bound. Verified teardown can close a stalled launch; missing identity or inconclusive termination evidence keeps it starting and recoverable by ID. `kimi_pid` is recorded at actual spawn. Host workspace defaults are containment boundaries, not arbitrary overrides.

`KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1` bypasses hook verification only. It is a test and diagnostic option, not a repair path. It does not bypass engine certification, provenance, or the native-v2 preflight.

Cancellation waits for process teardown. On POSIX systems, the runtime checks descendant identities before signaling and waits for a bounded period after forced termination. Windows lacks equivalent process-tree support.

Slash-command and skill model operations return Kimi's prose. The review gate parses a JSON allow/block decision and permits the host to stop on malformed output. MCP returns protocol envelopes, task or launch handles, and structured job-control metadata. Enable the optional Claude Code Stop hook with `/kimi:setup --enable-review-gate`.

Model selection follows the [model and provider contract](../docs/models.md). The plugin does not enforce a per-task thinking setting. `--thinking <effort>` requests effort for this process through `KIMI_MODEL_THINKING_EFFORT`; upstream provider/model rules can ignore it and stream-json cannot reveal whether it was honoured. `--no-thinking` is rejected; use `--thinking off`.

The shell wrapper accepts `CLAUDE_PLUGIN_ROOT` or `PLUGIN_ROOT`. Data selection uses the explicit `KIMI_PLUGIN_CC_DATA` override, verified installed-package identity, or unambiguous legacy data variables for custom launches. Conflicts refuse before store access; see [plugin data ownership](../docs/invariants.md#5-plugin-data-ownership). Logs remain under the selected parent in `kimi-plugin-cc/logs/`. See [entry points and generated surfaces](../scripts/README.md).

Production runs use `dist/companion.js` on Node. Development can use `tsx`; Bun installs dependencies and runs tests. The old Python Wire transport is historical and is not used by this runtime.
