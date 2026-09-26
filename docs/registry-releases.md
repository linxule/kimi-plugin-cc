# Registry releases

The npm package `kimi-plugin-cc` ships the Claude plugin at its root and the
self-contained Codex plugin under `plugins/kimi-codex`. GitHub marketplaces
remain available. The package has no install scripts and no separate CLI.

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

## First publication

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
