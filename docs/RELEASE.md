# VibeHub release policy

Status: proposed v1, implemented by `.github/workflows/release.yml`.

This policy separates an authored source release from a host-installable
marketplace release. A Git tag identifies the source. Platform marketplace
branches and GitHub Release archives identify the exact self-contained
artifacts that Claude Code and Codex install.

## Versioning

- VibeHub uses SemVer and tags releases as `vMAJOR.MINOR.PATCH`.
- `package.json`, `.claude-plugin/plugin.json`, and
  `.codex-plugin/plugin.json` must contain the same version before tagging.
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

Public marketplace artifacts are built for Node.js 24 LTS and:

| Target | GitHub Actions runner |
| --- | --- |
| `darwin-arm64-node24` | `macos-15` |
| `darwin-x64-node24` | `macos-15-intel` |
| `linux-arm64-node24` | `ubuntu-24.04-arm` |
| `linux-x64-node24` | `ubuntu-24.04` |

The Node major is part of the target because `better-sqlite3` is a native
dependency and its binary must match the operating system, CPU architecture,
and Node ABI. Source builds may support other maintained Node versions, but a
published marketplace artifact supports only the Node major in its target
name.

Windows is not in the initial support matrix. Add it only after native Claude
and Codex install verification runs on Windows in the release workflow.

## Release gates

Every tag must pass all of these gates before anything public is updated:

1. Version and tag equality.
2. Frozen-lockfile install.
3. Build, typecheck, unit, production E2E, bundle-boundary, isolated artifact,
   Codex plugin, and dogfood verification through `pnpm verify`.
4. A native build on every supported target.
5. Loading the packaged `better-sqlite3` binary and creating an in-memory
   database on that target.
6. Real isolated installation through the pinned Claude Code and Codex CLIs on
   every target.
7. Self-containment checks that reject symlinks escaping the marketplace.
8. Artifact archive and SHA-256 publication.

The pinned host versions in the release workflow are the minimum versions
certified for that release. Updating either pin requires passing the full
matrix. A scheduled latest-host compatibility lane can warn about upstream
drift, but must not silently change the certified minimum.

## Publication channels

For each target the workflow publishes:

- an immutable GitHub Release archive,
  `vibehub-VERSION-TARGET.tar.gz`, plus checksums;
- an immutable Git branch, `marketplace/vVERSION/TARGET`;
- a stable update branch, `marketplace/TARGET`.

The immutable branch is the rollback and audit surface. The stable branch is
updated only after every release gate passes. All stable target branches are
updated in one atomic Git push, and the GitHub Release remains a draft until
that push succeeds. Both branch types contain the Claude catalog, Codex
catalog, one shared self-contained plugin, and `release.json` provenance.

## Upgrade and rollback

- Normal upgrades use the stable target branch and the host's marketplace
  update command.
- Database migrations must be forward-only, transactional, and able to open
  the previous minor version's database.
- Before a migration that cannot be reversed safely, the CLI must create a
  restorable database backup and print its path.
- Runtime rollback uses the immutable branch for the desired version. If the
  newer runtime performed an irreversible data migration, restore its backup
  before starting the older runtime.
- A security-compromised release is not deleted silently. Mark it withdrawn in
  the GitHub Release notes, publish a fixed patch, and move stable branches only
  after the patch passes the complete matrix.

## Release procedure

1. Update the three public versions and `CHANGELOG.md`.
2. Run `pnpm verify:release-metadata`.
3. Run `pnpm verify` locally on a supported development target.
4. Create and push the signed or annotated `vMAJOR.MINOR.PATCH` tag.
5. Wait for `Release public marketplaces`.
6. Verify all four archives, immutable branches, and stable branches exist.
7. Install once from a stable branch on a clean machine and run
   `vibehub doctor --json`.

Do not publish manually around a failed gate. Fix the source, bump the version
when the tag was already public, and rerun the complete process.
