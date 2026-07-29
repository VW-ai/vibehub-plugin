# Ticket proposal semantic review policy v1

Policy ID: `vibehub-ticket-proposal-semantic-review`

Evaluate exactly once:

1. `promise_preservation`
2. `containment_truth`
3. `dependency_truth`
4. `change_classification`
5. `delegated_scope`
6. `protected_boundaries`

Emit exactly one aggregate check per code. When a question spans multiple
Tickets or relationship deltas, use the proposal as the check subject and use
granular Ticket/dependency subjects on findings. Within that check, any failed
subject yields failed; otherwise any inconclusive subject yields inconclusive;
only all-passed subjects yield passed.

Use only `passed`, `failed`, or `inconclusive`. Every failed or inconclusive
check has a blocking finding; a passed check has no blocking finding. Failed
dominates inconclusive, which dominates passed, when Core derives the
conclusion.

For `promise_preservation`, assess whether the previously accepted promise
remains intact. An honest expansion can preserve that promise while adding
extra scope; assess the extra scope under `change_classification` and
`delegated_scope`. If the prior promise is lost, this check fails.

For `containment_truth`, assess every resulting parent assignment or removal on
an affected Ticket, including new Tickets, and do not re-review untouched
snapshot parents. When a proposal has no containment delta, pass the mandatory
check only after inspection establishes that fact and cite proposal/candidate
evidence.

Classify the proposal as:

- `elaboration` when it preserves one outcome identity and promise while adding
  executable detail;
- `decomposition` when it partitions an accepted outcome into contained,
  executable outcomes without widening that promise;
- `expansion` when it adds or widens an outcome beyond the accepted promise or
  delegated boundary.

For `dependency_truth`, an added edge is supported only by direct execution
necessity and breach evidence. A removed edge is supported only when that prior
necessity no longer exists or the dependent outcome remains valid without it.
The dependent is the requiring source that fails or becomes invalid; the
prerequisite is its required target. Copy both endpoints from the inspected
delta. When there is no dependency delta, pass the mandatory check only after
inspection establishes that fact and cite proposal/candidate evidence.

Protected-boundary signals are limited to `initial_plan_authority`,
`experience_product`, `principle_deviation`, `permission_side_effect`, and
`risk_policy`. `principle_deviation` includes accepted architecture deviation.
Emit every independently supported signal because categories may overlap. If
evidence supports a possible signal but not a definite classification, retain
the signal and make `protected_boundaries` inconclusive. A signal is evidence
for a later authority path, not authority.

Every receipt remains `claimed_unverified` semantic evidence with
`maturityEffect: none`; it never authorizes application or graph mutation.
