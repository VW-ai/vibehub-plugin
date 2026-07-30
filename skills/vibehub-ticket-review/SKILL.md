---
name: vibehub-ticket-review
description: Open the installed VibeHub Ticket graph as a local structured review surface for an exact repository worktree. Use when a human should inspect outcome paths, execution readiness, blockers, evidence, or the review interventions currently exposed by the trusted host.
---

# VibeHub Ticket Review

Open one quiet, navigable view of the current Ticket graph without turning the
review into another chat transcript.

## Prerequisites

1. Read `../_stdlib/reporting.md`.
2. Resolve the exact repository and worktree the human intends to review.

## Workflow

1. Launch the installed review host and keep its process attached:

   ```text
   node ../scripts/vh-ticket-review.mjs --repo [root]
   ```

   Use `--no-open --json` only when the caller needs the short-lived local URL
   instead of opening it automatically.
2. Let the human read the graph in execution order: what is ready, what blocks
   it, and what completing a Ticket unlocks. Use the Inspector for the complete
   executable context and traceable evidence.
3. Treat only interventions the host actually exposes as available. A Decision
   requires one explicit confirmation in the installed Plugin host. The browser
   submits only the Decision content; the host freezes the exact current Ticket
   source, signs it with the install-local signing authority, and writes the
   exact detached authority receipt.
   Durable Decision controls require a named branch. A detached checkout stays
   readable; switch that worktree to a named branch and refresh before asking
   for a durable confirmation.
4. If the source moves or the install-local signature cannot be verified,
   refresh and ask the human to confirm the exact Decision again. Never retry
   by editing a Decision or authority-receipt YAML file.
5. Treat a hidden or unavailable control as unavailable; it is not an
   invitation to edit Ticket YAML directly.
6. After a human intervention, refresh Ticket facts before planning or
   execution. Use `$vibehub-ticket-plan` to reconcile a comment, proposed edit,
   or current Decision into the graph; never infer approval from browser access
   or from the host having opened.
7. Stop the host when review ends. Report a waiting or failed launch through the
   five-section protocol; otherwise keep routine launch mechanics brief.

## Guardrails

- Bind one host to one exact worktree. Restart it after switching worktrees.
- Treat the short-lived browser link as an approval capability and keep it
  private. It is neither durable identity nor a receipt; durable authority
  begins only when the installed host signs one exact confirmed Decision.
- Treat only a fresh-process-verified `authority_receipt` as an active Decision.
  Raw Decision YAML remains inspectable `current_unverified` intent.
- The receipt proves that the install-local VibeHub authority signed the exact
  host-confirmed action. It does not prove biometric presence or identify which
  person used the local browser.
- Never claim the human viewed, understood, or approved anything without a
  durable fact that proves the corresponding action.
