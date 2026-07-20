# 08-git-semantic-store — Git Semantic Store

This room is an architecture exploration, not an approved migration.

## Draft intent

Durable semantic truth may move to strict, versioned YAML tracked by Git so
intent, decisions, constraints, specs, relations and provenance gain native
diff, review, branch, merge and clone semantics.

SQLite would remain the operational database for sessions, hooks, events,
checkpoint cadence, injection claims, writer leases, Run state, live timeline,
indexes and materialized projections.

## Current authority

**SQLite remains the source of truth.** Existing implementation and
`decision-workbench-011/012` remain valid until a successful spike and explicit
architecture review supersede them.

## First gate

Prove a lossless round trip:

```text
SQLite durable semantic subset
  → deterministic strict YAML
  → clean SQLite
```

Identity, relations, revisions, activation pointers and provenance must rebuild
without semantic loss. Until then:

- no canonical write-through;
- no one-table-per-file migration;
- no hook/session/distillation-run state in Git;
- no App dependency on a proposed YAML layout.

## Spike result — 2026-07-19

The isolated architecture spike passes the first technical gate for the
approved subset:

- `kb_features` identity;
- `kb_specs` aggregates with every revision, revision anchor and evidence row;
- outgoing typed relations;
- spec-scoped and repo-scoped provenance;
- `current_revision` as the activation pointer, with
  `kb_spec_current_anchors` rebuilt from that pointer.

The protocol lives only under
`packages/core/src/experimental/git-semantic-store`. It emits canonical JSON
bytes as a strict YAML 1.2 subset at:

```text
.vibehub/semantic-store/v1/
  manifest.yaml
  features/sha256-*.yaml
  specs/sha256-*.yaml
```

The importer rejects non-canonical bytes, unknown/missing fields, digest or
inventory mismatch, symlinks, invalid ordering and an existing target DB. The
test oracle proves semantic digest equality, KnowledgeService query parity and
byte-identical re-export after rebuilding a clean SQLite database.

This result does **not** approve a storage migration. Mapping/distillation
state, receipts and all operational tables remain excluded; the experiment is
not exported from the package root and has no CLI, MCP, App or hook wiring.
SQLite remains canonical pending an explicit architecture review and decision.

## Merge ergonomics spike — 2026-07-20

Real Git three-way merge testing found that the v1 round-trip layout is not a
viable collaboration layout. Its content-addressed entity paths and committed
global manifest/digest make even unrelated spec edits conflict in
`manifest.yaml`.

A v2 candidate uses stable identity-derived entity paths and commits only
immutable protocol metadata. Inventory, per-file content digests and the global
semantic digest become deterministic projections of a checked-out Git tree or
commit, suitable for validation and a local SQLite query cache.

The real merge matrix establishes a useful PR boundary:

- different specs merge automatically;
- disjoint fields on one stable spec merge automatically and preserve both
  edits;
- same-field edits, concurrent revision numbers, lifecycle verdicts, relation
  appends and delete-versus-amend remain explicit Git conflicts.

A reusable team PR skill can orchestrate rebase, explanation, resolution and
review, while deterministic validation/CI remains the enforcement authority.
The v2 shape is not yet promoted: collision-safe durable provenance identity
and branch/ref cache semantics remain open. Full evidence is recorded in
`merge-ergonomics-spike.md`.

## Branch/ref cache spike and review readiness — 2026-07-20

The v2 follow-up closes the remaining technical research gates:

- light reads resolve arbitrary refs to exact commits and use `git show`
  without checkout mutation;
- semantic diffs report stable spec identities between refs;
- heavy queries build isolated SQLite caches keyed by repository identity,
  commit SHA and derived semantic digest;
- main and feature caches preserve their distinct KnowledgeService results;
- cache hits reuse the same validated database;
- v2 cache re-export reproduces the same semantic digest;
- provenance durable IDs derive from canonical event content plus nullable spec
  scope, independent of SQLite-local integer IDs.

The architecture is now ready for technical review. `technical-review.md`
contains the recommendation, requested decisions and autonomous overnight
migration/rollback gates. `decision-project-028` is deliberately draft;
`decision-project-014` remains active until explicit review promotion.

# Canonical Specs

- [intent-project-004] (draft) Explore Git/YAML for durable semantics while
  SQLite remains the approved canonical and operational store.
- [decision-project-028] (draft) Adopt Git v2 for durable semantic truth while
  retaining SQLite operational authority and commit-keyed semantic caches.
