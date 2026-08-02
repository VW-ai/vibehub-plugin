# Release VibeHub

VibeHub's release surface is a versioned plugin archive on GitHub Releases.
npm is not a release or installation surface for this product generation.

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
   dependency-free plugin, archives it, writes a SHA-256 checksum, and creates
   the GitHub Release.
6. Verify that the GitHub Release points to the tagged `main` commit and that
   both the archive and checksum are present.

Never create the final tag or GitHub Release from a feature branch.
