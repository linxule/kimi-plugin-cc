# Contributing

## Prepare your environment

You need:

- Node.js 22.5 or newer for the runtime and its built-in SQLite support
- Bun for installing dependencies, building, and testing
- macOS or Linux for the POSIX shell entry points

Run `bun install --frozen-lockfile` from the repository root. Installed plugin users do not need Bun or a build step.

Read [AGENTS.md](./AGENTS.md) before changing the runtime. It summarizes the [runtime contracts](./docs/invariants.md).

## Make and check a change

1. Edit the source files. Do not edit `dist/`, `plugins/kimi-codex/`, or `plugins/kimi-dsh/` by hand.
2. Run `bun run build && bun run generate:surfaces` after changing runtime code, shell entry points, or generated text sources.
3. Review and stage the generated changes in all three trees.
4. Run `bun run check` from the repository root.

The check rebuilds the runtime, checks generated surfaces, typechecks, runs tests, and checks for generated-file drift. It covers `dist/` and both plugin distributions, including untracked files. Unstaged generated changes fail the drift check.

Claude commands, agents, and plugin manifests have locked hashes in `scripts/surface-registry.ts`. Update the affected hashes after editing those files, then regenerate surfaces.

## Keep MCP transport behavior explicit

Keep Claude's per-request MCP task negotiation separate from Codex's ordinary launch/polling results; never infer task support from the server, a previous call, or a host name alone. New operations must use typed schemas and the existing companion dispatch, fixed task/job identity, `operation_kind`, exact workspace binding, and hook/preflight checks. Do not add a raw argv escape hatch or run model jobs inside the MCP server process.

Never overwrite a saved process identity during attachment. After an inconclusive identity or post-signal probe, keep the launch starting and recoverable by its public job ID; terminalize only on settled evidence. Reconcile a genuinely dead starting companion after the stale grace instead of leaving it in a permanent mismatch loop. Generic stale sweeps skip MCP-owned rows, and direct CLI cancellation refuses them; only MCP-bound controls may signal their recorded processes.

Run `bun test tests/runtime/mcp-*.test.ts` for transport changes. Cover compiled stdio framing, reconnects, terminal-result mapping, process identity, and both host distributions. `bun run check:package` must prove modern discovery and legacy initialization from the packed plugin.

## Keep code comments useful

Write comments only for current, non-obvious constraints, upstream quirks, and safety boundaries. Do not add cutover narratives, PR or reviewer attributions, release history, or narration that merely restates code and tests. Update or delete stale comments in the same change that makes them stale. Put release history in `CHANGELOG.md` or `ROADMAP-TO-GA.md`, and exact-version certification evidence in `docs/upstream-*-certification.md`.

Use these commands during development:

- `bun run build` to compile `runtime/` into `dist/`
- `bun run generate:surfaces` to generate Codex and DSH surfaces and bundled runtimes
- `bun run check:surfaces` to check generated files and Claude surface hashes
- `bun test <path>` to run a focused test file

## Keep installed packages complete

All hosts install precompiled JavaScript. Claude Code uses the root package, Codex uses `plugins/kimi-codex/`, and DSH uses `plugins/kimi-dsh/`. Commit all generated trees when they change so users can install without building.

## Keep onboarding translations aligned

The README contains English, Simplified Chinese, French, and Japanese guides on one page. Settle the English content before updating the translations. Check natural wording and meaning in each language. Keep commands, flags, model aliases, paths, and version numbers aligned.

Historical release notes record what was true at the time. Update current guidance without rewriting that history.

## Run real-binary smoke tests

The opt-in smoke suite uses real model calls to check hooks, engine provenance, plan-mode refusal, resume, and swarm behavior:

```sh
bun run smoke:real
```

Read [smoke authentication and run instructions](./docs/ci.md#running-the-same-gate-locally) before running it. The harness copies selected config files and symlinks OAuth credential stores into temporary homes; it never copies those stores. Do not treat it as a credential-free check. Use an authorized test account or explicitly authorized shared credential symlinks, and run live tests sequentially.

Normal `bun run check` skips these tests. A skipped smoke does not certify a release. The [upstream audit playbook](./docs/upstream-compat-audit.md) defines the additional gates for a new CLI version.

## Release a change

Follow [the release checklist](./AGENTS.md#releasing) and [npm publishing guide](./docs/registry-releases.md). Plugin versions advance independently of the upstream CLI; compatible maintenance and certification updates take the next unused plugin patch. Plugin-only fixes do not change the certified CLI table. Never reuse a published plugin version. Matching version numbers never replace the source audit or live tests. Documentation-only updates do not require a release tag.

Name Kimi and other substantive contributors in commit trailers and release notes. Credit implementation and review work accurately; do not invent usernames, email addresses, or verified account links.
