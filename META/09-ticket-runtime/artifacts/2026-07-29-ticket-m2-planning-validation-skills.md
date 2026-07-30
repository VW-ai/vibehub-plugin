# Ticket M2 implementation: planning and independent semantic validation

Date: 2026-07-29
Status: Skill implementation complete; first canonical graph write pending
Contract:
[`contract-ticket-planning-validation-skills-001`](../specs/contract-ticket-planning-validation-skills-001.yaml)

## Outcome

Ticket Runtime now has its first two Git-native intelligence entrypoints:

```text
deliverable or graph-tending scene
  -> vibehub-ticket-plan
  -> exact ticket.worktree.patch candidate
  -> vibehub-ticket-validate in an independent context
  -> passed / failed / inconclusive
  + delegated / review / human decision / Planning Fog
  -> exact patch when unchanged
```

`vibehub-ticket-plan` owns scene recognition, Ticket boundary judgment,
Backchain, Forward Normalize, fresh-Agent context packaging, protected-boundary
routing, and the choice between `review-plan` and
`auto-apply-unless-human-gate`.

`vibehub-ticket-validate` is the semantic counterparty. It checks the complete
prospective graph for stable promise identity, context sufficiency, acceptance
as proof, direct dependency truth, reachability, granularity, delegated scope,
honest Planning Fog, and protected decisions. It never applies the candidate,
grants authority, checkpoints, or claims runtime readiness or completion.

No generic Apply Skill, mandatory Proposal object, validation ledger, or
activation stage was added. Both Skills compose the existing receiptless Git
reads and exact worktree patch through the shared packaged wrappers.

The active Git lifecycle decision was reconciled with this implementation:
machine-validated initial plans may enter the current graph directly; human
review or delegation gates execution, and optional Proposal, Decision, or
semantic receipt documents remain scene-driven rather than patch stages.

## Active graph and human review

A passing plan enters the current worktree graph directly. Human review is an
execution-authority boundary over that active graph, not a
`draft -> review -> active` lifecycle.

The two planning policies are Skill invocation policies:

- `review-plan` writes the machine-validated graph, then pauses execution so a
  human can review outcome paths and protected questions;
- `auto-apply-unless-human-gate` writes the same kind of graph and continues
  only through delegated unblocked paths.

A plan may pass semantic validation while reporting
`human_decision_required`. That is correct when the graph preserves the
question as a blocker rather than silently choosing its answer.

## Forward test

A fresh planning Agent received only the new Planning Skill, the current
Ticket Runtime META sources, and a read-only repository instruction. It
observed the real protocol-only graph at:

- HEAD `ee6bd44682e90b3044eca1202d3167440f697228`;
- graph digest
  `sha256:704ee215ce0729bfb22c255b6a5dd30f706458ff479d16a6253028444fa8231c`;
- zero Tickets.

It produced a seven-Ticket flat graph:

1. `ticket-planning-validation-ready`;
2. `ticket-context-binding-decided`;
3. `ticket-closeout-contract-decided`;
4. `ticket-git-review-intervention-ready`;
5. `ticket-execution-closeout-ready`;
6. `ticket-dogfood-target-authorized`;
7. `ticket-runtime-loop-proven`.

The graph preserves three initial frontiers, protected decision Tickets,
parallel work, direct-only dependencies, and one final composition join. The
exact v1 candidate passed the public mechanical contract with SHA-256
`54406c32778f8da10b783805917ce5084f765aa568aec2535bfff54433722989`.

A separate Agent then invoked the Validation Skill without the planner's
expected answer. It returned `failed` with two material findings:

1. the final proof made its required parallel paths and join conditional,
   allowing an unsuitable dogfood target to pass;
2. two protected decision Tickets equated an active Spec with human
   ratification even though active means canonical availability.

The planner revised only those boundaries:

- the selected dogfood target must naturally support two independent paths and
  a real join, and the final proof is unconditional;
- exact successor Specs require durable owner or designated-human
  ratification evidence separate from machine validation and lifecycle state.

The r2 candidate again passed the mechanical contract. Independent revalidation
returned:

- semantic verdict: `passed`;
- authority: `human_decision_required`;
- material findings: none.

The exact validated candidate is preserved as
[`2026-07-29-first-git-ticket-graph-validated-candidate.json`](2026-07-29-first-git-ticket-graph-validated-candidate.json)
with SHA-256
`5c9d76bd3e9e3a69e3e7434c83aa6f3f049920fc4c45118d950f3809787efc1b`.
It is historical exact-bound evidence, not a replayable input after HEAD or the
Ticket source changes.

## Canonical write status

The public patch was invoked with the unchanged validated candidate. The
sandboxed call failed before any Ticket file changed because it could not
create the short-lived worktree writer lock under `.git`. The required
escalation was rejected by the current approval policy. No direct YAML edit or
indirect workaround was attempted.

Consequently:

- the Skill implementation and real planning/validation loop are proven;
- `.vibehub/tickets` still contains only the protocol document;
- the seven-Ticket graph is not yet canonical;
- M2 remains in progress until a fresh source-bound candidate is applied
  through `ticket.worktree.patch`.

After any commit changes HEAD, the stored candidate's four source fields must
be refreshed through a new snapshot, the semantic candidate reconciled, and
independent validation rerun. Replacing source tokens mechanically is
forbidden.

## Verification evidence

The following checks passed:

- Skill Creator `quick_validate.py` for both new Skills;
- packaged Skill artifact validation with nine canonical entrypoints;
- focused CLI Skill and operation-contract suites: 33 tests;
- workspace build and typecheck;
- CLI operation-contract regeneration and byte-identical managed Skill copy;
- npm package verification and packing, including both new Skill trees;
- public `ticket.worktree.patch` input validation for both candidate revisions;
- two independent semantic validation passes demonstrating one real
  fail-revise-pass loop;
- `git diff --check`.

The existing wrapper and generated operation contract were sufficient; no new
Core workflow logic or deterministic script was needed.

## Next boundary

1. Obtain explicit permission for the public operation's short-lived `.git`
   writer lock.
2. Reload the current graph, reconcile the seven semantic documents to the
   fresh source, and rerun independent validation.
3. Apply through `ticket.worktree.patch`, reload all seven Tickets, and
   optionally checkpoint only the returned exact Ticket paths.
4. Review the active outcome graph and protected decisions before executing
   their dependent paths.
