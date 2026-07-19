---
name: vibehub-query
description: Retrieve governed VibeHub project knowledge for status, a task, file or symbol, feature, design question, implementation decision, or why question. Use before non-trivial code work, when hooks request context, for spec-to-code or code-to-spec lookup, and whenever current, historical, candidate, missing, or conflicting context must be distinguished honestly.
---

# VibeHub Query

Select the cheapest sufficient depth and return a bounded context packet. This
skill is read-only.

## Prerequisites

1. Read `../_stdlib/db-operations.md` and `../_stdlib/reporting.md`.
2. Read `../_stdlib/ontology.md` for feature/spec/placement questions.
3. Read `../_stdlib/relations.md` and `../_stdlib/lifecycle.md` only for lineage,
   conflicts, history, or governed dependency traversal.
4. Shape input/output with `../contracts/query-request.schema.json` and
   `../contracts/context-packet.schema.json`.
5. Treat the query request as a workflow artifact, not dispatcher input. Map
   `query`, `paths`, `includeDrafts`, and `includeHistory` into
   `kb.spec.search`; use
   `specIds` to issue bounded `kb.spec.get`/lineage calls. `need`, `depth`, and
   `evidenceLimit` control orchestration/output and must never be sent to strict
   operation inputs.

## Choose depth

- **L0 status**: counts, active mapping, feature list, review pressure. Call
  `kb.status` and optionally `kb.feature.list`.
- **L1 focused**: active facts for a topic/path/spec. Call `kb.spec.search`,
  `kb.spec.get`, or `kb.anchors`.
- **L2 governed**: add lineage, typed relations, feature placement and explicit
  conflict inspection via `kb.lineage`, `kb.relations`, `kb.feature.get`.
- **L3 bounded evidence**: inspect immutable revisions/evidence from
  `kb.spec.get` for named specs only. Set an evidence limit; do not dump the KB.

`vibehub inspect`, `vibehub snapshot`, and the App expose the App/snapshot read
model: the active mapping plus runtime/team projections needed by that UI. They
are not a complete governed canonical-KB listing and cannot prove that a spec is
active, absent, or fully evidenced. For governed canonical verification, call
`kb.status` plus paginated `kb.spec.search`, then bounded `kb.spec.get` for the
returned IDs. Continue pages only as needed and preserve total/truncation
metadata. Search data is `{items,count,total,limit,offset,hasMore,truncated}`;
advance by `offset + count` only while `hasMore` is true. Never dump the KB or
substitute an App snapshot for this sequence.

Invoke through:

```text
node ../scripts/vh-kb.mjs <operation> --repo <root> --actor <id> --request <id> --input <request.json>
```

## Rules

1. Frame the need, affected repo-relative paths and decision to support.
2. Default search to canonical `active` facts. Include drafts, history, or
   candidates only when explicitly requested. Candidate content is never a
   canonical-search flag: select exactly one run/version and call
   `distill.candidates.list`, then bounded `distill.candidates.get`; preserve
   its `sourceKind: version_candidate` and provenance. L0 may count candidates
   without returning their content.
3. For code -> spec, use `kb.anchors` with `path`; then inspect governing specs.
   For spec -> code, use `kb.anchors` with `specId`. Never substitute a filename
   search for anchor traversal. These are canonical current-revision anchors.
   Use `distill.baseline.get` for active mapping anchors and
   `distill.version.get` for a named finalized version; never merge those truth
   layers implicitly.
4. Follow `OLD -> NEW` supersession lineage before treating history as current.
   Preserve unresolved `conflicts_with` edges rather than choosing silently.
5. Change one dimension per follow-up: path, concept, feature, lineage or
   evidence. Stop when another pass is unlikely to change the action.
6. If no source supports an answer, say `missing`. Keep retrieved facts and
   your inference in separate fields.
7. Return a context packet containing facts/spec IDs, conflicts, missing
   knowledge, implications, unresolved questions and source refs. Validate it.
8. Present per the reporting contract's five-section protocol: brief when
   the user asked for context, silent when this is a mechanical pull folded
   into ongoing work. An empty or missing answer stays brief and honest —
   a gap is information. A read never becomes a write claim.

Never write knowledge during query. Route durable discoveries to
`vibehub-ingest`; route stale/conflicting items to `vibehub-review`.
