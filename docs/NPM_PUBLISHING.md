# npm publishing

VibeHub publishes three public packages in dependency order:

1. `@vw-ai/vibehub-core`
2. `@vw-ai/vibehub-cli`
3. `@vw-ai/vibehub-workbench-mcp`

They share one version with the VibeHub plugin and Git tag. Users do not need a
global install; the CLI can be run as `npx @vw-ai/vibehub-cli`.

## Current publishing setup

The unscoped `vibehub` package belongs to an unrelated npm user. VibeHub uses
the `@vw-ai` organization scope instead.

All three packages already trust the repository's GitHub Actions publisher:

- Provider: GitHub Actions
- Organization or user: `VW-ai`
- Repository: `vibehub-plugin`
- Workflow filename: `npm-publish.yml`
- Environment: leave empty
- Allowed action: `npm publish`

The workflow keeps `id-token: write`; npm exchanges that OIDC identity for a
short-lived publish credential and adds provenance automatically. No npm token
is stored in GitHub, and normal releases require no npm login or browser
authentication.

Do not replace this with a long-lived `NPM_TOKEN`. If the repository, workflow
filename, or npm organization changes, update the Trusted Publisher settings
for all three packages before the next release.

## Publish a release

1. Update the root package, plugin manifests, marketplace manifests, and all
   three public packages to the same SemVer version.
2. Update `CHANGELOG.md`.
3. Run the local release checks below.
4. Merge the release commit to `main`.
5. Create an annotated `vMAJOR.MINOR.PATCH` tag on that commit and push it.
6. Wait for both the npm publication and GitHub Release workflows.
7. Verify the registry versions and GitHub Release assets.

For example, after replacing `VERSION` with the exact release number:

```bash
pnpm install --frozen-lockfile
pnpm verify:release-metadata
pnpm verify
git tag -a vVERSION -m "VibeHub vVERSION"
git push origin vVERSION
```

Never move a published tag or reuse a published npm version. If a public tag
contains a release defect, fix it and publish a new patch version.

## Release behavior

Publishing starts when an immutable `vMAJOR.MINOR.PATCH` tag is pushed. The npm
workflow:

1. checks out the release tag;
2. verifies every package and plugin version equals the tag;
3. runs the package build, typecheck, test, metadata, and isolated-install checks;
4. packs and uploads the exact npm tarballs;
5. publishes core, CLI, and MCP in dependency order through OIDC.

In parallel, the GitHub Release workflow builds one universal marketplace,
waits until the exact npm tarballs are public, installs them on macOS and Linux
across arm64 and x64, and only then publishes the GitHub Release.

This is a two-phase release: an npm version may be visible before the
four-platform matrix finishes, but it is not selected by the default VibeHub
installer until the corresponding GitHub Release is published. A failed matrix
therefore leaves normal installs on the previous verified release.

The publisher is restart-safe. If a job stops after publishing one package, a
rerun skips versions already present and continues with the remaining
packages, but only when the normalized registry tar payload matches the local
artifact. Published npm versions and Git tags are immutable.

## Local release checks

These commands build and inspect the same tarballs without publishing them:

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm pack:npm
```

The tarballs and their manifest are written to `dist/npm/`.

After publication, verify all three packages:

```bash
npm view @vw-ai/vibehub-core version
npm view @vw-ai/vibehub-cli version
npm view @vw-ai/vibehub-workbench-mcp version
```
