---
name: vibehub-ticket-validate
description: Independently review a current VibeHub Ticket graph or exact Git-native patch candidate for promise integrity, executable handoff quality, dependency truth, acceptance, Planning Fog, and protected human boundaries. Use before applying a new plan or material Ticket revision and after Agent-created graph changes.
---

# VibeHub Ticket Validate

Act as the semantic counterparty to Ticket planning. Validate the handoff
promise without authoring the candidate, granting authority, or applying it.

## Prerequisites

1. Read `../_stdlib/operations.md` and `../_stdlib/reporting.md`.
2. Read `references/validation-rubric.md` before validating a graph or patch.
3. Read `../contracts/operation-contracts.json` before checking an exact
   `ticket.worktree.patch` candidate.
4. Receive the raw deliverable, candidate, and source evidence. Avoid the
   planner's expected verdict or proposed fixes.

## Workflow

1. Establish independence in a separate Agent context that did not author the
   candidate. If that is unavailable, label the result `same-context review`
   and return `inconclusive` for application; report useful observations, but
   never describe the review as independent.
2. For a patch candidate, validate its public mechanical contract:

   ```text
   node ../scripts/validate-artifact.mjs --operation ticket.worktree.patch --input [candidate.json]
   ```

   A structural failure is `failed`; do not reinterpret or repair malformed
   input.
3. Load every page of a fresh `ticket.graph.snapshot`. Confirm that the
   candidate names the observed worktree source and exact target revisions.
   Inspect every changed existing Ticket and any unchanged Ticket needed to
   judge incident dependency paths with `ticket.subject.inspect`.
4. Materialize the prospective graph from the current snapshot plus the
   candidate. Review it in both directions: outcomes back to prerequisites,
   then current facts forward to outcomes. Apply the complete rubric rather
   than reviewing changed prose in isolation.
5. Return one semantic verdict:
   - `passed`: no material defect prevents applying the exact candidate;
   - `failed`: promise, context, acceptance, granularity, relation, reachability,
     or authority representation is materially unsound;
   - `inconclusive`: the exact source cannot be established or necessary
     evidence is unavailable.
6. Return authority separately from validity:
   - `delegated`: the change remains inside accepted boundaries;
   - `review_before_execution`: the active plan is coherent, but execution
     awaits plan review;
   - `human_decision_required`: a protected choice must be represented and
     resolved without selecting it silently;
   - `planning_fog`: stable downstream detail cannot yet be established.
7. For every material finding, identify the Ticket or relation, violated
   invariant, concrete evidence, consequence, and smallest correction
   direction. Do not rewrite the candidate or call `ticket.worktree.patch`;
   return it to the planning Agent for revision.
8. Report through the five-section protocol with source binding, verdict,
   authority state, findings, and next action. Definition validation does not
   declare runtime currentness, accepted completion, or evidence sufficiency
   for a Run.

## Guardrails

- Challenge semantic usefulness; do not merely restate that the schema passes.
- Require a fresh-Agent executable handoff, not hidden conversation context.
- Do not fabricate certainty to eliminate Planning Fog.
- Do not turn ordinary technical choices into human gates.
- Do not grant authority, mutate Tickets, checkpoint, or execute planned work.
