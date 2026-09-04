# Legacy proof revision policy

Status: owner-selected semantic policy; implementation and migration remain a
separate downstream Ticket. This document does not itself change schemas,
migrate proof, reopen Tickets, or alter current DONE/archive truth.

## Question

Future Evidence must bind to the exact Acceptance revision it proves, and an
Outcome must bind to the exact complete Contract revision it adjudicates. The
protected migration question is how to introduce those identities without
deleting history or silently treating proof for an older contract as proof for
a newer one.

The reproducible audit is:

```sh
node scripts/audit-legacy-proof.mjs --repo .
```

It uses each proof document's first appearance in Git and reads the owning
Ticket at that exact commit. It never edits `.vibehub/`.

## Audited corpus

Snapshot: `59de368c8a420d2913a6aa7a9d35cf7f52a7e569`.

| Fact | Count |
| --- | ---: |
| Tickets | 105 |
| Evidence | 307 |
| Outcomes | 95 |
| Successful Outcomes / current DONE | 94 |
| Archived delivered Tickets | 43 |
| Human-authority criteria | 22 |
| Currently satisfied human-authority criteria | 19 |
| Human-origin Evidence | 19 |

All 307 Evidence and all 95 Outcomes can be paired with an owning Ticket
contract at their first appearance on the current `HEAD` ancestry. The audit
deliberately excludes `--all`: an unrelated branch or worktree ref is not
current repository truth. This is useful reconstruction evidence, but not a
native creation-time identity. Twenty-four Evidence records belong to a Ticket
whose contract later changed; two successful Outcomes belong to such Tickets:
`ticket-deploy-public-site-cloudflare` and
`ticket-encode-human-acceptance-authority`.

Representative exact-source cases:

- `.vibehub/evidence/ticket-decide-task-harness-product-direction/owner-requires-whole-application-shell.yaml`
  can be reconstructed from its first appearance on the current ancestry. Its
  referenced criterion later changed, and newer human Evidence records the
  corrected product direction. A commit found only through `git log --all`
  must not be substituted because it may belong to an unrelated branch or
  worktree.
- `.vibehub/outcomes/ticket-encode-human-acceptance-authority.yaml` can be
  paired with the exact Ticket contract checked in when it first appeared; the
  owning Ticket's current criteria later changed.
- `.vibehub/outcomes/ticket-deploy-public-site-cloudflare.yaml` has the same
  important shape: the historical Outcome is valid for its reconstructed old
  Contract revision, but it cannot close a later active Contract revision.

The important limit is exact: Git proves what contract was checked in beside a
proof document, not what an Agent privately meant before that commit. A bulk
import or same-commit migration can preserve a readable snapshot without
proving that it was the original adjudicated contract. Reconstruction must
therefore remain visibly classified as reconstructed, never native.

The following impact matrix is produced mechanically by the audit. It shows
how the old boolean-current interpretations would affect today's projection;
it is retained to explain why the selected revision model is necessary.
`Current` uses the canonical current-scope graph projection, including required
DONE boundaries; `All` is the complete graph. `CLOSE_OUT` uses the shared
derived next-action implementation rather than raw Evidence count.

| Legacy interpretation | DONE | Archived | Human satisfied | CLOSE_OUT | Current | All | Successful prerequisite edges | Open dependents unblocked |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Mark all stale | 0 | 0 | 0 | 0 | 105 | 105 | 0 | 0 |
| Grandfather successful Outcomes as current | 94 | 43 | 19 | 0 | 17 | 105 | 77 | 4 |
| Count only unchanged reconstructed contracts as current | 92 | 42 | 18 | 2 | 25 | 105 | 75 | 6 |

## Rejected interpretations

### A. Mark every legacy proof stale

Treating every Evidence and Outcome without a native contract identity as
unbound is maximally strict and maximally destructive. It would reopen all 105
Tickets and erase the operational value of 94 successful independent
adjudications even though Git can reconstruct every proof binding in this
repository.

### B. Grandfather every successful Outcome onto the current contract

This preserves today's projection, but silently reinterprets an old Outcome as
having adjudicated criterion wording or Acceptance membership that did not
exist when it was written. Historical success may be preserved; automatic
rebinding to a newer Contract revision may not.

### C. Mark every drifted historical Outcome unresolved

This correctly prevents old proof from closing a changed current contract, but
describes too much as invalid. A reconstructable Outcome remains a successful
historical judgment of its old Contract revision. Only its ability to close a
different active revision is absent. `legacy-unresolved` is reserved for
missing or ambiguous reconstruction, not ordinary version drift.

## Selected policy: append-only Acceptance and Contract revisions

VibeHub uses an append/mutate model at the semantic layer: mutable presentation
and workflow metadata may change in place, while contract meaning evolves by
appending immutable revisions. The selected rules are:

1. An Acceptance has a stable logical `acceptance_id`, a human-readable
   monotonic revision such as `v1` or `v2`, and a deterministic immutable
   identity over its logical ID, revision, criterion, authority, and immutable
   lineage. Mutable active/retired selection and non-contract presentation data
   are excluded, so retiring a revision cannot change the identity already
   referenced by proof.
2. Strengthening, correcting, or redefining the same responsibility creates
   the next revision of the same logical Acceptance: `A1 v1` becomes `A1 v2`.
   It never overwrites `A1 v1`.
3. A separately passable or fail-able responsibility starts a new logical
   Acceptance at `v1`.
4. Splitting or merging responsibilities retires the replaced revisions,
   creates new logical Acceptances, and records explicit `derived_from`
   lineage. Retirement preserves history; it is not deletion.
5. An Acceptance that no longer applies is marked retired and remains
   addressable forever.
6. Pure display-copy changes belong in non-contract presentation fields. A
   criterion is not edited merely to improve wording if the obligation is
   intended to remain identical.
7. A Ticket keeps its stable `ticket_id`. Each complete Contract has a
   human-readable monotonic revision and deterministic immutable identity over
   the exact set of Acceptance revision identities it contains. Membership
   changes therefore create a new Contract revision even when an unchanged
   Acceptance revision is reused. Which Contract is active is mutable
   projection state and is excluded from every historical Contract identity.
8. Evidence binds one exact Acceptance revision. An Outcome binds one exact
   complete Contract revision. Neither silently rebinds when a newer revision
   becomes active.
9. A successful Outcome remains successful for the historical Contract
   revision it adjudicated. If a later Contract revision is active, that new
   revision is open until independently adjudicated; the historical Outcome is
   not relabelled failed, stale, or unresolved.
10. Closed revisions and their Evidence and Outcomes are immutable. Replanning
    appends semantic revisions and may update which revision is active; it does
    not rewrite prior proof.

The human-readable revision communicates lineage. The deterministic content
identity prevents accidental collision or silent mutation. Neither Git commit
identity, filename, timestamp, nor mutable repository position is the semantic
identity.

## Legacy reconstruction

Migration applies the selected model deterministically:

The existing cross-worktree upgrade contract requires its mechanical half to
leave every safe worktree valid and CURRENT while Git-history judgment remains
for a later Agent session. The format transition therefore uses one explicit
temporary `legacy-pending-reconstruction` representation for legacy Ticket,
Evidence, and Outcome payloads. Mechanical migration may add this marker and
the matching per-Ticket semantic-pending ref, but it does not invent a revision
binding or alter the proof's assertion. Pending proof is readable but cannot
satisfy active coverage, human authority, DONE, archive, or dependency unlock;
ordinary writers cannot create pending records or add revision-bound work to
that Ticket. This state is neither stale nor `legacy-unresolved`. The in-
worktree semantic step must replace it with exact reconstructed bindings, or
with `legacy-unresolved` only when history is actually missing or ambiguous.

1. Reconstruct the Acceptance and Contract revisions associated with each
   legacy Evidence and Outcome from the proof document's first appearance on
   the current `HEAD` ancestry.
2. Materialize the reconstructed historical contract as `v1` where no earlier
   explicit revision exists and mark the binding origin `reconstructed`.
3. If the current semantic contract is unchanged, it remains that same active
   revision. If it changed, append the current state as a later active revision
   and retain the reconstructed old revision.
4. Keep every reconstructable historical Outcome successful for its exact old
   Contract revision. It does not contribute DONE, archive membership, or
   dependent unlock for a different active revision until that active revision
   receives its own Outcome.
5. Use `legacy-unresolved` only when the first-appearance history is missing or
   ambiguous enough that an exact binding cannot be reconstructed. Route those
   cases to explicit review without deleting the proof document.
6. Reapplying migration must produce identical revision identities, lineage,
   active selections, and unresolved cases.

On the audited snapshot all 307 Evidence and 95 Outcomes are reconstructable;
there are no `legacy-unresolved` records. The 24 Evidence records and two
successful Outcomes whose owning contracts later changed become ordinary
historical revision bindings. Their current active Contract revisions require
new proof or adjudication as appropriate.

## Installed-artifact compatibility

The policy requires one explicit project-format migration, atomic changes to
the Ticket, Evidence, and Outcome schema contracts, and rebuilding both Codex
and Claude installed Plugin artifacts. It is not compatible with upgrading
only source `vh.mjs` while leaving an older host artifact behind.

Migration preserves historical documents and their revision bindings on
rollback. It introduces no runtime compatibility branch, cache, daemon,
database, ledger service, or hidden signature authority.

## Migration and rollback invariants

- Every historical Evidence and Outcome remains content-preserved with its
  prior Git provenance inspectable.
- Acceptance identity uses stable serialization of logical ID, revision,
  semantic criterion, explicit/default authority, and immutable lineage while
  excluding active/retired selection and presentation data. Contract identity
  uses stable Ticket ID and Contract revision and commits to exact Acceptance
  revision identities while excluding the mutable active selector.
- Unrelated Ticket context, constraints, relations, deliveries, formatting,
  and presentation copy do not create semantic revisions.
- Native Outcome support must bind the exact Acceptance revision. Reconstructed
  Outcomes retain immutable legacy `evidence_ids` even when a reference points
  to older proof; such references stay readable but grant no revision credit.
  Human authority still requires at least one referenced human-origin Evidence
  bound to the exact accepted revision.
- Migration is one explicit project-format step shared by source, Codex, and
  Claude artifacts; there is no compatibility daemon or hidden cache.
- Rollback changes the active format interpretation, never deletes proof,
  fabricates a prior successful Outcome, or rewrites revision lineage.

## Downstream implementation boundary

`ticket-bind-proof-to-acceptance-revision` must implement the selected policy
across the complete installed system:

- Ticket schema: stable logical Acceptance IDs, revision labels, immutable
  content identities, active/retired state, `derived_from` lineage, and exact
  Contract revision membership.
- Evidence schema: exact Acceptance revision identity plus native or
  reconstructed binding origin.
- Outcome schema: exact complete Contract revision identity and explicit
  handling of reconstruction failures.
- Mutation: semantic changes append revisions; new independent duties get new
  IDs; split/merge records lineage; retirement never deletes; pure display
  changes do not alter contract identity.
- Migration registry: this selected legacy policy, dry-run impact report,
  deterministic apply, unresolved list, and rollback guidance.
- Validation: historical proof remains readable and valid for its bound
  revision but never counts as coverage for a different active revision;
  ordinary mutation of a closed revision is rejected.
- Projection: `next_action`, CLI, graph, frontier, and Workbench distinguish
  historical success, active revision coverage, reconstructed bindings, and
  unresolved reconstruction without inventing another Ticket lifecycle status.
- Host parity: source, Codex, Claude, and installed artifacts use the same
  schemas and migration.
- Regression: wording versus presentation changes, authority, membership, ID
  replacement, new revision, split/merge lineage, retirement, legacy
  reconstruction, ambiguous history, closed mutation, rollback, archive,
  dependent unlock, and human authority.

## Owner decision

The owner selected the append-only revision policy in the
`conversation:2026-09-04-versioned-acceptance-lineage` discussion: same
responsibility means the same logical Acceptance with a new revision; separate
responsibilities get separate IDs; split/merge and retirement preserve explicit
lineage; Evidence and Outcomes stay bound to the exact historical revision they
adjudicated; and Git reconstruction supplies legacy `v1` bindings with an
unresolved fallback only for missing or ambiguous history.
