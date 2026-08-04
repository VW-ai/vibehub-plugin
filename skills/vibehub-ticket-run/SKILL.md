---
name: vibehub-ticket-run
description: Execute one READY lightweight VibeHub Ticket from its checked-in Git-native context and append acceptance-linked evidence. Use when an Agent should begin or resume concrete development work from the Ticket system.
---

# VibeHub Ticket Run

There is no Run lease or compiled Context copy. The named branch, Ticket YAML,
referenced Context, and Git status are the execution boundary, inside
`../vibehub-setup/references/architecture-boundary.md`.

Read `../vibehub-ticket-review/references/ticket-lifecycle.json` before acting.
This Skill owns `ready-execution` and `execution-needs-human`; it does not own
UI launch mechanics.

## Workflow

1. Read the READY frontier and select the Ticket requested by the user:

   ```text
   node ../scripts/vh.mjs ticket frontier --repo <root>
   node ../scripts/vh.mjs ticket get --repo <root> --input <id.json>
   ```

2. Read every `context_ref` from the exact checkout. Use `$vibehub-query` only
   when a real context gap appears. Confirm the branch and preserve unrelated
   changes.
3. Implement autonomously within the Ticket's outcome, constraints, and user
   authority. Git commits are cheap rollback points; one Agent/writer per
   worktree needs no coordination beyond Git. `ready-execution` stays
   quiet: do not open review UI for routine progress. New independently
   schedulable work discovered mid-execution belongs to planning — hand it to
   `$vibehub-ticket-plan`. A durable cross-ticket fact surfaced by execution
   is delegated to `$vibehub-ingest`, placed in the room this Ticket entered.
4. Test in proportion to risk. For each criterion with real proof, append one
   or more Evidence documents using `../contracts/evidence.schema.json`:

   ```text
   node ../scripts/vh.mjs ticket evidence --repo <root> --input <evidence.json>
   ```

5. Hand the Ticket, diff, and Evidence to a separate Agent using
   `$vibehub-ticket-closeout`. The executor never certifies its own success.

Stop only for a genuine protected choice, missing permission, or material
deviation. For `execution-needs-human`, ask `$vibehub-ticket-review` to present
the exact Ticket's Contract and wait after stating the precise choice. Fall
back to the same facts in conversation when a browser is unavailable. Hard
engineering work and implementation fog are not user gates.
