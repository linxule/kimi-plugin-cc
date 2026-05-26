# AGENTS.md

Project context for coding agents working in this repository.

## Quick reference

- **Version**: 1.0.0 (kimi-code, subprocess transport). v0.4.x is preserved at the `v0.4.0` tag (with a `v0.4-maintenance` branch cut from that tag, once published) for users still on kimi-cli.
- **Toolchain**: Node >= 22.5, TypeScript, **bun** (not npm/yarn)
- **Workflow**: edit `runtime/**/*.ts` → `bun run check` (build + typecheck + test + drift gate)

## Directory layout

```
.claude-plugin/     Plugin manifest (plugin.json, marketplace.json) — id stays as kimi/kimi-marketplace (no rename for v1); v0.4 users opt-in to v1 by updating the same install
commands/           Slash command markdown — thin wrappers over companion.sh
agents/             Claude Code subagent definitions (kimi-rescue, kimi-review, kimi-challenge, kimi-ask)
hooks/              Stop hook for the review gate (kimi-code-side PreToolUse hook lives at runtime/hooks/)
scripts/            Shell entry points (companion.sh, review-gate-hook.sh)
runtime/            TypeScript source — the real runtime
  ├── background-spawn.ts  Shared detached-worker spawn helper (rescue + ask)
  ├── cli-client.ts        Subprocess wrapper around `kimi -p --output-format stream-json`
  ├── stream-json.ts       Pure parser for kimi-code's NDJSON output
  ├── cli-cancellation.ts  AbortController-based cancellation for long-running commands
  ├── rescue-approval.ts   Workspace-bound allowlist (called by the PreToolUse hook)
  ├── commands/            One file per companion subcommand
  ├── hooks/               PreToolUse approval hook (entry script + policy + install verifier)
  └── schemas/             Structured output contract for review_gate (review/challenge dropped theirs in v0.2.3)
dist/               Compiled JS — committed for zero-build install
tests/              bun test suite
```

## Commands

- `bun run check` — rebuild `dist/`, typecheck, run full test suite, then drift gate (`git diff --exit-code -- dist`). If dist has unstaged changes, check fails — stage them and retry.
- `bun test <path>` — run a single test file
- `bun run build` — compile `runtime/**/*.ts` → `dist/**/*.js`

The companion runs via `scripts/companion.sh <subcommand>`, which resolves `node` and runs `dist/companion.js`. Subcommands: `setup`, `review`, `task`, `ask`, `status`, `result`, `cancel`, `replay`.

## Architecture

**Thin plugin, rich runtime** — mirrors [codex-plugin-cc](https://github.com/openai/codex-plugin-cc):

- Plugin layer (commands/, agents/, hooks/) handles routing only
- Runtime layer (runtime/, scripts/) owns subprocess lifecycle, SQLite job store, hook-side approval policy, and rendering
- Flow: `slash command → companion.sh → companion.js → kimi -p --output-format stream-json → job store → artifact`

**Key invariants:**

- Subprocess-first. One `kimi -p` process per job. Session id capture is **dual-source for kimi-code compatibility**: kimi-code 0.2.0+ emits a `role:"meta", type:"session.resume_hint"` record on stdout in stream-json mode (kimi-code PR #47, consumed in v1.0.0 GA) carrying a `session_<uuid>` token; kimi-code 0.1.x emitted a plain `To resume this session: kimi -r <uuid>` line on stderr. The cli-client consumes both channels — first-announce-wins, pinned, idempotent — and filters the meta record out of the consumer-facing records[] surface so commands iterating assistant/tool prose don't see it. The stderr regex anchors to line bounds and requires a full UUID payload (both bare and `session_<uuid>` alternations) so a malformed line can't pin a garbage id. 0.1.x users on text-output mode (or any future kimi version that re-introduces stderr emission with the new shape) keep working. Captured id round-trips verbatim via `kimi -r <token>` — we treat it as an opaque identifier whose shape may evolve again.
- Read-only commands (review, challenge, ask, review_gate) are enforced by the PreToolUse hook in `~/.kimi-code/config.toml` — `kimi -p`'s built-in auto-approve cannot be overridden via argv. `/kimi:setup` installs the managed block. Without it, rescue refuses to run.
- Hook verification is **strict-by-default and exact**: `verifyHookInstalled` always reconstructs the canonical shell command from env via `runtime/hooks/install-paths.ts::tryBuildExpectedHookCommand` and equality-checks against the installed `command = "..."` (after TOML decode). Substring match and opt-out paths were removed in the v1.0 pre-tag audit because both let crafted blocks (e.g. `command = "true # /path/to/approval-hook.js"`) bypass safety. The single source of truth for the command bytes lives in `install-paths.ts` and is consumed by setup-install, setup-check, the shell probe, and the verifier — drift between them is now a compile error.
- Rescue is the only write-capable command. Workspace allowlist (shell-quote parser, mutating-flag detector, symlink reject, path-realpath check) lives in `runtime/rescue-approval.ts` and is called by the hook via `evaluateRescueHookRequest`. Mutating-flag list includes `--fix`/`--write`/`--apply`/`--in-place`/`-i`/`-w` **and** the output-to-file class (`--output`/`--output-file`/`--output-directory`/`--output-dir`, exact + `=` prefix) so tools can't write outside the workspace via their own report-output mechanism (e.g. `git diff --output=`, `curl --output`, `eslint --output-file=`). The `-o` short form is rejected per-tool where its semantics are write-shape (currently: `eslint -o`).
- Rescue cannot mutate git state. The main Claude thread owns branch/commit.
- Jobs in SQLite are the source of truth. Terminal states are permanent.
- Review/challenge/ask/rescue are all prose pass-through (review/challenge dropped their JSON schemas in v0.2.3). Review gate is the only command that still parses Kimi output (JSON allow/block).
- Review gate is a Stop hook, disabled by default, fail-open on malformed output. When the gate skips (missing assistant message, unreadable transcript), `systemMessage` surfaces the reason.
- LLM-caller discipline (v0.3.6+): stderr is for humans only; anything load-bearing for an agent caller goes in stdout, exit codes, or persisted SQLite state. Parsers hard-fail on unknown flag-shaped tokens (INVALID_ARGS) instead of warn-and-swallowing — wrappers never see stderr warnings. `RuntimeError` carries an optional `details: Record<string, unknown>` for structured failure context.
- Default command stdout: review/challenge/ask/rescue emit raw prose; status emits raw job-row JSON; result emits raw artifact markdown. `result <jobId> --json` opts into a structured envelope (`{job_id, kind, status, summary, error, artifact_path, body, created_at, completed_at}`) for downstream automation.
- Cancellation uses AbortController + SIGTERM → SIGKILL (1500ms escalation) to ensure the kimi child **and its grandchildren** actually die when the user cancels or a budget expires. POSIX spawns with `detached: true` so kimi-code owns a process group, enumerates the descendant tree at abort time, signals `[child.pid, ...descendants]` individually, then also signals the negative pid (`process.kill(-child.pid, ...)`) as defense-in-depth. ESRCH/EPERM are best-effort skips per pid. Without descendant enumeration, kimi-code's Bash tool subprocesses that enter their own process groups survive cancel as orphans (denial-of-cancellation; for `/kimi:rescue` an approved long-running tool would keep consuming workspace state). win32 keeps the direct-kill path — descendant reaping on Windows is a known gap. Matches v0.4's wire-cancellation timing. Pre-listener abort race (signal aborted between the pre-spawn check and `addEventListener`) is recovered by re-checking `signal.aborted` after attach and invoking `onAbort()` synchronously — `{ once: true }` keeps it idempotent.
- Config writes preserve mode 0o600. `writeConfigAtomic` chmods the temp file before rename so the final inode never exists at a wider mode, matching the user's existing kimi-code config permissions (the file holds API keys + tokens).

## Post-GA roadmap

See [ROADMAP-TO-GA.md](./ROADMAP-TO-GA.md) for the full pre-GA history and v1.1 backlog. **v1.0.0 GA shipped 2026-05-26**, closing the kimi-code 0.2.0 stream-json session-meta gap (caught by alpha.4's loud-warning surface in production smoke), H6 (kimi-version probe at setup time), H2 (closed by upstream + plugin consumption), and H3 partial (forward-compat for unknown meta types). Remaining for v1.1: H1 (hook fail-open runtime drift), H3 partial (unknown top-level roles), H4 (Node version manager soft-recovery), H5 (per-spawn thinking control — upstream-blocked).

## When editing

- Read the code before changing it — the runtime has specific invariants that aren't obvious from file names
- Run `bun run check` before considering any change done
- `dist/` is committed intentionally (zero-build install). The drift gate catches forgotten rebuilds.
- Agent files register at session start. Adding or editing `agents/*.md` mid-session doesn't activate them until Claude Code reloads — reach for slash commands or direct `companion.sh` in the same session.
- `.claude/` is gitignored — notes, worktrees, internal docs under it stay local. Don't try to commit them.

## Releasing

Version bump touches 5 files — update all before tagging:

- `runtime/version.ts` (`KIMI_PLUGIN_CC_VERSION` — written into the managed-block marker comment by /kimi:setup)
- `package.json`
- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `AGENTS.md` (the "Version" line above)

Then `bun run check`, commit, `git tag -a vX.Y.Z -m "..."`, `git push` + `git push origin vX.Y.Z`, then `gh release create`.
