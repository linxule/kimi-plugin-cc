# Safety

This guide explains how kimi-plugin-cc 3.1.1 constrains every Kimi session it starts. Read-only operations deny file writes and shell commands. Rescue and pursue edit files only inside your workspace and never mutate Git. Write-swarm (`swarm_patch`) edits inside a temporary Git worktree and returns an unapplied patch.

The plugin makes promises about the sessions it launches. It does not police your own interactive Kimi configuration. One mechanism enforces every promise: a single bundled PreToolUse hook that denies every tool call outside the running operation's allowlist. Plan mode stays closed across every release as defense in depth even though Kimi Code 2.8.0 runs the hook before the plan guard. Where a Kimi setting would break a promise, the plugin neutralizes it for its own children or refuses before spawn; where it would not, the plugin runs and surfaces a launch warning.

Plugin 3.1.0 uses a rolling compatibility window with floor `>= 2.8.0`. The [runtime release table](../runtime/kimi-releases.ts) is the single authority: exact Kimi Code `2.8.0` is certified for all 7 model operations ([2.8.0 certification record](upstream-2.8.0-certification.md)), unlisted plain `2.y.z` releases strictly above `2.8.0` run read-only operations (`ask`, `review`, `challenge`) with a warning, and releases below `2.8.0` (including `legacy-v1`) refuse before spawn. The hook is not an operating-system sandbox.

## Why enforcement is hook-based

Kimi Code's `kimi -p` mode hard-codes `permission: "auto"` and approves every tool call automatically. There is no command-line flag to turn this off because `-p` is a non-interactive batch mode. That works for a standalone CLI run, but it breaks read-only reviews and bounded fixes launched from another assistant.

The plugin therefore publishes a self-contained ESM hook to `<pluginRoot>/hook/approval-hook.js` (default `~/.local/share/kimi-plugin-cc/hook/approval-hook.js`) and installs one canonical `PreToolUse` entry in `~/.kimi-code/config.toml`. On every spawn, the runtime sets `KIMI_PLUGIN_CC_CMD` on the child process so the hook applies that operation's policy. Out-of-plugin `kimi` runs leave `KIMI_PLUGIN_CC_CMD` unset and stay unrestricted.

```
┌───────────────────────────┐   KIMI_PLUGIN_CC_CMD=review   ┌──────────────────────┐
│ kimi_read / companion.sh  │ ────────────────────────────► │ kimi -p              │
│   (MCP or CLI)            │                               │   (permission: auto) │
└───────────────────────────┘                               └──────────┬───────────┘
                                                                       │
                                                                       │ PreToolUse:
                                                                       │   Bash
                                                                       ▼
                                                            ┌──────────────────────┐
                                                            │ approval-hook.js     │
                                                            │   reads env var,     │
                                                            │   applies policy,    │
                                                            │   exits 2 + stderr   │
                                                            │   (deny)             │
                                                            └──────────────────────┘
```

If the hook is missing, drifted, or invalid, every model-spawning operation fails closed before Kimi starts. `kimi_setup({ action: "install" })` and `scripts/companion.sh setup` run a two-layer probe before reporting success so missing-Node and shell-quoting errors surface immediately. `KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1` is a test and diagnostic bypass for hook verification only; it never bypasses engine certification, provenance checks, or the native-v2 preflight, and it is never a repair path. Damaged marker comments alone do not stop a job when the real TOML parser proves a clean, byte-exact enforcing hook entry; the job runs with a warning asking you to run setup.

## The canonical managed block and bundled hook

Running `kimi_setup({ action: "install" })` or `scripts/companion.sh setup` verifies `pluginRoot` and `hook/` via `lstat`/`realpath` (rejecting symlinks and non-directories), stages `package.json` (`{"type":"module"}`) and the self-contained bundled ESM `dist/hooks/approval-hook.js` in a unique staging subdirectory, probes the staged candidate before activating `<pluginRoot>/hook/approval-hook.js` (preserving any working hook on failure), and writes one canonical block in `~/.kimi-code/config.toml` inside the serialized config lock:

```toml
# === BEGIN kimi-plugin-cc-managed (v3.1.1) ===
# DO NOT EDIT — managed by kimi-plugin-cc setup. Run `scripts/companion.sh setup --uninstall` to remove.
# Purpose:
#   kimi-code's `kimi -p` mode hard-codes permission='auto' and
#   auto-approves every tool call. This hook enforces each managed command's
#   read-only or workspace-bound approval policy. Without this block,
#   the plugin's safety contract collapses.
# Matcher field is intentionally OMITTED — kimi-code compiles the
#   matcher with `new RegExp(...)`. An empty/missing matcher means
#   "fire for every tool". The string "*" would throw and silently
#   disable the hook. Do not "fix" this.
# The Node binary path is absolute so kimi-code's `/bin/sh -c`
#   hook spawn doesn't need `node` on its PATH (GUI launches,
#   LaunchAgents, etc.).
[[hooks]]
event = "PreToolUse"
command = "'/abs/path/to/node' '/abs/path/to/kimi-plugin-cc/hook/approval-hook.js'"
timeout = 15
# === END kimi-plugin-cc-managed ===
```

All 5 hosts (Claude Code, Codex, Antigravity, DeepSeek Harness, and Magpie) share this single canonical data directory and single managed block. Because the hook lives at the stable `<pluginRoot>/hook/approval-hook.js` path rather than a per-host cache directory, hosts no longer overwrite each other or leave stale older-host hooks behind. Running `setup` once after upgrading from 3.0 automatically consolidates any legacy `:<host-id>` blocks (`:claude-code`, `:codex`, `:dsh`) into this single block.

Constraints enforced by [`runtime/hooks/managed-block.ts`](../runtime/hooks/managed-block.ts) and [`runtime/hooks/config-safety.ts`](../runtime/hooks/config-safety.ts):

1. No `matcher` key in any TOML spelling. Kimi Code compiles `matcher` with `new RegExp(matcher)`; omitting it fires on every tool, while `"*"` throws and silently disables the hook.
2. Absolute, stable Node binary path. Kimi Code spawns hooks through `/bin/sh -c "<command>"`. Under GUI or LaunchAgent launches with a sanitized `PATH`, bare `node` exits 127, which upstream reads as allow. Both tokens are POSIX single-quoted via `runtime/hooks/install-paths.ts`.
3. TOML basic-string escaping. Unsafe control characters, raw quotes, or backslashes in the hook path are rejected upfront with `SETUP_HOOK_PATH_UNSAFE`.
4. Exact marker grammar and non-durable markers. Kimi Code rewrites `config.toml` through `smol-toml` on login and settings changes, stripping all comments (including BEGIN/END markers) while leaving `[[hooks]]` tables intact. In the absent state only, verification falls back to a whole-file `smol-toml@1.9.1` parse proving a clean enforcing table with `event = "PreToolUse"`, the byte-exact canonical `command`, no `matcher`, no extra keys, and `timeout >= 15` seconds. At job time, duplicate or orphan markers with that parser proof run with a warning; `setup` and `setup --check` still fail closed on duplicate or orphan markers.
5. Full-config parse, whole-hook-array schema validation, bundle SHA-256 verification, and timeout floor. Verification parses the complete TOML file with vendored `smol-toml@1.9.1` and validates every configured `[[hooks]]` entry (`event`, optional string `matcher`, non-empty `command`, optional integer `timeout` from 1 to 600, no unknown keys). Additive events (`PermissionRequest`, `PermissionResult`, `Interrupt`) require an exact certified `>= 2.8.0` `hook-schema` row. When `KIMI_PLUGIN_CC_HOOK_SCRIPT` is unset, `verifyHookInstalled` and `setup --check` also check `lstat` (rejecting symlinked managed hook paths) and compare the SHA-256 of `<pluginRoot>/hook/approval-hook.js` against the bundled `dist/hooks/approval-hook.js`; any mismatch (stale bundle after upgrade or cross-host downgrade) fails `setup --check` and refuses jobs with `retryable_after_setup: true`. Because upstream treats a timed-out hook as allow and runs only the first entry per command, every PreToolUse copy of the canonical command must give Kimi at least 15 seconds (an omitted `timeout` uses upstream's 30-second default). Meanwhile, the hook itself denies any labelled call still undecided at 10 seconds (`HOOK_DECISION_DEADLINE_MS`).
6. Serialized, atomic config edits and private plugin directories. Install, hook publication, and uninstall hold a private mode `0600` sibling lock (`config.toml.kimi-plugin-cc.lock`) across read-modify-write. Candidate locks publish atomically via hard link; reads are no-follow, nonblocking, regular-file-only, and capped at 4 KiB; live owners are never stolen; stale recovery uses an ABA-safe recovery lease; inode and token ownership are rechecked before mutation and release. Newly created Kimi homes and plugin-owned directories (`pluginRoot`, `logs/`, `artifacts/`, `hook/`) use mode `0700` on POSIX; atomic config writes and stream logs use mode `0600`.
7. Inline hook normalization and strict ownership pruning. Valid top-level inline `hooks = [...]` arrays are converted to `[[hooks]]` tables with a warning before insertion and before uninstall pruning. Paired managed blocks containing extra TOML table headers refuse (`SETUP_INVALID_HOOKS_CONFIG`) instead of deleting foreign content. Install removes lexically proven orphan marker comments and prunes only exact known install layouts of `approval-hook.js`, never touching custom or hand-rolled user hooks.

## Universal hosts and collapsed surfaces

All 5 hosts (Claude Code, Codex, Antigravity, DeepSeek Harness via root `cordis.patch.yml`, and Magpie) connect to the same MCP server (`scripts/companion.sh mcp`) and `kimi` skill (`skills/kimi/SKILL.md`, served over `SEP-2640` as `skill://kimi/SKILL.md`). Every surface runs the same 7 operations and selects the same hook labels:

| Operation (hook label) | MCP tool and mode | Primary CLI command | Write boundary |
| --- | --- | --- | --- |
| `ask` (`ask`) | `kimi_read` (`mode: "ask"`, default) | `companion.sh read` | Read-only |
| `review` (`review`) | `kimi_read` (`mode: "review"`) | `companion.sh read --mode review` | Read-only |
| `challenge` (`challenge`) | `kimi_read` (`mode: "challenge"`) | `companion.sh read --mode challenge` | Read-only |
| `swarm` (`swarm`) | `kimi_read` (`mode: "swarm"`) | `companion.sh read --mode swarm` | Read-only parallel fan-out |
| `rescue` (`rescue`) | `kimi_write` (`mode: "rescue"`, default) | `companion.sh write` | Workspace files only, never Git |
| `pursue` (`rescue`) | `kimi_write` (`mode: "pursue"`) | `companion.sh write --mode pursue` | Workspace files only, never Git |
| `swarm-write` (`swarm-write`) | `kimi_write` (`mode: "swarm_patch"`) | `companion.sh write --mode swarm-patch` | Ephemeral Git worktree; returns patch |

`routeSurfaceAliases` (`runtime/surface-routing.ts`) parses `--mode` (and legacy `ask --write` or `review --challenge`) strictly from leading flags before `--` or the first positional token. Prompt text never switches a read-only call into a write operation. MCP calls always place prompts after `--`.

For DeepSeek Harness, the root `cordis.patch.yml` mounts DSH's built-in `@deepseek-ai/dsh-mcp-client` and `@deepseek-ai/dsh-skill-filesystem`.

### Patched DSH host and profiles

DSH `0.2.1-rc.5` and `0.2.2-alpha.2` pin vulnerable `zod` and `undici` versions. See the [upstream dependency report](https://github.com/deepseek-ai/deepseek-harness/discussions/10847) for background. Install and run DSH from a patched host project with `zod >=4.6.6` and `undici >=8.12.2` on Node.js `24.9` or newer. The plugin never modifies your DSH host or profiles automatically, and a profile override alone does not patch a separate global DSH CLI.

Create a dedicated npm host project and use its DSH binary for plugin installation and launch:

```sh
mkdir -p ~/.local/share/kimi-dsh-host
cd ~/.local/share/kimi-dsh-host
npm init -y
npm pkg set 'overrides.zod=^4.6.6' 'overrides.undici=^8.12.2'
npm install @deepseek-ai/dsh@0.2.1-rc.5
npm audit --omit=dev --audit-level=high
./node_modules/.bin/dsh plugin --profile web add kimi-plugin-cc
./node_modules/.bin/dsh plugin --profile web audit --prod --audit-level high
./node_modules/.bin/dsh web --no-open
```

The host project lives outside `$DSH_HOME/profiles/web`. Always run that project's `./node_modules/.bin/dsh` binary so the audited host executes your profile. The commands above install the published npm package; pass a validated local tarball or checkout path when testing an unpublished build.

If an existing profile installs its own DSH packages, patch and audit that profile too:

```sh
dsh plugin --profile web pkg set 'pnpm.overrides.zod=^4.6.6' 'pnpm.overrides.undici=^8.12.2'
dsh plugin --profile web install
dsh plugin --profile web audit --prod --audit-level high
```

Replace `web` with your target profile name and run these commands with your patched host binary. The DSH package gate creates a clean patched host and audits both the host and profile for high or critical advisories. It verifies the 4 MCP tools and `kimi` skill and boots `dsh web`, without claiming upstream fixes for low or moderate advisories.

## The hook's per-command policy

[`runtime/hooks/approval-policy.ts`](../runtime/hooks/approval-policy.ts) is the single source of truth:

| `KIMI_PLUGIN_CC_CMD` | Allowed tools | Denied tools |
| --- | --- | --- |
| unset or empty | everything | nothing (Kimi invoked outside the plugin) |
| `ask`, `review`, `challenge` | `Read`, `Grep`, `Glob`, `ReadMediaFile`, `TaskList`, `TaskOutput`, `WaitFor`; with `--read-root` or `--network` the 4 read tools stay inside workspace and roots; with `--network`, also `WebSearch` and `FetchURL` to public hosts | everything else, including `Bash`, `Write`, `Edit`, `Agent`, `AgentSwarm`, and web tools without `--network` |
| `rescue` | governed by [`evaluateRescueHookRequest`](../runtime/rescue-approval.ts) against `KIMI_PLUGIN_CC_WORKSPACE_ROOT`; under `operationKind: "pursue"` with a trusted root, also exact `GetGoal {}` and `UpdateGoal { status: "complete" | "blocked" }` | missing-root writes, Git mutation, `SetGoalBudget`, and every shell command or edit the allowlist rejects |
| `swarm` | same as `ask` (including read scope and `--network`), plus admitted `AgentSwarm` waves at concurrency 2 or more | everything else, including singular `Agent`, shell, writes, forks, and delegation at concurrency 1 |
| `swarm-write` | read-only set plus admitted `AgentSwarm` waves at concurrency 2 or more; `Write`, `Edit`, `MultiEdit`, and `Bash` only through `evaluateRescueHookRequest` against the trusted ephemeral-worktree root | singular `Agent`, missing-root writes, explicit background Bash, delegation at concurrency 1, and anything the rescue evaluator rejects |
| unknown label | `Read`, `Grep`, `Glob`, `ReadMediaFile`, `TaskList`, `TaskOutput`, `WaitFor` | everything else (fail-closed default) |

`WaitFor` is in the read-only set because it waits (up to upstream's 90-second cap) on tasks that already exist and cannot start or stop one. Only write labels can start a background task inside plugin-managed runs. Like `TaskOutput`, `WaitFor` reads the session's task history and is not confined by `--read-root` or `--network`.

`EnterPlanMode` and `ExitPlanMode` are denied for every managed label before any per-label evaluator runs. Denied tool calls exit 2 with the denial reason on stderr so Kimi can adapt.

### Read scope and network access

Kimi auto-approves its own read and web tools, so the managed hook is the sole place they can be scoped. Callers set scope per invocation on `ask`, `review`, `challenge`, and read-only `swarm` (CLI `--read-root <abs-dir>` and `--network`; MCP `read_roots` and `network`):

- Default (no flags): read tools can read any path, and `WebSearch` and `FetchURL` are denied.
- `--read-root <absolute-directory>` (repeatable): `Read`, `Grep`, `Glob`, and `ReadMediaFile` are confined to the workspace realpath and the listed directories.
- `--network`: allows `WebSearch` and `FetchURL` to public hosts and confines the 4 read tools to the workspace and any listed read roots, so a job with web access can read only what you named.

Under confinement, the hook denies paths or globs containing a backslash or drive letter, symlink escapes outside the roots, unrecognized argument keys, `~`, URL-style paths (`kimi-file://`), dangling symlinks, globs containing `..`, and absolute out-of-root globs. `FetchURL` allows only `http:` and `https:` URLs without embedded credentials targeting a public hostname or canonical global unicast IP address (denying `localhost`, `.localhost`, `.local`, `.internal`, numeric hosts, private/CGNAT/loopback/link-local/IETF/documentation/benchmarking/`192.88.99.0/24`/multicast/reserved IPv4, non-`2000::/3` or IETF/Teredo/`2001:db8::/32`/`3fff::/20`/6to4 IPv6, and NAT64 addresses embedding non-global IPv4). A `--read-root` containing a backslash refuses (`INVALID_ARGS`), and a scoped job whose workspace contains one refuses (`READ_SCOPE_INVALID`).

The hook reads only per-spawn `KIMI_PLUGIN_CC_READ_ROOTS` and `KIMI_PLUGIN_CC_NETWORK`, both deleted before setting; malformed values fail closed. Scope is never inherited across turns. Naming an earlier session with `--reference-session` (MCP `referenced_sessions`) adds that session's validated `agents/main` directory (its log, saved tool outputs, and plans) to a scoped call's read roots; with `--network`, that content can reach the web. `--network` refuses on uncertified releases (`> 2.8.0`) and on resumed `ask` sessions unless every earlier plugin-recorded turn ran with confined roots inside the current call's roots. Write operations reject both scope flags because allowlisted shell commands can read files. Scope appears in `job status` JSON (`read_scope`) and as an opening `Scope:` line in stdout and saved artifacts.

### Native agent-core-v2 and the no-plan closures

At Kimi Code `2.8.0`, upstream runs external `PreToolUse` hooks in `legacyHook` ahead of every `registerHook` hook (including the plan guard) and zero production code calls `event.allow()`. A live plan-ON control confirmed the hook denies plan-file Writes. Because upstream issue MoonshotAI/kimi-code#3431 remains open and no ordering promise is documented, all four plugin-owned no-plan closures remain active on every release:

- Default plan mode preflight: `runtime/native-v2-preflight.ts` parses `<KIMI_CODE_HOME>/config.toml` under every spelling upstream normalizes to `defaultPlanMode`. On exact `2.8.0` (`print-cancels-plan`), fresh `kimi -p` cancels create-time plan entry before any turn, so configured `default_plan_mode` no longer refuses non-swarm launches; it still refuses swarm, write-swarm (including concurrency 1), and uncertified releases (`CLI_V2_PLAN_MODE_CONFIGURED`).
- Plan tool denials: `EnterPlanMode` and `ExitPlanMode` are denied by the managed hook for every label.
- Resume lineage, plan-taint, and tower scans: resume requires proven `native-v2` lineage (`KIMI_SESSION_LINEAGE_UNKNOWN` or `KIMI_SESSION_ENGINE_MISMATCH` otherwise) and scans every agent `wire.jsonl` raw for `plan_mode.*` and `plan.*` records (`KIMI_SESSION_PLAN_TAINTED`). On exact `2.8.0` non-swarm resumes, the single create-time `plan_mode.enter` followed by its cancel before any activity in a linear journal is tolerated, allowing only Kimi's 3 MCP bookkeeping records (`mcp.tools_discovered`, `mcp.server_failed`, `mcp.server_failure_resolved`) between them. The same scan refuses any session whose main journal leaves the main agent in tower mode (`KIMI_SESSION_TOWER_ACTIVE`).
- Experimental selector forcing: every child receives `KIMI_CODE_EXPERIMENTAL_TOWER=0` and `KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK=0` and never receives `KIMI_CODE_EXPERIMENTAL_FLAG`. On certified releases this forcing is silent; on uncertified `> 2.8.0` releases it runs with a launch warning naming every switched-on experimental selector.

Provenance: every native-v2 launch requires `system.version` as the first stream-json line matching the probed version (`CLI_ENGINE_PROVENANCE_MISMATCH` tears down the process tree before any record reaches the caller).

Residuals stated plainly: `config.toml` and session journals are trusted operator state; upstream's hook runner fails open on its own internal errors; concurrent external edits to an active plugin-managed session are unsupported (the upstream session lock is not a security boundary). Native plan mode, tower, Remote Control, and `--add-dir` are out of scope.

## The rescue allowlist

For `rescue`, `pursue`, and `swarm-write`, the hook delegates to [`evaluateRescueHookRequest`](../runtime/rescue-approval.ts) against `KIMI_PLUGIN_CC_WORKSPACE_ROOT`:

- File edits (`Write`, `Edit`, `MultiEdit`): paths must resolve inside the trusted root (`realpath`), stay outside `.git` in any case or with trailing dots/spaces, never escape via symlinks, and never target an existing regular file with more than one hard link.
- Path spellings: `path`, `file_path`, and `Bash.cwd` refuse backslashes, NUL bytes, leading `~`, drive letters, and URL schemes. On macOS and Linux, write operations refuse to launch (`CLI_TRUSTED_WORKSPACE_ROOT_INVALID`) when the workspace path or realpath contains a backslash, and the hook denies every tool for such a root.
- Command length: Bash commands over 16,384 characters are denied before evaluation so checks always finish well inside the 10-second hook deadline.
- Shell commands (`Bash`): parsed with `shell-quote`; pipeline stages validate independently. Mutating `git` subcommands (`commit`, `push`, `reset --hard`, and so on), `find -delete`/`-exec`, and `sed -i` are denied.
- Package-manager scripts: `npm/pnpm/yarn/bun/uv run <script>` is denied; `<pm> test` is allowed under the test-runner trust boundary below.
- Output-to-file flags: `--output`, `--output-file`, `--output-directory`, and `--output-dir` (and `=` forms) are denied on every binary. Per-tool `-o` is denied where it writes (`eslint -o`, `go -o`, `ruff check -o`, `sort -o`), and `uniq IN OUT` is denied in pipelines.
- Exec-delegating flags: `--open-files-in-pager` (plus git `-O`), `-vettool`, `-toolexec`, and `-exec` are denied on every binary. Known gap: `-exec` and `-execdir` match as exact tokens only (`go test -exec=<bin>` and `--exec` still pass).
- File operations: `rm` (`-f`, `-r`, `-R`, `-rf`, `-fr`), `mkdir` (`-p`), `mv` (`-f`, `-n`), and `cp` (`-R`, `-r`, `-p`, `-f`, `-n`) are allowed on absolute in-root non-`.git` paths only (never on Windows; relative operands are denied; one file op per command; `&&` and `;` stay denied). `rm` operands and `mv`/`cp` sources cannot name the workspace root. Recursive/directory sources scan for `.git` entries at any depth without following symlinks, staying on one filesystem, capped at 20,000 entries and 3 seconds. `mv`/`cp` sources must exist, destinations cannot lie inside sources or collide with another source's landing path, recursive `cp` must create its destination, and `cp` refuses existing destinations with more than one hard link. Deletions are permanent.
- Search, Git reads, and report flags: `grep -i` and `git --no-pager <read-only>` pass; `rg -i`, `rg -w`, `grep -w`, and report-writing flags on `mypy` and `pytest` are denied.
- `.git/`: excluded from every file edit, file operation, and `Bash.cwd`. Branch and commit decisions stay with the calling host.

### Effective working directory (`Bash.cwd`)

Because Kimi's `Bash` tool executes in `tool_input.cwd` without asserting workspace membership, the allowlist validates `Bash.cwd` before the command string: absent defaults to the trusted root; present must be an existing, non-symlinked directory whose realpath lies inside the trusted root and outside `.git`.

### Trust boundary for test runners and custom agents

Rescue, pursue, and write-swarm intentionally allow test and build runners (`go test`, `cargo test`, `pytest`, `<pm> test`). Running tests executes code from the repository (`build.rs`, `conftest.py`, fixtures), which the allowlist cannot confine. Similarly, Kimi discovers project agent profiles and system prompts (`<git-root>/.kimi-code/agents`, `<git-root>/.agents/agents`); while they cannot alter hooks, cwd, or allowlists, they can steer model intent. Run write operations only in repositories you trust.

## Autonomous goal mode (`pursue`, experimental)

`kimi_write({ mode: "pursue" })` (CLI `companion.sh write --mode pursue`) runs headless goal mode (`kimi -p "/goal -- <objective>"`) under `commandLabel: "rescue"`. Every continuation turn passes the managed PreToolUse hook and workspace allowlist with no Git mutation.

The child receives `KIMI_PLUGIN_CC_OPERATION=pursue` from its immutable plan. With a trusted root, the hook allows only exact `GetGoal {}` and terminal `UpdateGoal { status: "complete" | "blocked" }`; goal creation, reactivation, and `SetGoalBudget` stay denied. The mandatory finite wall-clock `--budget` (default 45m, max 24h) is the hard stop; `--turns` is a soft hint. Resume is not exposed because upstream `goalId` and `sessionId` remain separate. Exit codes 0 (complete), 3 (blocked), and 6 (paused) are terminal non-failures and require `system.version` provenance.

## Bounded swarm on 2.8.0 and newer

`--max-concurrency` defaults to 4 for read-only swarms (`kimi_read`, `mode: "swarm"`) and 1 for write-swarm (`kimi_write`, `mode: "swarm_patch"`). On exact `2.8.0`:

- Concurrency 1 runs one direct worker in fresh print with no `kimi web` activation and delegation tools denied, preserving read-only or ephemeral-worktree patch rules.
- Concurrency 2 or more uses short-lived loopback `kimi web --json` activation with an in-memory ephemeral token (`KIMI_CODE_SESSION_IDLE_RECLAIM_MS=0`), explicitly binds `environment_id: "local"` and canonical cwd, verifies direct WebSocket subscription state, disables native `TaskStop` in that fresh owned session (closing automatic Bash backgrounding), runs one `kimi -p -r` print job (`kimi_session_id_source: "preactivated"`), and deactivates swarm mode afterward.

Every coordinator and subagent call passes the canonical PreToolUse hook. At concurrency 2 or more, the hook admits `AgentSwarm` only when fresh `items` plus `resume_agent_ids` fit within the concurrency limit; singular `Agent`, forks, malformed calls, fresh singleton waves, and explicit `Bash.run_in_background: true` are denied. `KIMI_CODE_SWARM_TIMEOUT_MS=2147483647` prevents a short child timeout from overlapping waves. Parallel Bash commands have a 60-second default and 300-second maximum foreground timeout (use concurrency 1 for longer tests). Normal exit and cancellation both require identity-verified POSIX process-tree quiescence before capturing artifacts or patches. `--cap` remains a soft lifetime-total hint.

### Write-capable swarm (`swarm_patch`)

Write-swarm creates one detached worktree off born `HEAD` under `<pluginRoot>/worktrees/` (never inside your repository), runs Kimi with cwd = that worktree and `KIMI_PLUGIN_CC_WORKSPACE_ROOT` pinned to it, and captures an untruncated binary `.patch` (`git add -N` + `git diff --binary`, no loose objects written) on every terminal path before removing the worktree. Capture or cleanup failure fails the job and retains the worktree. The plugin never applies or commits patches. Use explicit cancellation (`kimi_job({ action: "cancel" })` or `companion.sh job cancel`) rather than interrupting the host so patch capture completes. See [swarm recovery](swarm-recovery.md) for interrupted runs.

## MCP transport, `SEP-2640` skills, and long-running jobs

`scripts/companion.sh mcp` runs one dependency-free NDJSON stdio server exposing 4 tools (`kimi_read`, `kimi_write`, `kimi_job`, `kimi_setup`) plus full `SEP-2640` `skills/list`, `skills/get` (returning `frontmatter` and `resources` SHA-256 digests and sizes for `SKILL.md` and `agents/openai.yaml`), `resources/list`, and `resources/read` (with `ttlMs: 0` and `cacheScope: "private"` on `2026-07-28`). It is a thin transport over the exact same certified execution plans, preflights, hooks, budgets, and SQLite store.

- Modern `2026-07-28` calls carrying per-request `io.modelcontextprotocol/tasks` return native task handles (`tasks/get` and `tasks/cancel`, both requiring an `mcp_tasks` row).
- Standard `tools/call` requests on `kimi_read` and `kimi_write` default to `wait: true` with a 50-second default `wait_timeout_ms` (configurable up to `86_400_000` ms) and return prose directly. Client disconnect or `notifications/cancelled` stops polling without cancelling the durable Kimi job. Pass `wait: false` to always receive the launch handle (`{ job_id, ... }`) immediately even if already terminal, then poll or cancel with `kimi_job`.
- Every model tool runs in a supervised detached `mcp-child <uuid>` process (60-second attachment bound, `kimi_pid` recorded at spawn). Disconnects never cancel running jobs; a new server reattaches by durable `job_id`.
- A configured `KIMI_PLUGIN_CC_MCP_WORKSPACE` acts as a containment boundary (explicit `workspace` must equal it or be a descendant), and `kimi_job` enforces strict canonical `realpath` workspace containment with scoped stale-job sweeps (no cross-workspace monorepo listing or cross-repo sweeps). When absent (as in Codex or generic stdio hosts), callers pass an absolute `workspace`.
- Direct CLI `cancel` refuses MCP-owned jobs; use `kimi_job({ action: "cancel" })` or `tasks/cancel`, which revalidate recorded companion and Kimi process identities before signalling (including persisted CLI identities for CLI-launched jobs). Failed jobs return `isError: true` with their artifact preserving partial output on budget timeouts.

## Response budgets, local execution, and newer Kimi releases

Single-turn operations default to 30 minutes (`ask`, `review`, `challenge`) or 45 minutes (`rescue`), overridable up to 24 hours with `--budget` / `budget`. Budget timeouts save partial settled prose under a clearly marked NOT-a-final-answer heading (`partial_output: true`) and recover a uniquely matched native-v2 session ID via exact `prompt_digest` binding when no ID was announced. Cancellation never captures partial output.

Every spawn deletes `KIMI_CODE_TRUST_WORKSPACE` and requires local execution. On exact `2.8.0`, configured `[environments] default` is neutralized on fresh non-swarm launches by `--environment local` and checked against stored local bindings on resume; it still refuses swarm and uncertified launches (`CLI_V2_ENVIRONMENT_UNSAFE`). `[workspace] require_trust = false` runs with a launch warning.

### Running a newer Kimi than the plugin certifies

When your selected binary is an unlisted plain `2.y.z` strictly above `2.8.0`, read-only operations (`ask`, `review`, `challenge`) run with this warning:

```text
kimi-code <version> is not certified by this plugin release; running <operation> read-only with 2.8.0 mechanics.
```

Uncertified releases borrow only `--environment local`. Write operations, swarm operations, `--network`, configured `default_plan_mode`, configured `[environments] default`, and additive hook events (`PermissionRequest`, `PermissionResult`, `Interrupt`) all refuse. Set `KIMI_PLUGIN_CC_STRICT_VERSIONS=1` to refuse uncertified releases for read-only operations too. Releases below `2.8.0`, pre-release/build-suffixed versions, and other majors refuse every operation.

To keep every operation working independently of your `PATH` `kimi`, run `kimi_setup({ action: "install_kimi" })` or `scripts/companion.sh setup --install-kimi`. It installs the newest certified release (`2.8.0`) into `<pluginRoot>/kimi-bin/<version>/` with `--ignore-scripts`, verifies containment and exact `--version`, and swaps `kimi-bin/current` atomically. One install serves all 5 hosts through the shared data directory. Jobs pick `KIMI_PLUGIN_CC_KIMI_BIN`, then `kimi-bin/current`, then `kimi` on `PATH`.

## Setup probe, verification, and opt-out

`setup` and `setup --check` run a two-layer probe:

1. Direct probe: spawns `<nodeBin> <hookScriptPath>` using the Node token parsed back from the canonical command with synthetic `KIMI_PLUGIN_CC_CMD=review` `Bash` JSON on stdin, requiring exit 2 and non-empty stderr.
2. Shell probe (POSIX): runs the exact canonical command string via `/bin/sh -c "<command>"` with the same payload and assertion.

Run `kimi_setup({ action: "check" })` or `scripts/companion.sh setup --check` to verify readiness without modifying config. Look for `Probe: ok`. Never read or paste raw `~/.kimi-code/config.toml` or `~/.kimi-code/credentials/` for routine checks.

To opt out, run `scripts/companion.sh setup --uninstall`. It removes all canonical and legacy managed blocks, orphan markers, and strictly owned bare hook tables while leaving foreign hooks untouched. Afterward, all 7 model operations refuse before spawn until you run `setup` again.

<a id="refusal-codes-of-the-native-v2-contract-v1100"></a>
## Native-v2 refusal codes

Every refusal below occurs before Kimi starts (or, for provenance mismatch, before any record reaches the caller) and carries `retryable_after_setup: false`. Never retry through `setup` on these codes.

| Code | Raised when | Remedy |
| --- | --- | --- |
| `KIMI_CAPABILITY_NOT_CERTIFIED` | probed `kimi --version` is below `2.8.0` (including `legacy-v1`), is a write/swarm call on an unlisted `> 2.8.0` release, is a pre-release/build-suffixed or non-2.x version, or `KIMI_PLUGIN_CC_STRICT_VERSIONS=1` is set on an uncertified release | run `kimi_setup({ action: "install_kimi" })` / `setup --install-kimi`, update the plugin, or set `KIMI_PLUGIN_CC_KIMI_BIN` to `>= 2.8.0` |
| `CLI_V2_PLAN_MODE_CONFIGURED` | `<KIMI_CODE_HOME>/config.toml` sets any spelling of `default_plan_mode` to non-`false` on a swarm, write-swarm, or uncertified launch | set `default_plan_mode = false` or remove it |
| `CLI_V2_CONFIG_UNREADABLE` | config cannot be read safely (symlink, oversized, unparseable TOML showing only `syntax error at line N, column M`) | fix or remove the unreadable file |
| `CLI_V2_ENVIRONMENT_UNSAFE` | `[environments]` is not a table, or `[environments] default` is set on a swarm, write-swarm, or uncertified launch | remove `environments.default` or use a non-swarm op on a certified release |
| `CLI_V2_WORKSPACE_TRUST_UNSAFE` | `[workspace]` is not a table, or `require_trust` is not a boolean | fix the value (`false` is allowed with a warning) |
| `CLI_V2_EXPERIMENTAL_UNSAFE` | plan-less launch with truthy `[experimental]` `tower`/`subagent_fork` or matching per-flag env (or unreadable config on an uncertified release) | unset the listed selectors |
| `CLI_V2_HOOK_ORDER_UNSAFE` | plan-less launch with truthy `KIMI_CODE_EXPERIMENTAL_FLAG` | unset `KIMI_CODE_EXPERIMENTAL_FLAG` |
| `KIMI_SESSION_PLAN_TAINTED` | resumed session has a `plan_mode.*`/`plan.*` record in any agent `wire.jsonl` outside the tolerated cancelled create-time pair (allowing only the 3 MCP bookkeeping records between enter and cancel) | start a fresh session |
| `KIMI_SESSION_TOWER_ACTIVE` | resumed session's main journal leaves the main agent in tower mode | run `/tower` in that session to turn tower mode off, or start a fresh session |
| `KIMI_SESSION_JOURNAL_UNAVAILABLE` | session journals are missing, symlinked, oversized, or non-regular files | start a fresh session |
| `KIMI_SESSION_LINEAGE_UNKNOWN` | resumed job has no proven engine provenance, no source job, or a mismatched session binding | start a fresh session; old job `status`/`result`/`replay` still work |
| `KIMI_SESSION_ENGINE_MISMATCH` | resumed source session is proven `legacy-v1` while 3.1.0 launches only `native-v2` | start a fresh session |
| `CLI_ENGINE_PROVENANCE_MISMATCH` | first stream-json line is missing `system.version`, mismatches the probed version, or has another line ahead of it | process tree is torn down; check for a binary swap |
| `INVALID_ENV` (`reserved_flag`) | `KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS` contains a plugin-owned Kimi root flag (`-r`, `-p`, `--plan`, `--environment`, and so on) | remove the flag from the launcher prefix |
| `CLI_TRUSTED_WORKSPACE_ROOT_INVALID` | POSIX write launch whose run directory or trusted root (or realpath) contains a backslash | run from a path without backslashes |
| `KIMI_HOOK_SET_INVALID` | configured hooks fail validation for the execution plan's probed CLI release so Kimi would drop all hooks | fix or remove the named `[[hooks]]` entry in `config.toml` |
| `READ_SCOPE_INVALID` | corrupt stored `read_scope`, scope on a write/uncertified-network spawn, or backslash in a scoped workspace | re-run with valid scope flags on a read-only operation |

## What this safety story does not cover

- Repository Git configuration and internal subprocesses: the hook gates model tool calls, not internal Git helpers (`core.fsmonitor`) or POSIX lock-contention `ps` calls executed by Kimi itself.
- Malicious `kimi-code` binaries: the threat model assumes you trust your installed Kimi binary.
- TOCTOU between path check and file write: an attacker who already has write access to your workspace can swap symlinks after validation.
- Custom Kimi skill libraries that bypass tools via native bindings.
- The calling host's own tools outside Kimi subprocesses.
- Compute exhaustion without `max_steps_per_turn`: the plugin bounds wall-clock time via finite budgets, not token spend; set `max_steps_per_turn` in Kimi config for a step cap.
- Pre-poisoned `KIMI_MODEL_*` parent environment variables that reroute API traffic.
- Unconfined default reads: without `--read-root` or `--network`, read-only and rescue jobs can read any file your user account can read.
- `FetchURL` DNS resolution and HTTP redirects: the hook inspects only the URL as written, and `--read-root /` removes read confinement if you pass it.
- Non-tool content in scoped calls: review diffs cover the repository and Kimi's own `AGENTS.md` files still reach the model; hard links inside a read root count as inside it; turns added directly in Kimi outside the plugin store are invisible to the networked-resume check.
- Un-consolidated legacy hooks: if an older 3.0 install left a `:<host-id>` hook block in `config.toml`, run `setup` once in 3.1.0 to consolidate it so old rules cannot veto new operations.
- Session preview race: a Kimi Desktop turn finishing between plugin exit and preview sync can have its preview overwritten.
- Your interactive Kimi sessions outside plugin jobs.

## Node version switches and caller-only drift repair

The verifier checks exact command equality against the canonical command built from the resolved Node binary and `<pluginRoot>/hook/approval-hook.js`. `preferStableNodePath` prefers `process.argv0` over `process.execPath` only when absolute and `realpath`-identical (preventing Homebrew Cellar upgrades from breaking the pin). If you switch Node versions with `nvm`, `asdf`, `mise`, or `fnm`, the pinned Node path changes and commands refuse until you run `setup` again.

When a structurally valid block has a mismatched command, `HookInstallStatus.drift` classifies the axis (`hook-script`, `node-bin`, or `both`) and sets `retryable_after_setup: true` only when setup can safely re-pin it (a moved hook script, or a Node path spelling proven to name the same file). When `KIMI_PLUGIN_CC_DATA` overrides the data directory while the installed block already points at the default shared canonical hook, drift marks `retryable_after_setup: false` and instructs unsetting `KIMI_PLUGIN_CC_DATA` and restarting the host instead of re-pinning the shared block. Agents may run setup and retry once only when `retryable_after_setup` is literally `true` and setup exits 0. `node-bin-not-executable` requires repairing the Node binary. The verifier never auto-repins `config.toml` itself (rejected due to lock deadlock, env-steering, downgrade, and spawn-window TOCTOU risks).

## Hook-escape monitor (detection evidence)

`runtime/hook-escape.ts` replays pure hook denials against streamed tool results. A result matching the managed denial (exact or followed only by upstream repeat-breaker `<system-reminder>` blocks) clears the pending call. Any other result records `mismatch` with a 200-character excerpt; a missing result at settlement records `unresolved`. Findings are logged (`hook_escape`), persisted in `hook_escapes`, printed as a stderr `safety hook notice`, and returned in `job status` and `job result --json`, but never fail the job because print-mode tool records lack an outcome field. Treat a finding as a cue to run `setup --check` and inspect the excerpt.

## Reporting safety issues

If you find a way to make a read-only operation run a non-read tool, or make a write operation mutate `.git/` or escape its trusted root, open a GitHub security advisory rather than a public issue.
