# Ticket next-action projection

`next_action` is a deterministic read projection over the checked-in Ticket,
its direct dependencies, acceptance-linked Evidence, acceptance authority, and
Outcome. It is routing advice for a Human or Agent. It is not persisted, does
not replace operational status, and cannot create an Outcome, DONE state,
archive membership, delivery membership, or dependent unlock.

The first matching row wins:

| Precedence | Canonical facts | Action | Stable reason | Relevant IDs |
| --- | --- | --- | --- | --- |
| 1 | Successful Outcome exists | `DONE` | `successful_outcome` | all current Acceptance IDs |
| 2 | Partial, failed, or deviated Outcome exists | `REPLAN` | `non_successful_outcome` | unresolved Acceptance IDs |
| 3 | Any direct dependency lacks a successful Outcome | `WAIT` | `unresolved_direct_dependencies` | blocking Ticket IDs |
| 4 | Ticket maturity is draft | `REFINE` | `draft_contract` | all current Acceptance IDs |
| 5 | Any agent-authority criterion lacks Evidence | `EXECUTE` | `acceptance_evidence_incomplete` | agent-authority criteria still lacking Evidence |
| 6 | A reachable human-authority criterion lacks human-origin Evidence | `NEEDS_HUMAN` | `missing_human_evidence` | affected human-authority Acceptance IDs |
| 7 | Otherwise, every current criterion has authority-satisfying Evidence and no Outcome exists | `CLOSE_OUT` | `authority_satisfying_evidence_complete` | all current Acceptance IDs |

Evidence satisfies an Agent-authority criterion when any Evidence record links
that Acceptance ID. Evidence satisfies a human-authority criterion only when a
linked record has `origin: human`. Raw Evidence count is never acceptance:
`CLOSE_OUT` asks an independent Agent to adjudicate the current contract.

A human-authority criterion is routed only once it is the remaining blocker.
While agent-authority work is still unevidenced the projection reports
`EXECUTE` and names exactly those agent-authority criteria, so a Ticket
carrying terminal human sign-off is executable from the start and asks its
person to judge a result that already exists. This is routing order only: it
never lets an Agent satisfy or bypass a human-authority criterion, and a
Ticket whose only unevidenced criteria are human-authority — including a
Ticket with no agent-authority criteria at all — still reports `NEEDS_HUMAN`
immediately. Rows 1 through 4 keep their precedence over both.

`ticket frontier` groups the same projection into `ready_to_execute`,
`ready_to_closeout`, `needs_human`, `needs_replan`, `needs_refinement`,
and `waiting`. Completed history remains available through `ticket get` and
`ticket graph`; it is intentionally absent from the actionable frontier. The
legacy `ready` field remains as a machine-readable alias of
`ready_to_execute`; it no longer includes work awaiting adjudication or human
authority.

Trusted Run presence and human attention remain orthogonal UI capabilities.
A Session may be running while Git-native routing is unchanged, and the UI may
show a human boundary separately from operational state. Neither browser state,
Session state, a lease, a heartbeat, a dispatcher, nor a cache is an input to
this projection.
