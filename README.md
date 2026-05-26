# kimi-plugin-cc

Use [Kimi](https://kimi.ai) as Claude Code's second reviewer, independent thinker, and delegated worker — without building your own multi-agent stack.

This is a [Claude Code](https://claude.ai/code) plugin that drives the [kimi-code](https://kimi.com/code/docs) CLI (the Node.js successor to Kimi CLI) as a subprocess. Claude can ask Kimi for a structured code review, delegate a bug hunt, or have Kimi double-check its own work before stopping — all through slash commands, with persistent job state, session resume, and per-command safety enforced by a [PreToolUse hook](./docs/safety.md) installed in `~/.kimi-code/config.toml`.

- **Independent model, independent perspective.** Kimi reasons differently from Claude. A second opinion from a different model catches things self-review misses.
- **No orchestration layer required.** No ACP, no cloud broker, no shared API keys. The plugin talks directly to a locally-installed `kimi` binary using `kimi -p --output-format stream-json`.
- **Full agent capabilities, safely bounded.** Kimi can read files, write code, run shell commands, and resume where it left off — all bounded by a [workspace allowlist](./runtime/rescue-approval.ts) invoked via the PreToolUse hook. Read-only commands enforce read-only at the hook layer, not the prompt.

> **Migrating from v0.4?** v0.4.x targeted the Python [Kimi CLI](https://github.com/MoonshotAI/kimi-cli) and stays available at the [`v0.4.0`](https://github.com/linxule/kimi-plugin-cc/releases/tag/v0.4.0) tag (`v0.4-maintenance` branch is cut from that tag for ongoing fixes — see the linked tag if the branch is not yet pushed). v1.0 is a hard cut to kimi-code — install kimi-code first, then `/plugin update kimi` will upgrade you in place. See [docs/migration.md](./docs/migration.md) for the step-by-step upgrade.

## Try it in 60 seconds

```
# Prerequisite: install kimi-code from https://kimi.com/code/docs
/plugin marketplace add linxule/kimi-plugin-cc
/plugin install kimi@kimi-marketplace
/kimi:setup
/kimi:review "review my current diff"
```

Kimi reads your working-tree diff and returns a review as markdown:

```markdown
## Verdict: concern

One high-confidence issue in the auth middleware; the rest looks fine.

### src/middleware/auth.ts:42-47 — JWT expiry not checked before token refresh

The refresh handler calls `getNewToken()` without first checking whether the
current token has actually expired. On a slow-clock client this triggers a
refresh on every request.

Suggested fix: add an expiry check before the refresh call.
```

Claude reads the review and can act on it directly. For programmatic access to the same content plus job metadata, `companion.sh result <jobId> --json` returns a structured envelope `{job_id, kind, status, summary, error, artifact_path, body, ...}` where `body` is the full markdown. To go further:

```
/kimi:rescue "fix the top review finding"
```

Kimi opens the file, writes the fix, runs the relevant tests, and reports back. The session persists — if you restart Claude Code, `/kimi:rescue --resume` picks up where it left off.

## When to use what

| Command | What it does | Kimi can write? | Session persists? |
|---------|-------------|-----------------|-------------------|
| `/kimi:ask` | Free-form Q&A — "explain this module"; supports `--background` / `--wait` like rescue | No | Fresh by default, `-r` to resume |
| `/kimi:review` | Structured code review of your diff | No | Fresh each time |
| `/kimi:challenge` | Adversarial review with a custom focus | No | Fresh each time |
| `/kimi:rescue` | Delegate real work — bug hunts, refactors, fixes | Yes (allowlisted) | Persists + resumable |
| Review gate | Kimi checks Claude's work before stopping | No | Per-stop-event |

The plugin ships four Claude Code **subagents** that the main thread can dispatch proactively via the Agent tool: `kimi-rescue` (write-capable delegation), plus `kimi-review`, `kimi-challenge`, and `kimi-ask` (read-only forwarders to the matching companion surfaces). Each agent's description is Kimi's own statement of what it's good for — Claude matches the moment and dispatches; no prescriptive skill manual in between.

## How it works

The architecture is modeled after OpenAI's [codex-plugin-cc](https://github.com/openai/codex-plugin-cc). Both follow the same pattern: thin plugin shell, rich local runtime, one process per job.

```
  /kimi:review "check the auth flow"
       │
       └─ companion.sh → node dist/companion.js
               │
               ├─ spawns: kimi --output-format stream-json -p "<prompt>"
               │            with KIMI_PLUGIN_CC_CMD=review in the env block
               ├─ parses OpenAI-shaped NDJSON records (assistant content + tool_calls)
               ├─ PreToolUse hook (installed by /kimi:setup) enforces the
               │   per-command policy: review/challenge/review_gate/ask are
               │   read-only; rescue uses the workspace allowlist
               ├─ persists job + stream log to SQLite (node:sqlite, zero native deps)
               └─ returns structured result to Claude
```

**Subprocess-first transport.** v1.0 drives `kimi -p --output-format stream-json` as a one-process-per-job subprocess. kimi-code mints the session id and announces it via a `role:"meta", type:"session.resume_hint"` record on stdout (kimi-code 0.2.0+) — earlier 0.1.x announced on stderr instead. The runtime consumes both channels (first-announce-wins) and round-trips the captured token verbatim via `--resume`. The v0.4 Wire JSON-RPC client is gone (kimi-code dropped it); the v0.4-maintenance branch keeps the Wire path alive for Kimi CLI users.

**Safety via PreToolUse hook.** kimi-code's `kimi -p` mode hard-codes `permission: auto` and auto-approves every tool call. The plugin's safety contract therefore lives in a [PreToolUse hook](./docs/safety.md) that `/kimi:setup` installs as a managed block in `~/.kimi-code/config.toml`. The hook reads `KIMI_PLUGIN_CC_CMD` from the env block we set per spawn and applies the right policy — read-only for review/challenge/review_gate/ask, workspace allowlist for rescue. Without the hook, rescue refuses to run.

**Workspace allowlist.** Rescue's allowlist ([`runtime/rescue-approval.ts`](./runtime/rescue-approval.ts)) is the security boundary — not the prompt. Symlink-aware path containment, `.git/` exclusion, a curated set of read-only check tools, mutating-flag detection on `git`/`find`/`sed`, and explicit rejection of `package-manager run <script>` (opaque scripts are a supply-chain risk). The hook calls `evaluateRescueHookRequest` for every rescue tool call.

**Job lifecycle.** Every job gets a SQLite record, a stream-json diagnostic log, and a `kimi_session_id` captured from kimi's stream-json meta record (0.2.0+) or stderr announce (0.1.x fallback). Jobs go through `running` → `completed`/`failed`/`cancelled`. Use `/kimi:status`, `/kimi:result`, `/kimi:cancel`, `/kimi:replay` to manage them.

**Zero native dependencies.** The runtime uses Node 22.5's built-in `node:sqlite` — no `better-sqlite3`, no `node-gyp`, no compilation step. `dist/` is precompiled and committed, so installed plugins work immediately with just `node` on PATH.

**342 tests, drift gate.** The test suite covers the stream-json parser, cli-client lifecycle, approval policy, approval hook entry script, rescue allowlist, command handlers, job lifecycle, setup managed-block installer, and more. `bun run check` rebuilds `dist/`, typechecks, runs the suite, and fails if the rebuild produces uncommitted changes — forgotten rebuilds can't ship.

## Install

### Via the Claude Code marketplace (recommended)

```
/plugin marketplace add linxule/kimi-plugin-cc
/plugin install kimi@kimi-marketplace
/kimi:setup
```

`/kimi:setup` writes the PreToolUse hook to `~/.kimi-code/config.toml` and probes it both directly and through `/bin/sh -c` so launch-from-GUI/LaunchAgent setups (where `node` may not be on the shell's PATH) get caught up front rather than silently auto-approving every tool call.

### From a local clone

```bash
git clone https://github.com/linxule/kimi-plugin-cc ~/kimi-plugin-cc
claude --plugin-dir ~/kimi-plugin-cc
```

Then run `/kimi:setup` to install the safety hook.

### Removing the integration

```
/kimi:setup --uninstall
```

Removes the managed block from `~/.kimi-code/config.toml`. The plugin itself can be uninstalled via `/plugin uninstall kimi`.

## Prerequisites

- **[kimi-code](https://kimi.com/code/docs)** installed and authenticated. The plugin spawns `kimi -p`; set `KIMI_PLUGIN_CC_KIMI_BIN` to override the binary location.
- **Node >= 22.5** — for built-in `node:sqlite`. Set `KIMI_PLUGIN_CC_NODE_BIN` to override.
- **bun** — only for contributor tooling. Not required at runtime.

Still on Python Kimi CLI? Stay on the [v0.4.0 tag](https://github.com/linxule/kimi-plugin-cc/releases/tag/v0.4.0) (or its `v0.4-maintenance` branch, once published) — see [docs/migration.md](./docs/migration.md).

## Development

```bash
bun run check    # rebuild dist/, typecheck, run the full test suite, drift gate
bun test <path>  # run a single test file
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full contributor workflow and [AGENTS.md](./AGENTS.md) for the architecture invariants coding agents should preserve.

## How this was built

This plugin was built through the same multi-model collaboration it enables — Claude, Kimi, and Codex working together at every stage from design through pre-public audit. The v1.0 cutover (PRs 1-5) used the same pattern: each PR landed with paired Claude code-reviewer + Codex codex-rescue adversarial reviews, contradictions resolved against the kimi-code source, and convergent findings applied before commit.

## Acknowledgments

- **[Kimi](https://kimi.ai)** (Moonshot AI) — the reasoning model this plugin delegates to, and a design/review collaborator throughout development
- **[Codex](https://openai.com/index/codex/)** (OpenAI) — architecture consults, parallel implementation, and independent pre-ship reviews via the [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) companion plugin
- **[Claude Code](https://claude.ai/code)** (Anthropic) — the host environment, primary development agent, and the platform this plugin extends

## License

[Apache-2.0](./LICENSE)
