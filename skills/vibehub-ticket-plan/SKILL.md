---
name: vibehub-ticket-plan
description: Shape a human-framed deliverable into an honest coarse VibeHub Ticket graph proposal by backchaining from observable outcomes and forward-normalizing the resulting paths. Use when a user asks to begin Ticket orchestration, when an accepted outcome needs decomposition, or when newly discovered work needs a bounded Ticket proposal rather than informal task notes.
---

# VibeHub Ticket Plan

Turn intent into one bounded graph-change proposal. Scenario is a
non-canonical planning and review lens; only work with a stable outcome and an
independent execution boundary becomes a Ticket.

## Prerequisites

1. Read `../_stdlib/operations.md`, `../_stdlib/reporting.md`, and
   `../_stdlib/relations.md` before planning.
2. Retrieve only the durable product, architecture, principle, and permission
   context needed to understand the requested outcome. Use `$vibehub-query`
   when the relevant governed context is not already present.
3. Use the strict generated operation contract for every Ticket input. Never
   guess a field, enum, identifier, revision, or snapshot binding.
4. Give each distinct read, validation, and submit operation its own request
   identity. Reuse an identity only to retry the same operation with
   byte-equivalent input.

## Shape the graph

1. Read the current graph with bounded `ticket.graph.snapshot` pages. Use the
   exact returned snapshot ID as `observedSnapshotId`. Use `null` only for a
   proven bootstrap with no canonical graph; a failed or ambiguous read is not
   proof of an empty graph.

   ```text
   node ../scripts/vh-ticket.mjs graph.snapshot --repo <root> --actor <id> --request <id> --input <request.json>
   ```

2. Frame a small set of human-understandable scenario lenses. For each lens,
   name the actor or system situation, observable outcome, relevant accepted
   boundaries, and unresolved decisions. Keep these as planning notes. Do not
   create a Scenario entity or force one scenario to equal one Ticket. When
   these lenses contain durable product decisions, preserve them in the
   project's planning artifact; the proposal `reason` is a concise summary,
   not a substitute for that record.

3. Backchain from each observable outcome. Ask which independently provable
   result, fact, or authorized decision must exist immediately before it, then
   repeat until reaching current evidence, an executable frontier, a genuine
   blocker, or Planning Fog. Preserve necessary parallel branches and joins.
   Keep alternative paths behind the decision that selects among them.

4. Create a Ticket only when its outcome is stable enough to preserve and it
   needs an independent scheduling, blocking, verification, permission, or
   retry boundary. Keep implementation steps that share their parent's
   acceptance as elaboration. A coarse assembly or verification Ticket may
   prove a scenario, but scenario membership remains a derived review lens.

5. Stop honestly at an unknown frontier. If a stable blocking decision or
   directional outcome is known, propose that coarse Ticket and leave its
   downstream continuation unexpanded. If even the direction is unknown,
   describe Planning Fog in the proposal reason and report; do not fabricate
   placeholder Tickets to make the graph look complete.

6. Forward-normalize from current facts toward the outcomes:

   - ensure every Ticket contributes to at least one coarse outcome;
   - merge duplicated outcomes and shared prerequisites;
   - remove unnecessary serialization and transitive dependency edges;
   - preserve real parallelism, joins, blockers, and human gates;
   - split work with an independent outcome, verifier, authority, or retry
     boundary;
   - remove orphan and dead-end nodes.

   Containment and execution order are different. Give every non-top-level
   Ticket one truthful `parent`. In `dependsOn`, the target is the prerequisite
   that must finish before the dependent Ticket can proceed. Attach shared work
   to the earliest coarse ancestor whose outcome truthfully contains it, then
   connect the affected branches with explicit dependencies.

7. Read the graph forward once more as if handing each proposed Ticket to a
   fresh Agent. Make every outcome concrete and bounded enough to distinguish
   success from activity. The current proposal contract records an outline
   graph, so do not claim that submission itself proves `specified`,
   `executable`, READY, or any Runtime status.

## Classify and submit

1. Classify the proposal honestly in `authorAssessment`:

   - `elaboration`: clarify the same promise without an independent new
     Ticket;
   - `decomposition`: partition work already contained by an accepted outcome;
   - `expansion`: widen an outcome or a delegated boundary.

   Record every supported protected-boundary signal:
   `initial_plan_authority`, `experience_product`, `principle_deviation`,
   `permission_side_effect`, or `risk_policy`. Set `introducesHumanGate`
   truthfully. These are claimed planning judgments that request later review;
   they do not grant authority. A bootstrap initial plan carries
   `initial_plan_authority`; never omit it to make the proposal appear
   delegated. That signal already requires the separate human authority path;
   set `introducesHumanGate` only when the candidate work itself adds a human
   decision gate. Technical difficulty alone is not a human boundary.

2. Construct one bounded `graph_change` input. Use local references for
   relationships among new Tickets and exact Ticket IDs and expected
   definition revisions for existing Tickets. Prefer the widest honest coarse
   graph over speculative leaf completeness.

3. Validate the exact input before submission:

   ```text
   node ../scripts/validate-artifact.mjs --operation ticket.proposal.submit --input <proposal.json>
   ```

4. Submit the validated proposal:

   ```text
   node ../scripts/vh-ticket.mjs proposal.submit --repo <root> --actor <id> --request <id> --input <proposal.json>
   ```

5. Report the scenario lenses, graph shape, parallel paths, joins, human
   blockers, Planning Fog, proposal identity, and exact snapshot binding using
   the shared five-section protocol. Distinguish canonical facts from planning
   inference.

## Handoff and authority boundary

- Hand the immutable proposal to `$vibehub-ticket-validate` for independent
  semantic evidence. Do not validate your own proposal inside this Skill.
- After validation, hand the exact proposal to `$vibehub-ticket-apply` for
  review and application handling. When that review derives a
  `human_authority` path, launch the proposal-specific trusted surface with
  `node ../scripts/vh-ticket-review.mjs --proposal <id> --repo <root>` and
  leave the actual authorize/reject action to the human. This wrapper prefers
  the repository's built CLI before any globally installed binary. The host
  applies only the exact candidate that receives a matching decision receipt.
- Never add a principal, approval, delegation, disposition, authority claim,
  maturity, status, assignee, progress, or direct graph mutation outside the
  generated operation input.
- Never infer authorization from the user conversation, public `actor`,
  validation success, an authority signal, or this Skill. If the trusted host
  is unavailable, stop at that boundary and surface it.
- Never edit canonical Ticket data or operational receipts directly.

The result of this Skill is an inspectable proposal, not an approved plan.
