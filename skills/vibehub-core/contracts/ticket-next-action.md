# Ticket next-action projection

`next_action` is a deterministic read projection over the checked-in Ticket,
its direct dependencies, acceptance-linked Evidence, acceptance authority, and
Outcome. It is routing advice for a Human or Agent. It is not persisted, does
not replace operational status, and cannot create an Outcome, DONE state,
archive membership, delivery membership, or dependent unlock.

The first matching row wins. There are exactly these seven actions; proof
bindings never add a status, they only decide which row a Ticket matches and
carry its explanation:

| Precedence | Canonical facts | Action | Stable reason | Relevant IDs |
| --- | --- | --- | --- | --- |
| 1 | Successful Outcome exists and its complete contract binding is current | `DONE` | `successful_outcome` | all current Acceptance IDs |
| 2 | Any other Outcome exists: partial, failed, deviated, or a successful one whose contract binding is unresolved | `REPLAN` | `non_successful_outcome`, or `unresolved_legacy_outcome` for an unresolved successful Outcome | unresolved Acceptance IDs, or the drifted Acceptance IDs |
| 3 | Any direct dependency lacks an accepted successful Outcome | `WAIT` | `unresolved_direct_dependencies` | blocking Ticket IDs |
| 4 | Ticket maturity is draft | `REFINE` | `draft_contract` | all current Acceptance IDs |
| 5 | A reachable human-authority criterion lacks binding-current human-origin Evidence | `NEEDS_HUMAN` | `missing_human_evidence` | affected Acceptance IDs |
| 6 | Every current criterion has authority-satisfying, binding-current Evidence and no Outcome exists | `CLOSE_OUT` | `authority_satisfying_evidence_complete` | all current Acceptance IDs |
| 7 | Otherwise | `EXECUTE` | `acceptance_evidence_incomplete` | criteria still lacking Evidence, stale-bound ones named in the detail |

Evidence satisfies an Agent-authority criterion when a linked record's
recorded binding digest equals the current per-criterion digest (native or
reconstructed alike). Evidence satisfies a human-authority criterion only
when such a binding-current record also has `origin: human`. Stale or unbound
Evidence stays readable forever but satisfies nothing. A successful Outcome
whose `contract_binding` digest no longer equals the current complete-contract
digest, or which carries an unresolved marker, stops contributing to `DONE`,
archive membership, dependent unlock, and `CLOSE_OUT` until independently
reviewed. Below the binding-aware project format (3) the legacy interpretation
applies: any linked Evidence satisfies coverage and any successful Outcome is
accepted — that interpretation is exactly what rollback restores. Raw Evidence
count is never acceptance: `CLOSE_OUT` asks an independent Agent to adjudicate
the current contract. Every projection surface carries this derivation's
`proof` explanation (native, reconstructed, stale, unresolved) verbatim; none
recomputes it.

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
