# Release VibeHub

VibeHub's release surface is a versioned plugin archive plus a release-paired
one-shot data-upgrade tarball on GitHub Releases. npm is an execution client
for that exact asset, not a registry release or global installation surface.

1. Update `package.json`, `.claude-plugin/plugin.json`, and `CHANGELOG.md` to
   the same version. `scripts/verify-release-version.mjs` treats the package
   and retained Claude plugin manifest as the only release-version
   declarations; marketplace manifests and the retired Codex plugin manifest
   are not release inputs.
2. Run `npm run verify` and open a PR to `main` with the relevant VibeHub Ticket
   Outcome and Evidence.
3. Merge the verified PR.
4. Tag the exact merged `main` commit, then push the tag:

   ```bash
   git switch main
   git pull --ff-only
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

5. The tag workflow checks version identity, verifies and builds the clean
   dependency-free plugin, and builds `vibehub-upgrade.tgz` from its explicit
   allowlist with the same tag and commit identity. It writes SHA-256 checksums
   for both archives and creates the GitHub Release. The upgrader has one bin,
   no dependencies or install scripts, and is never published to npm.
6. Verify that the GitHub Release points to the tagged `main` commit and that
   both archives and both checksums are present. Download them into one
   directory and run `sha256sum --check` for each checksum. Run the versioned
   upgrader with an explicit disposable root and confirm that its printed tag
   and commit equal the Release before publishing the command to users.

Never create the final tag or GitHub Release from a feature branch.

The per-push Verify workflow runs
`verify-release-version.mjs --check-shipped-content`. That maintainer-side
check imports `PLUGIN_PATHS` from the artifact builder as its only definition
of shipped content and compares the tree with the latest reachable stable
release tag. Changed shipped content may not retain that published version. A
greater prerelease identity keeps an `Unreleased` section between releases; a
greater stable identity is accepted only when its dated changelog entry is
finalized for a release PR.

There is intentionally no installed staleness command. The supported
`npx skills` path detects changes by content hash or an unconditional refetch,
independently of this human-facing release version. The gate protects truthful
release and migration metadata; the release-paired upgrader remains
responsible for restructuring project data when a user chooses to update.

## Data-layer changes

Any release that changes the project format or a persisted document schema must
update `skills/vibehub-migrate/references/migrations.json` in the same change.
Every added or changed migration entry must declare both
`mechanical.declared_paths` plus `mechanical.actions` and `semantic.steps`.
Every semantic step must carry its purpose, source material, good-value rule,
forbidden shortcuts, and executable instructions. An empty half is declared as
an empty array, never omitted.

`test/skill-contracts.test.mjs` enforces this classification and
`test/migration.test.mjs` exercises the mechanical operation. A data-layer
change is not releasable when either check fails.
