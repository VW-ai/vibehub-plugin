---
name: vibehub-ticket
description: Define, read, and update VibeHub task records, completion criteria, progress, and dependencies. Use when the user chooses VibeHub to remember planned work or asks to inspect or update an existing Ticket. Development methods belong to the user's chosen skills.
---

# VibeHub Ticket

Keep a durable account of what the user wants to do, why it matters, its
relationships, and what has happened. A Ticket is task memory. Use the user's
chosen skills to carry out work. This Skill does not select a development
method, start execution, require an independent Agent, or certify completion.

VibeHub is optional. Record validation applies to explicit record writes;
ordinary work and responses need no Ticket or prescribed format. Keep records
local unless the user authorizes sharing them. Publishing code does not grant
permission to publish task records or Context.

For the first opted-in operation, follow
`../vibehub-core/contracts/session-entry.md` to open or reuse the dashboard.
Subagents reuse the parent's entry and do not open another dashboard.
Continue in conversation if presentation is unavailable. If the project has
no `.vibehub/`, use `$vibehub-setup`, then return to the requested record work.
Resolve helper paths relative to this Skill. If `../vibehub-core/scripts/vh.mjs`
is missing, run `npx skills add VW-ai/vibehub-plugin -s vibehub-core`
before writing records.

## Read the task and its context

Read existing records before changing them or creating overlapping work:

```text
node ../vibehub-core/scripts/vh.mjs ticket get --repo <root> --input <id.json>
node ../vibehub-core/scripts/vh.mjs ticket graph --repo <root>
node ../vibehub-core/scripts/vh.mjs ticket frontier --repo <root>
```

`id.json` is `{"ticket_id":"<ticket-id>"}`. Read any Goal and Epic returned
with the Ticket. Resolve each `context_ref` through the shared resolver:

```text
node ../vibehub-core/scripts/vh.mjs context resolve --repo <root> --input <ref.json>
```

`ref.json` is `{"ref":"<Ticket context_ref>"}`. Consume the returned source
and identity. Never check out the referenced commit or treat a historical ref
as a working-tree path. Use `$vibehub-query` when a real context gap remains.

When paths are known, read their governing authority:

```text
node ../vibehub-core/scripts/vh.mjs context governing --repo <root> --input <governing.json>
```

`governing.json` carries `paths`, `ticket_id`, or both. Preserve the returned
canonical files, update rules, validation checks, and approval owner in the
task brief. Attach relevant authority paths to `context_refs` with their
purpose. These are project facts for the chosen development skill to respect.
Read `../vibehub-core/contracts/acceptance-authority.md` when a criterion has
an explicit human decision owner.

## Define or change a task

Record the desired outcome and the context already known. Completion criteria
are optional and may be added later. Preserve uncertainty without inventing a
plan. Use `depends_on` for direct prerequisites and `context_refs` for useful
background. Read `../vibehub-core/contracts/dependency-hygiene.json` when
choosing relationships. Goals and Epics are optional scope records described
in `../vibehub-core/contracts/planning-hierarchy.md`.

```text
node ../vibehub-core/scripts/vh.mjs ticket put --repo <root> --input <ticket.json>
```

A new record needs only a stable ID and its desired outcome:

```json
{"ticket_id":"password-reset","outcome":"Users can reset a forgotten password."}
```

Optional fields include `title`, `context`, `acceptance`, `constraints`,
`context_refs`, `relations`, `provenance_refs`, `deliveries`, and `epic_id`.
`title` is a short one-line display name of at most 80 characters; lists and
mirrors show it in place of the outcome. Give new Tickets one when the outcome
is long. An acceptance item
needs `acceptance_id` and `criterion`; `authority` is optional. A dependency
is `{"type":"depends_on","target_ticket_id":"<ticket-id>","rationale":"<required input>"}`.
For an existing Ticket, omitted definition fields stay unchanged. The helper
maintains acceptance revision identities internally. Do not construct hashes
or use `put` to change status or update history. The record shape lives in
`../vibehub-core/contracts/ticket.schema.json`.

## Record progress or completion

```text
node ../vibehub-core/scripts/vh.mjs ticket update --repo <root> --input <update.json>
```

```json
{"ticket_id":"password-reset","update_id":"reset-form-finished","summary":"The reset form is complete and the browser check passed.","status":"done","refs":["commit:abc123"]}
```

Every update needs a unique `update_id` and a truthful `summary`. `refs`,
`recorded_at`, and `status` are optional. Status is `open`, `in_progress`, or
`done`. Use `open` to reopen work. Previous updates and historical proof stay
intact. An identical retry with the same update ID is a no-op; a conflicting
payload is rejected. Omit the timestamp to let the helper set it on first write.

Record only observed progress or a clearly attributed user report. Completion
is a reported fact, not certification. Updates need no Evidence, Outcome,
independent review, session registration, or resolved prerequisite. Read back
the Ticket after a successful write and report its ID, path, and changed facts.
Use `$vibehub-review` when a graph or history view helps.

`../vibehub-core/contracts/ticket-state.md` defines state and history.
`../vibehub-review/references/ticket-lifecycle.json` assigns the record events
`ticket-defined` and `ticket-updated` to this Skill. Optional historical
Evidence and Outcome records keep their original meaning. Do not manufacture
those records to mark a task done. All writes stay within
`../vibehub-setup/references/architecture-boundary.md`.
