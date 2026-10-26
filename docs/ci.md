# Continuous integration and live smoke tests

Normal CI uses mock models and needs no model credentials. Live smoke tests are separate, opt-in runs that consume subscription quota or API credit.

## Base CI

Before release validation, run `bun install --frozen-lockfile` locally too.
An existing `node_modules` directory can disagree with the committed lockfile.
Generate both runtime distributions with those dependencies, run the full
check, and wait for the release commit's CI success before tagging/publishing.
Keep compiled-runtime regressions that execute emitted JS under Node and Bun;
source-only Bun tests do not exercise TypeScript's compiler output.

[ci.yml](../.github/workflows/ci.yml) runs on pushes to `main` and on pull requests. It installs locked dependencies, runs `bun audit`, and then runs `bun run check`.

The full check covers:

- compiled runtime output
- Claude surface hashes and generated Codex surfaces
- TypeScript types
- the test suite, including real-process MCP protocol, task recovery, ownership, cancellation, and hook-enforcement coverage
- changed or untracked files in `dist/` and `plugins/kimi-codex/`

`bun run check:package` additionally packs the release tarball and runs modern MCP discovery plus legacy initialization on both extracted compiled distributions. These checks use mock-backed or protocol-only fixtures and make no provider calls.

The real-binary smoke suite skips unless explicitly enabled. A successful base CI run does not certify a new CLI version.

## Live smoke coverage

[smoke.yml](../.github/workflows/smoke.yml) runs only by manual dispatch. Its default CLI version is `2.3.2`. It has no recurring schedule and skips model calls if `KIMI_MODEL_API_KEY` is absent.

The suite checks:

- forced writes denied under each read-only label
- unsafe experimental selectors and default plan mode refused before spawn
- native-v2 provenance, resume, and plan-tainted journal refusal
- hook enforcement across goal-mode continuation turns
- actual read-only swarm fan-out, proved by distinct child journals with each child's assigned Write attempt and managed denial, not merely an `AgentSwarm` call or aggregate denial
- write-swarm edits authored by distinct children and captured in a patch, with the real checkout unchanged; a coordinator-only patch is not fan-out evidence
- out-of-worktree write attempts by real children denied

On versions requiring host activation (currently exact 2.3.2), targeted OFF/ON controls must also distinguish direct print (no children) from the preactivated path (real children and verified deactivation). Exit status, tool-call records, denial text, or a patch alone never prove swarm compatibility.

Legacy-v1 binaries use the applicable legacy lanes. For a new native-v2 candidate, follow the [certification playbook](./upstream-compat-audit.md). A candidate smoke is not production certification.

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
# ~/.secrets.agent.op maps KIMI_CODE_API_KEY to the vault item (by UUID).
# Adapt it to the CLI's env-model channel with the documented coding endpoint.
op-agent run --env-file ~/.secrets.agent.op -- bash -c '
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
  npm install --no-package-lock --no-save @moonshot-ai/kimi-code@2.3.2
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

## Dependency maintenance

Dependabot checks the Bun manifest, lockfile, and GitHub Actions weekly. Updates require review; automatic merge and release are not configured.

The vendored runtime parsers are outside `bun audit` coverage. Review [TOML parser provenance](../runtime/vendor/smol-toml/README.md) and [shell parser provenance](../runtime/vendor/shell-quote/README.md) when an advisory affects them. Parser regressions cover source, compiled output, and the Codex runtime mirror.

## Windows spawn controls

The `windows-spawn` CI job compiles TypeScript on `windows-latest` and runs `node --test tests/windows/spawn-preflight.mjs` with Node 22. It checks UTF-16/quoting bounds, a real short Node spawn and refusal of a 103 KB prompt through the emitted CLI client before spawn. It uses no credentials, Kimi binary or model calls. This is not native Kimi, Git Bash or full Windows lifecycle certification; community reproduction of issue #14 remains welcome; see [the validation checklist](windows-validation.md). The normal `check` also enforces the AGENTS.md size limit.
