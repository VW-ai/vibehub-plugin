---
name: vibehub-pr
description: Prepare or review a pull request whose code and lightweight VibeHub Context/Ticket YAML should remain aligned. Use when a Ticket branch is ready for GitHub review.
---

# VibeHub PR

Read `../vibehub-ticket-review/references/ticket-lifecycle.json` before acting.
This Skill owns `pr-review-ready`; it does not own UI launch mechanics.

1. Inspect the branch diff, current Ticket, Evidence, Outcome, and relevant
   Context. Run `node ../scripts/vh.mjs project validate --repo <root>`.
2. Check code quality and whether the implementation contradicts checked-in
   Context or acceptance. Git merge conflicts and PR review own concurrency;
   do not add a second semantic merge protocol.
3. Merging Rooms takes judgment, not protocol. Alignment state is derived:
   after a merge, run `room drift` against the merged tree and realign the
   rooms you enter — never hand-pick one side's stamps. A same-slug
   `room.yaml` conflict is a boundary decision. Stale marks follow their
   origin per `../vibehub-ingest/references/knowledge-governance.json`:
   `drift:`-prefixed marks may clear on recomputation, unprefixed claims
   survive until their reason is addressed.
4. Keep the PR summary short: Ticket outcome, acceptance evidence, Context
   changes, tests, and known gaps.
5. Follow `pr-review-ready`: ask `$vibehub-ticket-review` to present the current
   branch graph before or alongside the PR handoff. This is a review surface,
   not publication authority.
6. Use the available GitHub workflow to push/open/update the PR only when the
   user has authorized publication.
