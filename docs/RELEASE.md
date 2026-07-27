# VibeHub release policy

Status: v2, implemented by `.github/workflows/npm-publish.yml` and
`.github/workflows/release.yml`.

This policy separates an authored source release from host-installable
packages. A Git tag identifies the source, public npm packages distribute the
runtime, and one platform-neutral marketplace package connects Claude Code and
Codex to that exact runtime version.

## Versioning

- VibeHub uses SemVer and tags releases as `vMAJOR.MINOR.PATCH`.
- `package.json`, all three public package manifests,
  `.claude-plugin/plugin.json`, and `.codex-plugin/plugin.json` must contain
  the same version before tagging.
- MAJOR changes include stored-data incompatibility, removal of a documented
  CLI/MCP operation, or a release that cannot read databases created by the
  previous major line.
- MINOR changes add backward-compatible capabilities, skills, or host
  integrations.
- PATCH changes fix behavior without intentionally changing the public
  contract.
- A release tag is immutable. Correct a bad release with a new version; never
  move or recreate a published tag.

## Supported runtime matrix

The marketplace itself is platform-neutral. Releases verify the npm runtime
with Node.js 24 on:

| Target | GitHub Actions runner |
| --- | --- |
| `darwin-arm64-node24` | `macos-15` |
| `darwin-x64-node24` | `macos-15-intel` |
| `linux-arm64-node24` | `ubuntu-24.04-arm` |
| `linux-x64-node24` | `ubuntu-24.04` |

`better-sqlite3` is installed by npm for the user's platform. The plugin does
not carry native binaries and therefore does not need target-specific branches.
The package manifests support Node.js 20 or newer; Node.js 24 is the certified
release lane.

Windows is not in the initial support matrix. Add it only after native Claude
and Codex install verification runs on Windows in the release workflow.

## Release gates

Every tag must pass all of these gates before anything public is updated:

1. Version and tag equality.
2. Frozen-lockfile install.
3. Build, typecheck, unit, isolated artifact, Codex plugin, and headless
   dogfood verification through `pnpm verify`.
4. Installation of the exact public npm packages on every supported target.
5. Loading `better-sqlite3` and creating an in-memory database on that target.
6. Real isolated installation through the pinned Claude Code and Codex CLIs on
   every target.
7. Thin-package checks that reject bundled `node_modules` and source packages.
8. Artifact archive and SHA-256 publication.

The pinned host versions in the release workflow are the minimum versions
certified for that release. Updating either pin requires passing the full
matrix. A scheduled latest-host compatibility lane can warn about upstream
drift, but must not silently change the certified minimum.

## Publication channels

The npm publication workflow is defined in `.github/workflows/npm-publish.yml`.
It publishes `@vibehub/core`, `@vibehub/cli`, and
`@vibehub/workbench-mcp` from an immutable release tag using npm Trusted
Publishing. See `docs/NPM_PUBLISHING.md` for the first-release bootstrap and
tokenless OIDC configuration.

The repository's default branch is the single marketplace URL. Each release
also attaches one `vibehub-VERSION-marketplace.tar.gz` archive and checksum to
GitHub Releases. There are no platform or per-release marketplace branches.

## Upgrade and rollback

- Normal upgrades use the host's marketplace update command. The plugin
  version selects the same npm runtime version.
- Database migrations must be forward-only, transactional, and able to open
  the previous minor version's database.
- Before a migration that cannot be reversed safely, the CLI must create a
  restorable database backup and print its path.
- Runtime rollback installs the desired immutable GitHub Release artifact or
  repository tag. If the newer runtime performed an irreversible data
  migration, restore its backup before starting the older runtime.
- A security-compromised release is not deleted silently. Mark it withdrawn in
  the GitHub Release notes, publish a fixed patch, and move stable branches only
  after the patch passes the complete matrix.

## Release procedure

1. Update the root, plugin, marketplace, and three public package versions,
   then update `CHANGELOG.md`.
2. Run `pnpm verify:release-metadata`.
3. Run `pnpm verify` locally on a supported development target.
4. Create the signed or annotated `vMAJOR.MINOR.PATCH` tag.
5. For the first npm release only, publish locally and configure Trusted
   Publishers as documented in `docs/NPM_PUBLISHING.md`.
6. Push the tag and wait for both release workflows.
7. Verify the three npm packages and the universal GitHub Release archive.
8. Install once from the repository marketplace on a clean machine and run
   `npx @vibehub/cli@VERSION doctor --json`.

Do not publish manually around a failed gate. Fix the source, bump the version
when the tag was already public, and rerun the complete process.
