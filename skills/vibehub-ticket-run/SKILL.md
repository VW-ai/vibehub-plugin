---
name: vibehub-ticket-run
description: Execute one READY lightweight VibeHub Ticket from its checked-in Git-native context and append acceptance-linked evidence. Use when an Agent should begin or resume concrete development work from the Ticket system.
---

# VibeHub Ticket Run

> If `../vibehub-core/scripts/vh.mjs` is missing, the install was partial. Run
> `npx skills add VW-ai/vibehub-plugin -s vibehub-core` (or reinstall through
> the host marketplace) before continuing; every VibeHub Skill needs that folder.

There is no Run lease or compiled Context copy. The named branch, Ticket YAML,
referenced Context, and Git status are the execution boundary, inside
`../vibehub-setup/references/architecture-boundary.md`.

Read `../vibehub-ticket-review/references/ticket-lifecycle.json` before acting.
Read `../vibehub-core/contracts/acceptance-authority.md`. An executor may satisfy
Agent-authority criteria autonomously. It must not satisfy a human-authority
criterion, set `origin: human`, or treat its own recommendation as the user's
decision; only explicit human input with a readable reference can become
human-origin Evidence.
Read `../vibehub-core/contracts/ticket-next-action.md`. Routine execution starts only from
`next_action.action: EXECUTE`; status `READY` alone may instead route to human
input or independent closeout.
This Skill owns `ready-execution` and `execution-needs-human`; it does not own
UI launch mechanics.

## Workflow

1. Read `ready_to_execute` from the frontier and select the requested Ticket:

   ```text
   node ../vibehub-core/scripts/vh.mjs ticket frontier --repo <root>
   node ../vibehub-core/scripts/vh.mjs ticket get --repo <root> --input <id.json>
   ```

2. Read every `context_ref` from the exact checkout. Use `$vibehub-query` only
   when a real context gap appears. When a direct prerequisite produced an
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
4. Test in proportion to risk. For each criterion with real proof, append one
   or more Evidence documents using `../vibehub-core/contracts/evidence.schema.json`:

   ```text
   node ../vibehub-core/scripts/vh.mjs ticket evidence --repo <root> --input <evidence.json>
   ```

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
`$vibehub-ticket-review` to present the exact Ticket's Contract, name the
acceptance ID and criterion, and wait for explicit human input. Fall back to
the same facts in conversation when a browser is unavailable. Hard engineering
work, implementation fog, and a future human boundary not reached yet are not
user gates.
