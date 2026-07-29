---
name: vibehub-ticket-apply
description: Review the complete immutable evidence for a VibeHub Ticket graph-change proposal, request the separate trusted authority decision when required, and safely apply an exactly authorized proposal. Use after proposal validation when advancing a proposal toward the canonical Ticket Graph, reconciling an interrupted application, or explaining why authority or application is blocked.
---

# VibeHub Ticket Apply

Advance one immutable proposal without turning the caller's claimed identity
into authority. Treat review, authority, and application as three distinct
operations.

## Prerequisites

1. Read `../_stdlib/operations.md` and `../_stdlib/reporting.md`.
2. Use the strict generated operation contract for every input. Never guess
   identifiers, digests, or fields.
3. Give every distinct operation and exact input its own request identity.
   Reuse an identity only to retry that same operation with byte-equivalent
   input.

## Workflow

1. Inspect the complete proposal review packet:

   ```text
   node ../scripts/vh-ticket.mjs proposal.review.inspect --repo <root> --actor <id> --request <id> --input <request.json>
   ```

2. Follow only the packet's exact state:

   - `validation_required`: stop application work and use
     `$vibehub-ticket-validate` to produce independent evidence.
   - `authority_required`: follow the packet's required authority path. For
     `human_authority`, launch the proposal-specific local review host described
     below and leave the authorize/reject action to the human. For
     `delegated_policy`, stop until a configured trusted policy host can supply
     the exact delegation basis.
   - `application_ready`: construct `ticket.proposal.apply` from the exact
     proposal, candidate, authority-decision ID, and authority-decision digest.
   - `applied`: report the immutable application receipt; do not republish.
   - `comment_only`, `rejected`, or `stale`: report the reason and stop.

3. Open the trusted local human review surface, when directed:

   ```text
   node ../scripts/vh-ticket-review.mjs --proposal <proposal-id> --repo <root>
   ```

   The foreground loopback host reads the exact review packet, shows the
   candidate graph and complete validation summaries, and supplies its
   proposal-specific provider only after the human explicitly authorizes or
   rejects. The wrapper prefers the repository's built CLI before any global
   installation. The Agent may launch the host but may not click, automate, or
   infer that decision. The ordinary CLI/MCP
   `ticket.proposal.authority.decide` operation has no provider and should
   continue to fail `trusted_authority_unavailable`; caller JSON never gains an
   authority field. The current local host supports `human_authority` only and
   must not substitute a browser click for delegated policy.

4. After the review-host process returns, inspect the review packet again with
   a new request identity. The host normally auto-applies an authorization:

   - `applied`: report the immutable decision and application receipts and
     stop;
   - `rejected` or `stale`: report the terminal boundary and stop;
   - `authority_required`: no human decision was recorded before the host
     closed or expired; stop without inference;
   - `application_ready`: the decision is durable but publication still needs
     exact recovery; continue below.

5. Apply only an exact already-authorized recovery:

   ```text
   node ../scripts/vh-ticket.mjs proposal.apply --repo <root> --actor <id> --request <id> --input <application-request.json>
   ```

   Retry the same logical application when publication was interrupted.
   Core's immutable intent and Git writer fence determine whether to resume,
   reconcile an already-published candidate, or fail closed on a foreign graph
   state. Do not edit the Ticket store, writer fence, operational ledger, or
   application receipt directly. If apply returns `authority_required`,
   re-inspect the proposal and stop until an exact authorized decision exists.

6. Inspect the review packet again with a new request identity. Report the
   proposal binding, authority decision, publication status, resulting
   snapshot, and any remaining blocker.

## Invariants

- Validation is evidence, not authority.
- A public actor is always a claimed identity, even when its string names a
  human.
- Bootstrap, expansion, a protected-boundary signal, or a human gate requires
  a host-authenticated human authority path.
- Delegated policy may authorize only unprotected elaboration or decomposition
  when the trusted provider supplies the exact delegation basis.
- Never weaken, omit, or select around contrary validation receipts. Authority
  binds the complete closed validation set and explicitly names accepted
  passing receipts.
- Never create mutable workflow status as a substitute for the immutable
  decision, intent, and application receipts.

Report blocked states plainly. A proposal that cannot cross its trusted
authority boundary has not failed; it is waiting at the correct boundary.
