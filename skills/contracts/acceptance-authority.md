# Acceptance authority

Authority is a property of one acceptance criterion, never of a whole Ticket.
It names the decision owner for that criterion, not the executor of the work.

- `acceptance.authority` may be `agent` or `human`. When omitted it means
  `agent`, preserving every existing Ticket.
- Use `human` only when successful acceptance requires a person's explicit
  judgment. Missing facts, implementation difficulty, and host permission to
  perform an already-authorized action do not by themselves change the
  decision owner. Do not infer authority from prose.
- `evidence.origin` may be `agent` or `human`. When omitted it means `agent`.
- An Agent may record `origin: human` only as a faithful record of explicit
  human input and must keep a readable reference to that input. Agent analysis,
  suggestions, and assertions remain Agent-origin Evidence.
- A successful Outcome may accept a human-authority criterion only through
  referenced human-origin Evidence. A separate Agent still adjudicates the
  Outcome.
- Human attention is orthogonal to READY, BLOCKED, REFINE, DONE, and DEVIATED.
  It never changes dependency or unlock semantics.

Plan the boundary in the Ticket graph when the decision gates independently
schedulable downstream work: a proposal Ticket produces a reviewable option, a
human-decision Ticket records the choice, and implementation depends on its
successful Outcome. A terminal human sign-off with no downstream work may stay
as one acceptance criterion in the delivery Ticket.

When the decision determines what downstream acceptance should be, keep that
dependent Ticket at `maturity: draft` instead of inventing a firm plan. The
decision's successful Outcome moves it from BLOCKED to REFINE, where Ticket
Plan reads the decision Evidence, rewrites the same Ticket in place, and only
then marks it `maturity: firm` and makes it eligible for READY execution.

If execution discovers an unplanned human decision, it returns to Ticket Plan.
Planning either revises the current Ticket or creates the smallest new Ticket
and direct dependency needed to make the boundary canonical. No Event record or
second execution package is required.

This is a lightweight provenance claim in checked-in Git documents, not an
identity, permission, approval, or attestation system.
