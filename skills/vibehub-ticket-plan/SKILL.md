---
name: vibehub-ticket-plan
description: Turn a deliverable into the smallest executable Git-native VibeHub Ticket graph. This Skill owns the canonical user entry “Start this with VibeHub.” Use when the user starts a development cycle, asks to plan work as Tickets, or when execution discovers new independently schedulable work.
---

# VibeHub Ticket Plan

> If `../vibehub-core/scripts/vh.mjs` is missing, the install was partial. Run
> `npx skills add VW-ai/vibehub-plugin -s vibehub-core` (or rerun it
> for every Skill) before continuing; every VibeHub Skill needs that folder.

Plan outcomes, not ceremony. One coherent deliverable is usually one Ticket.
Split only at a real scheduling, dependency, retry, authority, or verification
boundary.

Read `../vibehub-ticket-review/references/ticket-lifecycle.json` before acting.
Read `../vibehub-core/contracts/acceptance-authority.md` before assigning acceptance
authority. Omit `authority` (or use `agent`) for independently checkable work;
use `human` only for the exact criterion whose decision owner must be a person.
When that decision gates independently schedulable downstream work, make the
boundary visible in the graph: proposal, human decision, then dependent
implementation. Mark the dependent implementation `maturity: draft` when the
decision determines its real acceptance; do not manufacture a firm downstream
plan before the choice exists. Keep terminal human sign-off in the delivery
Ticket when no downstream work needs a separate scheduling boundary.
Read `../vibehub-core/contracts/dependency-hygiene.json` before choosing `depends_on` versus
`context_refs`; it is the single classification and preservation contract for
new dependency edges.
Read `../vibehub-core/contracts/ticket-next-action.md`. This Skill owns plans reached through
`REFINE` and `REPLAN`; it preserves any non-success Outcome while revising the
current contract for a later execution cycle.
This Skill owns `plan-applied`, `execution-discovers-work`, and
`draft-needs-refinement`; it owns their planning semantics, not Agent/session
routing or UI launch mechanics.
Read `../vibehub-core/contracts/revision-identity.md` before creating or
changing Acceptance. Existing semantic contracts are append-only: strengthen,
correct, or redefine one responsibility by appending the same logical ID's
next revision; create a new ID at v1 for a separately passable obligation;
retire split/merge predecessors and give the new IDs exact `derived_from`
references; retire a no-longer-applicable obligation without lineage; and put
display-only wording in `presentation` without revising the criterion.
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
   node ../vibehub-core/scripts/vh.mjs room drift --repo <root>
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
   node ../vibehub-core/scripts/vh.mjs ticket graph --repo <root>
   node ../vibehub-core/scripts/vh.mjs ticket get --repo <root> --input <id.json>
   ```

4. Query Context only for facts that govern the deliverable or fill a real
   planning gap. The Ticket itself carries enough `context`, `context_refs`,
   constraints, and acceptance for a fresh Agent.
   Resolve every `context_ref` through the shared engine operation, whether it
   names the current tree or immutable Git history:

   ```text
   node ../vibehub-core/scripts/vh.mjs context resolve --repo <root> --input <ref.json>
   ```

   `ref.json` is `{"ref":"<Ticket context_ref>"}`. Consume the returned
   source and identity; never interpret a versioned ref as a filesystem path
   or check out its commit.
5. Draft complete Ticket documents using `../vibehub-core/contracts/ticket.schema.json`.
   Write `maturity: firm` when acceptance is executable and `maturity: draft`
   when direction is known but acceptance is not; omitted maturity remains
   legacy-compatible firm, but new or rewritten Tickets state it explicitly.
   Dependents list only direct prerequisites. For every proposed dependency,
   read the target Ticket and current Outcome. When the target is DONE, keep
   the edge only when its successful Outcome is still the exact causal input
   or unlock described by the shared dependency-hygiene contract, and require
   an explicit non-empty causal rationale; otherwise move the exact Ticket,
   Outcome, Evidence, Context, or source file into `context_refs`. Do not
   manufacture migration, review, or dogfood stages.
   For a new Ticket, materialize v1 identities and its complete Contract v1
   with `materializeInitialTicket`. For an existing Ticket, use the canonical
   append path instead of rewriting old entries:

   ```text
   node ../vibehub-core/scripts/vh.mjs ticket revise --repo <root> --input <revision.json>
   ```

   `revision.json` carries `ticket_id`, the usual `validation` declaration,
   and `mutation` with `acceptance_changes`, `retire_acceptance_ids`, and/or
   `presentation_changes`. Review the resulting active Contract revision.
6. Ask a separate Agent to use `$vibehub-ticket-validate` on the raw candidate.
   The validator is read-only. A protected product, permission, or
   material-risk choice remains blocked for the user; ordinary engineering fog
   does not. When no independent Agent is available, say so rather than
   passing over it: step 7 requires the batch to declare which happened.
7. Apply the unchanged passing batch. The input declares whether step 6
   actually happened; the engine refuses a batch that does not say, and records
   the answer on every Ticket it writes as a `plan-validation:independent` or
   `plan-validation:none` provenance ref, so a skip stays visible afterwards:

   ```text
   node ../vibehub-core/scripts/vh.mjs ticket apply --repo <root> --input <tickets.json>
   ```

   ```json
   { "validation": { "independent": true, "note": "..." }, "tickets": [ ... ] }
   ```

   Read any structured `advice` in the success envelope. A completed-dependency
   review is nonblocking: resolve it semantically before reporting the plan,
   but never treat it as a schema failure or let the helper rewrite the batch.

8. Read the graph back and report Ticket IDs, paths, READY/BLOCKED state, and
   the next executable outcome. Follow `plan-applied`: ask
   `$vibehub-ticket-review` to present the refreshed graph, focused on the new
   Ticket when there is one clear subject. Git commit/PR is the review and
   rollback boundary.

## Guardrails

- Never edit around failed schema or graph validation.
- Never add a second lifecycle, source-token protocol, lease, or hidden state.
- Preserve the authority semantics in `../vibehub-core/contracts/acceptance-authority.md`;
  never turn comments, Agent suggestions, or suggestive prose into human
  authority or human-origin Evidence.
- Planning output stays inside
  `../vibehub-setup/references/architecture-boundary.md`.
