---
name: vibehub-ticket-validate
description: Independently review an immutable VibeHub Ticket graph-change proposal and append proposal-bound semantic validation evidence. Use after ticket.proposal.submit, when a proposal needs promise, containment, dependency, change-classification, delegated-scope, or protected-boundary review before any separate authority or application decision.
---

# VibeHub Ticket Validate

Review one immutable graph-change proposal independently and record one
`claimed_unverified` semantic assessment. This Skill does not validate Ticket
readiness and never grants authority or applies a proposal.

## Prerequisites

1. Before any operation, read `../_stdlib/operations.md`,
   `../_stdlib/reporting.md`, and `../_stdlib/relations.md`.
   Before reviewing, read `references/validator-profile-v1.md`.
   Only before constructing the record, read `references/proposal-validation-policy-v1.md`.
2. Use the strict generated operation contract for every Ticket input. Do not
   guess fields or enums.
3. Give each logical invocation and exact input its own request identity.
   Every affected-subject read uses a distinct identity. Keep an identity
   stable only when retrying that exact operation and input; never reuse one
   identity across inspect, context reads, and record.
4. Use these exact claimed descriptors in `ticket.proposal.validation.record`;
   their digests are the SHA-256 bytes of the two packaged references above:

   ```json
   {
     "validator": {
       "id": "vibehub-ticket-validate",
       "version": "1",
       "artifactDigest": "578541ee161a9c1134cce20d7137ac336317f1db1bd573ad2888461794add438"
     },
     "policy": {
       "id": "vibehub-ticket-proposal-semantic-review",
       "version": "1",
       "artifactDigest": "c02806b436408e925536509669be7c05510f3c6126f86fb7dd6fee47d59f465c"
     }
   }
   ```

   Do not substitute fixture hashes or claim these descriptors are trusted.

## Workflow

1. Call `ticket.proposal.inspect` for the named proposal:

   ```text
   node ../scripts/vh-ticket.mjs proposal.inspect --repo <root> --actor <id> --request <id> --input <request.json>
   ```

2. Verify that the returned record is an immutable `graph_change` proposal with
   an exact proposal digest and mechanically materialized candidate digest.
   Stop without recording validation for a comment, malformed binding, missing
   proposal, or failed mechanical review.
3. If `observedSnapshotId` is non-null, use `ticket.subject.inspect` with that
   exact snapshot ID for every affected existing Ticket, parent, and dependency
   endpoint needed to judge the change. When retained edge evidence is needed,
   also inspect every changed existing relation at that snapshot with
   `subject: {kind: "relation", relationRef: <exact ref>}`. Use bounded
   `ticket.trace.list` at the same snapshot when cited history or evidence is
   needed. Never substitute a new `ticket.graph.snapshot`: validation remains
   bound to the proposal's observed base. A bootstrap proposal with a null
   snapshot may be reviewed from its self-contained materialized candidate. If
   required retained context is absent, mark the affected checks inconclusive
   with blocking findings.
4. Review the immutable proposal and candidate independently of the author's
   judgment: do not inherit confidence from `actor`, `authorAssessment`, route
   hint, or the author's characterization of the requested outcome. Do compare
   the candidate with the actual promised outcome and referenced canonical
   context. Distinguish retrieved facts, evidence, and your inference.
5. Evaluate every required semantic question:
   - `promise_preservation`: the candidate preserves the previously accepted
     promised outcome. For an expansion, ask whether that prior promise remains
     intact even though extra scope was added; judge the extra scope separately
     under classification and delegation;
   - `containment_truth`: every resulting parent assignment or removal on an
     affected Ticket, including each new Ticket, truthfully expresses outcome
     containment. Do not re-review untouched snapshot parents;
   - `dependency_truth`: an added edge needs direct execution necessity and
     breach evidence; a removed edge is sound only when that prior necessity no
     longer exists or the dependent outcome remains valid without it. Map
     `addedPrerequisiteTicketIds` to `change: added` and
     `removedPrerequisiteTicketIds` to `change: removed`, using the materialized
     change's Ticket ID as `dependentTicketId`. The dependent is the requiring
     source that becomes invalid or fails; the prerequisite is its required
     target. Copy both endpoints from the inspected delta and never label a
     retained edge as a dependency change;
   - `change_classification`: classify same-promise executable detail as
     elaboration, partitioning one accepted promise into contained outcomes as
     decomposition, and any widened promise or delegated boundary as
     expansion;
   - `delegated_scope`: the change stays inside already delegated scope and
     decision authority;
   - `protected_boundaries`: identify only
     `initial_plan_authority`, `experience_product`,
     `principle_deviation`, `permission_side_effect`, or `risk_policy`.
     `principle_deviation` includes deviation from accepted architecture as
     well as accepted principles. Emit every independently supported signal;
     overlaps are allowed. If a possible boundary cannot be classified from
     evidence, retain the supported signal and make this check inconclusive.
6. Use the exact finite judgments and finding shape accepted by the generated
   operation contract. Cite bounded actionable findings and evidence. Mark
   missing support as `inconclusive`; do not invent proof or convert
   uncertainty into approval. Emit exactly one check for each of the six codes.
   When one check covers several Tickets or relationship deltas, use
   `subject.kind: proposal` for that aggregate check and put exact
   `ticket_change` or `dependency_change` subjects on its findings; use a
   granular check subject only when it alone represents the whole question.
   Within an aggregate check, failed dominates inconclusive and inconclusive
   dominates passed. Every failed or inconclusive check needs a
   blocking finding, while a passed check cannot have a blocking finding. Core
   derives the receipt conclusion mechanically: any failed check yields `failed`;
   otherwise any inconclusive check yields `inconclusive`; only six passed
   checks yield `passed`. Keep every check and finding `localRef` unique, and
   bind each finding's `checkLocalRef` to a check in the same input. A proposal
   with no containment or dependency delta still gets those checks: mark the
   zero-delta check passed only after inspection establishes that no applicable
   delta exists, and cite the proposal/candidate evidence.
7. Call `ticket.proposal.validation.record` once with the exact proposal and
   candidate bindings returned by inspection:

   ```text
   node ../scripts/vh-ticket.mjs proposal.validation.record --repo <root> --actor <id> --request <id> --input <validation.json>
   ```

8. Report the immutable validation identity, proposal binding, semantic
   conclusion, protected-boundary findings, and remaining uncertainty. Inspect
   the new record when exact replay verification is useful. If a protected
   boundary exists, record the honest check and signal first, then stop and
   wait for the separate authority path. The signal alone does not dictate a
   check outcome. `protected_boundaries` passes only when the classification
   itself is supported; that never means the crossing is authorized.
   `delegated_scope` is failed for a demonstrated scope violation and
   inconclusive when delegated scope or required authority cannot be
   established.

## Authority rules

- Treat the validator actor as `claimed_unverified`, even when it names a human
  or known Agent.
- Treat this record as proposal/candidate semantic evidence only. It is not the
  Ticket-revision ValidationReceipt that derives `outline`, `specified`, or
  `executable` maturity.
- Never emit or imply a GateDecision, authority grant, approval, readiness,
  application eligibility, graph mutation, or Ticket status.
- Never call an apply operation, the internal Git publisher, or persistence
  directly.
- Allow contrary validation records to coexist. Do not select a `current`,
  `latest`, winning, superseding, or authoritative assessment.
- Technical difficulty alone is not a protected boundary. Escalate only when a
  proposal affects the accepted experience/product, principles or architecture,
  permissions/side effects, risk/policy, or foundational plan authority.
- In the shared five-section report, describe the receipt as `persisted` or
  `claimed`; never call it `verified`, a decision, approved, or authorized.

Validation informs a later, separately authorized decision; it never makes that
decision itself.
