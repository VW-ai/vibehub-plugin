---
name: vibehub-ticket-plan
description: Turn a deliverable into the smallest executable Git-native VibeHub Ticket graph. This Skill owns the canonical user entry “Start this with VibeHub.” Use when the user starts a development cycle, asks to plan work as Tickets, or when execution discovers new independently schedulable work.
---

# VibeHub Ticket Plan

Plan outcomes, not ceremony. One coherent deliverable is usually one Ticket.
Split only at a real scheduling, dependency, retry, authority, or verification
boundary.

Read `../vibehub-ticket-review/references/ticket-lifecycle.json` before acting.
Read `../contracts/acceptance-authority.md` before assigning acceptance
authority. Omit `authority` (or use `agent`) for independently checkable work;
use `human` only for the exact criterion whose decision owner must be a person.
When that decision gates independently schedulable downstream work, make the
boundary visible in the graph: proposal, human decision, then dependent
implementation. Mark the dependent implementation `maturity: draft` when the
decision determines its real acceptance; do not manufacture a firm downstream
plan before the choice exists. Keep terminal human sign-off in the delivery
Ticket when no downstream work needs a separate scheduling boundary.
This Skill owns `plan-applied`, `execution-discovers-work`, and
`draft-needs-refinement`; it owns their planning semantics, not Agent/session
routing or UI launch mechanics.
`execution-discovers-work` is the single home of the mid-cycle transition:
when execution surfaces new independently schedulable work, the same or a
later Agent applies this Skill to turn the discovery into Tickets with their
direct dependencies — including a newly discovered human decision that gates
continuation. Planning may revise the current Ticket when the boundary is not
independently schedulable, or create the smallest new decision Ticket when it
is; executors never absorb it silently. `draft-needs-refinement` is the single
home of rolling-wave refinement: a Ticket planned with `maturity: draft`
carries honest direction whose acceptance cannot be written yet and surfaces
as REFINE (never READY) once unblocked. That checked-in state is sufficient for
any Agent selecting work to apply this Skill, rewrite acceptance for real, and
set `maturity: firm` in place on the same Ticket. No session handoff or wake-up
is implied.

## Workflow

1. Treat “Start this with VibeHub.” as the canonical request to start the
   concrete deliverable already present in the conversation. If the exact
   checkout has no `.vibehub/` project yet, use `$vibehub-setup` first and then
   resume this workflow. Do not ask the user to select Skills or remember a UI
   command, and do not add a router or second lifecycle.
2. Check Room alignment before planning:

   ```text
   node ../scripts/vh.mjs room drift --repo <root>
   ```

   `cold_start:true` routes through `$vibehub-distill` first — the one
   alignment experience allowed to be perceptible. Otherwise reconcile only
   the rooms this deliverable enters: re-read exactly the changed, added, and
   deleted files drift lists, update that room's knowledge, then
   `room align` it. Mark unrelated drifted rooms `room stale` with a short
   `drift:`-prefixed reason and move on — alignment cost stays proportional to the rooms
   entered, never to whole-project debt. Surface the result as one line,
   e.g. `Aligned 2 rooms (3 files drifted)`.
3. Read the current graph and any named Ticket:

   ```text
   node ../scripts/vh.mjs ticket graph --repo <root>
   node ../scripts/vh.mjs ticket get --repo <root> --input <id.json>
   ```

4. Query Context only for facts that govern the deliverable or fill a real
   planning gap. The Ticket itself carries enough `context`, `context_refs`,
   constraints, and acceptance for a fresh Agent.
5. Draft complete Ticket documents using `../contracts/ticket.schema.json`.
   Write `maturity: firm` when acceptance is executable and `maturity: draft`
   when direction is known but acceptance is not; omitted maturity remains
   legacy-compatible firm, but new or rewritten Tickets state it explicitly.
   Dependents list only direct prerequisites. Do not manufacture migration,
   review, or dogfood stages.
6. Ask a separate Agent to use `$vibehub-ticket-validate` on the raw candidate
   when an independent Agent is available. The validator is read-only. A
   protected product, permission, or material-risk choice remains blocked for
   the user; ordinary engineering fog does not.
7. Apply the unchanged passing batch:

   ```text
   node ../scripts/vh.mjs ticket apply --repo <root> --input <tickets.json>
   ```

8. Read the graph back and report Ticket IDs, paths, READY/BLOCKED state, and
   the next executable outcome. Follow `plan-applied`: ask
   `$vibehub-ticket-review` to present the refreshed graph, focused on the new
   Ticket when there is one clear subject. Git commit/PR is the review and
   rollback boundary.

## Guardrails

- Never edit around failed schema or graph validation.
- Never add a second lifecycle, source-token protocol, lease, or hidden state.
- Preserve the authority semantics in `../contracts/acceptance-authority.md`;
  never turn comments, Agent suggestions, or suggestive prose into human
  authority or human-origin Evidence.
- Planning output stays inside
  `../vibehub-setup/references/architecture-boundary.md`.
