---
name: kimi
description: "Delegate read-only repository questions, diff reviews, adversarial challenges, bounded workspace fixes, autonomous goals, and parallel read/patch swarms to the local Kimi Code CLI via the 4 Kimi MCP tools (`kimi_read`, `kimi_write`, `kimi_job`, `kimi_setup`) or `scripts/companion.sh`."
---

# Kimi

Use Kimi Code as an independent peer for second-opinion reviews, adversarial design challenges, codebase questions, bounded workspace fixes, autonomous goals, and parallel read/patch fan-out.

Prefer the 4 MCP tools whenever the `kimi` MCP server is connected (in DSH they are prefixed `mcp__kimi__kimi_read`, `mcp__kimi__kimi_write`, `mcp__kimi__kimi_job`, `mcp__kimi__kimi_setup`). Use the `scripts/companion.sh` CLI fallback only when MCP is unavailable.

## MCP Tools

### `kimi_read` (read-only)

| `mode` | Purpose | Key options |
|---|---|---|
| `ask` (default) | Answer a question or trace code | `prompt` (required unless `resume`), `resume` (`"last"` may pair with `prompt`; job/session ID cannot include `prompt`) |
| `review` | Defect review of uncommitted changes or branch diff | `base` or `uncommitted` (mutually exclusive; uncommitted default), optional `prompt` focus |
| `challenge` | Adversarial critique of assumptions and tradeoffs | `base` or `uncommitted`, optional `prompt` focus |
| `swarm` | Parallel read-only fan-out across independent targets | `prompt` (required), `cap` (1..25 soft hint), `max_concurrency` (1..16; 1 runs directly) |

Shared `kimi_read` options: `workspace` (absolute dir when host sets no default), `model`, `thinking` (`off|low|medium|high`), `budget` (`30m`, `1h`, `90s`, or bare minutes; max `24h`), `read_roots` (extra absolute dirs), `network` (boolean, default `false`; confines reads to `workspace` + `read_roots`), `referenced_sessions` (up to 8 earlier job/session IDs), `wait` (default `true`), `wait_timeout_ms` (`1000..86400000`, default `50000`).

### `kimi_write` (workspace-confined; never mutates Git)

| `mode` | Purpose | Key options |
|---|---|---|
| `rescue` (default) | Single-turn bounded edit/fix/test in workspace | `prompt`, `resume` (`"last"` may pair with `prompt`; job/session ID cannot include `prompt`), `referenced_sessions` |
| `pursue` | Autonomous multi-turn goal loop in workspace | `prompt`, finite `budget` (default `45m`); no `resume` or `referenced_sessions` |
| `swarm_patch` | Parallel edits in a born-HEAD detached worktree returning a git patch without modifying the real tree | `prompt`, `cap` (1..25), `max_concurrency` (1..16; default 1 runs directly), `referenced_sessions` |

Shared `kimi_write` options: `workspace`, `model`, `thinking`, `budget`, `wait` (default `true`), `wait_timeout_ms`.

### `kimi_job` (job lifecycle)

`action` (required):
- `list`: list workspace jobs (`status_filter`: `running|completed|failed|cancelled`, `limit`: `1..100`, default `20`).
- `status` / `result` / `cancel`: inspect, read terminal artifact, or cancel `job_id` (defaults to latest matching repo job).
- `wait`: poll until terminal or `wait_ms` (`100..600000`, default `30000`) elapses (`job_id` optional).
- `replay`: re-render persisted stream log (`job_id` required).
- `recover_swarm`: preview (`apply: false`, default) or apply (`apply: true`) cleanup and patch capture for an orphaned swarm (`job_id` required).

### `kimi_setup` (readiness, models, maintenance)

`action` (default `check`):
- `check`: verify the canonical `PreToolUse` safety hook and Kimi binary (read-only).
- `models`: credential-safe inventory of configured Kimi model aliases (offline, not a connection test).
- `install`: publish bundled hook artifact and write/repair the canonical managed block in `~/.kimi-code/config.toml`.
- `install_kimi`: download and install the newest certified Kimi Code CLI under the plugin data root (only on explicit user request).
- `repair_sessions`: preview (`apply: false`, default) or apply (`apply: true`) session title/preview repair (`all: true` spans all repos).

## Execution Patterns

- **Synchronous default (`wait: true`)**: Standard `kimi_read` and `kimi_write` calls wait up to `wait_timeout_ms` (default `50000` ms / 50s) and return the final prose directly. If `wait_timeout_ms` expires first, the call returns a running handle (`timed_out_waiting: true`) while the job continues; finish with `kimi_job({ action: "wait", job_id })`.
- **Parallel fan-out / Code Mode (`wait: false`)**: Launch independent jobs with `wait: false` to get `{ job_id }` handles immediately, then coordinate with `kimi_job` (`wait`, `status`, `result`, `cancel`). Clients supporting MCP `2026-07-28` tasks receive native task handles (`tasks/get`, `tasks/cancel`).
- **Continuity (`resume` vs `referenced_sessions`)**: Use `resume` to continue an `ask` or `rescue` session directly (kind-scoped). Use `referenced_sessions` (up to 8 job or Kimi session IDs) to let a fresh `ask`, `review`, `challenge`, `swarm`, `rescue`, or `swarm_patch` run consult earlier main session logs read-only. When paired with `read_roots` or `network`, each referenced session's `agents/main` directory becomes readable.

## Safety & Handling

- **Model selection**: Omit `model` to use Kimi's configured default (resumes keep their session model). Before selecting a named model, call `kimi_setup({ action: "models" })`; never guess an alias and never read `~/.kimi-code/config.toml` or `~/.kimi-code/credentials/`.
- **Hook & version gates**: Never suggest bypass env vars (`KIMI_PLUGIN_CC_SKIP_HOOK_CHECK`). On a hook refusal, check structured details: if `refusal_kind` is `"node-bin-not-executable"`, tell the user to repair their Node install or set `KIMI_PLUGIN_CC_NODE_BIN` to a valid Node `>=22.5` executable (setup cannot repair a missing Node binary); if `retryable_after_setup` is literally `true` (routine hook-script or same-interpreter path drift after a plugin update), run `kimi_setup({ action: "install" })` (or `scripts/companion.sh setup`) and, only if it succeeds, retry the refused command once; surface any other refusal or a second refusal directly. Certified floor is Kimi Code `>= 2.8.0`; unlisted newer `2.x` releases may run read-only `ask`/`review`/`challenge` with a warning, while write and swarm modes require an exact certified row.
- **Faithful reporting**: Return Kimi's review/challenge/ask prose verbatim without softening critiques. Relay any `Warnings:` block or `hook_escapes` detection notice directly to the user. Never apply a `swarm_patch` patch unless the user asks.

## CLI Fallback (`scripts/companion.sh`)

Resolve `<plugin-root>` (two directories above this `SKILL.md`, or `$PLUGIN_ROOT`) and run from the target workspace directory:

```sh
"<plugin-root>/scripts/companion.sh" read [--mode ask|review|challenge|swarm] [options] [--] [prompt]
"<plugin-root>/scripts/companion.sh" write [--mode rescue|pursue|swarm-patch] [options] [--] <prompt>
"<plugin-root>/scripts/companion.sh" job <list|status|result|wait|cancel|replay|recover-swarm> [job-id] [options]
"<plugin-root>/scripts/companion.sh" setup [--check | --uninstall | --models [--json] | --install-kimi [--json] | --repair-sessions [--apply] [--all]]
"<plugin-root>/scripts/companion.sh" mcp
```

Common CLI flags: `-m/--model <alias>`, `--thinking <off|low|medium|high>`, `--budget <dur>`, `--base <ref>` (`review`/`challenge`), `-r` / `--resume <id>` / `--fresh` (`ask`/`rescue`), `--background` / `--wait` (`ask`/`rescue`), `--read-root <abs-dir>`, `--network`, `--reference-session <id>`, `--turns <n>` (`pursue`), `--cap <n>`, `--max-concurrency <n>` (`swarm`/`swarm-patch`). Job flags: `list` takes `--status <status>` and `--limit <1..100>`; `wait` takes `--timeout <dur>`; `result` takes `--json` and `--type <kind>`; `recover-swarm` takes `--apply`. Pass `--` before prompt text that starts with `-`.
