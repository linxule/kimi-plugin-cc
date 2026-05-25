# Changelog

## 1.0.0-alpha.1 — 2026-05-25

### Highlights

Hard cut from the Python Kimi CLI Wire transport to the kimi-code Node.js subprocess transport. v0.4.x stays available at the [`v0.4.0`](https://github.com/linxule/kimi-plugin-cc/releases/tag/v0.4.0) tag (with a `v0.4-maintenance` branch cut from that tag for ongoing fixes — see the tag if the branch is not yet pushed). v1.0 is an explicit opt-in upgrade — the marketplace and plugin id changed (`kimi-marketplace-v1` / `kimi-v1`) so existing installs do not auto-pull v1.

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

### Renamed marketplace + plugin id

- `kimi-marketplace` → `kimi-marketplace-v1`
- `kimi` → `kimi-v1`

Existing v0.4 installs continue working unchanged. Upgrade is explicit; see [docs/migration.md](./docs/migration.md) for the full step-by-step procedure (uninstall the v0.4 plugin + marketplace, install the v1 plugin from the renamed marketplace, run `/kimi:setup` to install the PreToolUse hook — `/kimi:setup` is load-bearing for safety, not optional).

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

### Test surface

342 tests across 28 files. Drift gate (`git diff --exit-code -- dist`) runs as part of `bun run check` to catch forgotten rebuilds before commit.

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
