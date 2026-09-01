---
name: vibehub-ingest
description: Explicitly capture durable user intent, decisions, constraints, contracts, conventions, changes, or notes as lightweight Git-native VibeHub Context. Use when the user says to record, remember, archive, or preserve something for future development.
---

# VibeHub Ingest

> If `../vibehub-core/scripts/vh.mjs` is missing, the install was partial. Run
> `npx skills add VW-ai/vibehub-plugin -s vibehub-core` (or reinstall through
> the host marketplace) before continuing; every VibeHub Skill needs that folder.

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

## Guardrails

- Never create filler Context from acknowledgements or transient execution.
- Never overwrite disagreement as if it were agreement. Preserve the conflict
  in a new Context item or ask the user when product authority is required.
- Do not dual-write into another documentation system unless the user selected
  dual-write during setup.
- A write gains no authority beyond Git; stay inside
  `../vibehub-setup/references/architecture-boundary.md`.
