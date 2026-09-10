---
name: vibehub-ingest
description: Explicitly capture durable user intent, decisions, constraints, contracts, conventions, changes, or notes as lightweight Git-native VibeHub Context. Use when the user says to record, remember, archive, or preserve something for future development.
---

# VibeHub Ingest

## Optional workflow and unrestricted responses

Use this Skill when the user requests its VibeHub operation or has already
chosen VibeHub for the current work. Installation alone does not opt a user
into ticketing. Ordinary chat, exploration, and implementation can continue
without a Ticket, a special phrase, or a prescribed response format. Users can
leave the workflow at any time; do not block their work for missing VibeHub
records. Never truncate, rewrite, suppress, or withhold a model response to
satisfy VibeHub. Schema and lifecycle checks govern explicit VibeHub record
writes only, not the model's answer or the user's ability to work.



## Automatic dashboard entry

Before the first user-facing operation in an opted-in VibeHub session, follow
`../vibehub-core/contracts/session-entry.md`: run the bundled `vh-start.mjs`
entry helper, reuse the session's existing dashboard when available, then
continue this Skill. Do not ask the user to start a separate dashboard.
Subagents reuse the parent's entry; a user request to keep it closed wins.

> If `../vibehub-core/scripts/vh.mjs` is missing, the install was partial. Run
> `npx skills add VW-ai/vibehub-plugin -s vibehub-core` (or rerun it
> for every Skill) before continuing; every VibeHub Skill needs that folder.

Capture only when the user explicitly asks, or when another VibeHub workflow
explicitly delegates durable capture. Do not poll conversation turns or infer a
checkpoint cadence.

Branch on the shape of what was handed over, never on its size and never by
asking the user to choose. When the material is one or more whole documents or
files to be absorbed, rather than a claim, decision, or note the user has
already stated, follow `references/bulk-absorption.md` — it orchestrates the
same writes below with a survey, a Room-tree gate, and a coverage obligation
around them. Otherwise continue directly with the workflow.

## Workflow

1. Decide whether the request is durable Context or executable work. A product
   decision, constraint, convention, intent, or reusable explanation is
   Context. A deliverable to implement is a Ticket. When both exist, write both
   and link them with `context_refs`.
2. Query current Context first:

   ```text
   node ../vibehub-core/scripts/vh.mjs context query --repo <root> --input <query.json>
   ```

3. Create one atomic document per claim using
   `../vibehub-core/contracts/context.schema.json`. Preserve the user's exact source ref and,
   when useful, a short exact quote. Every document needs readable evidence.
4. Choose the owning room per the placement rule in
   `references/knowledge-governance.json`, then write the complete document:

   ```text
   node ../vibehub-core/scripts/vh.mjs context put --repo <root> --room <path> --input <context.json>
   ```

   The `.yaml` file uses JSON-compatible YAML so the installed plugin needs no
   package runtime. Git owns history, review, concurrency, and rollback.
5. Report the Context ID and path only after `ok:true`. A failed envelope means
   nothing was persisted.

## Authority Context

When the user names golden truth — a contract, an architecture graph, a rule
set, or a resource that implementation must follow — write `type: authority`
with an `authority` object: `governs` (repository territory in Room anchor
syntax), `canonical` (current repository paths of the artifacts, never under
`.vibehub/`), `update_rules` (the ordered steps an Agent follows before a
canonical artifact changes), `validation` (the checks that keep implementation
and related Context consistent), and `approval: human` only when the user
reserves that change to a person. Place it in the Room whose anchors cover the
canonical artifacts; `context put` returns `advice` when one falls outside, so
widen the anchors rather than leave drift in the golden truth invisible.

A change to a canonical artifact is recorded as a `type: change` Context in the
same Room that `relates_to` the authority and cites the changed artifact in
`evidence`. `context guard` reads that record; without it the change blocks
closeout. Keep `contract` for long-range prose; `authority` is the
artifact-backed sibling.

## Guardrails

- Never create filler Context from acknowledgements or transient execution.
- Never overwrite disagreement as if it were agreement. Preserve the conflict
  in a new Context item or ask the user when product authority is required.
- Do not dual-write into another documentation system unless the user selected
  dual-write during setup.
- A write gains no authority beyond Git; stay inside
  `../vibehub-setup/references/architecture-boundary.md`.
