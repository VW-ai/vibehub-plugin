---
name: vibehub-pr
description: Prepare or review a pull request whose code and lightweight VibeHub Context/Ticket YAML should remain aligned. Use when a Ticket branch is ready for GitHub review.
---

# VibeHub PR

> If `../vibehub-core/scripts/vh.mjs` is missing, the install was partial. Run
> `npx skills add VW-ai/vibehub-plugin -s vibehub-core` (or reinstall through
> the host marketplace) before continuing; every VibeHub Skill needs that folder.

Read `../vibehub-review/references/ticket-lifecycle.json` before acting.
This Skill owns `pr-review-ready`; it does not own UI launch mechanics.

1. Inspect the branch diff, current Ticket, Evidence, Outcome, and relevant
   Context. Run `node ../vibehub-core/scripts/vh.mjs project validate --repo <root>` and
   `node ../vibehub-core/scripts/vh.mjs room drift --repo <root>`. Rooms this branch
   entered must be aligned: an unexplained DRIFTED room blocks the handoff
   until it is aligned or honestly marked, while `drift:`-prefixed marks are
   recorded debt and may ship. Never export staleness the branch created;
   rooms the branch never entered do not block.
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
4. Keep the PR summary short and read it through the Room lens: contract and
   shared-reference diffs first — their blast radius exceeds prose — then the
   rooms this branch entered with their knowledge changes, then Ticket
   outcome, acceptance evidence, tests, and known gaps.
5. Follow `pr-review-ready`: ask `$vibehub-review` to present the current
   branch graph before or alongside the PR handoff. This is a review surface,
   not publication authority.
6. Use the available GitHub workflow to push/open/update the PR only when the
   user has authorized publication.
