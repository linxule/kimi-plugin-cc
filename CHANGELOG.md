# Changelog

Release notes for notable plugin changes. Published tags and GitHub Releases never change.

## 3.1.3 — 2026-11-27

Certifies exact kimi-code `2.8.1` for all 7 model operations and fixes two candidate-smoke harness gaps exposed by the 2026-11-27 patch monitor run. Certification evidence: [docs/upstream-2.8.1-certification.md](./docs/upstream-2.8.1-certification.md).

### Added

- Exact `@moonshot-ai/kimi-code@2.8.1` (commit `62402f173c5a838a1c1f8fa263b637a22486fa39`, scope `"all"`) added to `runtime/kimi-releases.ts` and `tests/audit/v2-tag-scan.test.ts` (re-pinning `toolSelectService.ts`; 170 of 171 pinned files unchanged from `2.8.0`). Unlisted plain `2.y.z` releases strictly above `2.8.1` now borrow `local-environment` mechanics from `2.8.1`, and `setup --install-kimi` now installs `2.8.1`. Because `dist/hooks/approval-hook.js` bundles `kimi-releases.ts`, its SHA-256 changes cleanly on `3.1.3`; upgrading hosts run `setup` once (or auto-repin when `retryable_after_setup: true`).

### Fixed

- `registerSmokeCandidateReleaseForTests` in `runtime/kimi-releases.ts` and `kimiCertifiedReleaseHas` in `runtime/swarm-activation.ts` wire `KIMI_PLUGIN_CC_SMOKE_V2_CANDIDATE` across swarm preactivation and bounded-swarm policy inside the smoke harness without altering production version tables.
- The `[ask] every experimental feature switched on` smoke prompt now instructs Kimi that the installed `PreToolUse` hook owns enforcement so `Write` executes and records a managed denial; `createScopeFixture` allocates scope fixtures in `os.tmpdir()` rather than gitignored `runtime/dev-data/tests/` so ripgrep inside `Grep` sees fixture files without needing `include_ignored`; and `escapePrompt` passes that instruction inside the child `prompt_template` with failure diagnostics in `assertSwarmChildEvidence`.

## 3.1.2 — 2026-11-27

Fixes a swarm run that failed when its Kimi process exited before the plugin read its process identity. Certified Kimi Code versions and hook policy are unchanged.

### Fixed

- A swarm or write swarm no longer fails with `CLI_PROCESS_SETTLEMENT_FAILED` ("The print root identity was not durably recorded before its process snapshot") when the Kimi process has already exited by the time its identity is read, or when that read times out. Before this fix the run stalled for about 2 seconds, lost a clean result, reported a settlement error where the process had failed at startup, and left a recovery record behind. On macOS and Linux, such a launch now settles once 4 things hold: the plugin's own child handle has reported the exit, the plugin has seen the process's output pipes close, no process the plugin had seen is still alive, and the operating system reports no process left in the process's own process group. The job keeps the process's own result or startup error.
- Each of those checks is refused and retried until all 4 hold. The teardown deadline bounds the retries; if the checks never all hold, settlement fails as before and a write swarm captures no patch. This covers a helper that survives in the process group and a helper that keeps the output pipes open.
- A cancelled or timed-out write swarm of this kind can now capture its partial patch, as one with an identified process already could.
- `recover-swarm --apply` finishes a launch of this kind that settled but was interrupted before its exit was recorded. It signals nothing and still refuses one that never settled.

### Changed

- A settled launch of this kind is recorded with `rootUnidentified: true` and no identities in `swarm_recovery`. Plugin 3.1.0 and 3.1.1 read these records in status, result and the recovery preview. Their `recover-swarm --apply` refuses one that was interrupted before its exit was recorded; 3.1.2 finishes it.

## 3.1.1 — 2026-11-26

Fixes what a host reports when a leftover `KIMI_PLUGIN_CC_DATA` override points it away from the shared hook. Certified Kimi Code versions and hook policy are unchanged.

### Fixed

- A host that has `KIMI_PLUGIN_CC_DATA` set while the shared block points at the default hook now names the override as the cause. This happens when a 3.0 per-host value is left behind, for example in the `env` block of `~/.claude/settings.json`. `setup --check`, the launch warning and the refusal tell you to unset the variable and restart the host. They no longer tell you to re-pin, which would point the one shared block at a single host's directory. The refusal carries `retryable_after_setup: false`, so agents do not run setup and retry. Verification is unchanged and still fails closed.
- The ordinary hook-path drift message no longer says the install path is version-stamped.

### Changed

- `docs/migration.md` now starts with removing any `KIMI_PLUGIN_CC_DATA` override before you upgrade.
- `docs/upstream-2.8.0-certification.md` separates the gates run before the 3.1.0 host collapse from the gates run on the published 3.1.0 tree and on this release.

## 3.1.0 — 2026-11-26

Certifies exact kimi-code `2.8.0` for all 7 model operations under a new rolling `>= 2.8.0` compatibility window, collapses all host interfaces onto 4 MCP tools plus `SEP-2640` skill discovery and 5 primary CLI subcommands, unifies all hosts on one canonical shared data directory and one bundled PreToolUse hook, and adds universal packaging across Claude Code, Codex, Antigravity, DeepSeek Harness, and Magpie. Certification evidence: [docs/upstream-2.8.0-certification.md](./docs/upstream-2.8.0-certification.md). Upgrade steps: [docs/migration.md](./docs/migration.md#upgrading-from-30-to-31).

### Breaking

- Rolling compatibility floor raised to Kimi Code `>= 2.8.0`: exact `2.8.0` is certified for all 7 operations (`ask`, `review`, `challenge`, `rescue`, `pursue`, `swarm`, `swarm-write`); unlisted plain `2.y.z` releases strictly above `2.8.0` run read-only operations (`ask`, `review`, `challenge`) with a warning and borrow only `--environment local`. Releases below `2.8.0` and the `legacy-v1` engine (`0.1` to `0.41`) are removed and refuse before spawn (`KIMI_CAPABILITY_NOT_CERTIFIED`); historical `legacy-v1` SQLite rows remain readable only.
- Collapsed the MCP surface from 9 tools to 4: `kimi_read` (`mode`: `ask|review|challenge|swarm`), `kimi_write` (`mode`: `rescue|pursue|swarm_patch`), `kimi_job` (`action`: `list|status|result|wait|cancel|replay|recover_swarm`), and `kimi_setup` (`action`: `check|models|install|install_kimi|repair_sessions`). Standard `tools/call` calls on `kimi_read` and `kimi_write` default to `wait: true` with a 50-second default `wait_timeout_ms` (up to `86_400_000` ms; client disconnect or cancellation stops polling without cancelling the durable job); `wait: false` always returns the launch handle even if already terminal.
- Removed Claude Code slash commands (`commands/*.md`), subagent definitions (`agents/*.md`), and the optional review-gate Stop hook (`hooks/hooks.json`, `scripts/review-gate-hook.sh`, `review_gate`, `setup --enable-review-gate`, and `setup --disable-review-gate`).
- Replaced the 9 shell-backed Codex skills with one progressive-disclosure `kimi` skill (`skills/kimi/SKILL.md` and `skills/kimi/agents/openai.yaml`).
- Removed the custom DeepSeek Harness companion runtime (`runtime/dsh/`, `plugins/kimi-dsh/`). DSH now loads root `cordis.patch.yml` directly via DSH's built-in `@deepseek-ai/dsh-mcp-client` and `@deepseek-ai/dsh-skill-filesystem`.
- Unified all hosts onto one canonical shared data directory (`~/.local/share/kimi-plugin-cc` or `$XDG_DATA_HOME/kimi-plugin-cc` on macOS/Linux; `%LOCALAPPDATA%\kimi-plugin-cc` on Windows; override via `KIMI_PLUGIN_CC_DATA`), with mode `0700` plugin-owned directories and mode `0600` stream logs on POSIX, removing per-host `CLAUDE_PLUGIN_DATA`, `PLUGIN_DATA`, and `$DSH_HOME/plugin-data/kimi-plugin-cc` resolution. No automatic migration of older 3.0 per-host stores is performed.
- Replaced per-host `:<host-id>` managed hook blocks and `setup --uninstall --all` with one self-contained bundled ESM hook (`<pluginRoot>/hook/approval-hook.js`, symlink-checked, staged and probed before activation by `setup`, and SHA-256-verified against bundled `dist/hooks/approval-hook.js` during `verifyHookInstalled` and `setup --check`) and one canonical `# === BEGIN kimi-plugin-cc-managed (v3.1.0) ===` block in `~/.kimi-code/config.toml`. Running `setup` automatically consolidates legacy `:<host-id>` blocks; `setup --uninstall` normalizes inline hooks and removes all managed blocks and strictly owned bare hook tables.

### Added

- Full `SEP-2640` MCP skill and resource discovery: `skills/list`, `skills/get` (returning `frontmatter` and `resources` SHA-256 digests and sizes for `SKILL.md` and `agents/openai.yaml`), `resources/list`, and `resources/read` (with `ttlMs: 0` and `cacheScope: "private"` on `2026-07-28`), advertised on both modern `2026-07-28` (`extensions["io.modelcontextprotocol/skills"]`) and legacy `initialize` (`experimental.skills`).
- 5 primary CLI subcommands on `scripts/companion.sh` (and executable `kimi-companion` bin): `read`, `write`, `job`, `setup`, and `mcp` (older subcommand spellings stay wired as compatibility aliases; `routeSurfaceAliases` reads `--mode` from leading flags only, rejects leading `--write` on `read`, and treats negative numbers as positional prompt text).
- Strict canonical workspace containment and scoped stale-job sweeps in `kimi_job`, bound-task enforcement on `tasks/cancel`, and persisted process identities for MCP cancellation of CLI-launched jobs.
- Universal root packaging for 5 hosts: Claude Code (`.claude-plugin/`, `.mcp.json`, `skills/kimi/`), Codex (`.agents/`, generated `plugins/kimi-codex/`), Antigravity (root `plugin.json`, `mcp_config.json`, `assets/logo.svg`, `skills/kimi/`), DeepSeek Harness (root `cordis.patch.yml`, `dsh/index.json`), and Magpie (local stdio MCP pointing at `scripts/companion.sh mcp`).
- `--reference-session <job-id|session-id>` (repeatable, at most 8) on `ask`, `rescue`, `review`, `challenge`, `swarm`, and `swarm-write`, and MCP `referenced_sessions` on `kimi_read` and `kimi_write` (rejected on `pursue`). Resolves each id to its session's main-agent log without reading journal content and appends upstream's exact `<referenced_sessions>` block. Refuses unknown, ambiguous, self-resumed, or unsafe IDs with `INVALID_ARGS` before any job row. Scoped calls (`--read-root` or `--network`) add each referenced session's `agents/main` directory to read roots. Never included in summaries, titles, or session previews.
- Resumed sessions whose main journal leaves the main agent in tower mode refuse with `KIMI_SESSION_TOWER_ACTIVE`. Restoring such a session lets kimi-code adopt workspace `.tower` state outside the hook; turn tower mode off with `/tower` or start a fresh session.

### Changed

- On an uncertified native-v2 release (`> 2.8.0`), enabled experimental selectors (`[experimental]` config keys and `KIMI_CODE_EXPERIMENTAL_*` environment variables, including the master flag) warn instead of refusing while the child still starts with `KIMI_CODE_EXPERIMENTAL_TOWER=0` and `KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK=0` and without `KIMI_CODE_EXPERIMENTAL_FLAG`. `CLI_V2_EXPERIMENTAL_UNSAFE` and `CLI_V2_HOOK_ORDER_UNSAFE` remain for plan-less launches. Certified releases neutralize them silently.
- The hook-escape monitor (`runtime/hook-escape.ts`) accepts only the exact denial reason or the reason followed by upstream repeat-breaker `<system-reminder>` blocks; the pre-2.6.0 handoff-veto exception (`emitsHandoffVeto`) is removed with releases below `2.8.0`.
- The setup notice about enabled kimi-code plugins states that read-only operations deny every tool outside the hook's read-only allowlist.
- At kimi-code `2.8.0`, a Write to the plan file reaches the managed hook ahead of the plan guard and zero production code calls `event.allow()`. All four no-plan closures remain active as defense in depth.
- The managed hook allows Kimi's `WaitFor` tool under every label so `pursue` and background test runs do not waste turns on denials.

### Fixed

- With `default_plan_mode = true` and an MCP server configured, kimi-code `2.8.0` can journal `mcp.tools_discovered` between the create-time `plan_mode.enter` and print's `plan_mode.cancel`. The resume scan now accepts Kimi's 3 durable MCP bookkeeping records (`mcp.tools_discovered`, `mcp.server_failed`, `mcp.server_failure_resolved`) between them; any other record or unparseable line still taints.
- The real-binary smoke skips its `WebSearch` lane by name when the seed home has no Kimi login or search configuration.

## 3.0.0 — 2026-11-26

The plugin makes promises about the sessions it launches and no longer polices the user's own Kimi configuration. Certified kimi-code versions are unchanged: exact 0.42.0 through 2.7.3 as listed in `runtime/kimi-releases.ts`, with 2.7.3 the newest and 2.6.0 still non-swarm-only.

### Security

GPT Astra and Kimi found the first round of these issues in an adversarial review before release. GPT Astra then reviewed the fix diff and found a second round: the `.git` aliases, the backslash workspace and the command size below, the FetchURL blocks and the `mv`/`cp` operand rules under Added, and the hook timeout value.

- In 2.7.3 and earlier, a rescue, pursue or write-swarm job could write outside the workspace when a Write or Edit path began with `~/` or used backslashes, because the hook resolved the path differently from kimi-code. This was reproduced against real kimi-code with the released plugin: a rescue job wrote a file in the home directory. Write/Edit/MultiEdit paths (`path` and `file_path`) and `Bash.cwd` now refuse any backslash, NUL, leading `~`, drive-letter prefix or URL scheme. On POSIX, rescue, pursue and write-swarm also refuse to launch with `CLI_TRUSTED_WORKSPACE_ROOT_INVALID` when the run directory or trusted root, or its realpath, contains a backslash, and the hook denies every tool for such a root.
- In 2.7.3 and earlier, on a case-insensitive filesystem a native write could reach a `.git` pointer file (a linked worktree or submodule; the write-swarm worktree is one) through a case alias such as `.GIT`. Native write targets and `Bash.cwd` now refuse `.git` in any letter case or with trailing dots or spaces, at any path component, comparing an existing target under its realpath.
- In 2.7.3 and earlier, a long enough rescue command could run unchecked. Brace-expansion detection was quadratic: a 256 KiB command took about 52 s to check (measured), the plugin installs its hook with a 15 s timeout, and kimi-code treats a timeout as allow. Rescue Bash commands longer than 16,384 characters are now refused before evaluation; the measured worst case at that length is about 0.2 s.
- In 2.7.3 and earlier, a hook entry with a hand-edited short `timeout`, such as `timeout = 1`, verified as installed and enforcing, although kimi-code reads a hook that runs past its timeout as allow. A kimi-plugin-cc hook entry counts as installed only if kimi-code waits at least 15 seconds for it (a missing `timeout` means kimi-code's 30-second default), because kimi-code treats a hook that times out as allowing the call; every copy of the command must meet this, since kimi-code runs only the first one. `setup --check` fails on a short entry, and `setup` rewrites its own block or refuses with `SETUP_INVALID_HOOKS_CONFIG` for a copy it cannot prune.
- Write/Edit/MultiEdit now refuse an existing regular file with more than one hard link. Writing it in place also changed every other name for the file, which could lie outside the workspace.
- kimi-code reads a hook that times out, crashes or cannot be spawned as allow. For a labelled call the hook now denies if it has not decided within 10 s, below the 15 s installed timeout; out-of-plugin calls are unchanged.
- Swarm activation and deactivation read the main-agent journal with the same framing as kimi-code's replay, and a corrupt line makes the swarm state unreadable, so no later record can confirm activation or deactivation. Before, a record after a whitespace-only or other corrupt line could confirm deactivation that kimi-code's replay never reached.
- A malformed `~/.kimi-code/config.toml` could make the TOML parser's error message, which quotes neighbouring source lines, reach `setup --check` stdout and job stderr; those lines could include an API key. Errors now report only `syntax error at line N, column M`. The leak was present in 2.7.3 and earlier.

### Breaking

- Claude Code slash commands `/kimi:ask`, `/kimi:rescue` and `/kimi:challenge` and agents `kimi-ask`, `kimi-rescue`, `kimi-challenge` and `kimi-swarm-write` are removed. `/kimi:task` and agent `kimi-task` replace ask (read-only by default) and rescue (a leading `--write`). `/kimi:review --challenge` and agent `kimi-review` with a leading `--challenge` replace challenge. Agent `kimi-swarm` with a leading `--write` replaces `kimi-swarm-write`. `/kimi:pursue`, `/kimi:swarm`, `/kimi:setup`, `/kimi:status`, `/kimi:result`, `/kimi:cancel` and `/kimi:replay` are unchanged.
- MCP tool `kimi_challenge` is removed; call `kimi_review` with `mode: "challenge"`. The server lists six model tools and three job tools.
- Codex skills go from twelve to nine: `kimi-ask`, `kimi-rescue`, `kimi-challenge` and `kimi-swarm-write` are removed and `kimi-task` is added. `kimi-task` is not implicitly invocable, so Codex no longer starts the read-only question skill on its own.
- A configured `default_plan_mode`, `[environments] default`, `require_trust = false` or enabled tower/subagent-fork selector no longer refuses certified launches where the plugin can neutralize it. Plan mode, the environment default and the selectors are neutralized silently; disabled trust and job-time marker problems appear in `warnings`.
- The native-v2 session preview now shows the run's raw request instead of the plugin's prefixed prompt, and replaces a differing preview after every settled run.

### Added

- Read-only operations run on an unlisted plain 2.x kimi-code release newer than 2.0.0 with the warning `kimi-code <version> is not certified by this plugin release; running <operation> read-only with <row> mechanics.` `rescue`, `pursue`, `swarm` and `swarm --write` still refuse with `KIMI_CAPABILITY_NOT_CERTIFIED`. `KIMI_PLUGIN_CC_STRICT_VERSIONS=1` restores exact-version refusal for every operation; the Codex MCP config forwards it.
- `setup --install-kimi [--json]` installs the highest certified kimi-code into `<data root>/kimi-plugin-cc/kimi-bin/<version>/` and points `kimi-bin/current` at it. It executes a candidate binary only after it resolves to an executable regular file inside the expected version or staging directory. Jobs use `KIMI_PLUGIN_CC_KIMI_BIN`, then that binary, then `kimi` on PATH. `setup` and `setup --check` print a `Kimi binary:` line. New error codes: `KIMI_INSTALL_FAILED`, `KIMI_INSTALL_VERIFY_FAILED`, `KIMI_INSTALL_UNSUPPORTED_PLATFORM`.
- A launch warnings channel: the nullable `warnings` job column, a `Warnings:` block at the top of stdout and the artifact, and a `warnings` key in `status`, `result --json` and MCP results. Output without warnings is unchanged.
- `--read-root <absolute-directory>` (repeatable) and `--network` on `ask`, `review`, `challenge` and read-only `swarm`, and the matching `read_roots` and `network` arguments on MCP `kimi_ask`, `kimi_review` and `kimi_swarm`. `--read-root` confines `Read`, `Grep`, `Glob` and `ReadMediaFile` to the workspace and the named roots. `--network` allows `WebSearch` and `FetchURL` to public hosts and confines reads the same way. Scope is stored in the nullable `read_scope` job column and is not inherited by a resumed or follow-up job. Under confinement a path or glob pattern with a backslash or a leading drive letter is denied; a `--read-root` containing a backslash refuses with `INVALID_ARGS`, and a scoped spawn whose workspace contains one refuses with `READ_SCOPE_INVALID`. `FetchURL` IP literals must be global unicast; `192.88.99.0/24` and `3fff::/20` are denied too. A networked resume requires every earlier turn's effective roots (its workspace plus its read roots) to lie inside the current call's. New error code: `READ_SCOPE_INVALID`.
- Rescue, pursue and write-swarm may run `rm`, `mv`, `cp` and `mkdir` on absolute paths inside the workspace, with exact flags, symlink-resolved containment and no `.git` targets. Flags are accepted only before the first operand; any later token, `--` included, is an operand. `rm -r` operands, directory `mv` sources and `cp -R` sources must contain no `.git` entry at any depth; the scan stays on the operand's filesystem, inspects at most 20,000 entries and runs at most 3 s, and reaching any limit refuses. `cp` refuses an existing destination file with more than one hard link; `mv` and `rm` are unaffected. Every `mv`/`cp` source must exist, no source may lie under or equal another source's landing path, no destination may lie inside a source, and a command holds at most one `rm`, `mv`, `cp` or `mkdir`, so `mkdir -p d && cp a d/` must be two commands. A relative operand is denied with `Rescue requires absolute paths for <cmd>; use paths under <root>: <command>`.
- The MCP `initialize` and `server/discover` results carry an `instructions` string: prefer these tools for detached or long-running work, which tools write, that jobs survive a disconnect, and that warnings should be relayed.
- DSH `/kimi-setup` accepts `--install-kimi [--json]`.

### Changed

- On exact 2.4.0 through 2.7.3, a configured `default_plan_mode` no longer refuses non-swarm launches, fresh or resumed, because print mode cancels the create-time plan entry before any turn. The resume scan frames each wire journal exactly as kimi-code's replay does (LF-delimited, one trailing CR stripped, only empty lines skipped), and after the first corrupt line no later record can fold a cancelled create-time plan enter. Swarm launches at any concurrency, older versions and uncertified releases still refuse.
- Every child runs with `KIMI_CODE_EXPERIMENTAL_TOWER=0` and `KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK=0`, and native-v2 children no longer receive `KIMI_CODE_EXPERIMENTAL_FLAG`. Enabled selectors no longer refuse certified releases.
- On exact 2.5.0 through 2.7.3, a configured `[environments] default` no longer refuses a fresh or resumed non-swarm launch: a fresh print passes `--environment local`, and a resume applies the session's stored binding, which must still be local and inside the trusted root (`KIMI_SESSION_ENVIRONMENT_UNSAFE`). Swarm launches, and any launch without a certified release row, still refuse.
- `[workspace] require_trust = false` produces a warning instead of a refusal. A non-boolean value still refuses.
- The runtime chooses the operation: `ask` with a leading `--write` runs rescue and `review` with a leading `--challenge` runs challenge (`runtime/surface-routing.ts`). Only flags before the first prompt word count, and MCP prompts always follow `--`. The companion spellings `task rescue`, `task challenge` and `task swarm --write` still work. DSH keeps its seven providers, including `kimi_challenge` and `kimi_swarm_write`.
- Each job launch and each setup warns about every other host's kimi-plugin-cc hook that is older than this plugin (prereleases and unreadable versions count as older), because its rules still apply. Every installed hook checks every labelled job, and any deny wins.
- The plan-time hook check refuses a definite missing or invalid hook with the operation's command-gate error before any job row exists; an unverifiable check still proceeds, and `KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1` bypasses it as at the gates. Rescue, pursue and swarm hook refusals are therefore thrown before a job row is created; a row-persisted refusal remains only if the hook disappears after the plan. A job also checks the configured hooks against the release its execution plan probed, using that probe, and refuses with the new code `KIMI_HOOK_SET_INVALID` when kimi-code would drop the hooks array.
- At job time, duplicate or orphaned managed hook markers produce a warning instead of a refusal when the real TOML parser proves a clean, byte-exact managed entry. `setup` and `setup --check` still fail on them.
- `repair-sessions` replaces a preview that is blank or one of the session's own verified plugin prompts, and reports `would-replace-preview` or `preview-replaced`.
- Release facts live in one table, `runtime/kimi-releases.ts`. Background ask and rescue no longer set `KIMI_PLUGIN_CC_ASK_REUSED_SESSION` or `KIMI_PLUGIN_CC_RESCUE_REUSED_SESSION`. The `setup --check` direct probe uses the Node path parsed from the installed hook command. `classifySetupFailure` no longer returns `runtimeProbe` or `authProbe`, and the `CODEX_SKILLS[].displayName` field and the `TimeoutKind` export are removed.

### Fixed

- On Linux, a swarm could fail to start or stop with "The Kimi web process tree did not become quiescent after shutdown" although nothing was left running. One incomplete process snapshot, such as one taken while the web process was exiting, made the whole teardown unverifiable. An incomplete snapshot or group scan is now read again before it counts; a process table that stays unreadable still fails. The error now says which check failed. The affected code is unchanged since 2.7.x.
- `grep -i` and `git --no-pager <read-only subcommand>` are allowed under rescue; both were wrongly rejected.
- An MCP job that finished between the server's job read and its process-identity probe now attaches normally instead of failing with `MCP_PROCESS_IDENTITY_MISMATCH`.

### Known limitations

- Reads stay unconfined unless the caller passes `--read-root` or `--network`.
- The `FetchURL` host check sees only the URL as written, not DNS resolution or HTTP redirects. `--read-root /` removes read confinement.
- Another host's older hook still checks every plugin job by its own rules until that host updates and runs setup, and can deny what this version allows; each job launch and setup carries a warning that names the host and its hook version.
- The read scope limits Kimi's tool reads only. A review's status summary and diff cover the whole repository, even when the review starts in a subdirectory, and reach the model whatever the roots are. So do Kimi's own instruction files: `~/.kimi-code/AGENTS.md`, `~/.agents/AGENTS.md`, and `AGENTS.md` or `.kimi-code/AGENTS.md` in each directory from the Git root down to the working directory. Untracked files are not embedded; Kimi reads them with tools, so any outside the roots are denied.
- A hard link inside a read root counts as inside the root, even when another name for the same file lies outside it.
- The networked-resume check sees only the turns this host's plugin job store recorded for the session; a turn added to the same session directly in Kimi, or through another host's plugin install, is invisible to it, so its reads can be carried into a `--network` turn.
- Review status: the maintainer's agent read the second-round fixes, and failing-first tests cover them, but they have not been through a third outside review.
- A Desktop turn that finishes after a plugin run and before its preview sync has its preview overwritten.
- The review gate's `systemMessage` does not carry warnings, and `recover-swarm` still writes its notices to stderr.
- `go test -exec=<bin>` and `--exec` are still approved under rescue while `-exec <bin>` is rejected; `rg -i`, `rg -w` and `grep -w` are still rejected.

## Earlier releases

For release notes prior to `3.0.0`, see [GitHub Releases](https://github.com/linxule/kimi-plugin-cc/releases) and the archived [`v3.0.0` changelog](https://github.com/linxule/kimi-plugin-cc/blob/v3.0.0/CHANGELOG.md).
