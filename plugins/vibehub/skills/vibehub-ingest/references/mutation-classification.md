# Mutation classifier

Compare the atomic claim with full active/history candidates, anchors and
lineage. Apply the first supported class:

- **duplicate**: same normative/observable proposition, scope and qualifiers;
  wording-only difference. Skip the write and cite the canonical ID.
- **refinement / amend**: preserves the prior proposition while adding evidence,
  precision or non-conflicting qualifiers. Amend only after explicit review;
  do not create a second identity merely to avoid review.
- **new**: materially independent proposition or scope with no equivalent ID.
- **contradiction**: propositions cannot both govern the same scope/time. Create
  a draft plus `conflicts_with`; never amend one side away.
- **supersession**: evidence explicitly says NEW replaces OLD, not merely differs
  or is newer. Keep `OLD -> NEW`; replacement requires explicit review.
- **staleness evidence**: proves the active claim may no longer match reality but
  does not establish a replacement. Route to review; ingestion itself does not
  mark stale.

Anchor overlap and lexical equality are deterministic signals, not semantic
decisions. Different scope/time qualifiers can turn apparent contradiction into
two valid claims. If the source does not authorize mutation, create/review a
draft and preserve the ambiguity.
