# Registry releases

The npm package `kimi-plugin-cc` ships the Claude plugin at its root and the
self-contained Codex plugin under `plugins/kimi-codex`. GitHub marketplaces
remain available. The package has no install scripts and no separate CLI.

## Publishing status

As of September 26, 2026, [2.0.7 is live on npm](https://www.npmjs.com/package/kimi-plugin-cc/v/2.0.7).
The first upload used the validated GitHub Actions artifact and interactive npm
authentication. Its public tarball matched that artifact byte-for-byte, and a
fresh registry install passed isolated setup/check for both hosts.

The trusted publisher is configured for `linxule/kimi-plugin-cc`, workflow
`publish.yml`, environment `npm`, with direct publishing allowed.
`NPM_TRUSTED_PUBLISHING=true` is enabled in GitHub Actions. Future GitHub releases
use short-lived OIDC credentials, without a stored npm token or interactive 2FA.
The first npm OIDC publication will be the next release; do not republish 2.0.7.

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
both hosts. It also exercises unsupported-version refusal using a fake CLI.
It does not invoke a model or read the maintainer's Kimi configuration.

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
release tag is available for a first OIDC release or recovery after a verified
publication failure. Check npm before retrying; released versions are immutable.

A locally bootstrapped first version is already published: do not dispatch it
again. The next release is the first OIDC publication.
