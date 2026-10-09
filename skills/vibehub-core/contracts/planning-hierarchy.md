# Goal, Epic, and Ticket

| Entity | Meaning | Canonical ownership |
| --- | --- | --- |
| Goal | The benefit we want and the criteria by which we will judge it. | Project-local `.vibehub/goals/<goal-id>.yaml`. |
| Epic | A coherent capability large enough to require several independently verifiable deliveries. | Exactly one Goal through `goal_id`; `.vibehub/epics/<epic-id>.yaml`. |
| Ticket | A task with its intended outcome, context, relationships, and reported progress. | Optional `epic_id`; `.vibehub/tickets/<ticket-id>.yaml`. |

Ticket Goal membership is derived through its Epic. Do not store a second
`goal_id` on Tickets or inverse child lists on parents. IDs are project-local;
cross-project coordination remains explicit work and Context. An Epic cannot
contain another Epic, and a Ticket cannot contain another Ticket. Standalone
Tickets remain valid for small requests and legacy work. Empty Goals and Epics
can express scope whose executable work has not yet been planned.

Ownership answers **why this work belongs together**. Ticket `depends_on`
answers **which tasks are recorded prerequisites**. Membership does not
create dependencies, imply sequence, or change readiness. Related work in the
same Epic may run independently; dependencies may cross Epic/Goal boundaries.

## Planning a PRD

Read the PRD and governing project Context. Preserve its path in `context_refs`
(or an exact conversation reference in `provenance_refs` when no file exists).
Reuse an existing Goal/Epic when the scope matches. Translate benefits into
Goals with meaningful `success_criteria`; group coherent capabilities into
Epics; then create the smallest useful Ticket graph beneath them. Do not
make every heading an Epic, or inflate a small deliverable into three records.
A single request may contain several Goals, each with several Epics.

Use `goal.schema.json`, `epic.schema.json`, and `ticket.schema.json`. Goal
`description` explains the benefit; Epic `outcome` explains the capability.
Tickets record known completion criteria. Unknown criteria may remain empty
until the necessary facts or decisions exist. Read both parent documents and resolve their `context_refs` before
planning or executing a member Ticket. Parent criteria are context, not hidden
Ticket acceptance: an obligation needed for this Ticket belongs explicitly in
its acceptance contract.

For example: Goal **Make the product usable by teams**; Epic **Team
invitations**; Tickets **Persist invitations**, **Send invitation emails**, and
**Accept invitations**. The latter two may depend on persistence, but their
shared Epic alone does not make either block the other.

## Helper operations

All operations use `node ../vibehub-core/scripts/vh.mjs ... --repo <root>`:

- `goal put --input <goal.json>` / `epic put --input <epic.json>` create or
  replace a complete parent document; publish the Goal before its Epic.
- `goal get --input <id.json>` / `epic get --input <id.json>` take
  `{"goal_id":"..."}` / `{"epic_id":"..."}` and return the document, direct
  child IDs and ticket progress. `goal list` / `epic list` enumerate them.
- `ticket apply --input <plan.json>` accepts optional `goals` and `epics`
  arrays alongside the non-empty `tickets` array. An independent-validation
  declaration is not required.
  The helper validates the full candidate before writes, rejects duplicate or
  dangling IDs, and restores files after a caught write failure. Git provides
  the review boundary; this is not a crash-atomic database transaction.
- `project hierarchy` returns every Goal, Epic, membership, standalone Ticket
  ID, and full-repository ticket progress. `ticket graph` includes the same
  `hierarchy` separately from its filtered execution dependency graph;
  `hierarchy.scope: all` makes that distinction explicit. `ticket get` includes
  the Ticket's parent documents. Workbench data and copied Agent handoffs also
  carry this hierarchy; the canvas continues to draw execution dependencies.

Reparent a Ticket with `ticket put` and a changed `epic_id`. Use a complete
`ticket apply` document without `epic_id` to make it standalone. Reparent an Epic with `epic
put` and a changed `goal_id`. Reparenting is metadata: preserve all Acceptance,
Contract, Evidence and Outcome identities. If the actual obligation changes,
use `ticket put` to preserve acceptance history while changing the definition.
Omitted members in a batch are never deletions. Removing a parent file while
children still reference it is invalid; move the children first.

## Completion and compatibility

Ticket `status` is the current completion authority. Parent
`progress` counts current Ticket statuses across the entire repository,
including completed history. Empty scope reports zero total and zero completed.
No parent `DONE` or `achieved` flag is inferred: completing planned Tickets
alone does not prove Goal success criteria or complete Epic scope. Plan a
verification Ticket when those outcomes require additional evidence.

Project format 5 introduced these records and optional Ticket ownership while
retaining Ticket schema 3 and all proof identities. The explicit format-4 to
format-5 migration changes only `.vibehub/version.yaml`: old Tickets remain
standalone and no historical membership is invented. Older helpers reject
writes to the newer project format. Parent schema versions start at 1.

Format 6 adds Ticket status and progress updates. Evidence and Outcome remain
optional historical records. Format 7 adds an optional Ticket `title`.
Parent progress uses the current Ticket status.
