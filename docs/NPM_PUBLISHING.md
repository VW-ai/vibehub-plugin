# npm publishing

VibeHub publishes three public packages in dependency order:

1. `@vw-ai/core`
2. `@vw-ai/cli`
3. `@vw-ai/workbench-mcp`

They share one version with the VibeHub plugin and Git tag. Users do not need a
global install; the CLI can be run as `npx @vw-ai/cli`.

## One-time npm setup

The unscoped `vibehub` package belongs to an unrelated npm user. VibeHub uses
the `@vw-ai` organization scope instead.

1. Sign in to npm and enable account-level two-factor authentication.
2. Create or join the npm organization named `vw-ai`.
3. Merge the npm distribution changes to `main`.
4. Create the annotated `v0.2.0` tag locally, but do not push it yet.
5. Build, verify, and publish the first packages from that exact local tag.
6. Configure Trusted Publishing for all three packages.
7. Push the tag. The normal GitHub release workflows can now use OIDC.

The first release is published interactively because npm requires a package to
exist before a Trusted Publisher can be attached to it. No npm token is stored
in GitHub.

From the tagged `main` commit:

```bash
npm whoami
git tag -a v0.2.0 -m "VibeHub v0.2.0"
pnpm install --frozen-lockfile
pnpm verify
pnpm pack:npm
VIBEHUB_NPM_RELEASE_TAG=v0.2.0 pnpm publish:npm
```

The publish command requires `v0.2.0` to exist locally and point to `HEAD`.
It publishes core, CLI, and MCP in dependency order and safely skips an
already-published tarball only when its registry integrity exactly matches the
local artifact.

## Switch to tokenless Trusted Publishing

After the first successful npm publication, install npm 11.15.0 or newer, sign
in, and configure the same GitHub Actions workflow for every package:

```bash
npm trust github @vw-ai/core \
  --repo VW-ai/vibehub-plugin \
  --file npm-publish.yml \
  --allow-publish

npm trust github @vw-ai/cli \
  --repo VW-ai/vibehub-plugin \
  --file npm-publish.yml \
  --allow-publish

npm trust github @vw-ai/workbench-mcp \
  --repo VW-ai/vibehub-plugin \
  --file npm-publish.yml \
  --allow-publish
```

The same configuration can be entered on npmjs.com under each package's
Settings → Trusted Publisher:

- Provider: GitHub Actions
- Organization or user: `VW-ai`
- Repository: `vibehub-plugin`
- Workflow filename: `npm-publish.yml`
- Environment: leave empty
- Allowed action: `npm publish`

Once all three connections are present:

1. In each npm package's publishing settings, require 2FA and disallow tokens.
2. Keep the workflow's `id-token: write` permission. npm exchanges that OIDC
   identity for a short-lived publish credential and adds provenance
   automatically.
3. Push the release tag:

```bash
git push origin v0.2.0
```

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

The publisher is restart-safe. If a job stops after publishing one package, a
rerun skips versions already present and continues with the remaining
packages. Published npm versions and Git tags are immutable.

## Local release checks

These commands build and inspect the same tarballs without publishing them:

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm pack:npm
```

The tarballs and their manifest are written to `dist/npm/`.
