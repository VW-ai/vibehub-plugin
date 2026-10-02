# Ticket state and history

A Ticket records a task, its context, relationships, and progress. Development
methods belong to the user's chosen skills.

## Current state

`ticket.status` is the current completion authority. Its values are `open`,
`in_progress`, and `done`. A new Ticket starts `open`. A status records reported
progress. It does not certify that acceptance criteria were verified.

`ticket get` and `ticket graph` expose the canonical `status`, a `ticket_state`
projection, and `blocking_ticket_ids`. The projection is:

| Recorded status | Unfinished dependencies | Ticket state |
| --- | --- | --- |
| `done` | Any | `DONE` |
| `in_progress` | Any | `IN_PROGRESS` |
| `open` | Present | `BLOCKED` |
| `open` | None | `OPEN` |

Blocking IDs remain visible when work is in progress. A completed task stays
done if a prerequisite later reopens. The frontier groups unfinished tasks
into `open`, `in_progress`, and `blocked`; its count is the total unfinished.
No state chooses an executor, skill, review method, or next action.

## Definition and update writes

`ticket put` creates or patches a definition. Creation needs `ticket_id` and
`outcome`. Context and acceptance may be empty. Omitted existing definition
fields remain unchanged. The helper maintains acceptance revisions internally.
It rejects status and update history in a definition write.

`ticket update` appends `{update_id, summary, refs, recorded_at, status?}` and
optionally sets the current status in the same write. An identical retry is a
no-op. Reusing the ID with a different payload is an error. When a retry omits
`recorded_at`, it reuses the first write's timestamp. Reopening with `open`
preserves prior updates and proof records.

A progress update needs no independent review, Evidence, Outcome, live
session, firm contract, or resolved prerequisite. The caller records only
observed facts or attributed reports.

## Historical proof

Evidence and Outcomes are optional historical records. Their acceptance and
contract revision identities keep earlier claims readable after definitions
change. A historical Outcome does not change the current Ticket status.

`ticket evidence`, `ticket closeout`, and revision operations remain available
for projects that choose those records. Their proof shapes retain validation.
An independence declaration, when present, is a recorded claim, not a verified
identity. Ordinary task memory does not require these operations.

Format 6 stores Ticket schema 4. The explicit format-5 migration initializes
updates to an empty list. It sets status to done only for a successful Outcome
bound to the active contract; otherwise it sets open. Migration preserves the
original proof and does not manufacture progress updates.
