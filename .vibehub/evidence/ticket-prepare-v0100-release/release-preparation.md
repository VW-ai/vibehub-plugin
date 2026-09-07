# 0.10.0 release preparation

Explicit owner authorization in conversation:2026-09-07-owner-merge-and-release:

> okay的话就合然后发release

This followed the explanation that current main uses a merged commit plus tag-triggered release, and the future atomic release lane is not implemented. The request authorizes merging PR136 and publishing this delivery; it supersedes the preceding prepare-only no-tag/no-release limit. This is a faithful transcription, not an authenticated conversation export.

Release impact judgment: minor. New large-document ingestion, coverage settlement and paragraph anchors extend the0.9.0 capabilities. Latest reachable stablev0.9.0 plus minor yields0.10.0. This is a recorded manual judgment under current docs/RELEASE.md, not a claim that the future calculator exists.

Package, retained Claude manifest, installed mirror template and current release assertions now use0.10.0. CHANGELOG has0.10.0 dated2026-09-07, without Unreleased. No runtime behavior changed from independently integrated d39ef67.

Execution checks on stable candidate:
- `node scripts/verify-release-version.mjs --tag v0.10.0`: passed.
- `node scripts/verify-release-version.mjs --check-shipped-content`: passed, baselinev0.9.0, stable0.10.0.
- `npm run verify`:311 passed,0 failed,0 skipped; artifact69files3405706bytes.
- project and skills validators passed. Product Room restamped for finalized changelog.
- historical record audit passed:108main Ticket revision records415proofs;13branch acceptance/constraint sets163original proof payloads unchanged.

Known limits: Peel contract remains partial4/5(no-prompted-recovery), Skill graph contractv2 partial3/4(no-runtime-role); integration contractv1 remains successful and immutable. PR description discloses both.

Publication follows independent preparation closeout and final green CI: merge PR136, fetch exact merged main commit, verify identity and tag absence, tag only that commit, allow existing tag workflow to publish, then verify all four assets/checksums and run paired upgrader in a disposable bounded root. This preparation evidence does not claim publication has happened.
