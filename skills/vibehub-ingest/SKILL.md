---
name: vibehub-ingest
description: Capture discussions, handoffs, reviews, notes, requirements, and implementation evidence as governed VibeHub draft knowledge. Use when durable intent, decisions, constraints, contracts, conventions, context, or changes must be decomposed, deduplicated, placed, preserved with provenance, and handed to human review.
---

# VibeHub Ingest

Convert messy evidence into an atomic, previewed draft batch. Keep semantic
judgment here; persist only through dispatcher operations.

## Prerequisites

1. Read `../_stdlib/ontology.md` and `../_stdlib/provenance.md`.
2. Read `../_stdlib/db-operations.md` before the first operation.
3. Read `../_stdlib/relations.md` only when a candidate depends on, conflicts
   with, relates to, or replaces another spec.
4. Read `../_stdlib/lifecycle.md` only when evidence affects an existing spec.
5. Validate the batch against `../contracts/ingest-plan.schema.json`.
6. Read `references/decomposition-and-classification.md` when input contains
   more than one claim or any type is ambiguous.
7. Read `references/mutation-classification.md` when preview finds a possible
   duplicate, overlap, conflict, existing ID or replacement.

## Workflow

1. Triage durable evidence. Preserve authored decisions, behavioral promises,
   constraints, rationale and implementation transitions. Drop acknowledgments,
   transient execution chatter, and unsupported speculation.
2. Split into atomic claims. Apply the seven-type test from ontology and the
   method reference when needed. Split
   combined decision/constraint, contract/constraint, or change/decision claims.
3. Query active knowledge and placement candidates:

   ```text
   node ../scripts/vh-kb.mjs spec.search --repo <root> --actor <id> --request <id> --input <request.json>
   node ../scripts/vh-kb.mjs feature.suggest --repo <root> --actor <id> --request <id> --input <request.json>
   ```

4. Classify each claim with the mutation method as `new`, `duplicate`, `amend`, `conflict`,
   `supersession`, or `staleness`. Never hide disagreement inside an amendment.
   Place cross-cutting claims at project level; leave uncertain placement
   unplaced rather than inventing a feature ID.
5. Preserve exact quotes/source refs and anchors. Label inference. Ask at most
   two clarifying questions across an interactive batch: placement first, then
   genuinely ambiguous type/mutation. When invoked by a hook or other
   noninteractive caller, ask none; choose the safest draft default and report
   it for review.
   Before adding any relation, apply the relations edge checklist. Use
   `depends_on` only when concrete necessity and direct breach evidence are
   shown. Adjacency, anchor overlap, co-mention, imports, or shared placement
   alone means `relates_to` or no edge.
6. Build one ingest-plan artifact. Preview without writing:

   ```text
   node ../scripts/vh-kb.mjs ingest.preview --repo <root> --actor <id> --request <id> --input <preview.json>
   ```

   Reconcile exact lexical/anchor-overlap signals. Semantic similarity remains
   judgment, never a fabricated deterministic match.
7. Apply all new drafts atomically with a stable idempotency key and task ID:

   ```text
   node ../scripts/vh-kb.mjs draft.apply --repo <root> --actor <id> --task <task> --request <id> --input <plan.json>
   ```

   Never fall back to per-spec writes or direct database access after rejection.
8. Read `../_stdlib/reporting.md`; report written draft IDs, duplicates,
   defaults, conflicts and unresolved mutations. Hand off to `vibehub-review`.

## Guardrails

- Never promote, delete, or silently replace active human-authored knowledge.
- Use amend/stale/supersede only through explicit review operations.
- Never claim capture when the dispatcher envelope has `ok:false`.
