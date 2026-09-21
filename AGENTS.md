<!-- VIBEHUB:START -->
<!-- VIBEHUB:VERSION 2 -->
## VibeHub

VibeHub is optional project tooling. Use its Ticket Skills only when the user
asks to use VibeHub or to work on an existing VibeHub Ticket. Ordinary questions,
exploration, and implementation may proceed without Tickets. Never constrain,
truncate, rewrite, or withhold a model response to fit a VibeHub workflow.
When the user chooses or resumes VibeHub, its built-in dashboard opens
automatically through the shared session-entry contract; reuse a live session
host and continue work if presentation is unavailable.
GitHub is opt-in. Keep new planning records local; publishing code does not
authorize sharing goals, Tickets, Context, Evidence, or Outcomes. Never
force-add ignored records without explicit sharing authorization.
When working with a Ticket, read its context references and query the Room tree
under `.vibehub/rooms/` when a real gap appears. When the user explicitly says to record, remember, archive, or
“沉淀” something durable, use the VibeHub ingest Skill. Do not create periodic
conversation checkpoints or background capture.
<!-- VIBEHUB:END -->

## This repository's shared development records

The owner explicitly opts this repository into Git sharing for VibeHub's own
development records. This repository-specific choice overrides the local-only
default above: project goals, Tickets, Context, Evidence, and Outcomes created
for this repository belong in Git alongside the code they describe.

When committing a change, include its related project records in the same
commit or coordinated commit series; include them when publishing that work.
Do not introduce local-only ignore rules for these records. If initialization
is needed, use `project init` with `sharing: "shared"`.
Personal records unrelated to this project and temporary runtime files remain
outside this sharing authorization. GitHub Issue mirroring is a separate opt-in.

Direct development without Tickets remains valid. Do not create a Ticket or
Context solely to satisfy this sharing policy; when durable project records
are created or updated, version them with the work.

## Semantic Runtime development

Develop the proposed Semantic Runtime inside `semantic-runtime/`, with its own
dependency, build, test, and release boundaries. Read `semantic-runtime/AGENTS.md`
before working there. Share this repository's existing `.vibehub/` project
Context; do not initialize a second project store inside the Runtime directory.
The shipped Skill plugin remains independently installable and usable.

## Public site releases

For changes, deployment, verification, or rollback of `site/` and
`https://vibehub.team`, use the repository-local Skill at
`site/release/SKILL.md`.
