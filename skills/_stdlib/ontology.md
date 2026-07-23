# Knowledge ontology

Canonicality comes from governed operation results, lifecycle state and source
kind—not from a backing store or file format. Skills never infer authority by
reading persistence files or tables directly.

## Entities

- A **feature identity** is stable and repository-scoped. A mapping version owns
  its current name, parent, description and intent. Absence from the active
  mapping means `unplaced`, not deleted.
- A **canonical spec** is a stable identity with immutable revisions. Classify
  it as exactly one of: `intent`, `decision`, `constraint`, `contract`,
  `convention`, `context`, `change`.
- A **version candidate** is inferred knowledge inside one distillation run. It
  is not canonical truth and activation does not promote it.

## Type test

- intent: desired outcome or purpose.
- decision: a selected option, ideally with rationale.
- constraint: a required or forbidden boundary.
- contract: an interface or observable behavioral promise.
- convention: a repeated team practice.
- context: durable background or observable WHAT when rationale is unavailable.
- change: a substantive transition and its impact.

Split independent claims. A sentence may yield multiple specs when it contains,
for example, both a decision and a constraint.

## Placement

Place cross-cutting knowledge at project level. Place knowledge on a feature
when deleting that feature would also delete the concern. Use feature suggest
and active mapping evidence; never invent feature IDs. An uncertain placement
remains unplaced and enters review.
