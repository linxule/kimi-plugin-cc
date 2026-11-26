# Continuous integration and live smoke tests

Normal CI uses mock models and needs no model credentials. Live smoke tests are separate, opt-in runs that consume subscription quota or API credit.

## Base CI

Before release validation, run `bun install --frozen-lockfile` locally too.
An existing `node_modules` directory can disagree with the committed lockfile.
Generate all compiled and generated surfaces (`dist/`, `plugins/kimi-codex/`, `cordis.patch.yml`, and `dsh/index.json`) with those dependencies, run the full check, and wait for the release commit's CI success before tagging or publishing.
Keep compiled-runtime regressions that execute emitted JS under Node and Bun;
source-only Bun tests do not exercise TypeScript's compiler output.

[ci.yml](../.github/workflows/ci.yml) runs on pushes to `main` and on pull requests. It installs locked dependencies, runs `bun audit`, and then runs `bun run check`.

The full check covers:

- compiled runtime output and self-contained bundled `dist/hooks/approval-hook.js`
- `AGENTS.md` size gate (strictly below 24,576 bytes)
- pinned root surface hashes and generated Codex (`plugins/kimi-codex/`) and DSH (`cordis.patch.yml`, `dsh/index.json`) surfaces
- TypeScript types
- the test suite, including real-process MCP protocol, `SEP-2640` skills/resources, task recovery, ownership, cancellation, and hook-enforcement coverage
- changed or untracked files in `dist/`, `plugins/kimi-codex/`, `cordis.patch.yml`, and `dsh/index.json`

`bun run check:package` packs the release tarball, verifies the npm-installed `kimi-companion` bin, runs modern MCP discovery plus legacy initialization, setup/check, and version-floor refusal smokes on the extracted package, and boots a fresh patched DSH host against the tarball's `cordis.patch.yml`. These checks use mock-backed or protocol-only fixtures and make no provider calls.

The real-binary smoke suite skips unless explicitly enabled. Before any model turn it removes every other kimi-plugin-cc hook block from its isolated copy of the config, so its allows and denials come from this checkout's hook alone. A successful base CI run does not certify a new CLI version.

## Live smoke coverage

[smoke.yml](../.github/workflows/smoke.yml) runs only by manual dispatch. Its default CLI version is `2.8.0`; the release gate requires every operation, including bounded parallel and single-worker swarm paths. It has no recurring schedule and skips real-provider calls if `KIMI_MODEL_API_KEY` is absent.

The suite checks:

- forced writes denied under each read-only label
- the master experimental flag kept from native-v2 children (and refused before spawn on a pinned legacy-v1 binary)
- an ask that runs with every experimental feature switched on in config and environment, with every non-read tool call denied and no tower state left behind
- default plan mode cancelled by print on `print-cancels-plan` releases and refused before spawn elsewhere
- a fresh ask that opens an earlier job's session log through `--reference-session` and answers from it
- `WaitFor` passing the hook under `ask`, `rescue` (a real wait on a background test run, which needs `bun` on the child's PATH) and `pursue`, each with a recording hook and a same-run managed denial
- native-v2 provenance, resume, and plan-tainted journal refusal
- deterministic loopback Write attempts for native-v2 resume and goal continuation, with exact call IDs and objective-digest store recovery; these two lanes require no real credentials
- managed denials correlated with write attempts across goal-mode continuation turns
- actual read-only swarm fan-out, proved by distinct child journals with each child's assigned Write attempt and managed denial, not merely an `AgentSwarm` call or aggregate denial
- write-swarm edits authored by distinct children and captured in a patch, with the real checkout unchanged; a coordinator-only patch is not fan-out evidence
- out-of-worktree write attempts by real children denied

The `--network` WebSearch lane runs only when the seed home has a Kimi login or config, or `KIMI_WEB_SEARCH_BASE_URL` is set. Kimi offers WebSearch only with its managed login, a provider `search_url`, `[services.moonshot_search]` or `KIMI_WEB_SEARCH_BASE_URL`, so on the API-key route with an empty seed home and no search endpoint the lane is skipped by name. A skip is not evidence: a certification record must say whether that lane ran.

On versions requiring host activation (exact `2.8.0` and future bounded-swarm rows on the parallel path), targeted OFF/ON controls must distinguish direct print (no children) from the preactivated path (real children and verified deactivation). Exit status, tool-call records, denial text, or a patch alone never prove swarm compatibility.

Exact `2.8.0` requires full 7-operation evidence, including the canonical wave guard, new/resumed entry counting, fresh-singleton rejection, nested rejection, recovery, swarm-child-timeout protection, native Bash background-policy closure, explicit background denial, direct-worker read/write behavior, and normal-exit/cancellation quiescence before artifact capture and test-provider cleanup. Agent-turn counts and OS subprocess checks are separate evidence. Expected negative controls must actually reproduce their preconditions. Releases below `2.8.0` and `legacy-v1` are removed in 3.1.0 and refuse before spawn.

For a new native-v2 candidate above `2.8.0`, follow the [certification playbook](./upstream-compat-audit.md). A candidate smoke is not production certification.

## Authentication and credential handling

The local harness copies selected seed-home files into temporary Kimi homes: `config.toml`, `device_id`, `mcp.json`, and `tui.toml` when present. The OAuth token stores `credentials/` and `oauth/` are **symlinked, never copied** (since 2.2.1): a copied store that refreshes rotates the refresh token and leaves the real store with a revoked grant once the copy is removed. It does not touch the session store.

The default seed home is `~/.kimi-code`. Setting API environment variables does not disable seed-file copying. To avoid copying personal credentials, set `KIMI_PLUGIN_CC_SMOKE_HOME` to a dedicated empty test home and supply authorized `KIMI_MODEL_*` credentials through the environment.

Do not run a smoke against a personal seed home unless that use of the operator's login is explicitly authorized for that run. Run live controls and smokes sequentially. Copied token stores invalidated the operator's login twice (2026-09-15, 2026-10-15; `The provided authorization grant is invalid`, fixed only by `kimi login`) — never reintroduce copying, and never write an ad-hoc control that copies `~/.kimi-code/credentials`. Temporary homes are cleaned up by the harness (removing a symlink never touches the real store); inspect cleanup after an interrupted run.

Routine diagnosis uses the active installation's `setup --check` or `setup --models`. Do not print raw config or OAuth files. Do not paste credentials into commands, logs, issues, or assistant conversations.

## Running the same gate locally

After choosing an authorized authentication route, run from the plugin repository root:

```sh
bun run smoke:real
```

The default route seeds your local Kimi home as described above. It consumes subscription quota; it is not a free or credential-free test.

To use API authentication without seeding personal files, first supply the authorized `KIMI_MODEL_NAME` and `KIMI_MODEL_API_KEY` environment variables. Then run:

```sh
SMOKE_SEED_DIR=$(mktemp -d)
KIMI_PLUGIN_CC_SMOKE_HOME="$SMOKE_SEED_DIR" bun run smoke:real
```

The seed directory is empty and can be removed afterward. Choose provider type and endpoint through the supported `KIMI_MODEL_*` settings if your account requires them. A configured model or an existing credential file is not proof that authentication works.

**Maintainer route (1Password Agent Keys, no Touch ID, no OAuth store):** keep the API key in the read-only
service-account vault and resolve it only for the smoke process:

```sh
# ~/.secrets.agent.kimi-plugin-cc.op maps only KIMI_CODE_API_KEY to the vault item
# (by UUID), so unrelated shared-vault items cannot block this task. Adapt it to
# the CLI's env-model channel with the documented coding endpoint.
op-agent run --env-file ~/.secrets.agent.kimi-plugin-cc.op -- bash -c '
  export KIMI_MODEL_API_KEY="$KIMI_CODE_API_KEY"
  export KIMI_MODEL_NAME="kimi-for-coding"
  export KIMI_MODEL_PROVIDER_TYPE="kimi"
  export KIMI_MODEL_BASE_URL="https://api.kimi.com/coding/v1"
  export KIMI_PLUGIN_CC_SMOKE_HOME="$(mktemp -d)"
  bun run smoke:real
'
```

This never touches the operator's subscription login, so the token-rotation hazard above cannot occur. It
consumes API credit, not subscription quota, and the synthesized provider is not trait-driven, so a
`--thinking` request would be a no-op there (irrelevant to the smoke lanes). Prefer this route for every
release gate; the seeded-personal-home route is the fallback when no API key is available.

To test an exact CLI without updating the installed binary:

```sh
SMOKE_BIN_DIR=$(mktemp -d)
(
  cd "$SMOKE_BIN_DIR"
  printf '%s\n' '{"name":"kimi-smoke","private":true}' > package.json
  npm install --no-package-lock --no-save @moonshot-ai/kimi-code@2.8.0
)
KIMI_PLUGIN_CC_KIMI_BIN="$SMOKE_BIN_DIR/node_modules/.bin/kimi" bun run smoke:real
```

This changes only the binary used by the smoke. It does not change authentication or the seed-home requirement. Inspect the full result: skipped tests and unmet fan-out preconditions are not passes. Do not hide the test's exit status behind a shell pipeline.

## Configure manual Actions runs

Store CI credentials in GitHub Actions secrets. The workflow uses the API environment route, not an interactive subscription login.

| Kind | Name | Purpose |
| --- | --- | --- |
| Secret | `KIMI_MODEL_API_KEY` | Authorized provider API key |
| Secret | `KIMI_MODEL_NAME` | Provider model ID |
| Variable | `KIMI_MODEL_PROVIDER_TYPE` | Provider type; workflow default is `kimi` |
| Variable | `KIMI_MODEL_BASE_URL` | Optional endpoint override |

Billing and access depend on the account behind the key. The workflow references secret names; never commit their values. Dispatching a run can make paid model calls.

## DSH host smoke and release maintenance

`node scripts/check-dsh-package.mjs [destination]` packs the root npm artifact and creates a fresh DSH `0.2.1-rc.5` host with explicit `zod` (`>=4.6.6`) and `undici` (`>=8.12.2`) dependency overrides. It audits both that host and the isolated plugin profile for high or critical advisories, mounts the tarball's root `cordis.patch.yml` (`@deepseek-ai/dsh-mcp-client` and `@deepseek-ai/dsh-skill-filesystem`), boots `dsh web`, verifies that all 4 MCP tools (`mcp__kimi__kimi_read`, `mcp__kimi__kimi_write`, `mcp__kimi__kimi_job`, `mcp__kimi__kimi_setup`) and the `kimi` skill register on `ctx.tools` and `ctx.skills`, and exercises a credential-free `mcp__kimi__kimi_setup` (`{ action: "models" }`) call through the live DSH bridge. It makes no model calls and touches no maintainer Kimi configuration. An existing host binary cannot substitute for the audited installation. See [patched DSH host and profiles](./safety.md#patched-dsh-host-and-profiles); verify the current supported release and the latest prerelease before widening `engines.dsh`. The separate `bun run check:consumer-security` gate installs the packed package normally into a fresh npm consumer and audits its production graph; both CI and release validation run it.

For live DSH integration smoke, install the root package into an isolated DSH profile, install the canonical PreToolUse hook through `kimi_setup` (`action: "install"`) or `scripts/companion.sh setup`, and use an isolated Kimi home with an authorized authentication route.

Required scenarios for a host-parity change are:

- `kimi_read` (`mode: "ask"`) returns `4`
- a write attempt through `kimi_read` is denied and creates no file
- `kimi_write` (`mode: "rescue"`) writes only the requested marker inside the workspace
- `kimi_write` (`mode: "swarm_patch"`) returns a valid disjoint-target patch without applying it or modifying the real workspace
- `kimi_setup` (`check` and `models`) and the `kimi` skill resolve cleanly

Inspect the persisted job result, marker file, and patch artifact rather than relying only on parent completion text. Run these sequentially, keep all test state in throwaway homes, and clean up interrupted processes and worktrees.

Every release also updates `DSH_PUBLISH_TIMESTAMP` in `scripts/surface-registry.ts`, regenerates `cordis.patch.yml` and `dsh/index.json`, and validates the version, timestamp, and engine assertions in `tests/runtime/dsh-surfaces.test.ts`. This keeps the DSH Discover entry aligned with the published package.

## Dependency maintenance

Dependabot checks the Bun manifest, lockfile, and GitHub Actions weekly. Updates require review; automatic merge and release are not configured.

The vendored runtime parsers are outside `bun audit` coverage. Review [TOML parser provenance](../runtime/vendor/smol-toml/README.md) and [shell parser provenance](../runtime/vendor/shell-quote/README.md) when an advisory affects them. Parser regressions cover source, compiled output, and the Codex runtime mirror.

## Windows spawn controls

The `windows-spawn` CI job compiles TypeScript on `windows-latest` and runs `node --test tests/windows/spawn-preflight.mjs` with Node 22. It checks UTF-16 quoting bounds, a short Node subprocess spawn, and pre-spawn `CLI_COMMAND_LINE_TOO_LONG` refusal of a 103 KB prompt. It uses no credentials, Kimi binary, or model calls.

Run the same offline diagnostics locally with Node.js `22.5` or newer and Bun:

```powershell
bun install --frozen-lockfile
bunx tsc -p tsconfig.build.json
node --test tests/windows/spawn-preflight.mjs
```

This does not certify native Kimi, Git Bash, or Windows execution; report native CLI or Git Bash findings in [issue #14](https://github.com/linxule/kimi-plugin-cc/issues/14). The normal `check` also enforces the `AGENTS.md` size limit.

## npm OIDC publishing

Before configuring Trusted Publishing, publish the validated `npm-package` workflow tarball once with `npm login` and `npm publish kimi-plugin-cc-X.Y.Z.tgz --access public`. Configure npm Trusted Publishing for owner `linxule`, repository `kimi-plugin-cc`, workflow `publish.yml`, environment `npm`, and direct publishing, then set repository variable `NPM_TRUSTED_PUBLISHING=true`. Use `npm` only for registry operations and package installs while keeping Bun for development.

On every `release.published` event, [.github/workflows/publish.yml](../.github/workflows/publish.yml) verifies that the tag matches `package.json`, runs `bun run check`, `check-package.mjs`, `check-dsh-package.mjs`, and `bun run check:consumer-security`, and publishes the single root tarball through OIDC with provenance (which also serves DSH via root `cordis.patch.yml`). If a release run fails before npm accepts the tarball, confirm on npm that the version was not published, then trigger `publish.yml` manually with the existing tag. Published versions never change.
