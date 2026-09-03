# Release VibeHub

VibeHub's release surface is a versioned plugin archive plus a release-paired
one-shot data-upgrade tarball on GitHub Releases. npm is an execution client
for that exact asset, not a registry release or global installation surface.

1. Update `package.json`, both plugin manifests, the Claude marketplace
   metadata, and `CHANGELOG.md` to the same version.
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
