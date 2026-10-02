# VibeHub product concept

VibeHub preserves task memory and project Context. A Ticket records what the
user wants to do, why it matters, how it relates to other work, and what has
happened. The user's chosen skills decide how to complete the work.

## Tasks and progress

A Ticket needs an ID and desired outcome. Context, completion criteria, and
relationships can grow as the task becomes clearer. The `vibehub-ticket` Skill
owns definition, reading, and updates. Choosing VibeHub does not select a
research, development, testing, or review process.

`ticket.status` records `open`, `in_progress`, or `done`. Progress updates are
append-only accounts with a summary and optional references. Reopening a task
preserves those accounts. Completion is a report, not a certification service.

Unfinished direct prerequisites make an open task appear blocked. Work already
in progress keeps its state while blockers remain visible. Completed tasks
stay done if a prerequisite reopens. No state chooses the next agent or skill.
See the [Ticket state contract](../skills/vibehub-core/contracts/ticket-state.md).

## Context and authority

Context preserves decisions, constraints, conventions, and reusable knowledge.
An explicit request to remember future work creates a Ticket. An explicit
request to preserve a durable project fact creates Context. One request may
need both records, linked by `context_refs`.

Authority Context names canonical artifacts, the territory they govern,
update rules, validation checks, and any reserved approval owner. Ticket reads
carry those facts into the task brief. A completion criterion may also name a
human decision owner. These facts guide the user's chosen skills without
requiring a universal execution or review workflow.

## Goals, Epics, and relationships

A Goal records an intended benefit and success criteria. An Epic groups a
capability under one Goal. A Ticket may belong to an Epic or stand alone.
Membership describes scope. `depends_on` describes a prerequisite. Neither
membership nor task completion alone proves that a Goal has been achieved.
See the [hierarchy contract](../skills/vibehub-core/contracts/planning-hierarchy.md).

## Records and presentation

Records use a JSON-compatible YAML subset under `.vibehub/`. New records are
ignored by Git staging. Users can choose which records to share through Git.
GitHub mirroring requires separate opt-in.

The dashboard reads the task graph, progress, and Rooms of Context. It can copy
a task brief for an agent, but it cannot run an agent or change task records.
Optional local session observations remain separate from Ticket status.

Evidence and Outcomes from earlier versions retain their exact revision
bindings as optional historical proof. They do not determine current status.
VibeHub does not manufacture historical proof when a user reports completion.

The package contains Skills, schemas, and dependency-free helpers. It requires
no global CLI, database, daemon, or background conversation capture.
