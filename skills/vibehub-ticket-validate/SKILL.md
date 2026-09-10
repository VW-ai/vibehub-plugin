---
name: vibehub-ticket-validate
description: Independently validate a proposed or current lightweight VibeHub Ticket graph for executable outcomes, dependency truth, acceptance quality, Context sufficiency, and protected human boundaries.
---

# VibeHub Ticket Validate

## Optional workflow and unrestricted responses

Use this Skill when the user requests its VibeHub operation or has already
chosen VibeHub for the current work. Installation alone does not opt a user
into ticketing. Ordinary chat, exploration, and implementation can continue
without a Ticket, a special phrase, or a prescribed response format. Users can
leave the workflow at any time; do not block their work for missing VibeHub
records. Never truncate, rewrite, suppress, or withhold a model response to
satisfy VibeHub. Schema and lifecycle checks govern explicit VibeHub record
writes only, not the model's answer or the user's ability to work.


> If `../vibehub-core/scripts/vh.mjs` is missing, the install was partial. Run
> `npx skills add VW-ai/vibehub-plugin -s vibehub-core` (or rerun it
> for every Skill) before continuing; every VibeHub Skill needs that folder.

Be independent and read-only. Do not rewrite or apply the candidate.

Read `../vibehub-review/references/ticket-lifecycle.json` before acting.
Read `../vibehub-core/contracts/acceptance-authority.md` and verify that `human` appears only
on the exact acceptance criteria that genuinely reserve human judgment. Never
infer or remove authority from criterion wording.
Read `../vibehub-core/contracts/dependency-hygiene.json` and use its exact classification
when reviewing proposed dependency edges. It is advice about planning truth,
not another schema gate.
Read `../vibehub-core/contracts/planning-hierarchy.md`. Read a member Ticket's
Epic and Goal and resolve their Context references. Verify that ownership does
not masquerade as an execution dependency and that required parent obligations
are explicit in Ticket acceptance.
Read `../vibehub-core/contracts/revision-identity.md`. For an existing Ticket,
verify the candidate preserves every immutable historical Acceptance and
Contract revision, advances revisions monotonically, uses new logical IDs for
separately passable obligations, and does not manufacture lineage or a
semantic revision for presentation-only copy.
This Skill owns `validation-needs-human`; an unapplied candidate cannot be
projected as canonical UI state.

1. Read `../vibehub-core/contracts/ticket.schema.json` and the raw candidate.
   When parents are included, also read `goal.schema.json` and `epic.schema.json`
   in that contracts directory. Validate the whole Goal/Epic/Ticket batch in a
   disposable project; check benefit, capability, and executable outcome are
   distinct, and that existing matching scope is reused.
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
   checked-in Context for a fresh Agent, and resolves every `context_ref`
   through the shared operation below rather than treating valid-looking
   syntax as readable Context:

   ```text
   node ../vibehub-core/scripts/vh.mjs context resolve --repo <root> --input <ref.json>
   ```

   `ref.json` is `{"ref":"<Ticket context_ref>"}`; consume the returned
   source and immutable identity without checking out a historical commit.
   Verify golden truth is attached and untouched:

   ```text
   node ../vibehub-core/scripts/vh.mjs context governing --repo <root> --input <governing.json>
   node ../vibehub-core/scripts/vh.mjs context guard --repo <root> --input <guard.json>
   ```

   `governing.json` carries the candidate's `context_refs` as `paths`; every
   returned `authority` Context must already be in `context_refs`, and an
   authority with `approval: human` whose canonical artifact the Ticket
   changes must appear as human-authority acceptance. For a current Ticket,
   `guard.json` (`{}` or `{"since":"<base commit>"}`) must return
   `passed: true`; a violation is a material finding, not fog.
   Verify that the Ticket encodes every judgment whose
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
