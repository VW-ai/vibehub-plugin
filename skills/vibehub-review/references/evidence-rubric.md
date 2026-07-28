# Evidence and confidence review rubric

Confidence is advisory support strength, never automatic authorization.

| Evidence | Review posture |
|---|---|
| direct human-authored decision/constraint with exact quote and attribution | verify scope/placement; machine-validated ingest may write it active |
| authored document plus stable source ref | verify version and whether text is normative |
| observable code/test contract with hash/anchor | accept WHAT/contract; do not infer WHY |
| repeated implementation pattern | possible convention/context; require counterexample search |
| inferred rationale or directory/name-only hypothesis | do not persist as canonical; request stronger evidence |
| missing, stale, contradictory or unverifiable source | reject candidate or amend/deprecate/stale existing knowledge |

Before active insertion, machine-check atomicity, type, placement, current
source, conflicts, lineage, and whether summary/detail/evidence agree. Before amend, ensure the new
claim preserves identity; otherwise supersede. Before stale/deprecate, record
reason/evidence. Before supersede, show both claims and verify `OLD -> NEW`.

For mapping activation, inspect bounded candidate content, provenance and
version diff. Mapping activation does not create or activate canonical Specs.
