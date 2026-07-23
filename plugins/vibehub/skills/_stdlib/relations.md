# Relations

Use only `depends_on`, `relates_to`, `supersedes`, `conflicts_with`.

- `depends_on`: source concretely requires the target. Record the necessity and
  direct breach evidence: what behavior fails, becomes invalid, or violates a
  named contract when the target is absent or changes. A shared folder, import,
  caller, vocabulary, anchor, or execution neighborhood is not enough by itself.
- `conflicts_with`: two claims cannot both govern the same situation. Preserve
  both until review.
- `supersedes`: store `OLD -> NEW`. Do not reverse it.
- `relates_to`: meaningful context not captured by the stronger types; do not
  mint edges to satisfy a quota.

## Edge checklist

1. State the two complete propositions and the direction being proposed.
2. For `depends_on`, name the concrete necessity and direct breach evidence.
   If neither can be shown, do not create `depends_on`.
3. Adjacency is not dependency evidence. Co-location, anchor overlap, nearby
   calls/imports, shared ownership, or appearing in the same discussion yields
   `relates_to` or no edge unless direct necessity is supported.
4. Use `relates_to` only when the connection improves a bounded future query;
   otherwise record no edge.
5. Preserve uncertainty in the rationale or review queue. Never strengthen an
   edge to remove ambiguity, connect the graph, or meet a relation quota.

Endpoints are canonical spec IDs for canonical relations and run-scoped
candidate IDs for candidate relations. Never relate features through the spec
edge table. Traverse direction explicitly and resolve supersession lineage
before treating a result as current authority.
