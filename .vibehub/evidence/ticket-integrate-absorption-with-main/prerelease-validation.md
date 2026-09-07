# Authorized prerelease integration

Owner decision: ticket-decide-pr136-prerelease-convention, independently successful Contract v1. Prepare 0.10.0-dev.1 plus Unreleased; no tag/release/deployment.

Package, Claude manifest, GitHub mirror template stamp and current release assertions updated. Historical changelog and release-gate fixtures remain unchanged. Initial full suite found a stale 0.9.0 template stamp (310 passed / 1 failed); after correction the complete suite passed 311 / 0 failed / 0 skipped.

Validation on final prerelease source:
- `node scripts/verify-release-version.mjs --check-shipped-content`: passed, baseline v0.9.0, changed shipped content, prerelease 0.10.0-dev.1.
- `npm test`: 311 passed, zero failed, zero skipped.
- `npm run verify:artifact`: passed (69 files, 3405707 bytes); uses loopback permissions.
- Record preservation audit: main 108 Ticket revision records and 415 proof documents preserved; branch 13 Acceptance/constraint sets and 163 original proof payloads preserved.
- Project and Skill validation passed; product realigned for the changelog. All entered Rooms FRESH; unrelated marketing drift debt remains marked.

PR 136 description updated to include authorized prerelease scope. Independent integration closeout must rerun checks and verify the pushed head. Prior site preflight evidence remains applicable because these edits do not change site assets.
