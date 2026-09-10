---
name: vibehub-ticket-closeout
description: Independently adjudicate one lightweight VibeHub Ticket against every acceptance criterion and write its Git-native Outcome. Use after implementation and acceptance-linked Evidence exist.
---

# VibeHub Ticket Closeout

## Optional workflow and unrestricted responses

Use this Skill when the user requests its VibeHub operation or has already
chosen VibeHub for the current work. Installation alone does not opt a user
into ticketing. Ordinary chat, exploration, and implementation can continue
without a Ticket, a special phrase, or a prescribed response format. Users can
leave the workflow at any time; do not block their work for missing VibeHub
records. Never truncate, rewrite, suppress, or withhold a model response to
satisfy VibeHub. Schema and lifecycle checks govern explicit VibeHub record
writes only, not the model's answer or the user's ability to work.



## Automatic dashboard entry

Before the first user-facing operation in an opted-in VibeHub session, follow
`../vibehub-core/contracts/session-entry.md`: run the bundled `vh-start.mjs`
entry helper, reuse the session's existing dashboard when available, then
continue this Skill. Do not ask the user to start a separate dashboard.
Subagents reuse the parent's entry; a user request to keep it closed wins.

> If `../vibehub-core/scripts/vh.mjs` is missing, the install was partial. Run
> `npx skills add VW-ai/vibehub-plugin -s vibehub-core` (or rerun it
> for every Skill) before continuing; every VibeHub Skill needs that folder.

The closeout Agent must be independent from the executor. Independence comes
from exactly one of three sources, and you must state which you used:

<!-- independence-sources:start -->
- `subagent` — a fresh Agent with no context from the execution
- `separate_session` — a session started from the copied read-only handoff
- `different_human` — a person other than whoever ran the work
<!-- independence-sources:end -->

This list is the whole set: `ticket closeout` refuses any other value, and
the contract tests hold the list and the engine to each other. Declaring a
source anywhere but this list is a documentation defect no test catches — do
not do it.

If you can obtain none of them, **stop**. Write no Outcome, say which sources
you tried, and report that this Ticket cannot be adjudicated from here. An
executor grading its own work is the one failure this Skill exists to prevent,
and `ticket closeout` rejects an Outcome that declares no source.

Read `../vibehub-review/references/ticket-lifecycle.json` before acting.
Read `../vibehub-core/contracts/acceptance-authority.md`. A human-authority criterion can be
accepted only when the Outcome references Evidence with `origin: human` that
faithfully records explicit human input. Agent-origin Evidence may support the
record but cannot substitute for that judgment.
Read `../vibehub-core/contracts/agent-session.md`. When executing this workflow,
report a local session for the exact Ticket with operation `closeout`. Report meaningful
activity and waiting boundaries, and end the session when this work ends. Use
the foreground wrapper for a command-based agent; otherwise use the explicit
reporter and let missed reports expire. Session completion never replaces
Ticket Evidence or independent Outcome.

Read `../vibehub-core/contracts/ticket-next-action.md`. The normal closeout entry is
`next_action.action: CLOSE_OUT`; full Evidence coverage still requires this
independent adjudication and never creates success automatically.
This Skill owns `closeout-recorded`; it does not own UI launch mechanics.
Read `../vibehub-core/contracts/revision-identity.md`. An Outcome adjudicates
one exact complete Contract revision. Older success remains historical truth
and never closes a later active revision.

1. Read the exact Ticket, diff, tests, and all Evidence:

   ```text
   node ../vibehub-core/scripts/vh.mjs ticket get --repo <root> --input <id.json>
   node ../vibehub-core/scripts/vh.mjs ticket validate --repo <root>
   ```

   Then check that golden truth did not change without its record:

   ```text
   node ../vibehub-core/scripts/vh.mjs context guard --repo <root> --input <guard.json>
   ```

   `guard.json` is `{}` for the dirty worktree or `{"since":"<base commit>"}`
   when the work is committed. Git cannot see ignored local records. For a
   local-only workflow, pass `{"paths":[...changedArtifactPaths,...changeRecordPaths]}`
   with the complete changed artifact set and the exact local change Contexts
   written for this work. Never stage private records just to make the guard
   see them. A `violations` entry names an `authority`
   Context whose canonical artifact changed with no `change` Context relating
   to it in the same change set; that blocks `successful` and belongs in the
   Outcome as the reason.
2. Decide each current acceptance criterion from reproducible evidence. Do not
   accept an executor's summary as proof.
3. Create one complete Outcome using `../vibehub-core/contracts/outcome.schema.json`.
   `successful` requires every criterion accepted with referenced Evidence.
   Use `partial`, `failed`, or `deviated` honestly otherwise. Carry
   `independence: { source, note }` naming how you were independent; the engine
   records that claim and never verifies it, so a reader can see what was
   asserted but not that it was true.
   Use schema 2, `outcome_id: contract-vN`, `binding_state: bound`,
   `binding_origin: native`, and copy the current Contract's exact revision and
   identity. The engine writes it to
   `.vibehub/outcomes/<ticket-id>/contract-vN.yaml` and refuses overwrite.
4. Persist it:

   ```text
   node ../vibehub-core/scripts/vh.mjs ticket closeout --repo <root> --input <outcome.json>
   ```

5. Read `ticket frontier` back. Only a successful Outcome unlocks direct
   dependents. Follow `closeout-recorded`: ask `$vibehub-review` to
   present the exact Ticket's Log, then report the result and any concrete
   follow-up gap. A durable cross-ticket fact revealed by adjudication is
   delegated to `$vibehub-ingest`, placed in the Ticket's room. Do not create
   speculative parity work.
