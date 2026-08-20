# Legacy proof revision policy

Status: decision proposal only. This document does not change schemas, migrate
proof, reopen Tickets, or alter current DONE/archive truth.

## Question

Future Evidence must bind to the exact Acceptance criterion it proves, and an
Outcome must bind to the complete contract it adjudicates. The protected
migration question is what to do with Evidence and Outcomes created before
that identity existed.

The reproducible audit is:

```sh
node scripts/audit-legacy-proof.mjs --repo .
```

It uses each proof document's first appearance in Git and reads the owning
Ticket at that exact commit. It never edits `.vibehub/`.

## Audited corpus

Snapshot: `b558f35e4813268e02d3438b6e7d863fbc7951e7`.

| Fact | Count |
| --- | ---: |
| Tickets | 79 |
| Evidence | 202 |
| Outcomes | 59 |
| Successful Outcomes / current DONE | 59 |
| Archived delivered Tickets | 43 |
| Human-authority criteria | 12 |
| Currently satisfied human-authority criteria | 10 |
| Human-origin Evidence | 11 |

All 202 Evidence and all 59 Outcomes can be paired with an owning Ticket
contract at their first Git appearance. That is useful reconstruction evidence,
but not a native creation-time identity. Nineteen Evidence records belong to a
Ticket whose contract later changed; one successful Outcome belongs to such a
Ticket: `ticket-encode-human-acceptance-authority`. Its current Ticket changed
three criteria after the Outcome first appeared.

Representative exact-source cases:

- `.vibehub/evidence/ticket-decide-task-harness-product-direction/owner-requires-whole-application-shell.yaml`
  first appears at `24b3d6d9df041a94ef3cb74468be9528b0214747`; its referenced
  `initial-shell-and-dsh-direction-decided` criterion later changed, and newer
  human Evidence records the corrected product direction.
- `.vibehub/outcomes/ticket-encode-human-acceptance-authority.yaml` first
  appears at `ffaad6d19139942e4d1e21679a3cf7b8a6d94f21`; the owning Ticket's
  `decision-boundary-policy-approved`, `plan-and-run-handle-human-decisions`,
  and `rooms-flow-proves-graph-boundary` contracts later changed.

The important limit is exact: Git proves what contract was checked in beside a
proof document, not what an Agent privately meant before that commit. A bulk
import or same-commit migration can preserve a readable snapshot without
proving that it was the original adjudicated contract. Reconstruction must
therefore remain visibly classified as reconstructed, never native.

## Policy comparison

### A. Mark every legacy proof stale

Treat every Evidence and Outcome without a native contract identity as
unbound. This is maximally strict and maximally disruptive.

On the audited snapshot it retains 0 DONE Tickets, 0 archived Tickets, 0 human
authority satisfactions, and 0 successful prerequisite edges. It effectively
reopens the repository and destroys the operational value of already-reviewed
history. Rollback would require restoring the previous project format or an
explicit re-adjudication of all 59 Outcomes.

Source-of-truth assumption: absence of native identity means no trustworthy
historical binding, even when Git contains a contemporaneous contract.

### B. Grandfather every currently successful Outcome

Preserve all currently valid successful Outcomes as permanently accepted
legacy closures, while binding only new proof to revisions.

It retains all 59 DONE Tickets, 43 archived Tickets, 10 human-authority
satisfactions, 59 successful prerequisite edges, and the current three open
dependents whose prerequisites are satisfied. Migration and rollback are
simple. The cost is semantic: the one known drifted successful Outcome would
remain DONE against current criterion wording it did not originally
adjudicate, and future discovery of more drift would not change that.

Source-of-truth assumption: current repository validity and prior independent
closeout are sufficient authority to freeze legacy success despite missing
contract identity.

### C. Reconstruct from Git; unresolved or drifted proof stops

Bind legacy proof to the Ticket contract at its first Git appearance. Keep a
successful Outcome current only when reconstruction succeeds and that complete
contract is unchanged today. Anything missing, ambiguous, or drifted becomes
legacy-unresolved and requires review.

On this snapshot it retains 58 DONE Tickets, 42 archived Tickets, 9 satisfied
human-authority criteria, and 58 successful prerequisite edges. The one known
drifted successful Outcome becomes unresolved. All 202 Evidence and 59 Outcomes
are reconstructable here, but another repository may have missing history.

Source-of-truth assumption: a contemporaneous Git snapshot is acceptable
migration evidence, but cannot silently certify later contract changes.

Rollback can restore the pre-migration format without deleting reconstructed
metadata. Reapplying the migration must produce identical identities and the
same unresolved set.

## Recommendation: bounded reconstruction with explicit legacy closure

Choose a hybrid of B and C:

1. Compute a native deterministic identity for every current Acceptance and
   complete Ticket contract going forward.
2. Reconstruct legacy Evidence and Outcomes from their first Git appearance
   where possible and mark the binding origin `reconstructed`, never `native`.
3. Preserve a successful legacy Outcome only when its reconstructed complete
   contract is unchanged today.
4. Mark missing, ambiguous, or drifted legacy Outcomes `legacy-unresolved`.
   They stop contributing to current DONE, archive, dependent unlock, and
   CLOSE_OUT until independently reviewed against the current contract.
5. Keep stale or superseded Evidence readable forever. It may explain history
   but cannot satisfy current coverage or human authority.
6. Do not mutate closed Acceptance contracts in ordinary `ticket apply`.
   Replanning after success needs a future explicit reopen protocol that keeps
   the prior Outcome immutable.

This recommendation preserves 58 of 59 current closures while surfacing the
one real semantic drift already present. It avoids the repository-wide reset of
A and the silent reinterpretation of B. The owner must explicitly approve this
tradeoff before implementation becomes firm.

## Migration and rollback invariants

- Every historical Evidence and Outcome file remains byte-preserved or
  content-preserved with its prior Git provenance inspectable.
- Identity uses stable serialization of Ticket ID, Acceptance ID, criterion,
  and explicit/default authority. A complete Outcome contract additionally
  commits to Acceptance membership.
- Unrelated Ticket context, constraints, relations, deliveries, formatting,
  and copy do not invalidate unchanged criteria.
- Human authority still requires referenced human-origin Evidence.
- Migration is one explicit project-format step shared by source, Codex and
  Claude artifacts; there is no compatibility daemon or hidden cache.
- Rollback changes the active format interpretation, never deletes proof or
  fabricates a prior successful Outcome.

## Downstream implementation boundary

After the owner decides, `ticket-bind-proof-to-acceptance-revision` should be
replanned from draft to firm. Its implementation must cover:

- Ticket schema: deterministic per-criterion and complete-contract identity.
- Evidence schema: recorded identity plus native/reconstructed binding origin.
- Outcome schema: accepted/unresolved identities or one complete digest.
- Migration registry: selected legacy policy, dry-run impact report,
  deterministic apply, unresolved list, and rollback guidance.
- Validation: stale proof is preserved but never counts as current coverage;
  normal mutation of a successfully closed contract is rejected.
- Projection: `next_action`, CLI, graph, frontier, and Workbench explain current,
  stale, reconstructed, and unresolved proof without inventing another status.
- Host parity: source, Codex, Claude, and installed artifacts use the same
  schemas and migration.
- Regression: wording, authority, membership, ID replacement, unchanged
  criteria, legacy reconstruction, ambiguous history, closed mutation,
  rollback, archive, dependent unlock, and human authority.

## Owner decision

Select one policy for the next Ticket:

- A — mark all legacy proof stale;
- B — grandfather every current successful Outcome;
- C — reconstruct from Git and stop on every drift/unresolved case; or
- Recommended hybrid — reconstruct from Git, preserve only unchanged legacy
  closures, and route drift/unresolved cases to independent review.
