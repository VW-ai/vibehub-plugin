# Acceptance authority

Authority names the decision owner for one completion criterion. It does not
assign the work or select a development process.

`acceptance.authority` is `agent` or `human` and defaults to `agent`. Use
`human` only when a person has reserved that decision. Missing information,
implementation difficulty, and host permission do not change the decision
owner. Preserve known authority facts in task briefs and context references.

A decision may be its own Ticket when other tasks depend on it. A terminal
sign-off may stay in the delivery Ticket's criteria. These are task-definition
choices. They do not require a proposal, decision, and implementation sequence.
Record unknown criteria as unknown until the decision exists.

## Optional historical proof

`evidence.origin` is `agent` or `human` and defaults to `agent`. A record with
human origin must faithfully describe explicit human input and cite that
input. Agent suggestions and assertions remain Agent-origin Evidence.

A successful historical Outcome can accept a human criterion only through
referenced human-origin Evidence bound to that criterion's exact revision.
An independence declaration is optional and unverified. Historical proof does
not change Ticket status. Neither an update nor a done status creates evidence
that a person made a reserved decision.

These fields are provenance in Git documents. They are not an identity,
permission, or approval service.
