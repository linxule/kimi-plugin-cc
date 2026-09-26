# Scripts

The shell entry points run the compiled Node runtime while preserving the caller's project directory.

| File | Purpose |
| --- | --- |
| `companion.sh` | Launch `dist/companion.js` for commands and skills |
| `review-gate-hook.sh` | Launch the optional Claude Code Stop hook |
| `surface-registry.ts` | Define Codex text surfaces and lock Claude surface hashes |
| `generate-surfaces.ts` | Generate Codex manifests, skills, scripts, and the runtime mirror |
| `smoke-rescue-drift.sh` | Run an opt-in live rescue check after CLI changes |
| `audit-subscription-routing.ts` | Offline, exact-source counterexamples to atomic regional routing in CLI 2.0.1 |
| `audit-subscription-recovery.ts` | Offline, exact-source evidence that terminal quota/recovery metadata is unavailable |
| `audit-source.ts` | Extract pinned declarations with the TypeScript 7 async API and transpile probe code with Bun |

Both shell entry points accept `CLAUDE_PLUGIN_ROOT` or `PLUGIN_ROOT` and otherwise use their parent directory. Data selection happens in the runtime. Standard cache installs verify shared data variables against the current package's host-specific directory. Use the absolute `KIMI_PLUGIN_CC_DATA` override for a deliberate custom location; conflicting shared values fail before store access. Checkouts retain unambiguous legacy data variables and the Codex fallback under `CODEX_HOME` or `HOME` when neither is set. A fully sanitized launch with no home needs an explicit data root. See [plugin data ownership](../docs/invariants.md#5-plugin-data-ownership).

`companion.sh` preserves the caller's directory in `KIMI_PLUGIN_CC_WORKSPACE_CWD`. It resolves Node from `KIMI_PLUGIN_CC_NODE_BIN` or `PATH` and requires Node.js 22.5 or newer.

After changing runtime code or shell scripts, run `bun run build && bun run generate:surfaces`. Review and stage `dist/` and `plugins/kimi-codex/`, then run `bun run check`. Never edit the generated Codex package by hand.

Live smoke scripts use model calls. Read the script and the [smoke run instructions](../docs/ci.md) before using them. They are not part of routine offline checks.

The subscription audit scripts take an exact upstream source directory as their single argument. They make no provider calls and read no credentials. Passing means the documented blockers reproduce, not that subscription fallback works. See the [capability audit](../docs/subscription-capability-audit.md).
