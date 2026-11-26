# Compatibility and upgrades

Plugin 3.1.0 certifies exact Kimi Code CLI `2.8.0` for all 7 model operations: `ask`, `review`, `challenge`, `rescue`, `pursue`, `swarm`, and `swarm-write`. It introduces a rolling compatibility window starting at `2.8.0`. You can review the test evidence in [the 2.8.0 certification record](upstream-2.8.0-certification.md).

Unlisted plain `2.y.z` releases above `2.8.0` run read-only operations (`ask`, `review`, and `challenge`) with a warning and borrow only `--environment local`. The plugin refuses write and swarm operations, `--network`, pre-release or build suffixes, and other major versions before spawn (`KIMI_CAPABILITY_NOT_CERTIFIED`). Setting `KIMI_PLUGIN_CC_STRICT_VERSIONS=1` also refuses all unlisted versions before spawn.

Plugin 3.1.0 removes Kimi Code releases below `2.8.0` and the `legacy-v1` engine (`0.1` to `0.41`). Those versions refuse before spawn. You can still read historical `legacy-v1` job rows through `job status`, `job result`, and `job replay`, but you cannot resume them. The [runtime release table](../runtime/kimi-releases.ts) is the single source of truth for certified versions.

See the [README](../README.md) for installation steps across Claude Code, Codex, Antigravity, DeepSeek Harness (DSH), and Magpie. See the [model setup guide](./models.md) for model aliases and provider login. Never alter your host application login to configure Kimi.

## Plugin versions and compatibility

Plugin versions advance independently using semantic versioning and may match a certified CLI release number. Similar version numbers do not imply compatibility, so check the per-operation table in `runtime/kimi-releases.ts`. Published versions and Git tags never change.

## Upgrading from 3.0 to 3.1

Plugin 3.1.0 consolidates all 5 host integrations onto one shared architecture. Every host now uses 4 MCP tools, one `kimi` skill (`skill://kimi/SKILL.md`), 5 primary CLI subcommands, one shared data directory, and one PreToolUse hook block.

### Surface and packaging changes

| Area | Plugin 3.0.x | Plugin 3.1.0 |
| --- | --- | --- |
| Minimum Kimi Code CLI | Exact rows from `0.42.0` to `2.7.3` plus pinned `legacy-v1` (`<= 0.41.x`) | Rolling floor `>= 2.8.0`, exact `2.8.0` certified for all 7 operations, `< 2.8.0` and `legacy-v1` removed |
| MCP tools | 9 tools (`kimi_ask`, `kimi_review`, `kimi_rescue`, `kimi_pursue`, `kimi_swarm`, `kimi_swarm_write`, `kimi_job_status`, `kimi_job_result`, `kimi_job_cancel`) | 4 tools (`kimi_read`, `kimi_write`, `kimi_job`, `kimi_setup`) plus `SEP-2640` (`skills/list`, `skills/get`, `resources/list`, `resources/read` for `skill://kimi/SKILL.md` and `agents/openai.yaml`) |
| Standard MCP `tools/call` | Returned a running handle unless already settled | Defaults to `wait: true` with a 50-second `wait_timeout_ms` (up to `86400000` ms), stops polling on disconnect without canceling the job, and returns a launch handle when `wait: false` |
| Claude Code commands, agents, and Stop hook | 9 slash commands (`/kimi:*`), 4 agents (`kimi-*`), optional `review_gate` Stop hook (`--enable-review-gate`) | Removed in favor of the 4 MCP tools and `skills/kimi/SKILL.md` |
| Codex skills | 9 shell-backed skills (`$kimi-task`, `$kimi-review`, `$kimi-setup`, and others) | One `$kimi` skill (`skills/kimi/SKILL.md` and `agents/openai.yaml`) plus the 4 MCP tools |
| DeepSeek Harness (DSH) | Custom `plugins/kimi-dsh/` bundle with `runtime/dsh/` and 7 custom providers | Root `cordis.patch.yml` mounting `@deepseek-ai/dsh-mcp-client` and `@deepseek-ai/dsh-skill-filesystem` |
| Supported hosts | Claude Code, Codex, DSH | 5 hosts: Claude Code, Codex, Antigravity (`plugin.json`, `mcp_config.json`, `assets/logo.svg`), DSH, and Magpie (`magpie library mcp add`) |
| Primary CLI subcommands | `ask`, `review`, `task`, `status`, `result`, `cancel`, `replay`, `setup`, `recover-swarm`, `repair-sessions`, `mcp` | 5 primary subcommands: `read`, `write`, `job`, `setup`, `mcp` (older names remain as compatibility aliases) |
| Plugin data directory | Per-host `CLAUDE_PLUGIN_DATA`, `PLUGIN_DATA`, or `$DSH_HOME/plugin-data/kimi-plugin-cc` | One shared root: `~/.local/share/kimi-plugin-cc` (or `$XDG_DATA_HOME/kimi-plugin-cc`) on macOS and Linux, `%LOCALAPPDATA%\kimi-plugin-cc` on Windows, or `$KIMI_PLUGIN_CC_DATA/kimi-plugin-cc` |
| Managed PreToolUse hook | Per-host `:<host-id>` blocks pointing at version-stamped `dist/hooks/approval-hook.js` paths and `--uninstall --all` | One bundled ESM `<pluginRoot>/hook/approval-hook.js` published by `setup` and one `# === BEGIN kimi-plugin-cc-managed (v3.1.0) ===` block |

### Runtime behavior changes

Plugin 3.1.0 includes 5 runtime behavior updates:

- session references allow `--reference-session <job-id|session-id>` and MCP `referenced_sessions` (up to 8) to attach earlier session paths without reading log content
- tower-mode resume checks refuse sessions left in tower mode with `KIMI_SESSION_TOWER_ACTIVE` until you turn `/tower` off or start a new session
- uncertified release checks warn on enabled `[experimental]` settings for unlisted `2.y.z > 2.8.0` builds while still forcing tower and subagent fork off
- tool allowlists permit Kimi's `WaitFor` tool across every operation label so `pursue` and background tests avoid wasted denials
- journal scans accept Kimi's 3 durable MCP bookkeeping records (`mcp.tools_discovered`, `mcp.server_failed`, `mcp.server_failure_resolved`) inside a canceled create-time plan-mode pair

### Upgrade steps

1. Update Kimi Code CLI to `2.8.0` or newer, or let the plugin install a dedicated copy in step 4.
2. Update the plugin in each host you use. If you installed `plugins/kimi-dsh` in DSH, remove it and add the root package with `dsh plugin --profile web add kimi-plugin-cc`.
3. Run setup once from any host with `kimi_setup({ action: "install" })` or `./scripts/companion.sh setup`. Setup rejects symlinks under `pluginRoot` and `hook/`, probes the staged hook before activating `<pluginRoot>/hook/approval-hook.js`, and merges legacy `:<host-id>` blocks in `~/.kimi-code/config.toml`. If 2 hosts use different Node binaries, set `KIMI_PLUGIN_CC_NODE_BIN` to the same absolute Node `22.5` or newer path in both hosts.
4. Run `kimi_setup({ action: "install_kimi" })` or `./scripts/companion.sh setup --install-kimi` if you want a plugin-owned certified `2.8.0` binary shared across all hosts.
5. Run `kimi_setup({ action: "check" })` or `./scripts/companion.sh setup --check` and confirm that the output shows `Probe: ok`.

### Previous job databases

Plugin 3.1.0 does not move or delete your 3.0 per-host job databases (`plugins/data/.../kimi-plugin-cc/state.db` or `$DSH_HOME/plugin-data/kimi-plugin-cc/state.db`). New jobs write to the shared canonical data directory (`~/.local/share/kimi-plugin-cc` on POSIX, or `%LOCALAPPDATA%\kimi-plugin-cc` on Windows). To inspect or reuse a 3.0 database, set `KIMI_PLUGIN_CC_DATA` to the parent directory that contains `kimi-plugin-cc/`.

## Parallel swarm behavior

The `--max-concurrency` flag defaults to `4` for read-only swarms and `1` for write swarms (`swarm_patch`). On exact `2.8.0`, concurrency `1` runs one direct worker in print mode without swarm activation or subagent delegation. Write mode at concurrency `1` still uses a temporary Git worktree and captures an unapplied patch.

At concurrency `2` or higher, `runSwarm` uses bounded waves and short-lived `kimi web --json` activation with a short-lived in-memory token.

1. Activation starts `kimi web --json` and validates the loopback origin, `/api/v1/ws`, exact server version, and KAP `1.0.0` metadata. It creates a session in the canonical execution root with `environment_id: "local"`, `permission_mode: "auto"`, and `swarm_mode: true`. It verifies the WebSocket subscription state, stops within 15 seconds, confirms `swarm_mode.enter`, and disables native `TaskStop` before print starts.
2. One `kimi -p -r` runner executes the prompt with `kimi_session_id_source: "preactivated"`. Every coordinator and subagent tool call passes the PreToolUse hook, which enforces wave limits across `items` and `resume_agent_ids`. The hook also denies forks, fresh singleton waves, and explicit background Bash commands. Setting `KIMI_CODE_SWARM_TIMEOUT_MS=2147483647` keeps slow children active until they finish or hit the finite job budget.
3. Deactivation runs a second bounded `kimi web --json` lifecycle to recheck the local binding, set `swarm_mode: false`, verify `swarm_mode.exit`, and shut down. Both normal exit and cancellation wait for verified process quiescence before capturing artifacts or patches.

Parallel Bash commands use Kimi's 60-second default and 300-second maximum foreground timeout. Use concurrency `1` for longer test runs, and see [swarm recovery](./swarm-recovery.md) to clean up interrupted runs.

## Earlier upgrades

Plugin 3.0.0 merged 7 Claude Code commands into 4, folded `kimi_challenge` into `kimi_review`, and added `--read-root`, `--network`, `setup --install-kimi`, and launch warnings. Plugin 3.1.0 replaces those host-specific command and skill layouts with the 4 MCP tools and one `kimi` skill described above. For upgrades from versions earlier than `3.0.0`, see [GitHub Releases](https://github.com/linxule/kimi-plugin-cc/releases) and the archived [`v3.0.0` migration guide](https://github.com/linxule/kimi-plugin-cc/blob/v3.0.0/docs/migration.md).
