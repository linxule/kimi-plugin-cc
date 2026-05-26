# Changelog

## 1.0.0-alpha.4 — 2026-05-26

> **Roadmap update**: alpha.4 closes G1 + G3 + L2. G2 deferred to v1.1 as H4 (Node version manager soft-recovery). New H5 added (per-spawn thinking control via kimi-code CLI, pending upstream). See [ROADMAP-TO-GA.md](./ROADMAP-TO-GA.md).

### User directive

Thinking is enabled for all user-facing commands (ask, review, challenge, rescue). Previous diagnosis — that review hung at the 10-minute default budget — was a budget-sizing problem, not a flag problem.

### Changed

- **Budget constants raised for the thinking-on workflow.** `KIMI_ASK_PROMPT_TIMEOUT_MS` 300s → 900s; `KIMI_REVIEW_PROMPT_TIMEOUT_MS` 600s → 1800s; new `KIMI_RESCUE_PROMPT_TIMEOUT_MS = 1800s` (rescue no longer shares the ask budget — it runs multi-step apply/test/verify loops under thinking-on and needs the full headroom). `KIMI_REVIEW_GATE_TIMEOUT_MS` unchanged at 8s; comment now honest about what it assumes (user has `default_thinking = false` or a non-thinking-capable model selected, since kimi-code 0.1.1 has no per-spawn CLI thinking control).
- **`--thinking` / `--no-thinking` removed from every user-facing surface.** Stripped from `commands/{ask,challenge,review,rescue}.md` (argument-hint + flag bullets), from `agents/{kimi-review,kimi-challenge}.md` strict allowlists, from `runtime/parsing.ts` `SUPPORTED_FLAGS` strings and error templates, and from `runtime/kimi-errors.ts` nextStep hints. The parser now **hard-rejects** both flags with `INVALID_ARGS` (`THINKING_FLAG_REMOVED_MESSAGE`) — no escape hatch. Multi-agent Round 1-3 review surfaced and closed five contradicting references across docs, agents, and source.
- **`RESPONSE_TIMEOUT` nextStep hint qualified for review/challenge.** Previous hint suggested `--background` as a universal retry; review and challenge explicitly reject `--background`. Hint now qualifies it as ask/rescue-only.
- **Hook-missing warning surfaces the nvm/asdf remediation explicitly.** Users who switch Node versions hit a strict-equality verifier rejection by design. The warning now points at re-running `/kimi:setup` after every Node version switch and links to `docs/safety.md`.

### Added

- **`warnIfSessionIdMissing` helper in `runtime/commands/cli-helpers.ts`.** When kimi finishes a job but never announces a session id, a loud stderr warning fires so the user learns resume/replay won't work for that job. Wired into review/challenge/ask/rescue end-of-job paths. Full unit coverage in `tests/runtime/cli-helpers.test.ts`.
- **`CliClientOptions.thinking` (reserved field, currently no-op).** Round 2 Codex review caught that emitting `--no-thinking` in argv crashes kimi-code 0.1.1 (`allowUnknownOption(false)`). The field stays as an intent contract — review-gate sets `thinking: false` to declare its requirement — and `buildArgs` will translate when upstream lands a per-spawn CLI flag (see ROADMAP H5).
- **Negative test assertions to lock the v1.0 thinking-on contract.** ask, rescue, and review-gate argv assertions now verify `--no-thinking` is NOT emitted; parseRescueArgs has a dedicated rejection test alongside parseAskArgs and parseReviewArgs.

### Fixed

- **Empty-string sessionId no longer poisons the SQLite row.** All four sessionId-capturing commands (review/challenge, ask, rescue, review-gate) tightened from `result.sessionId !== undefined` to `result.sessionId.length > 0`. Kimi Round 1 finding #3.
- **Orphan JSDoc above `warnIfSessionIdMissing` moved back above `assertCliResultSuccess` where it belongs.** Both kimi-review and code-reviewer flagged this in Round 1.
- **Redundant `RESCUE_PROMPT_TIMEOUT_MS` local alias dropped.** rescue.ts now imports `KIMI_RESCUE_PROMPT_TIMEOUT_MS` directly.

### Process

- Multi-agent review across 3 rounds: kimi-review + code-reviewer (Claude opus) + kimi-challenge + codex-rescue. Round 2 surfaced 1 Critical (kimi-code rejects `--no-thinking`) and 2 High (agent files still advertised removed flags). Round 3 found 4 release-blockers (version bump, AGENTS gate text, missing warnIfSessionIdMissing tests, missing alpha.4 CHANGELOG entry) — all addressed in this tag.

### Documentation

- `ROADMAP-TO-GA.md` reflects alpha.4 reality: G1+G3+L2 closed, G2→H4, new H5 (kimi-code upstream thinking-flag negotiation). Ship-gate updated.
- `docs/safety.md` "Known limitation: Node version manager switches" section added.
- `AGENTS.md` GA gate sentence updated.

---

## 1.0.0-alpha.3 — 2026-05-25

> **Roadmap to GA:** see [ROADMAP-TO-GA.md](./ROADMAP-TO-GA.md). The deferred items from the three audit rounds + production smoke testing are triaged into GA blockers (4), high-priority post-GA (3), and polish backlog (3). GA gate ≈ 1 working day of focused work.

### Fixed

- **Cancellation: grandchild orphan (CRITICAL, production-observed).** kimi-code 0.1.1's internal `LocalKaos` spawns every Bash tool subprocess with `detached: true` deliberately — so kimi-code can group-kill its own tools during cancellation. This gives bash subprocesses their own PGID (sibling to kimi-code's PGID, not nested). The alpha.2 process-group fix (`process.kill(-kimi_pid, ...)`) therefore only killed kimi-code itself; the bash grandchildren survived as orphans. Reproduced in production smoke testing — `/kimi:cancel` left `bun test` running indefinitely after the cancel completed.

  **Fix:** On POSIX, enumerate the descendant tree once at abort time (BFS over `/proc/*/status` on Linux, `ps -axo pid=,ppid=` snapshot on macOS, `pgrep -P` recursive as fallback; depth bounded at 8, pid count bounded at 512). The snapshot is reused for both SIGTERM and the SIGKILL escalation 1500ms later — re-enumerating at SIGKILL would miss any grandchildren whose parent (kimi) died from SIGTERM and reparented them to launchd, since the PPID-walk roots at kimi-code's now-dead pid. After per-pid kill, each descendant ALSO gets a negative-pid (process-group) kill as defense-in-depth, because each bash subprocess is itself a session leader and may have its own children that our enumeration missed (e.g. just-spawned pipeline kids). Win32 is unchanged — descendant reaping on Windows is a known limitation, documented in `runtime/cli-client.ts`.

  **Regression coverage:** New `tests/helpers/process-group-grandchild.ts` spawns its sleep grandchild with `{ detached: true }` to mirror kimi-code's actual production shape. New test in `tests/runtime/cli-client.test.ts` parses the grandchild PID via stdout, aborts the parent, waits for the SIGKILL escalation window, then asserts ESRCH on the grandchild. Confirmed to fail on the alpha.2 process-group-only path. Replaced an older sh-based test that could pass via shell SIGHUP cleanup semantics rather than actual descendant signaling.

  **Why this is a real safety regression rather than UX polish:** under `/kimi:rescue` an approved long-running tool (e.g. `bun test`, `cargo check`) kept consuming model tokens, file descriptors, and CPU after the user thought the job was cancelled. For build/test commands the workspace impact is bounded by the rescue allowlist's read-only-shape constraints, but the denial-of-cancellation is unacceptable for a write-capable surface. Surfaced by `/kimi:challenge` Finding 4 during smoke testing (challenge mode literally predicted this exact gap) and confirmed empirically.

### Investigation notes

- kimi-code 0.1.1's `detached: true` is a deliberate design choice in its `LocalKaos.exec` abstraction, paired with kimi-code-side `process.kill(-pid, ...)` cancellation. The behavior is structural and unlikely to change in the 0.1.x line. There is no env var or flag to disable it (confirmed by binary-strings inspection and source-level grep of the bundled Node binary at `~/.kimi-code/bin/kimi`).
- Production smoke testing observed a three-level PGID chain: plugin (own PGID from our `detached: true`) → kimi-code (own PGID from kimi-code's spawn shape) → bash (own PGID from kimi-code's `LocalKaos.exec`). All three are siblings, not nested. This is the shape the alpha.3 fix now handles.



## 1.0.0-alpha.2 — 2026-05-25

### Highlights

Same alpha.1 functionality; the rollback of the marketplace/plugin rename is the only meaningful change. v0.4 installs can now update in place to v1 (`/plugin update kimi`), so long as kimi-code is installed locally first.

### Reverted

- **Marketplace and plugin rename.** alpha.1 shipped with the IDs renamed to `kimi-marketplace-v1` / `kimi-v1` as a defensive measure against v0.4 users auto-upgrading into a kimi-code dependency they didn't have. For a plugin at this scale the friction of forcing a fresh marketplace registration + reinstall is more cost than the auto-upgrade risk is worth, so alpha.2 restores the original `kimi-marketplace` / `kimi` ids. The kimi-code prerequisite is now communicated through README + migration docs rather than the install path itself.

### Migration from alpha.1

If you installed `kimi-v1@kimi-marketplace-v1` during the brief alpha.1 window:

```
/plugin uninstall kimi-v1
/plugin marketplace remove kimi-marketplace-v1
/plugin marketplace update linxule          # or: marketplace add linxule/kimi-plugin-cc
/plugin install kimi@kimi-marketplace
```

Then reload Claude Code and re-run `/kimi:setup` (the managed block is keyed by version marker — alpha.1 markers will be detected as stale and refreshed).

## 1.0.0-alpha.1 — 2026-05-25

### Highlights

Hard cut from the Python Kimi CLI Wire transport to the kimi-code Node.js subprocess transport. v0.4.x stays available at the [`v0.4.0`](https://github.com/linxule/kimi-plugin-cc/releases/tag/v0.4.0) tag (with a `v0.4-maintenance` branch cut from that tag for ongoing fixes — see the tag if the branch is not yet pushed). alpha.1 briefly renamed the marketplace and plugin ids to `kimi-marketplace-v1` / `kimi-v1`; alpha.2 reverted that. Read the alpha.2 entry above for the upgrade path.

The alpha shipped after **two multi-agent audit rounds**: a comprehensive cross-PR pass over the five-commit cutover and a focused re-review of the audit-fix diff. Convergent findings from Claude code-reviewer + Codex closed before tag — exact-command hook verification, abort-race recovery, 0o600 config-mode preservation, an `--output=*` rescue-allowlist gap, and a TOML-decode false-fail for apostrophe-in-path installs. See [docs/safety.md](./docs/safety.md) for the hardened safety story.

See [docs/migration.md](./docs/migration.md) for the step-by-step upgrade.

### Architecture changes

- **Transport.** Spawns `kimi --output-format stream-json -p "<prompt>"` as a one-process-per-job subprocess; parses OpenAI-shaped NDJSON records (assistant content + tool_calls). Replaces the v0.4 Wire JSON-RPC client. (PRs 1–3)
- **Safety enforcement.** kimi-code's `kimi -p` mode hard-codes `permission: auto`. v1.0 enforces the read-only contract for review/challenge/review_gate/ask, and the workspace-bound rescue allowlist, via a PreToolUse hook installed in `~/.kimi-code/config.toml`. `/kimi:rescue` REFUSES to run when the hook is missing.
- **Setup.** `/kimi:setup` rewrites the kimi-code config with a marker-delimited managed block (idempotent), runs a two-layer probe (in-process Node + `/bin/sh -c` shape that mirrors kimi-code's hook runner), and reports failure with actionable detail. `--check` and `--uninstall` subcommands added.
- **Session id semantics.** kimi-code mints the session id and announces it on stderr; the runtime captures it via regex. Resume passes the captured id via `-r <id>`. The `(repo_id, command_type, kimi_session_id)` SQLite unique index still guards concurrent resumes; concurrent fresh runs are now distinct (NULL session ids until kimi announces).
- **Replay.** Now reads the v1.0 cli-client NDJSON log format (`{event, record}` lines). v0.4 Wire JSON-RPC logs surface as `REPLAY_LOG_UNREADABLE`. ([PR 4](#))

### Per-command policy (PreToolUse hook)

| `KIMI_PLUGIN_CC_CMD` | Allowed tools | Denied tools |
|---|---|---|
| `ask`, `review`, `challenge`, `review_gate` | `Read`, `Grep`, `Glob`, `ReadMediaFile`, `TaskList`, `TaskOutput` | everything else |
| `rescue` | workspace-bound shell + edit allowlist (see [docs/safety.md](./docs/safety.md)) | every shell command, file edit, or write the allowlist rejects |
| unset / out-of-plugin | everything | nothing — kimi-code is being driven directly |

`/kimi:ask` is read-only in v1.0. v0.4 ran ask under Kimi CLI agent profiles that allowed write tools; the hook tightens this to match the documented "narrative answer, not implementation" contract.

### Marketplace + plugin id (reverted in alpha.2)

alpha.1 renamed the marketplace and plugin ids (`kimi-marketplace` → `kimi-marketplace-v1`, `kimi` → `kimi-v1`) so existing v0.4 installs couldn't auto-pull v1. **alpha.2 reverted that rename**; see the alpha.2 entry above. For posterity the original intent was: kimi-code is a hard dependency in v1, and the rename was a defensive forcing function for users to acknowledge the new prerequisite before upgrading. The revert traded that defense for a much smoother upgrade UX, with the kimi-code prerequisite communicated through README + migration docs instead.

### Removed

- `runtime/wire/` — Wire JSON-RPC client, turn capture, approval dispatcher, think-stall guard. Replaced by `runtime/cli-client.ts` + `runtime/stream-json.ts`.
- `runtime/kimi-launch.ts` — Wire-client launch helper. Subsumed by `runtime/cli-client.ts` + `runtime/kimi-command.ts`.
- `runtime/kimi-web-client.ts` — Kimi web PATCH endpoint for session titles. kimi-code's vis-server doesn't expose PATCH; the title feature is gone in v1.0.
- `runtime/cancellation.ts` — Wire-client SIGTERM/SIGKILL handler. Replaced by `runtime/cli-cancellation.ts` + cli-client's built-in escalation.
- `runtime/agents/*.yaml` — Kimi CLI agent profiles. kimi-code doesn't load user profiles; per-command safety lives in the PreToolUse hook now.
- `runtime/prompts/*-system.md` — System prompts that were attached via agent profiles. Inlined into command preambles where still needed.
- `tests/wire/`, `tests/helpers/mock-kimi-cli.ts` (v0.4), `tests/helpers/mock-wire-server.ts`, and the Wire-client / Kimi-launch / Kimi-web / cancellation test files.

### Added

- `runtime/cli-client.ts` — subprocess wrapper with AbortController cancellation, SIGTERM→SIGKILL escalation (1500ms, matching v0.4), rolling stderr tail, NDJSON diagnostic log, log-drain timeout, pre-aborted signal check.
- `runtime/stream-json.ts` — pure parser for kimi-code's `--output-format stream-json` records.
- `runtime/cli-cancellation.ts` — AbortController-based cancellation handler.
- `runtime/hooks/approval-policy.ts` — pure per-command decision function (the heart of the safety policy).
- `runtime/hooks/approval-hook.ts` — entry script (`dist/hooks/approval-hook.js`) installed in `~/.kimi-code/config.toml`.
- `runtime/hooks/managed-block.ts` — shared parser for the managed block; used by both the installer and the verifier so the two cannot disagree.
- `runtime/hooks/install.ts` — `verifyHookInstalled` + `maybeWarnHookMissing` helpers used by ask/review/challenge/review_gate (warn-once) and rescue (refuse).
- `runtime/kimi-command.ts` — `KIMI_PLUGIN_CC_KIMI_BIN` / `KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS` env-var resolver.
- `tests/runtime/setup.test.ts` — managed-block install / check / uninstall lifecycle, orphan detection, duplicate detection, CRLF preservation, TOML-safe path enforcement.
- `tests/helpers/mock-kimi-cli-v1.ts` — stream-json mock for the cli-client path.
- `tests/helpers/sigterm-trap.ts` — child process that traps SIGTERM so SIGKILL escalation paths can be exercised deterministically.
- `docs/migration.md`, `docs/safety.md`.

### Review-driven hardening

The five-PR cutover landed with paired Claude code-reviewer + Codex codex-rescue adversarial reviews on every PR. Convergent and divergent findings applied before commit:

- **PR 2 / hook script compiled but never installed** — added `verifyHookInstalled` + one-time stderr warning so the gap is loud.
- **PR 2 / withTimeout left the subprocess running after the budget expired** — added `runCliPromptWithBudget` that ties the timeout to an internal AbortController.
- **PR 3 / rescue running write-capable without the hook** — rescue now refuses with `RESCUE_HOOK_NOT_INSTALLED`.
- **PR 3 / SIGKILL escalation race** — added `processClosed` flag distinct from `settled` so a timer queued during log-drain can't fire a redundant SIGKILL.
- **PR 4 / ask=allow contradicted read-only docs** — ask now shares the read-only allowlist with review/challenge/review_gate.
- **PR 4 / verifier was a substring check** — shared the managed-block parser with the installer; both gates reject the same shapes (orphan, duplicate, missing event, missing command, matcher present).
- **PR 4 / bare `node` in the managed block could silently fail-open** — installer writes `process.execPath` (absolute Node path).
- **PR 4 / TOML escape in the command field** — switched from shell-single-quoting to TOML basic-string escaping; rejects paths with characters that cannot safely round-trip.
- **PR 4 / writeConfigAtomic race on a fixed temp file** — unique random tmp filenames.
- **PR 4 / stripAllMarkers destroyed user content after an orphan BEGIN** — only marker lines removed; surrounding content preserved.
- **PR 4 / locateMarkerBlock only inspected the first BEGIN/END pair** — duplicate-block detection with `SETUP_DUPLICATE_BLOCKS`.
- **PR 4 / CRLF line endings mixed on write** — line-ending detection threaded through install/uninstall/splice.

### Pre-tag audit hardening

Two further multi-agent rounds (Claude code-reviewer + Codex codex-rescue, plus plugin-validator and claude-code-guide for spec compliance) found these classes during the pre-tag audit. All closed before tag:

- **rescue.ts skipped the hook-path drift gate** — the optional `expectedHookPath` parameter let a stale managed block silently re-enable kimi-code's auto-approve. Verifier is now strict-by-default and always reconstructs the canonical command via the shared `runtime/hooks/install-paths.ts` module.
- **Verifier substring match → exact equality** — `commandPath.includes(expectedHookPath)` accepted `command = "true # /path/to/approval-hook.js"` (`/bin/sh -c` parsed `#` as a comment, hook exited 0 = ALLOW). Equality on the full canonical shell command closes the bypass.
- **`await mkdir` race in cli-client** — if abort fired during the mkdir yield, the listener attached after meant SIGTERM/SIGKILL was never sent. Re-checks `signal.aborted` after attach. Mirrors kimi-code's own runner pattern.
- **`writeConfigAtomic` umask** — temp file inherited umask before rename. Now chmods 0o600 before rename so the user's existing API-key/token file mode is preserved.
- **`--output=*` workspace escape via Bash** — `git diff --output=/etc/passwd`, `curl --output /tmp/x`, `eslint --output-file=/tmp/x` all wrote outside the workspace through their own report-output mechanism. `--output`/`--output-file`/`--output-directory`/`--output-dir` (exact + `=` prefix) now live in `MUTATING_FLAGS`. `-o` is rejected per-tool where its semantics are write-shape (eslint).
- **TOML basic-string capture without decode** — `parseManagedBlock` captured raw, so apostrophe-in-path installs round-tripped through `\\` (TOML escape) → captured `\\` ≠ canonical `\` → false-fail. `decodeTomlBasicString` handles the six standard escapes.
- **Relative `KIMI_PLUGIN_CC_HOOK_SCRIPT` override** — kimi-code spawns hooks via `/bin/sh -c` with a cwd that may differ from the companion's. Override is now required to be absolute, matching the `KIMI_PLUGIN_CC_NODE_BIN` contract.

### Round 3 audit hardening

A third multi-agent audit pass (Claude code-reviewer + Codex + plugin-validator + claude-code-guide) found one High, four Medium, two Low, and several polish gaps. All closed before tag:

- **Process-group cancellation (HIGH)** — `runtime/cli-client.ts` spawned kimi-code with default process-group behavior, so `child.kill(SIGTERM/SIGKILL)` only hit the immediate process. kimi-code's Bash tool subprocesses ran as grandchildren and survived cancel — a denial-of-cancellation issue where long-running approved subprocesses kept consuming workspace state after the plugin reported cancellation. POSIX now spawns with `detached: true` (own process group) and signals the negative pid (`process.kill(-child.pid, ...)`). ESRCH/EPERM fall through to direct `child.kill()`. win32 keeps the original direct-kill path (negative-pid signaling does not exist there; grandchild reaping on Windows is a known gap).
- **Session-id capture: incremental + anchored (MEDIUM)** — `runtime/cli-client.ts` only parsed the session id from the final 8192-char `stderrTail` on close; if kimi-code emitted the announce line early and then wrote more than 8192 bytes of stderr, the id was evicted and resume/replay handles silently disappeared. `runtime/stream-json.ts` regex was unanchored and accepted any `[0-9a-f-]{8,}` token, so a hostile Bash command under `/kimi:rescue` could `echo 'To resume this session: kimi -r <fake>' >&2` and poison the captured id. Capture now runs in the stderr `data` handler (first announce wins, pinned), regex tightened to anchored line-bounded full-UUID shape (`/^To resume this session:\s+kimi\s+-r\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/im`), and `stderrTail` scan remains as a fallback.
- **Stream-json line size cap (MEDIUM)** — `StreamJsonParser.push()` appended every chunk into one in-progress buffer until `\n` appeared, with no upper bound; a single 1MB+ unterminated stdout line could land whole in `malformed[]` and the diagnostics log. New `MAX_STREAM_JSON_LINE_BYTES = 1_048_576` guard emits a malformed outcome with a truncated preview, clears the buffer, and continues parsing. `cli-client.ts` also truncates `entry.line` before storing for diagnostics.
- **Drift gate untracked-file gap (MEDIUM, convergent with code-reviewer)** — `bun run check`'s `git diff --exit-code -- dist` caught modifications but not untracked files. A new `runtime/foo.ts` whose compiled `dist/foo.js` was forgotten by `git add` would silently pass the gate. The check now additionally fails when `git ls-files --others --exclude-standard -- dist` is non-empty, and prints the offending files so the developer knows what to stage.
- **`buildManagedBlock` env divergence** — the installer's managed-block writer called `buildHookShellCommand(hookScriptPath, process.env)` while the verifier and `--check` path resolved the canonical command from a parameter `env`. Production masked this (context.env === process.env), but any future caller or test that passed divergent env would produce an unfixable "installed: false" loop. `buildManagedBlock` now takes `env: NodeJS.ProcessEnv` and the install path threads `context.env` through — single source of truth for the canonical command bytes stays in `runtime/hooks/install-paths.ts`.
- **Agent color collision** — `kimi-review`, `kimi-challenge`, and `kimi-ask` all declared `color: cyan`, defeating Claude Code's per-agent UI hint. `kimi-challenge` moved to `yellow` (adversarial framing → warning color); the read-only narrative trio (`kimi-review`, `kimi-ask`) keep cyan and `kimi-rescue` keeps magenta as the only write-capable surface.
- **Missing `argument-hint` on lifecycle commands** — `replay`, `result`, `status`, `cancel` accepted positional or flag arguments but exposed no hint in the slash-command palette. Added hints matching the actual parsers (`<job-id>` for replay; `[<job-id>] [--type <kind>] [--json]` for result; `[<job-id>] [--type <kind>]` for status; `[<job-id>]` for cancel).
- **Explicit `commands` array in plugin manifest** — `.claude-plugin/plugin.json` relied on auto-discovery from `commands/*.md`. Adding an explicit `commands` array (belt-and-suspenders) prevents the README.md in that directory from being mistakenly registered as a slash command and documents the surface in the manifest itself.
- **Setup side-effect doc note** — `commands/setup.md` description didn't mention that `/kimi:setup` writes to `~/.kimi-code/config.toml` (outside the plugin's own files). Description now spells out the side effect.
- **Docs drift** — `docs/safety.md` said "once per Claude Code session" for the missing-hook warning latch, but the companion is a fresh Node process per slash-command invocation, so the latch is actually per-companion-invocation. Docs corrected. Same file's unknown-label policy row listed only `Read`, `Grep`, `Glob` while `runtime/hooks/approval-policy.ts::READ_ONLY_TOOLS` and the unknown-label branch actually allow six tools (adds `ReadMediaFile`, `TaskList`, `TaskOutput`). Docs widened to match the code — the broader set is intentional and consistent with the named labels.

### Test surface

358 tests across 28 files. Drift gate (`git diff --exit-code -- dist && test -z "$(git ls-files --others --exclude-standard -- dist)"`) runs as part of `bun run check` to catch forgotten rebuilds and untracked compiled artifacts before commit.

### Versions

Synced version `1.0.0-alpha.1` across:

- `runtime/version.ts` (`KIMI_PLUGIN_CC_VERSION` — written into the managed-block marker by `/kimi:setup`)
- `package.json`
- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `AGENTS.md`

## Older releases

See the [`v0.4.0` tag](https://github.com/linxule/kimi-plugin-cc/releases/tag/v0.4.0) (and the `v0.4-maintenance` branch cut from it, once published) for the v0.4.x line. Notable releases:

- **0.4.0** — Eliminated stderr-as-correctness; structured result envelope.
- **0.3.7** — Loud failures across review/challenge/ask/rescue.
- **0.3.6** — Hard-error unknown flags on review/challenge.
- **0.3.5** — ApprovalRouter; outputMode invariant; command registry.

For pre-1.0 commit-level history see `git log v0.4.0..` on the v0.4-maintenance branch.
