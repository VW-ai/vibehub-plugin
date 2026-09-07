# Integration execution evidence

Fetched main: 5846c3f44ede79a4e260befe67105a7102caf377.
Pre-integration delivery: d3289c2; plan: c3515c4.
Merge commit: 556ec78; graph v2 adjudication: 9606874.
PR: https://github.com/VW-ai/vibehub-plugin/pull/136 (draft).

## Conflict and contract decisions

Eight conflicting paths were resolved. Four Room definitions preserve the shared
boundaries, main's added revision-contract anchors, and this branch's renamed
workbench anchor. Both sides' stamps were removed and all four Rooms were aligned
after reviewing the merged source; no stamp was chosen as merge truth.

The core helper retains normalized segment anchors, coverage and source operations,
main's revision-bound proof implementation and independence declarations, and the
branch's agent-before-human routing applied to exact active revision references.
The shared context resolver handles explicit immutable refs; closed-Ticket plain
missing paths retain historical fallback. Its Outcome commit lookup includes the
new per-Ticket Outcome directory. Malformed refs do not gain a fallback.

The UI combines Room-tree projection with revision-aware history/context output.
Install documentation keeps npx-only distribution and the retired-Skill cleanup
notice. The deleted marketplace parity suite remains deleted; maintained package,
release and npx artifact tests remain. Three live Ticket metadata refs were updated
to the renamed review Skill; immutable Acceptance/Contract identities were untouched.

The retired-name scanner now exempts only a successful active Contract, including
nested versioned Outcomes. A new test proves stale success and partial Outcome do
not exempt a live Ticket. A specific historical Context occurrence was allowlisted
with its exact text; no file-level or broad scan exemption was added.

## Explicit mixed-format migration

Main's marker is format4 but this branch adds 13 legacy-schema Tickets and their
proofs. Re-entered ONLY the existing declared format3 -> format4 mechanical step
in this exact worktree; that action explicitly skips already-bound main records.
The marker returned to format4. An initial validation failure on a renamed live
Ticket ref rolled back the mechanical writes; after updating that metadata pointer,
the same engine completed. No downgrade remained and no validator was bypassed.

Then project migrate-proof-revisions reconstructed current-HEAD Git history:
13 Tickets, 63 Evidence bound, 12 Outcomes bound, 0 unresolved. Existing main
records were not rebound. The first addition semantics of proof are preserved by
the engine; old success cannot silently close a newer Contract.

Run audit-records.mjs from the repository root. It independently compares main's
108 Ticket revision records and 415 complete Evidence/Outcome documents unchanged;
13 imported current Acceptance sets/constraints and 163 original proof payloads
remain intact. It also checks Peel partial and no-prompted-recovery explicitly.

The graph Ticket's active Contract reconstructed as v2 while old success bound v1.
A fresh independent Agent re-adjudicated v2, accepting 3/4 and recording partial
for no-runtime-role: setup's retired-folder command reads packaged skill-graph.json.
Its isolated probe confirmed the identical behavior at pre-merge d3289c2. The
criterion is unchanged; historical v1 is intact. This inherited mismatch remains
REPLAN rather than being hidden or opportunistically changed during integration.
Peel remains partial (4/5) with its exact original unresolved criterion.

## Verification

- Merged full suite: 311 pass, 0 fail, 0 skip (loopback-enabled host).
- verify:artifact: passed on the npx-only 0.9.0 baseline inherited from main.
- project validate: format4 valid:true, no unverifiable refs after merge commit.
- skills validate: valid:true.
- Four entered Rooms FRESH; marketing/video FRESH; unrelated marketing keeps its
  existing drift:-prefixed mark (hashes_match true).
- Site release Skill preflight: lint/build and 9 rendered tests passed. These
  site files exactly match main; no deployment was performed.
- git merge-base --is-ancestor for the fetched main: exit0; no unmerged entries.
- Branch pushed to PR136 and body updated with merged scope, actual results,
  and both partial Tickets. A final fetch confirms main has not advanced.

Tests added on this branch that predated main now declare validation and fixture
independence explicitly rather than weakening production write/closeout gates.
No force-push, release publication, or changes to other worktrees/Peel.
Independent integration closeout remains required; this is execution evidence.
