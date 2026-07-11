# Migrating from v0.4 to v1.0

v1.0 of kimi-plugin-cc targets the **kimi-code** Node.js binary (Moonshot's successor to Kimi CLI). The v0.4.x line targeted the Python **Kimi CLI** over its Wire JSON-RPC transport. kimi-code dropped the Wire transport from its first release, so v1.0 is a hard cut rather than a backwards-compatible upgrade.

If you're already running v0.4.x with the Python Kimi CLI, you have a choice:

- **Stay on v0.4** if you depend on `kimi --wire`. The [`v0.4.0`](https://github.com/linxule/kimi-plugin-cc/releases/tag/v0.4.0) tag is the stable reference point; a `v0.4-maintenance` branch is cut from that tag for ongoing fixes (once published, pin to it via `linxule/kimi-plugin-cc@v0.4-maintenance`).
- **Upgrade to v1.0** if you've installed (or are willing to install) kimi-code. v1.0 gets the new safety story (PreToolUse hook), kimi-code's vis-server integration for free, and a leaner subprocess transport.

## What changes between v0.4 and v1.0

| | v0.4 | v1.0 |
|---|---|---|
| Backing CLI | Python [Kimi CLI](https://github.com/MoonshotAI/kimi-cli) | [kimi-code](https://kimi.com/code/docs) (Node.js) |
| Transport | `kimi --wire` (JSON-RPC over stdio) | `kimi -p --output-format stream-json` (subprocess + NDJSON) |
| Per-command safety | YAML agent profiles (`exclude_tools`) shipped in the plugin | PreToolUse hook installed in `~/.kimi-code/config.toml` |
| Session id | Client-assigned UUID, passed via `--session` | Server-minted, captured from kimi's stream-json `session.resume_hint` record (stderr announce fallback) |
| Web UI integration | `kimi web` + PATCH `/api/sessions/{id}` for pre-run human-readable titles | kimi-code session store, with deterministic post-run titles for plugin-created user-command sessions |
| Replay log format | Wire JSON-RPC events (`{direction, message}`) | cli-client NDJSON (`{event, record}`) |
| Marketplace name | `kimi-marketplace` (plugin: `kimi`) — unchanged | same `kimi-marketplace` / `kimi` (v1 upgrades in place) |
| Rescue allowlist | In-band approval policy on the Wire client | Out-of-band via the PreToolUse hook (same allowlist code) |

The marketplace + plugin IDs are unchanged from v0.4, so an existing install can update in place — but only after kimi-code is installed locally. Without kimi-code the new transport has nothing to spawn, so the order matters: install kimi-code first, then update the plugin.

## Upgrade procedure

### 1. Install kimi-code

Follow Moonshot's install steps at [kimi.com/code/docs](https://kimi.com/code/docs). Verify it works on its own:

```
kimi --version
kimi -p "Reply READY"
```

### 2. Audit your kimi-plugin-cc env block

If you set any of these env vars for v0.4, review them before continuing — v1.0 reads the same vars but with different effective semantics:

| Env var | Notes |
|---|---|
| `KIMI_PLUGIN_CC_KIMI_BIN` | Path to the kimi binary. Was the Python `kimi` in v0.4; should now point at the kimi-code binary (typically `~/.kimi-code/bin/kimi`). Unset to use the kimi-code on `PATH`. |
| `KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS` | JSON array of args prepended to every kimi spawn. Was a Wire-mode flag carrier in v0.4; in v1 it's still honored but the v0.4 contents (`--wire`, `--session`, `--agent-file`) are gone. Unset unless you have a specific override reason. |
| `KIMI_PLUGIN_CC_NODE_BIN` | Absolute path to the Node binary used to run the companion AND the hook script. v1 setup hard-requires absolute. |
| `KIMI_PLUGIN_CC_HOOK_SCRIPT` | Override for the hook script path written into `~/.kimi-code/config.toml`. Tests / advanced users only. |
| `KIMI_CODE_HOME` | Override for the kimi-code config directory (default `~/.kimi-code`). New in v1.0 — recognized by setup, install verifier, and the hook itself. |
| `KIMI_PLUGIN_CC_SKIP_HOOK_CHECK` | Bypasses every hook-verification refusal gate (and the review-gate skip), restoring un-enforced `permission: auto` execution. Only set for tests or deliberate diagnostics. |
| `CLAUDE_PLUGIN_DATA` | Plugin data root. Unchanged from v0.4. |

### 3. Update the plugin in place

From an existing v0.4 install:

```
/plugin marketplace update linxule
# then in the /plugin UI: select kimi → "Update now"
```

Or fresh install on a machine that doesn't have v0.4:

```
/plugin marketplace add linxule/kimi-plugin-cc
/plugin install kimi@kimi-marketplace
```

(v0.4 ALPHA NOTE: v1.0.0-alpha.1 was briefly tagged with renamed IDs `kimi-v1` / `kimi-marketplace-v1`. The rename was rolled back in v1.0.0-alpha.2. If you happened to install alpha.1 by those names, uninstall first: `/plugin uninstall kimi-v1`, `/plugin marketplace remove kimi-marketplace-v1`, then follow the procedure above.)

### 4. Run setup

```
/kimi:setup
```

This writes the PreToolUse hook to `~/.kimi-code/config.toml` and runs a two-layer probe (direct + via `/bin/sh -c`) to verify the hook fires and denies as expected. If setup fails, look at the `Probe:` line in the output. Common failure codes (the runtime emits these as `SETUP_*` errors):

- **Bad `KIMI_PLUGIN_CC_NODE_BIN` override** — v1 setup requires the override to be an absolute path; relative paths (`node`) are rejected with `SETUP_NODE_BIN_NOT_ABSOLUTE`.
- **Orphan markers in `~/.kimi-code/config.toml`** from a manual edit or aborted earlier setup. Run `/kimi:setup --uninstall` to clean up, then `/kimi:setup` again. Code: `SETUP_ORPHAN_MARKERS`.
- **Duplicate managed blocks** from two setup runs racing. Same fix: `/kimi:setup --uninstall` + `/kimi:setup`. Code: `SETUP_DUPLICATE_BLOCKS`.
- **Hook script path contains characters TOML can't represent** (quotes, control chars). Reinstall to a path without these, or set `KIMI_PLUGIN_CC_HOOK_SCRIPT` to a safe path. Code: `SETUP_HOOK_PATH_UNSAFE`.
- **Probe timed out** (5s budget). Usually means kimi-code or the Node binary is wedged on cold start. Re-run; if persistent, file an issue with `/kimi:setup --check` output.
- **Hook script not found** — `dist/hooks/approval-hook.js` is missing. Reinstall the plugin or run `bun run build` if you're on a local clone. Code: `SETUP_HOOK_SCRIPT_MISSING`.

### 5. Verify

```
/kimi:setup --check
```

Reports the install state without writing. Run `/kimi:review` against a small diff to confirm the round-trip works end-to-end.

### Local-clone install upgrade

If you're running the plugin via `claude --plugin-dir ~/kimi-plugin-cc` rather than the marketplace:

```bash
cd ~/kimi-plugin-cc
git fetch --tags origin
git checkout v1.0.0-alpha.2
# Verify dist/ is in sync; if you previously deleted it locally, rebuild:
ls dist/hooks/approval-hook.js >/dev/null || bun run build
# Restart Claude Code so the new agents/ and dist/ register
```

Then run `/kimi:setup` in your Claude Code session. The local clone uses the same managed-block installer; no marketplace operations needed.

### Using both Claude Code and Codex (v1.7.0+)

Claude Code and Codex install the plugin to **different, version-stamped paths**
but share one `~/.kimi-code/config.toml`. As of **v1.7.0** each host manages its
**own** host-scoped PreToolUse block (`# === BEGIN kimi-plugin-cc-managed:claude-code …`
vs `:codex`), so:

- Run **`/kimi:setup` in Claude Code AND `$kimi-setup` in Codex** — once each.
  They no longer clobber each other; both blocks coexist and each host verifies
  its own. (Before v1.7.0 a single shared block was overwritten every time you
  switched hosts, which is why setup seemed to "need redoing.")
- **One-time cleanup on upgrade to v1.7.0:** update the plugin in *both* hosts,
  then run setup in each. The first setup adopts your old un-suffixed block and
  prunes orphaned hook entries left by earlier installs.
- `/kimi:setup --uninstall` removes only the current host's block. Use
  `/kimi:setup --uninstall --all` to remove *every* host's block from the shared
  config (a deliberate full nuke — it clears blocks for **all** hosts, not just
  this one).

> **⚠️ Upgrade both hosts before re-running setup.** During the window where one
> host is on v1.7.0+ and the other is still on ≤1.6.5, running setup on the OLD
> host writes an un-suffixed block that can overwrite the block the new host just
> migrated, re-creating the clobber (or leaving a duplicate the new host rejects
> with `SETUP_DUPLICATE_BLOCKS`). Update **both** Claude Code and Codex to v1.7.0+
> first, then run setup in each. If the config ever looks tangled, the clean-slate
> escape hatch is `/kimi:setup --uninstall --all` followed by setup in each host.

## Data and session continuity

- **SQLite job rows** from v0.4 remain in `${CLAUDE_PLUGIN_DATA}/kimi-plugin-cc/state.db`. They're still visible to `/kimi:status` and `/kimi:result`, but `/kimi:replay` will report `REPLAY_LOG_UNREADABLE` on the v0.4 wire logs — v1.0's replay parser doesn't understand the Wire JSON-RPC shape. Archive or delete the database if you don't need v0.4 history.
- **Kimi CLI sessions** under `~/.kimi/sessions/` are independent of kimi-code's `~/.kimi-code/sessions/`. v1.0's `--resume` will not see v0.4 sessions.
- **Plugin config** (`${CLAUDE_PLUGIN_DATA}/kimi-plugin-cc/config.json` — only `reviewGateEnabled` lives here) carries over unchanged.

## Rollback

If something is wrong, the v0.4 install is one step away:

```
/kimi:setup --uninstall            # removes the v1.0 PreToolUse hook
/plugin uninstall kimi
/plugin marketplace remove kimi-marketplace
# If the v0.4-maintenance branch is published:
/plugin marketplace add linxule/kimi-plugin-cc@v0.4-maintenance
# Otherwise, pin to the v0.4.0 tag:
/plugin marketplace add linxule/kimi-plugin-cc@v0.4.0
/plugin install kimi@kimi-marketplace
```

Claude Code's marketplace tooling uses `@ref` to pin a GitHub shorthand to a branch or tag. Your Python Kimi CLI install is untouched — v1.0 only edits `~/.kimi-code/config.toml`, never `~/.kimi/*`.

## What's gone

- The `--wire`, `--session`, and `--agent-file` invocation shape. v1.0 uses `kimi -p` only.
- The YAML agent profiles in `runtime/agents/`. The plugin doesn't ship Kimi-side profiles in v1.0; per-command safety is enforced exclusively by the PreToolUse hook.
- The Wire-protocol replay path. The runtime no longer parses JSON-RPC turn events.
- The v0.4 pre-run `Kimi Task: ...` title assignment path through Kimi CLI / `kimi web`. v1 uses `kimi -p`, whose session id is minted only after the run, so the plugin cannot name the session before spawn. Instead, after Kimi announces the session id, the runtime deterministically syncs a title such as `Kimi Ask: ...`, `Kimi Review: ...`, or `Kimi Swarm Write: ...` into kimi-code's session metadata. Manually renamed/custom Kimi titles are preserved. Internal `review_gate` Stop-hook sessions are intentionally not titled.

## What's new

- A two-layer setup probe that catches `node`-not-on-PATH failure modes before they become silent fail-opens.
- Workspace-bound rescue safety enforced by a hook that the plugin sets `KIMI_PLUGIN_CC_CMD=rescue` for. The hook only enforces the allowlist when that env var is set — kimi-code invocations from outside the plugin (e.g., direct user `kimi -p` calls) keep kimi-code's default permission posture, unrestricted by the plugin. The allowlist's job is to scope plugin-driven rescue, not to police all uses of kimi-code on the system.
- `/kimi:setup --check` and `/kimi:setup --uninstall` for state inspection and cleanup.
- Stream-json logs are easier to grep than Wire JSON-RPC dumps when you need to debug a job after the fact.

If you hit problems, file an issue with the output of `/kimi:setup --check` and the contents of the managed block in `~/.kimi-code/config.toml` (the block is between the BEGIN and END markers — don't paste the rest of your kimi-code config).
