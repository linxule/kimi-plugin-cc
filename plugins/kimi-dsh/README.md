# kimi-plugin-cc for DeepSeek Harness

Kimi Code subagents for DeepSeek Harness (DSH), backed by the same companion runtime as the Claude Code and Codex plugins.

## What this bundle provides

| Tool | Operation | File access |
|---|---|---|
| `kimi_ask` | Answer a self-contained repository question | Read-only |
| `kimi_review` | Review the working tree, including untracked files | Read-only |
| `kimi_challenge` | Challenge assumptions and design choices | Read-only |
| `kimi_rescue` | Investigate and implement a bounded fix | Can edit the selected workspace |
| `kimi_pursue` | Pursue an autonomous multi-turn objective with a finite budget | Can edit the selected workspace |
| `kimi_swarm` | Fan out independent read-only subagents | Read-only |
| `kimi_swarm_write` | Edit disjoint targets in a temporary worktree and return a patch | Patch only; never applies or commits |

Every activation starts a fresh companion and Kimi CLI process. The existing runtime owns hook verification, exact Kimi-version certification, SQLite jobs, response or safety budgets, artifacts, and process teardown. DSH owns delegation identity and completion notices. Parent conversations do not flow into the child, and child tool traffic stays out of the parent conversation.

Job controls are `/kimi-status [job-id]`, `/kimi-result [job-id]`, and `/kimi-cancel [job-id]`. Without an id, status and result select the latest job for the current repository, and cancel selects the latest active job. Cancellation stops work but does not roll back changes or patches already produced.

## Requirements

- Node.js 24.9.0 or later.
- DeepSeek Harness >=0.2.1-rc.5 <0.3.0; this package is developed and composed against 0.2.1-rc.5.
- Kimi Code CLI on `PATH`, authenticated and configured through Kimi. The companion's exact-version certification table remains authoritative.
- A patched DSH host and profiles with zod >=4.6.6 and undici >=8.12.2; see [host installation and audit instructions](../../docs/registry-releases.md#patched-dsh-host-and-profiles). The plugin does not patch your host automatically.

## Install

From this repository checkout:

```sh
dsh plugin --profile web add ./plugins/kimi-dsh
```

For another DSH profile, replace `web` with its name. To install the published root package instead, run `dsh plugin --profile web add kimi-plugin-cc`.

For DSH Discover, enable **Custom plugin indexes** and add `https://raw.githubusercontent.com/linxule/kimi-plugin-cc/main/dsh/index.json` as an index source.

Restart when requested, then run `/kimi-setup`. Setup is explicit: installing or enabling the bundle does not modify Kimi configuration. Delegation refuses to start when the DSH managed hook is missing or invalid.

Useful setup commands:

```text
/kimi-setup --check
/kimi-setup --models
/kimi-setup --models --json
/kimi-setup --uninstall
```

Model inventory is local and credential-safe; it is not a connection test. Uninstall removes only the DSH managed block. The all-host `--uninstall --all` action is deliberately not exposed through the DSH command.

## Use

Ask DSH to use one of the seven tools with a self-contained task. Each accepts a description, prompt, and optional working directory, returns an activation id, and delivers the final result when the companion finishes. Review and challenge treat the prompt as focus text. Pursue and swarm operations retain their existing finite default budgets; swarm-write returns the captured patch path without applying it.

Prefer `/kimi-cancel` for stopping work when possible. DSH cancellation also terminates the managed subprocess range and waits for quiescence.

## Configuration

The bundle's `kimi-plugin-cc` row accepts:

| Field | Default | Meaning |
|---|---|---|
| `dataRoot` | `$DSH_HOME/plugin-data/kimi-plugin-cc` | Absolute companion data directory; `KIMI_PLUGIN_CC_DATA` overrides the derived default |
| `env` | `{}` | Explicit child environment layered over DSH's credential-scrubbed environment |
| `disposeGraceMs` | `6000` | Managed subprocess termination grace in milliseconds; minimum 6000 |
| `maxOutputBytes` | `16777216` | Maximum captured stdout or stderr bytes per command |
| `model` | Native Kimi default | Optional configured model alias applied to every delegation |
| `thinkingEffort` | Native Kimi default | Optional per-run thinking effort request |
| `budget` | Existing command default | Optional duration such as `30m`, `1h`, or `90s`, validated at load and capped at 24h |
| `reviewBase` | Working tree | Optional Git base applied only to review and challenge |

Host identity, workspace, hook path, Node binary, and bypass variables are provider-owned and cannot be replaced through `env`. The DSH managed block uses host id `dsh`; Claude Code and Codex blocks remain independent. Native Kimi authentication and provider configuration stay under `KIMI_CODE_HOME` or `~/.kimi-code`.

## Limits

- Activations are one-shot and do not accept follow-up input, parent-context inheritance, per-call model overrides, output schemas, or Harness depth enforcement. Use profile configuration for a fixed model or thinking request; interactive ask/rescue resume stays outside the DSH provider.
- DSH activation ids are not companion job ids. Use the slash commands to inspect companion state.
- There is no child progress stream. Response-time budgets, safety ceilings, and timeout artifacts follow the existing companion rules.
- The parent receives final stdout only on success. stderr stays on the host; failures use bounded diagnostics without task text, credentials, or raw protocol payloads.
- This package does not create an account, select a provider, repair Kimi authentication, or provide an approval channel beyond the companion's managed PreToolUse policy.
- Rescue and pursue edit the real selected workspace. Swarm-write works from born HEAD in a temporary worktree, excludes uncommitted changes, and returns a patch without applying or committing it.
