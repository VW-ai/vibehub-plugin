---
name: vibehub-review
description: Review VibeHub draft, low-confidence, conflicting, stale, unplaced, or distillation-candidate knowledge. Use to inspect review queues, promote an approved draft, amend evidence/content, deprecate or mark stale, supersede old truth, carry human knowledge across mappings, or decide whether a finalized mapping may be activated.
---

# VibeHub Review

Make explicit human-governed lifecycle decisions. Never auto-promote or delete.

## Prerequisites

1. Read `../_stdlib/lifecycle.md`, `../_stdlib/provenance.md`,
   `../_stdlib/db-operations.md`, and `../_stdlib/reporting.md`.
2. Read `../_stdlib/relations.md` for conflicts/supersession.
3. Read `../_stdlib/ontology.md` for placement/type disputes.
4. Read `../_stdlib/quality-gates.md` when reviewing a distillation version.
5. Read `references/evidence-rubric.md` before promotion, amendment,
   supersession, staleness/deprecation, carry-over, or mapping activation.

## Workflow

1. Call `kb.review` for requested kinds (`low_confidence`, `conflict`, `stale`,
   `unplaced`) and explicitly query canonical drafts when needed. Fetch full
   canonical specs with `kb.spec.get`. For candidates, select one explicit
   `runId` or `versionId`, call `distill.candidates.list` and bounded
   `distill.candidates.get`; never review from counts alone.
2. Show the current claim, state/source kind, immutable evidence, anchors,
   placement, conflicts, lineage and proposed action. Do not present a version
   candidate as canonical.
   Apply the relations edge checklist to every proposed relation. Approve
   `depends_on` only with concrete necessity and direct breach evidence;
   adjacency, co-location, shared imports/callers, or anchor overlap alone is
   `relates_to` or no edge. Defer when evidence cannot choose honestly.
3. Obtain explicit authorization for one action:
   - `kb.promote`: shown canonical draft becomes active;
   - `kb.amend`: create a new immutable revision with fresh evidence;
   - `kb.mark-stale`: active truth is known unreliable but unresolved;
   - `kb.deprecate`: reject/withdraw while preserving history;
   - `kb.supersede`: atomically set `OLD -> NEW`, with a canonical active (or
     explicitly promoted shown draft) replacement;
   - carry over: keep canonical human truth unchanged while accepting/rejecting
     mapping candidates separately.
4. Execute exactly one idempotent dispatcher mutation per authorized decision:

   ```text
   node ../scripts/vh-kb.mjs <promote|amend|mark-stale|deprecate|supersede> --repo <root> --actor <id> --request <id> --input <decision.json>
   ```

5. Re-read the spec/review queue and report the receipt as a brief
   five-section block per the reporting contract; a queue still waiting for
   review renders expanded with the required action in Next. For finalized
   mapping review, call `distill.version.get` and `distill.version.diff`,
   inspect content, provenance/removals/conflicts, then make activation a
   separate explicit `distill.activate` CAS operation.

There is no hard delete and no generic “reject” mutation: deprecate is the
auditable terminal rejection. Never auto-promote based on confidence alone.
