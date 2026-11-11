# Registry releases

The npm package `kimi-plugin-cc` ships the Claude plugin at its root and the
self-contained Codex and DSH plugins under `plugins/`. DSH users install that
same root package with `dsh plugin --profile <name> add kimi-plugin-cc`.
GitHub marketplaces remain available. The package has no install scripts and
no separate CLI.

## Publishing status

Plugin **2.5.7** certifies exact Kimi Code **2.5.3** for all eight operations, alongside 2.5.0, 2.5.1 and 2.5.2; see the [2.5.3 certification record](./upstream-2.5.3-certification.md). Candidate and production matrices each passed 24 tests with 201 assertions and no skips. The corrected-tree full check passed 1,437 tests with 18,980 assertions in 396.30 seconds, package validation passed 332 files across all three distributions, and isolated consumer security passed. Codex returned APPROVE with no findings; Claude returned READY-TO-TAG with no blocker or major findings, and its two chronology corrections are included. Publication does not update installed hosts or operator pins. [Release v2.5.7](https://github.com/linxule/kimi-plugin-cc/releases/tag/v2.5.7) is anchored at `b203b6fd0db865935bf47241ee4ea8cf3931b9a5`. [Release-commit CI](https://github.com/linxule/kimi-plugin-cc/actions/runs/43045729840) and [OIDC publication](https://github.com/linxule/kimi-plugin-cc/actions/runs/43046887763) passed. The 332-file registry tarball has SHA-1 `adfee8da730dc14349d26125bc5add44fe204aa5`, matches the validated workflow artifact byte-for-byte, and carries signed provenance (sigstore log index `3812668747`). A fresh registry npm installation has zero production advisories; isolated Claude Code, Codex, and DSH setup/checks and unsupported-version refusal pass, and all compiled runtime mirrors match the release tag. The Discover timestamp records npm publication at `2026-11-11T15:25:33.059Z`.

Plugin **2.5.6** certifies exact Kimi Code **2.5.2** for all eight operations, alongside 2.5.0 and 2.5.1; see the [2.5.2 certification record](./upstream-2.5.2-certification.md). Candidate and production matrices each passed 24 tests with 167 assertions and no skips. The full check passed 1,429 tests with 18,662 assertions, package validation passed 331 files across all three distributions, and isolated consumer security passed. Publication does not update installed hosts or operator pins. [Release v2.5.6](https://github.com/linxule/kimi-plugin-cc/releases/tag/v2.5.6) is anchored at `a9585a1cd4177b17e422b63305d390aa1f1b9c81`. [Release-commit CI](https://github.com/linxule/kimi-plugin-cc/actions/runs/42376507143) and [OIDC publication](https://github.com/linxule/kimi-plugin-cc/actions/runs/42381804227) passed; the first three publication attempts failed with `TLOG_CREATE_ENTRY_ERROR` during a Sigstore Rekor database upgrade and published nothing, and attempt 4 succeeded unchanged. The 331-file registry tarball has SHA-1 `32c712a00186c1b0a334bf39d03cc397a2012b05`, matches the validated workflow artifact byte-for-byte, and carries provenance (sigstore log index `3739983164`). A fresh registry npm installation has zero production advisories and all compiled runtime mirrors match. The Discover timestamp records npm publication at `2026-11-07T14:56:36.462Z`.

Plugin **2.5.5** keeps every host's managed hook block contiguous in the shared `~/.kimi-code/config.toml`, so a comment-preserving third-party writer that regroups tables cannot strip a block's BEGIN marker, and scopes orphan-marker verification per host: another host's orphan warns, own and legacy orphans still fail closed, and the remedy is plain setup. Exact CLI certification remains 2.5.0 and 2.5.1; publication does not update installed hosts or operator pins. The [v2.5.5 release](https://github.com/linxule/kimi-plugin-cc/releases/tag/v2.5.5) is anchored at `ba0bb8f293839d8658f9486da2feb32908eab4d4`. [Release-commit CI](https://github.com/linxule/kimi-plugin-cc/actions/runs/42372824792) and [OIDC publication](https://github.com/linxule/kimi-plugin-cc/actions/runs/42373304448) passed. The 330-file registry tarball has SHA-1 `b035ab57aa7902538c13bee384b2dead48c2a57c`, matches the validated workflow artifact byte-for-byte, and carries provenance (sigstore log index `3738319436`). A fresh registry npm installation has zero production advisories and all compiled runtime mirrors match. The Discover timestamp records npm publication at `2026-11-07T12:44:10.489Z`.

Plugin **2.5.4** restores the original platform-neutral bounded-close settlement for swarm agent-state verification after follow-up CI showed that `wasClean` can both accept an early close and reject a valid one. The immutable 2.5.3 artifact contains that trial condition; 2.5.4 carries its revert with deterministic no-close-event coverage and a protocol-correct mock handshake, without changing exact CLI certification through 2.5.1. Activation validation passed 71 tests with 244 assertions, the full repository check passed 1,412 tests with 18,282 assertions, and 330-file package and consumer-security validation passed. [Release v2.5.4](https://github.com/linxule/kimi-plugin-cc/releases/tag/v2.5.4) is anchored at `836da262ae303f51c9049b2711c9d957d7692ed2`. [Release-commit CI](https://github.com/linxule/kimi-plugin-cc/actions/runs/42249517714) and [OIDC publication](https://github.com/linxule/kimi-plugin-cc/actions/runs/42251575637) passed. The 330-file registry tarball has SHA-1 `b9e23fe6b1ceb54fdc5ee26447da050653526b7f`, matches the validated workflow artifact byte-for-byte, and carries provenance (sigstore log index `3721306580`). A fresh registry npm installation has zero production advisories; isolated Claude Code, Codex, and DSH setup/checks pass, and all compiled runtime mirrors match. The Discover timestamp records npm publication at `2026-11-06T16:29:28.637Z`.

Plugin **2.5.3** certifies exact Kimi Code **2.5.0 and 2.5.1** for all eight operations, adding local-execution/workspace-trust closures and authenticated WebSocket swarm activation with deterministic close-timeout coverage while preserving the no-plan construction and legacy-v1 0.41.x boundary. See the [2.5.0](./upstream-2.5.0-certification.md) and [2.5.1](./upstream-2.5.1-certification.md) certification records. The 2.5.1 source scan passed 18 tests with 153 assertions; candidate and production matrices each passed 24 tests with 167 assertions and no skips. The full check passed 1,412 tests with 18,282 assertions, package validation passed 330 files across all three distributions, isolated consumer security passed, and independent read-only `claude -p` review returned APPROVE. [Release v2.5.3](https://github.com/linxule/kimi-plugin-cc/releases/tag/v2.5.3) is anchored at `11d862a3fd9dae006c6888bfa221ea73101fb171`. [Final release-commit CI](https://github.com/linxule/kimi-plugin-cc/actions/runs/42237176295) and [OIDC publication](https://github.com/linxule/kimi-plugin-cc/actions/runs/42238045923) passed. The 330-file registry tarball has SHA-1 `6aa5ab4a2c862347e14354698b2ba6f7f8b1defd`, matches the validated workflow artifact byte-for-byte, and carries provenance (sigstore log index `3719667960`). A fresh registry npm installation has zero production advisories; isolated Claude Code, Codex, and DSH setup/checks pass, and all compiled runtime mirrors match. The Discover timestamp records npm publication at `2026-11-06T15:01:13.468Z`. Follow-up CI showed that `wasClean` is inconsistent and has been reverted on `main`; the published 2.5.3 artifact contains the trial condition. [Plugin 2.5.4](https://github.com/linxule/kimi-plugin-cc/releases/tag/v2.5.4) carries the correction.

Plugin **2.5.2** hardens setup recovery and DSH dependency ownership. Its real Kimi Code **2.4.1** smoke passed **24 tests and 167 assertions with no skips**; the exact-source audit passed **16 tests and 97 assertions**. Normal npm installation keeps DSH host services optional. DSH use requires explicitly patched host/profile dependencies and both installation audits described below. Exact CLI certification remains unchanged. [Release v2.5.2](https://github.com/linxule/kimi-plugin-cc/releases/tag/v2.5.2) is anchored at `8b303bb6e49c581ad96c72bd031e8fd1643c9121`. [Release-commit CI](https://github.com/linxule/kimi-plugin-cc/actions/runs/41361753223) and [npm publication](https://github.com/linxule/kimi-plugin-cc/actions/runs/41362262009) passed. The 328-file registry tarball has SHA-1 `e620040dd35986a6929be7ad677642729a3126e7`, matches the validated workflow artifact byte-for-byte, and carries provenance (sigstore log index `3636981979`). A fresh registry npm installation has zero production advisories; isolated Claude Code, Codex, and DSH setup/checks pass, and all compiled runtime mirrors match. The Discover timestamp records npm publication at `2026-11-01T23:35:04.270Z`.

Plugin **2.5.1** adds DeepSeek Harness through the existing root npm package and its established OIDC workflow. [Release v2.5.1](https://github.com/linxule/kimi-plugin-cc/releases/tag/v2.5.1) is anchored at `afe68ee2f0e7744e1fc97eb0f1e4007585d969d0`; its [CI check](https://github.com/linxule/kimi-plugin-cc/actions/runs/41335810767) and [release-event publishing run](https://github.com/linxule/kimi-plugin-cc/actions/runs/41336273042) passed. The registry tarball has SHA-1 `f0e42febcb14082be6a654b9b0830885242fd92a`, contains 328 files, matches the CI artifact, and carries signed provenance (sigstore log index `3635166158`). A fresh registry installation into an isolated DSH profile composed all seven providers and booted the Web host. DSH users install with `dsh plugin --profile <name> add kimi-plugin-cc`; no second npm package or Trusted Publishing binding is required.

Plugin **2.4.5** certifies exact CLI **2.4.1** for all eight operations with host-preactivated swarm sessions. [Release v2.4.5](https://github.com/linxule/kimi-plugin-cc/releases/tag/v2.4.5) is anchored at `de8c195c2986443a088b674717133b164d2e4ef2`; its [CI check](https://github.com/linxule/kimi-plugin-cc/actions/runs/41226096281) and [release-event publishing run](https://github.com/linxule/kimi-plugin-cc/actions/runs/41226438326) passed. The registry tarball has SHA-1 `39f97a6de4b26ad51ac77305054682fcd5cd0164`, contains 233 files, and matches the CI artifact byte-for-byte. Fresh registry installs passed setup/check and unsupported-version refusal for both Claude Code and Codex, and both compiled mirrors are byte-identical to the release checkout. See the [certification record](./upstream-2.4.1-certification.md) and structured verification at `.claude/kimi-code-research/release-2.4.5/registry-verification.json`.

Plugin **2.4.2** adds durable interrupted-swarm recovery and Windows spawn diagnostics.
Exact CLI certification remains unchanged through **2.3.2**; this is not a new
Windows-support or large-prompt-transport claim. See the [release](https://github.com/linxule/kimi-plugin-cc/releases/tag/v2.4.2),
[recovery guide](./swarm-recovery.md), and [Windows community controls](./windows-validation.md).
Publication uses the same validated-tarball OIDC workflow below; release execution
and registry verification are recorded in the release notes.

Plugin **2.4.1** certifies exact CLI **2.3.2** for all eight operations with host-preactivated swarm sessions. [Release v2.4.1](https://github.com/linxule/kimi-plugin-cc/releases/tag/v2.4.1) is anchored at `06a0a47f2b34dffb8dd71e7ce93646212e74ed19`; its [CI check](https://github.com/linxule/kimi-plugin-cc/actions/runs/40236704464) and [release-event publishing run](https://github.com/linxule/kimi-plugin-cc/actions/runs/40237085945) passed. The registry tarball has SHA-1 `77fe6daaa0f23750cc9b5d857bdbdd5107a7d4ce`, contains 224 files, and matches the CI artifact byte-for-byte. Fresh installs from the CI artifact and npm registry both passed isolated setup/check for Claude Code and Codex. The earlier CI attempt 40231073897 exposed an intermittent root-exit cleanup issue; the root-continuity fix and independent review landed before tagging. Final closeout CI run 40238295139 passed.

Plugin **2.4.0** preserves exact CLI **2.3.1** certification and adds the shared MCP transport. [Release v2.4.0](https://github.com/linxule/kimi-plugin-cc/releases/tag/v2.4.0) is anchored at `9232d1ec98465454d8d9328e439d3f31bfc53e04`; its [CI check](https://github.com/linxule/kimi-plugin-cc/actions/runs/40040084944) and [release-event publishing run](https://github.com/linxule/kimi-plugin-cc/actions/runs/40040442610) passed. The registry tarball has SHA-1 `8243616529aa9f03f26bf4fef68c36d90e2304ae`, contains 222 files, and matches the CI artifact byte-for-byte. A fresh npm install passed isolated setup/check for both hosts.
The previous verified publication was **2.3.1**:
[Release v2.3.1](https://github.com/linxule/kimi-plugin-cc/releases/tag/v2.3.1) is anchored at `20011ff0554c611afe0a426b30a68c2473175568`; its [CI check](https://github.com/linxule/kimi-plugin-cc/actions/runs/39977037533) and [release-event publishing run](https://github.com/linxule/kimi-plugin-cc/actions/runs/39977818482) passed. The registry tarball has SHA-1 `e309448480a2ce841b49840cdaeeed37acc6c50b`, contains 196 files, and matches the CI artifact byte-for-byte. See the [certification evidence](./upstream-2.3.1-certification.md).
Earlier verified publication was **2.2.2**:
[Release v2.2.2](https://github.com/linxule/kimi-plugin-cc/releases/tag/v2.2.2)
is anchored at `256e78ff7cbf302fb19e8e523d8e3f943f7cb366`; its
[CI check](https://github.com/linxule/kimi-plugin-cc/actions/runs/39755724024)
and [release-event publishing run](https://github.com/linxule/kimi-plugin-cc/actions/runs/39755982507)
passed. npm accepted the OIDC publication with signed provenance (sigstore log
index `3383319298`) and tarball shasum
`31aa9752bf05dc4e9c818d5eef5f99e604968613`. The registry tarball matches the
validated Actions artifact byte-for-byte. A fresh npm install passed isolated
setup/check for both hosts, and both runtime mirrors match the release checkout.
Metadata and tarball availability propagated separately; the tarball endpoint
briefly served a cached 404 (300-second TTL). No publication retry was needed.
Publication does not update installed
hosts, re-pin their hooks, or change the operator's CLI binary.

### Previous publications

As of October 15, 2026, [2.2.1 is live on npm](https://www.npmjs.com/package/kimi-plugin-cc/v/2.2.1), published by
the release-event run of `publish.yml` (run 38720071707) through GitHub Actions OIDC with a signed
provenance statement (sigstore log index 3263398504; tarball shasum
`03907c66d440155763a860ab52b5107c0233938b`, registry propagation took a few minutes this time).
2.2.0 (same day, run 38658918855, log index 3256863983) was the first release where the tag-triggered
path worked end to end without a manual dispatch; 2.0.8 (same day, run 38650044033) was the first
OIDC publication; 2.0.7 (September 26) was the hand-published bootstrap.
The first upload used the validated GitHub Actions artifact and interactive npm
authentication. Its public tarball matched that artifact byte-for-byte, and a
fresh registry install passed isolated setup/check for both hosts.

The trusted publisher is configured for `linxule/kimi-plugin-cc`, workflow
`publish.yml`, environment `npm`, with direct publishing allowed.
`NPM_TRUSTED_PUBLISHING=true` is enabled in GitHub Actions. Future GitHub releases
use short-lived OIDC credentials, without a stored npm token or interactive 2FA.
OIDC publication is established; never republish an existing version.

**2026-10-15 status.** The `v2.0.8` release triggered the first OIDC attempt. It
failed twice on the publish step for reasons unrelated to the package: current
npm parses a bare `package/<file>.tgz` argument as the GitHub shorthand
`github:package/<file>` (fixed in `publish.yml`, which now locates the tarball
and publishes an anchored `./` path), and the manual re-dispatch then received
`404 Not Found - PUT https://registry.npmjs.org/kimi-plugin-cc`, the response
npm gives when the OIDC token exchange is refused. The GitHub Actions side
checks out (environment `npm` exists with no protection rules;
`NPM_TRUSTED_PUBLISHING=true`), so the cause was on npmjs.com: the trusted-publisher binding created on
September 26 had **expired unused** (npm expires a binding that never publishes).
Deleting it and creating a new one (GitHub Actions, `linxule` / `kimi-plugin-cc` /
`publish.yml` / environment `npm`, with *Allow npm publish* ticked) and
dispatching `publish.yml` with `tag=v2.0.8` published 2.0.8 with provenance. A new
binding shows *Pending validation* until its first publish, which must happen
within about a day; publish promptly after creating one, and expect to recreate it
after a long gap between releases. Note that a `release` event runs the workflow
file at the tag, so fixes to `publish.yml` reach an existing tag only through
`workflow_dispatch`.

## Validation

Use the repository's normal version bump and generated-surface procedure in
AGENTS.md. Keep plugin and npm versions identical, and update
`DSH_PUBLISH_TIMESTAMP` with the actual publication time so the generated DSH
Discover index stays current. Certification for new Kimi Code versions still
requires the source audit and real-binary controls; adding a registry channel
does not certify another CLI version.

```sh
bun install --frozen-lockfile
bun run build
bun run generate:surfaces
# Review and stage generated distributions before the drift gate.
bun run check
bun run check:consumer-security
node scripts/check-package.mjs .tmp/npm
node scripts/check-dsh-package.mjs .tmp/dsh-npm
```

The root package check inspects the actual tarball, rejects sync-conflict copies in
any path component, verifies runtime copies and vendored licenses, and
installs/checks the safety hook in isolated homes for all three hosts. It also
exercises unsupported-version refusal using a fake CLI and modern MCP discovery
plus legacy initialization on the extracted compiled distributions. The DSH
check installs that same root tarball into an isolated DSH home, verifies all
seven tools, and boots the Web host. Neither check invokes a model or reads the
maintainer's Kimi configuration.

The consumer-security gate installs the packed package into a fresh npm project
and audits the resolved production dependency graph. DSH services and its tool
adapter are optional peers supplied by the DSH host; ordinary npm installation
for Claude Code or Codex does not install the harness. Optional peers still
carry compatibility ranges when present. The gate runs in CI and release
validation and refuses high/critical advisories, failed audits, and incomplete
reports. The checkout's overrides do not constrain downstream npm resolution.

### Patched DSH host and profiles

DSH 0.2.1-rc.5 and 0.2.2-alpha.2 still pin vulnerable `zod` and `undici`
versions. See the [upstream dependency report](https://github.com/deepseek-ai/deepseek-harness/discussions/10847).
Use a patched DSH host installation with `zod >=4.6.6` and `undici >=8.12.2`.
This is an explicit installation requirement; the plugin does not rewrite the
host or profiles automatically. A profile override alone does not patch copies
inside a separately installed DSH CLI.

For example, create a dedicated npm host project (Node >=24.9), then use its
DSH binary for plugin installation and launch:

```sh
mkdir -p ~/.local/share/kimi-dsh-host
cd ~/.local/share/kimi-dsh-host
npm init -y
npm pkg set 'overrides.zod=^4.6.6' 'overrides.undici=^8.12.2'
npm install @deepseek-ai/dsh@0.2.1-rc.5
npm audit --omit=dev --audit-level=high
./node_modules/.bin/dsh plugin --profile web add kimi-plugin-cc
./node_modules/.bin/dsh plugin --profile web audit --prod --audit-level high
./node_modules/.bin/dsh web --no-open
```

The host project is separate from `$DSH_HOME/profiles/web`. Keep using that
project's DSH binary so the audited host is the one that runs. The commands
above install the published plugin; use a validated local tarball when testing
an unpublished change.

If an existing profile separately installs DSH packages, its owner must also
patch and audit that profile:

```sh
dsh plugin --profile web pkg set 'pnpm.overrides.zod=^4.6.6' 'pnpm.overrides.undici=^8.12.2'
dsh plugin --profile web install
dsh plugin --profile web audit --prod --audit-level high
```

Replace `web` with the intended profile, and run these commands with the patched
host binary. Overrides affect dependency resolution and require application
checks. The DSH package gate creates a fresh host with the declared overrides,
audits both that host and the installed profile for high/critical advisories,
then verifies all seven tool compositions and Web boot using that same host.
These checks do not claim that every moderate/low advisory is fixed or that
upstream has published a patched release.

## First publication (completed bootstrap reference)

The package must first exist on npm before its package settings can be configured.
After the release commit passes CI, create its immutable version tag and GitHub
release using the normal AGENTS.md procedure. The workflow builds and uploads a
validated tarball; publishing stays disabled until the repository variable
`NPM_TRUSTED_PUBLISHING` is `true`. Download the `npm-package` workflow artifact,
authenticate to npm interactively, then publish that validated artifact:

```sh
npm login
npm publish kimi-plugin-cc-X.Y.Z.tgz --access public
```

Do not publish a placeholder or reuse a version. Inspect registry metadata and
install the published version into a temporary directory before announcing it.

Configure npm Trusted Publishing for this package:

- GitHub owner: `linxule`
- Repository: `kimi-plugin-cc`
- Workflow: `publish.yml`
- Environment: `npm`
- Allow direct publishing for this release workflow

After configuring trust, set the GitHub Actions repository variable
`NPM_TRUSTED_PUBLISHING=true` to enable future publications.

No npm token is stored in GitHub. The npm CLI is used only for registry
operations; Bun remains the development toolchain.

## Subsequent releases

Push the reviewed release commit, wait for CI, tag it, and publish its GitHub
release. `.github/workflows/publish.yml` runs on `release.published`; it checks
the tag against `package.json`, runs the full gate and both package smokes, then
publishes the root tarball through OIDC with provenance. The DSH smoke installs
that same tarball directly into an isolated DSH profile, so no second npm
package or Trusted Publishing binding is needed. The publish job has no source
checkout or build scripts. A manual dispatch with an existing release tag is
available for recovery after a verified publication failure. Check npm before
retrying; released versions are immutable.
