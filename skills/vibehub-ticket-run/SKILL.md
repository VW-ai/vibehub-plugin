---
name: vibehub-ticket-run
description: Execute one READY lightweight VibeHub Ticket from its checked-in Git-native context and append acceptance-linked evidence. Use when an Agent should begin or resume concrete development work from the Ticket system.
---

# VibeHub Ticket Run

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

There is no Run lease or compiled Context copy. The named branch, Ticket YAML,
referenced Context, and Git status are the execution boundary, inside
`../vibehub-setup/references/architecture-boundary.md`.

Read `../vibehub-review/references/ticket-lifecycle.json` before acting.
Read `../vibehub-core/contracts/acceptance-authority.md`. An executor may satisfy
Agent-authority criteria autonomously. It must not satisfy a human-authority
criterion, set `origin: human`, or treat its own recommendation as the user's
decision; only explicit human input with a readable reference can become
human-origin Evidence.
Read `../vibehub-core/contracts/agent-session.md`. When executing this workflow,
report a local session for the exact Ticket with operation `execute`. Report meaningful
activity and waiting boundaries, and end the session when this work ends. Use
the foreground wrapper for a command-based agent; otherwise use the explicit
reporter and let missed reports expire. Session completion never replaces
Ticket Evidence or independent Outcome.

Read `../vibehub-core/contracts/ticket-next-action.md`. Routine execution starts only from
`next_action.action: EXECUTE`; status `READY` alone may instead route to human
input or independent closeout.
This Skill owns `ready-execution` and `execution-needs-human`; it does not own
UI launch mechanics.
Read `../vibehub-core/contracts/planning-hierarchy.md`. Read a member Ticket's
Epic and Goal and resolve their Context references. Verify that ownership does
not masquerade as an execution dependency and that required parent obligations
are explicit in Ticket acceptance.
Read `../vibehub-core/contracts/revision-identity.md`. Evidence is proof for
the exact active Acceptance revision, not for its logical ID in the abstract.

## Workflow

1. Read `ready_to_execute` from the frontier and select the requested Ticket:

   ```text
   node ../vibehub-core/scripts/vh.mjs ticket frontier --repo <root>
   node ../vibehub-core/scripts/vh.mjs ticket get --repo <root> --input <id.json>
   ```

2. Resolve every `context_ref` with the shared engine operation and consume
   the returned source plus identity:

   ```text
   node ../vibehub-core/scripts/vh.mjs context resolve --repo <root> --input <ref.json>
   ```

   `ref.json` is `{"ref":"<Ticket context_ref>"}`. This reads both current
   repository paths and immutable Git history. Never check out the referenced
   commit.
   Read the golden truth before touching territory:

   ```text
   node ../vibehub-core/scripts/vh.mjs context governing --repo <root> --input <governing.json>
   ```

   `governing.json` carries the `ticket_id` and `paths` for the files this
   work will touch. For each returned `authority` Context, read its canonical
   artifacts and follow them; a conflict between the Ticket and golden truth
   is surfaced in the conversation and in Evidence, never resolved by
   silently diverging.
   Use `$vibehub-query` only when a real context gap appears. When a direct prerequisite produced an
   input this Ticket consumes, read that Ticket's successful Outcome and
   referenced Evidence too. Confirm the branch and preserve unrelated changes.
3. Implement autonomously within the Ticket's outcome, constraints, and user
   authority. Git commits are cheap rollback points; one Agent/writer per
   worktree needs no coordination beyond Git. `ready-execution` stays
   quiet: do not open review UI for routine progress. New independently
   schedulable work discovered mid-execution belongs in the checked-in graph;
   use `$vibehub-ticket-plan` semantics before crossing that boundary. This
   includes a newly discovered human decision: revise the current Ticket or
   split out a new human-decision Ticket and wire the direct dependency before
   execution waits. The repository state is the handoff; no Agent session is
   assigned or resumed automatically.
   A durable cross-ticket fact surfaced by execution is delegated to
   `$vibehub-ingest`, placed in the room this Ticket entered.
   When the work must change a canonical artifact of an authority Context,
   follow its `update_rules` in order, run its `validation` checks, and record
   the change through `$vibehub-ingest` as a `change` Context in the same
   Room that `relates_to` the authority and cites the changed artifact. When
   that authority sets `approval: human`, the change is `execution-needs-human`:
   wait for the person's decision before changing the artifact. Before
   appending Evidence, prove golden truth was not changed silently:

   ```text
   node ../vibehub-core/scripts/vh.mjs context guard --repo <root> --input <guard.json>
   ```

   `guard.json` is `{}` for the dirty worktree or `{"since":"<base commit>"}`
   when the work is already committed. Resolve every listed violation by
   recording the missing `change` Context; the guard never writes one.
4. Test in proportion to risk. For each criterion with real proof, append one
   or more Evidence documents using `../vibehub-core/contracts/evidence.schema.json`:

   ```text
   node ../vibehub-core/scripts/vh.mjs ticket evidence --repo <root> --input <evidence.json>
   ```

   A native Evidence document uses schema 2, `binding_state: bound`,
   `binding_origin: native`, and copies each exact `acceptance_revisions`
   reference from the current Ticket. Never copy an old revision forward or
   emit either legacy migration state from this workflow.

5. Read the exact Ticket back after Evidence is appended. If its host-derived
   `next_action.action` is `CLOSE_OUT`, hand the exact Ticket, current
   Acceptance and authority, Evidence, diff or Git refs, and tests to a
   separate Agent using `$vibehub-ticket-closeout`. Do not start another Run
   merely because operational status still says READY. If it is
   `NEEDS_HUMAN`, follow the human boundary below; other actions retain their
   owner from the shared lifecycle routing. The executor never certifies its
   own success.

Stop only when execution reaches a human-authority criterion, missing
permission, or material deviation. For `execution-needs-human`, ask
`$vibehub-review` to present the exact Ticket's Contract, name the
acceptance ID and criterion, and wait for explicit human input. Fall back to
the same facts in conversation when a browser is unavailable. Hard engineering
work, implementation fog, and a future human boundary not reached yet are not
user gates.
