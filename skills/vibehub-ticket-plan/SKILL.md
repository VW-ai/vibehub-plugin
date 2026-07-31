---
name: vibehub-ticket-plan
description: Shape a deliverable, scenario set, blocker resolution, deviation, or newly discovered work into a flat executable VibeHub Ticket graph. Use when an Agent should create, revise, decompose, expand, or forward-normalize Git-native Tickets and apply the independently validated result to the current worktree.
---

# VibeHub Ticket Plan

Turn intended outcomes into the smallest truthful dependency graph that a
fresh Agent can execute without the planning conversation.

## Prerequisites

1. Read `../_stdlib/operations.md` and `../_stdlib/reporting.md`.
2. Read `references/planning-method.md` before shaping or revising a graph,
   including a change prompted by a Review or Decision.
3. Read `../contracts/operation-contracts.json` before constructing an exact
   `ticket.worktree.patch` input.
4. Use `$vibehub-query` when governing project knowledge, prior decisions, or
   constraints are needed. Inspect relevant repository facts directly.

## Workflow

1. Frame the deliverable as observable outcomes. Use scenario lenses when they
   help a human understand the plan, but never persist Scenario as a second
   object or force one Ticket per scenario. Identify the authorized product,
   experience, architecture, design, permission, and risk boundaries.
2. Refresh one coherent semantic view before choosing or revising work:
   - load every page of `ticket.graph.snapshot`;
   - use its `snapshotId` for `ticket.subject.inspect` on the graph, every
     affected Ticket, and incident relation needed to judge the change;
   - load every page of `ticket.trace.list` for the graph and those Ticket or
     relation subjects, including any subject whose reported trace count is
     non-zero.

   ```text
   node ../scripts/vh-ticket.mjs graph.snapshot --repo [root] --actor [actor] --request [id] --input [snapshot-request.json]
   node ../scripts/vh-ticket.mjs subject.inspect --repo [root] --actor [actor] --request [id] --input [inspect-request.json]
   node ../scripts/vh-ticket.mjs trace.list --repo [root] --actor [actor] --request [id] --input [trace-request.json]
   ```

   Keep the returned `sourceToken`, worktree identity, commit, graph digest,
   semantic-ledger digest, snapshot ID, Ticket revisions, and trace currentness
   together. Never combine pages or subject facts from different snapshots.
   If an exact snapshot or subject cannot be reconstructed, stop visibly and
   refresh; an unavailable read is not an empty trace.
3. Reconcile projected review facts before acting:
   - a `comment` is non-mutating input. It can improve judgment or motivate
     planning, but it neither changes a Ticket nor grants authority;
   - a current `ticket_edit` is a proposed complete replacement, not an
     approved patch. Read the exact Review document named by its typed
     repository-path target, reconcile it with the freshly inspected Ticket
     and complete graph, and author a new candidate. If retained, add the
     Review `recordRef` to the Ticket's provenance;
   - only a Decision projected as a current `gate_decision` from an
     `authority_receipt` supplies human authority. A `plan_review` applies
     only to its exact graph digest; a `protected_boundary` applies only to
     its exact Ticket revision and recorded boundary. `request_changes`
     requires new planning, while `decline` leaves the protected answer
     unresolved. Before acting, follow the Decision's typed repository-path
     target and verify the complete durable document; the trace summary alone
     never supplies delegated boundaries, a protected selection, or scope.

   Historical comments, proposals, and Decisions remain useful causal
   evidence, but they are non-authoritative. Claimed or host-attested Review
   authorship is attribution, never Decision authority. On a stale subject,
   conflicting fact, missing Review document, or stale source, preserve the
   blocker or Planning Fog and report it; do not transplant the fact to a new
   revision.
4. Select the planning policy from user intent and current exact Decisions:
   - `review-plan`: write the machine-validated graph active, then stop before
     execution so the human can review the outcome paths and genuine gates;
   - `auto-apply-unless-human-gate`: write and proceed inside delegated
     boundaries, stopping only at a protected decision.
   Treat an initial product-facing plan as `review-plan` unless the human
   explicitly delegated plan review. Do not route objectively adjudicable
   internal engineering choices to a human.
5. Classify the change as no durable work, elaboration, decomposition,
   expansion, decision blocker, deviation, or Planning Fog. Backchain from
   each observable outcome, then read forward from current facts and normalize.
   Create a node only when it has an independent scheduling, blocking, retry,
   authority, or verification boundary.
6. Build one exact patch candidate containing complete Ticket documents. Each
   dependent Ticket lists only its direct prerequisites. Use `null` only for a
   genuinely absent Ticket; copy every replacement revision and all source
   fields, including `semanticLedgerDigest`, from the same latest snapshot.
   Because writing a Review or Decision changes the semantic source, never use
   a candidate captured before that fact was written. A Review-driven
   candidate is newly authored even when it adopts the proposed replacement.
7. Validate mechanics before semantic review:

   ```text
   node ../scripts/validate-artifact.mjs --operation ticket.worktree.patch --input [candidate.json]
   ```

   Then delegate the raw candidate, deliverable, and source evidence to
   `$vibehub-ticket-validate` in a separate Agent context. If no independent
   context is available, stop with `inconclusive`; same-context observations
   cannot authorize apply. Do not apply a candidate with a `failed` or
   `inconclusive` verdict. A protected question may be represented honestly as
   a blocking Ticket; the candidate must not silently choose the answer.
8. Apply only the unchanged passing candidate:

   ```text
   node ../scripts/vh-ticket.mjs worktree.patch --repo [root] --actor [actor] --request [id] --input [candidate.json]
   ```

   On a stale source or revision, reload the graph and redo semantic
   reconciliation; never swap in fresh tokens mechanically.
9. Reload the graph and relevant trace pages, inspect every changed Ticket, and
   verify the intended dependency paths and provenance readback. Use the
   returned exact checkpoint selection only when the caller or repository
   policy requests a durable checkpoint. Never include unrelated worktree
   changes.
10. Report through the five-section protocol. Include changed Ticket IDs,
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
- Do not auto-accept reviewer prose or a `ticket_edit`. Review facts enter the
  same fresh planning, independent validation, and exact patch path as any
  other graph change.
- Never self-certify semantic validity, auto-commit inside the patch, or bypass
  a failed operation by editing Ticket files directly.
