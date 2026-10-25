# Registry releases

The npm package `kimi-plugin-cc` ships the Claude plugin at its root and the
self-contained Codex plugin under `plugins/kimi-codex`. GitHub marketplaces
remain available. The package has no install scripts and no separate CLI.

## Publishing status

Plugin **2.4.1** certifies exact CLI **2.3.2** for all eight operations with host-preactivated swarm sessions. Its [certification evidence](./upstream-2.3.2-certification.md) includes the source scan, plan controls, hardened 15-test/115-assertion candidate matrix, and final 19-test/125-assertion production smoke in 296.67 seconds. Independent review is complete: Claude reports no blockers and Codex returned RESOLVED. The final repository gate passed 1,264 tests with zero failures and 16,046 assertions across 78 files, and package validation passed 224 files. CI, tagging, and registry verification are pending; the currently published release remains 2.4.0 until that closeout completes.

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
AGENTS.md. Keep plugin and npm versions identical. Certification for new Kimi
Code versions still requires the source audit and real-binary controls; adding
a registry channel does not certify another CLI version.

```sh
bun install --frozen-lockfile
bun run build
bun run generate:surfaces
# Review and stage generated distributions before the drift gate.
bun run check
bun run check:package .tmp/npm
```

The package check inspects the actual tarball, verifies runtime copies and
vendored licenses, and installs/checks the safety hook in isolated homes for
both hosts. It also exercises unsupported-version refusal using a fake CLI and
modern MCP discovery plus legacy initialization on both extracted compiled
distributions. It does not invoke a model or read the maintainer's Kimi configuration.

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
the tag against `package.json`, runs the full gate and package smoke, then
publishes the validated tarball through OIDC with provenance. The publish job
has no source checkout or build scripts. A manual dispatch with an existing
release tag is available for recovery after a verified publication failure.
Check npm before retrying; released versions are immutable.
