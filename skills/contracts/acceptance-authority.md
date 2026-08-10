# Acceptance authority

Authority is a property of one acceptance criterion, never of a whole Ticket.

- `acceptance.authority` may be `agent` or `human`. When omitted it means
  `agent`, preserving every existing Ticket.
- Use `human` only when the criterion reserves a product, permission, or
  material-risk judgment for a person. Do not infer it from prose.
- `evidence.origin` may be `agent` or `human`. When omitted it means `agent`.
- An Agent may record `origin: human` only as a faithful record of explicit
  human input and must keep a readable reference to that input. Agent analysis,
  suggestions, and assertions remain Agent-origin Evidence.
- A successful Outcome may accept a human-authority criterion only through
  referenced human-origin Evidence. A separate Agent still adjudicates the
  Outcome.
- Human attention is orthogonal to READY, BLOCKED, REFINE, DONE, and DEVIATED.
  It never changes dependency or unlock semantics.

This is a lightweight provenance claim in checked-in Git documents, not an
identity, permission, approval, or attestation system.
