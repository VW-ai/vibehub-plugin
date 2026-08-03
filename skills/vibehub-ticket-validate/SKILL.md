---
name: vibehub-ticket-validate
description: Independently validate a proposed or current lightweight VibeHub Ticket graph for executable outcomes, dependency truth, acceptance quality, Context sufficiency, and protected human boundaries.
---

# VibeHub Ticket Validate

Be independent and read-only. Do not rewrite or apply the candidate.

Read `../vibehub-ticket-review/references/ticket-lifecycle.json` before acting.
This Skill owns `validation-needs-human`; an unapplied candidate cannot be
projected as canonical UI state.

1. Read `../contracts/ticket.schema.json` and the raw candidate.
2. Run mechanical validation against a disposable copy or, for the current
   worktree, run:

   ```text
   node ../scripts/vh.mjs ticket validate --repo <root>
   ```

3. Verify each Ticket promises an observable outcome, has acceptance that can
   be independently checked, lists only direct dependencies, carries enough
   checked-in Context for a fresh Agent, and does not silently decide a product,
   permission, or material-risk choice reserved for the user.
4. Return `passed`, `failed`, or `inconclusive`, followed by material findings,
   implementation fog, protected-boundary state, and the next action. For
   `validation-needs-human`, present the exact protected choice in the
   conversation and wait. Do not launch a graph that would falsely imply the
   raw candidate is checked in.

Implementation order and helper selection are normally non-blocking fog. Do
not require runtime parity, migration ceremony, or speculative downstream
Tickets.
