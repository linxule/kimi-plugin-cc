# Recovering an interrupted swarm

Normal stop: use `scripts/companion.sh cancel` for a shell-owned run, or the MCP job cancel tool for an MCP-owned run. A hard kill cannot execute cleanup. Cancellation still starts no fresh cleanup server.

For exact CLI 2.3.2 and 2.3.3 swarm runs created by this runtime, status includes a durable `swarm_recovery` record. It contains the resolved home/workspace, companion identity, launch intent, verified process identities and session identity. It never contains the web authentication token, credentials, prompt or config contents. Session identity is committed before the request enabling swarm mode.

## Preview, then recover

Run from the original repository with its original plugin data root and Kimi home:

```sh
scripts/companion.sh recover-swarm <job-id>
scripts/companion.sh recover-swarm <job-id> --apply
```

Preview does not signal processes, modify sessions, or capture patches. Apply:

1. Requires the original companion to be gone and acquires an identity-checked recovery claim. A second recovery cannot race the first; a dead recovery owner can be reclaimed by compare-and-swap.
2. Revalidates recorded processes and groups. It stops only verified individual identities, never a guessed PID or unproven group. An unknown surviving group member, changed group, incomplete probe or unrecorded launch refuses recovery.
3. If session cleanup is pending, requires the selected exact certified CLI and valid managed hook. It starts one bounded authenticated web lifecycle, disables the recorded session's swarm mode, verifies status and the exit journal, then verifies process quiescence. It does not resume a prompt, generate model output, install hooks or retry failed cleanup automatically. New recovery web launches are themselves journaled.
4. Captures a binary patch from a retained write worktree. It does not apply the patch or delete the tree. The result names both paths for inspection.

The recovery attempt has a 30-second cancellation signal, with bounded identity probes and normal teardown. Interrupting recovery retains its journal. An already-recovered record is an idempotent no-op. Failed/cancelled/completed job outcomes are immutable; a previously running abandoned job becomes failed, never completed. Recovery status is separate from task success.

## Limits and manual inspection

- SIGKILL between process creation and durable identity capture leaves an explicit pending launch. Apply refuses to guess ownership. A supervisor/OS-owned launch primitive would be required to eliminate this remaining crash window; the journal does not claim that guarantee.
- No recovery record means no automatic recovery: older runs, or a failure before the record was created, require inspection. Recovery is not general-purpose process or native-session cleanup.
- Windows does not currently provide the required durable process-identity proof. Preview is available; apply refuses. This does not change existing Windows direct-child cancellation limits.
- A changed home, missing/redirected worktree, CLI mismatch, invalid hook or uncertain identity leaves evidence intact and reports failure. Do not repair this by bypassing the hook or killing processes by name.
- Abandoned worktrees are no longer age-deleted. Inspect and recover them before explicitly removing them. This also protects legacy orphaned trees without a recovery record.

The trust boundary is the same local, host-owned plugin database used for execution plans. Recovery does not make an attacker-modified database trustworthy. Internal Git capture retains the repository-configuration trust boundary documented in [safety.md](safety.md).
