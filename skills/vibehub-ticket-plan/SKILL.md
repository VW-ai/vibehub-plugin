---
name: vibehub-ticket-plan
description: Shape a deliverable, scenario set, blocker resolution, deviation, or newly discovered work into a flat executable VibeHub Ticket graph. Use when an Agent should create, revise, decompose, expand, or forward-normalize Git-native Tickets and apply the independently validated result to the current worktree.
---

# VibeHub Ticket Plan

Turn intended outcomes into the smallest truthful dependency graph that a
fresh Agent can execute without the planning conversation.

## Prerequisites

1. Read `../_stdlib/operations.md` and `../_stdlib/reporting.md`.
2. Read `references/planning-method.md` before shaping or revising a graph.
3. Read `../contracts/operation-contracts.json` before constructing an exact
   `ticket.worktree.patch` input.
4. Use `$vibehub-query` when governing project knowledge, prior decisions, or
   constraints are needed. Inspect relevant repository facts directly.

## Workflow

1. Frame the deliverable as observable outcomes. Use scenario lenses when they
   help a human understand the plan, but never persist Scenario as a second
   object or force one Ticket per scenario. Identify the authorized product,
   experience, architecture, design, permission, and risk boundaries.
2. Select the planning policy from user intent:
   - `review-plan`: write the machine-validated graph active, then stop before
     execution so the human can review the outcome paths and genuine gates;
   - `auto-apply-unless-human-gate`: write and proceed inside delegated
     boundaries, stopping only at a protected decision.
   Treat an initial product-facing plan as `review-plan` unless the human
   explicitly delegated plan review. Do not route objectively adjudicable
   internal engineering choices to a human.
3. Load every page of the current graph:

   ```text
   node ../scripts/vh-ticket.mjs graph.snapshot --repo [root] --actor [actor] --request [id] --input [snapshot-request.json]
   ```

   Inspect affected existing Tickets with `ticket.subject.inspect`. Treat the
   returned source and Ticket revisions as facts, not reusable memory.
4. Classify the change as no durable work, elaboration, decomposition,
   expansion, decision blocker, deviation, or Planning Fog. Backchain from
   each observable outcome, then read forward from current facts and normalize.
   Create a node only when it has an independent scheduling, blocking, retry,
   authority, or verification boundary.
5. Build one exact patch candidate containing complete Ticket documents. Each
   dependent Ticket lists only its direct prerequisites. Use `null` only for a
   genuinely absent Ticket; copy every replacement revision and all source
   fields from the same latest snapshot.
6. Validate mechanics before semantic review:

   ```text
   node ../scripts/validate-artifact.mjs --operation ticket.worktree.patch --input [candidate.json]
   ```

   Then delegate the raw candidate, deliverable, and source evidence to
   `$vibehub-ticket-validate` in a separate Agent context. If no independent
   context is available, stop with `inconclusive`; same-context observations
   cannot authorize apply. Do not apply a candidate with a `failed` or
   `inconclusive` verdict. A protected question may be represented honestly as
   a blocking Ticket; the candidate must not silently choose the answer.
7. Apply only the unchanged passing candidate:

   ```text
   node ../scripts/vh-ticket.mjs worktree.patch --repo [root] --actor [actor] --request [id] --input [candidate.json]
   ```

   On a stale source or revision, reload the graph and redo semantic
   reconciliation; never swap in fresh tokens mechanically.
8. Reload the graph, inspect every changed Ticket, and verify the intended
   dependency paths. Use the returned exact checkpoint selection only when the
   caller or repository policy requests a durable checkpoint. Never include
   unrelated worktree changes.
9. Report through the five-section protocol. Include changed Ticket IDs,
   validation verdict, protected-boundary state, exact changed paths, and the
   next executable or blocked outcome. Human review gates execution authority,
   not a draft-to-active lifecycle.

## Guardrails

- Keep semantic judgment in this Skill; use scripts only for exact reads,
  validation, stale checks, and bounded writes.
- Preserve a stable outcome under one Ticket ID. Create a new Ticket when the
  promised result materially changes.
- Preserve honest uncertainty. Do not manufacture speculative downstream
  Tickets merely to make the graph look complete.
- Never self-certify semantic validity, auto-commit inside the patch, or bypass
  a failed operation by editing Ticket files directly.
