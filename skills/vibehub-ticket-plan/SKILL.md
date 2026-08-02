---
name: vibehub-ticket-plan
description: Turn a deliverable into the smallest executable Git-native VibeHub Ticket graph. Use when the user starts a development cycle, asks to plan work as Tickets, or when execution discovers new independently schedulable work.
---

# VibeHub Ticket Plan

Plan outcomes, not ceremony. One coherent deliverable is usually one Ticket.
Split only at a real scheduling, dependency, retry, authority, or verification
boundary.

Read `../vibehub-ticket-review/references/ticket-lifecycle.json` before acting.
This Skill owns `plan-applied`; it does not own UI launch mechanics.

## Workflow

1. Read the current graph and any named Ticket:

   ```text
   node ../scripts/vh.mjs ticket graph --repo <root>
   node ../scripts/vh.mjs ticket get --repo <root> --input <id.json>
   ```

2. Query Context only for facts that govern the deliverable or fill a real
   planning gap. The Ticket itself carries enough `context`, `context_refs`,
   constraints, and acceptance for a fresh Agent.
3. Draft complete Ticket documents using `../contracts/ticket.schema.json`.
   Dependents list only direct prerequisites. Do not manufacture migration,
   review, or dogfood stages.
4. Ask a separate Agent to use `$vibehub-ticket-validate` on the raw candidate
   when an independent Agent is available. The validator is read-only. A
   protected product, permission, or material-risk choice remains blocked for
   the user; ordinary engineering fog does not.
5. Apply the unchanged passing batch:

   ```text
   node ../scripts/vh.mjs ticket apply --repo <root> --input <tickets.json>
   ```

6. Read the graph back and report Ticket IDs, paths, READY/BLOCKED state, and
   the next executable outcome. Follow `plan-applied`: ask
   `$vibehub-ticket-review` to present the refreshed graph, focused on the new
   Ticket when there is one clear subject. Presentation is not an approval
   gate; continue when the user already authorized execution. Git commit/PR is
   the review and rollback boundary.

## Guardrails

- Never edit around failed schema or graph validation.
- Never add a second lifecycle, source-token protocol, lease, or hidden state.
- Comments and Agent suggestions are input, not human authority.
