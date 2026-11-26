# Recovering an interrupted swarm

To stop a running swarm normally, run `scripts/companion.sh job cancel <job-id>` in your terminal or call `kimi_job({ action: "cancel", job_id: "..." })` over MCP. The compatibility alias `scripts/companion.sh cancel <job-id>` also works. Normal cancellation stops the active processes without starting a new cleanup server, while a hard `SIGKILL` skips cleanup entirely.

For certified `2.8.0` and newer parallel swarms (`--max-concurrency` of `2` or more), job status includes a durable `swarm_recovery` record. This record stores the resolved home and workspace, companion identity, launch intent, verified process identities, and session identity. It never stores web tokens, credentials, prompts, or config contents, and it commits the session ID before enabling swarm mode. When `--max-concurrency` is `1`, the plugin runs one direct worker without swarm activation, so normal cancellation and patch capture handle cleanup.

Parallel sessions on `2.8.0` and newer keep their `TaskStop`-disabled policy after normal deactivation or recovery. Recovery does not remove that policy. Certification covers the managed job lifecycle rather than interactive resumption of historical swarm sessions in another client.

Recovery resolves the real path of `record.cwd` only when deactivating a session through symlinked parent directories. Ownership, workspace, and patch checks still enforce the original recorded path alias.

## Preview and apply recovery

Run recovery from the original repository using the same plugin data root and Kimi home:

```sh
scripts/companion.sh job recover-swarm <job-id>
scripts/companion.sh job recover-swarm <job-id> --apply
```

Over MCP, call `kimi_job({ action: "recover_swarm", job_id: "..." })` to preview, then add `apply: true` to execute recovery. The CLI compatibility alias `scripts/companion.sh recover-swarm <job-id> [--apply]` also works.

Preview mode never signals processes, edits sessions, or captures patches. When you pass `--apply` or `apply: true`, recovery follows 4 steps in order.

1. It confirms that the original companion process has exited and acquires an atomic, identity-checked recovery claim. A second recovery cannot race an active one, and a later recovery replaces a crashed owner through compare-and-swap.
2. It revalidates recorded processes and process groups, stopping only verified identities and never signaling a guessed PID or unverified group. If it finds an unknown surviving group member, a changed group, an incomplete probe, or an unrecorded launch, it refuses recovery.
3. If session deactivation is pending, it verifies the exact certified CLI and managed PreToolUse hook, then starts one bounded `kimi web --json` lifecycle. It sets `swarm_mode: false`, verifies the WebSocket subscription state, local environment binding, and `swarm_mode.exit` journal entry, and confirms process quiescence. It never resumes a prompt, calls a model, installs hooks, or retries failed cleanup automatically.
4. For a retained write-swarm worktree, it captures an untruncated binary patch without applying the patch or deleting the worktree. The recovery output prints both the patch path and worktree path so you can inspect them.

Each recovery run uses a 30-second cancellation timeout with bounded identity probes and normal teardown. Interrupting recovery preserves its recovery journal, and running recovery again on an already recovered job succeeds as a no-op. Terminal job outcomes (`failed`, `cancelled`, or `completed`) never change, while an abandoned `running` job moves to `failed`. The plugin tracks recovery status separately from job success.

## Limits and manual inspection

Keep 5 boundaries in mind when inspecting or recovering an interrupted swarm:

- a hard kill between process spawn and identity capture leaves an unrecorded launch that `--apply` refuses to guess
- jobs without a recovery record (such as concurrency `1` runs or failures before activation) cannot use automatic recovery
- Windows supports preview mode only and refuses `--apply` because it lacks durable process-identity verification
- a changed Kimi home, missing worktree, invalid hook, uncertain process identity, or changed selected CLI binary causes recovery to refuse and preserve evidence
- the plugin never deletes abandoned worktrees by age, so you can inspect and recover them before removing them manually

If `setup --install-kimi` or `KIMI_PLUGIN_CC_KIMI_BIN` changes the selected Kimi binary after launch, select the job's recorded binary again before running `--apply`. Never bypass the hook or kill processes by name to force recovery.

Recovery relies on the same local, host-owned SQLite database used for execution plans. It does not protect against an untrusted local database, and Git patch capture retains the repository trust boundary in [the safety guide](safety.md).
