---
name: vibehub-ticket-closeout
description: Independently adjudicate one VibeHub Ticket Run against every current acceptance criterion and append an exact Git-native closeout. Use after execution evidence exists and a separate Agent must decide whether the Ticket succeeded, partially completed, failed, deviated, or became stale.
---

# VibeHub Ticket Closeout

Act as the executor's semantic counterparty. Closeout judges the current Ticket
promise; it does not merely summarize a Run.

## Prerequisites

1. Read `../_stdlib/operations.md` and `../_stdlib/reporting.md`.
2. Read the exact operation entries in
   `../contracts/operation-contracts.json` before constructing any input.
3. Work in a separate Agent context that did not execute the Run. If
   independence cannot be established, stop visibly; self-close is invalid.
4. Receive the repository, exact Ticket or Run identity, and raw implementation
   and verification artifacts rather than the executor's expected verdict.

## Workflow

1. Load one fresh `ticket.graph.snapshot`. Inspect the exact Ticket with
   `ticket.subject.inspect`, and load every page of `ticket.trace.list` needed
   to reconstruct its context binding, Run, evidence, prior closeouts,
   prerequisites, and protected Decisions. Do not combine facts from different
   source snapshots.
2. Verify the Run generation, Ticket revision, context binding, worktree,
   branch, graph, bound Decision verification, and acceptance set from current
   operation facts. Distinguish implementation commits cited by the Run from
   unrelated source movement; advancing HEAD with the Ticket's own
   implementation is not automatically stale. A missing, obsolete,
   unauthorized, or mismatched execution subject uses only the exact
   historical-binding `stale` path; never transplant another terminal form
   onto a newer Ticket revision or graph.
3. Review forward from the Run and backward from the Ticket promise. For a
   current binding, adjudicate every current acceptance ID in binding order.
   For the historical `stale` path, adjudicate the acceptance IDs and order
   frozen in that historical binding; never mix in a newer Ticket's acceptance
   set. For each adjudicated acceptance:

   - reproduce or inspect the cited evidence;
   - verify that every evidence reference belongs to the exact Run and
     acceptance;
   - distinguish a passing criterion from plausible executor prose;
   - record `accepted`, `rejected`, or `unresolved` in the binding's acceptance
     order, with the smallest honest rationale and exact evidence references.
4. Resolve overlapping conditions in this order: `stale`, then `deviated`,
   then `successful`; otherwise choose `partial` when useful bounded work or at
   least one accepted criterion exists, and `failed` when it does not. Select
   one terminal form:
   - `successful` only when every current acceptance is accepted with matching
     evidence and no current deviation invalidates the promise;
   - `partial` when useful bounded work exists but the promise is incomplete;
   - `failed` when execution did not produce the promised outcome;
   - `deviated` when the result violates an accepted product, experience,
     architecture, design, permission, or risk boundary;
   - `stale` when the exact execution subject or binding is no longer current.
5. For partial, failed, deviated, or stale work, include follow-up Ticket refs
   only when they already exist. Do not change the graph before appending
   closeout merely to create a reference; never manufacture one or edit YAML.
6. Treat semantic knowledge effects as proposals. A closeout may cite existing
   semantic refs, but it must not activate, amend, or certify governed project
   knowledge as a side effect.
7. Call `ticket.closeout.append` once with the exact source, Run generation,
   terminal form, a bounded executor report, per-acceptance adjudications,
   follow-up refs, and semantic proposal refs. Derive the executor report from
   the raw Run summary, implementation state, verification commands, and named
   unresolved work; treat it as a claim to check, not evidence. Apply only the
   operation's strict contract; do not omit rejected or unresolved adjudicated
   acceptance criteria to obtain success.

   ```text
   node ../scripts/vh-ticket.mjs closeout.append --repo [root] --actor [actor] --request [id] --input [closeout.json]
   ```
8. Refresh `ticket.frontier.read` plus the closed Ticket's traces. Claim
   downstream unlock only when the persisted closeout is `successful` and its
   exact ContextBinding plus bound Decision verification remain operationally
   current. Partial, failed, deviated, stale, unavailable, conflicting, or
   authority-invalidated closeouts unlock nothing. The durable Outcome remains
   visible after authority withdrawal but no longer derives `DONE`. Read
   operational state in this order: a current authorized successful closeout
   is `DONE`; without one, a current deviation is `DEVIATED`; otherwise
   prerequisite outcomes and authority blockers determine `READY` or
   `BLOCKED`. After this readback, use `$vibehub-ticket-plan`
   to create or revise any newly discovered follow-up work, preserving the
   closeout reference as provenance; use `$vibehub-ticket-review` only for a
   genuine protected Decision.
9. Report through the five-section protocol with the terminal form, accepted /
   rejected / unresolved counts, closeout reference, follow-up work, and exact
   next executable or blocked outcome.

## Guardrails

- Never close a Run you executed or helped execute.
- Never infer acceptance from a passing test suite alone.
- Never rewrite evidence, Run facts, Decisions, or Ticket definitions during
  adjudication.
- Never turn closeout into plan review, dogfood, a scheduler, a daemon, or a
  generic workflow.
- Never claim downstream readiness without a fresh successful readback.
