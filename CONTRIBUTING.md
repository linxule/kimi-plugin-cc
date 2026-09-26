# Contributing

## Prepare your environment

You need:

- Node.js 22.5 or newer for the runtime and its built-in SQLite support
- Bun for installing dependencies, building, and testing
- macOS or Linux for the POSIX shell entry points

Run `bun install --frozen-lockfile` from the repository root. Installed plugin users do not need Bun or a build step.

Read [AGENTS.md](./AGENTS.md) before changing the runtime. It summarizes the [runtime contracts](./docs/invariants.md).

## Make and check a change

1. Edit the source files. Do not edit `dist/` or `plugins/kimi-codex/` by hand.
2. Run `bun run build && bun run generate:surfaces` after changing runtime code, shell entry points, or generated text sources.
3. Review and stage the generated changes in `dist/` and `plugins/kimi-codex/`.
4. Run `bun run check` from the repository root.

The check rebuilds the runtime, checks generated surfaces, typechecks, runs tests, and checks for generated-file drift. It covers both `dist/` and `plugins/kimi-codex/`, including untracked files. Unstaged generated changes fail the drift check.

Claude commands, agents, and plugin manifests have locked hashes in `scripts/surface-registry.ts`. Update the affected hashes after editing those files, then regenerate surfaces.

Use these commands during development:

- `bun run build` to compile `runtime/` into `dist/`
- `bun run generate:surfaces` to generate Codex skills, manifests, and the bundled runtime
- `bun run check:surfaces` to check the generated files and Claude surface hashes
- `bun test <path>` to run a focused test file

## Keep installed packages complete

Both hosts install precompiled JavaScript. Claude Code uses the root package; Codex uses the self-contained package in `plugins/kimi-codex/`. Commit both generated trees when they change so users can install without building.

## Keep onboarding translations aligned

The README contains English, Simplified Chinese, French, and Japanese guides on one page. Settle the English content before updating the translations. Check natural wording and meaning in each language. Keep commands, flags, model aliases, paths, and version numbers aligned.

Historical release notes record what was true at the time. Update current guidance without rewriting that history.

## Run real-binary smoke tests

The opt-in smoke suite uses real model calls to check hooks, engine provenance, plan-mode refusal, resume, and swarm behavior:

```sh
bun run smoke:real
```

Read [smoke authentication and run instructions](./docs/ci.md#running-the-same-gate-locally) before running it. The harness copies selected files from a seed Kimi home into temporary homes, including credentials when present. Do not treat it as a credential-free check. Use an authorized test account or explicitly authorized temporary credential copies, and run live tests sequentially.

Normal `bun run check` skips these tests. A skipped smoke does not certify a release. The [upstream audit playbook](./docs/upstream-compat-audit.md) defines the additional gates for a new CLI version.

## Release a change

Follow [the release checklist](./AGENTS.md#releasing) and [npm publishing guide](./docs/registry-releases.md). Plugin versions advance independently of the upstream CLI; compatible maintenance and certification updates take the next unused plugin patch. Plugin-only fixes do not change the certified CLI table. Never reuse a published plugin version. Matching version numbers never replace the source audit or live tests. Documentation-only updates do not require a release tag.
