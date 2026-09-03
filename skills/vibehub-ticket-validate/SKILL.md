---
name: vibehub-ticket-validate
description: Independently validate a proposed or current lightweight VibeHub Ticket graph for executable outcomes, dependency truth, acceptance quality, Context sufficiency, and protected human boundaries.
---

# VibeHub Ticket Validate

> If `../vibehub-core/scripts/vh.mjs` is missing, the install was partial. Run
> `npx skills add VW-ai/vibehub-plugin -s vibehub-core` (or rerun it
> for every Skill) before continuing; every VibeHub Skill needs that folder.

Be independent and read-only. Do not rewrite or apply the candidate.

Read `../vibehub-ticket-review/references/ticket-lifecycle.json` before acting.
Read `../vibehub-core/contracts/acceptance-authority.md` and verify that `human` appears only
on the exact acceptance criteria that genuinely reserve human judgment. Never
infer or remove authority from criterion wording.
Read `../vibehub-core/contracts/dependency-hygiene.json` and use its exact classification
when reviewing proposed dependency edges. It is advice about planning truth,
not another schema gate.
This Skill owns `validation-needs-human`; an unapplied candidate cannot be
projected as canonical UI state.

1. Read `../vibehub-core/contracts/ticket.schema.json` and the raw candidate.
2. Run mechanical validation against a disposable copy or, for the current
   worktree, run:

   ```text
   node ../vibehub-core/scripts/vh.mjs ticket validate --repo <root>
   ```

   When disposable `ticket apply` returns structured dependency advice, report
   it as nonblocking implementation fog unless the candidate prose itself
   reveals that a completed baseline was mistaken for an execution unlock.
   Never rewrite the candidate or fail it merely because the target is DONE.

3. Verify each Ticket promises an observable outcome, has acceptance that can
   be independently checked, lists only direct dependencies, carries enough
   checked-in Context for a fresh Agent, and encodes every judgment whose
   decision owner must be the user as human-authority acceptance. When such a
   decision gates independently schedulable downstream work, verify that the
   proposal, decision, and implementation boundary is represented by direct
   Ticket dependencies rather than hidden inside one Ticket's prose. If the
   decision determines the downstream acceptance, require that dependent to
   remain `maturity: draft` until planning can refine it from the decision's
   successful Outcome and Evidence.
4. Return `passed`, `failed`, or `inconclusive`, followed by material findings,
   implementation fog, protected-boundary state, and the next action. For
   `validation-needs-human`, present the exact protected choice in the
   conversation and wait. Do not launch a graph that would falsely imply the
   raw candidate is checked in.

Implementation order and helper selection are normally non-blocking fog. Do
not require runtime parity, migration ceremony, or speculative downstream
Tickets.
