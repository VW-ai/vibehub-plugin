# 08-git-semantic-store — Git Semantic Store

This room records the completed architecture spike and the approved,
repository-scoped Git Semantic Store cutover.

## Approved direction

Durable semantic truth lives in strict, versioned YAML tracked by Git so
intent, decisions, constraints, specs, relations and provenance gain native
diff, review, branch, merge and clone semantics.

SQLite remains the operational database for sessions, hooks, events,
checkpoint cadence, injection claims, writer leases, Run state, live timeline,
indexes and materialized projections. It also hosts disposable semantic query
caches materialized from an exact Git commit.

## Current authority

For a repository containing `.vibehub/semantic-store/protocol.yaml`, Git is the
durable semantic authority under `decision-project-028`. SQLite remains the
operational authority. A repository without the marker stays on the legacy
SQLite semantic path until its own explicit migration.

## Historical first gate

Prove a lossless round trip:

```text
SQLite durable semantic subset
  → deterministic strict YAML
  → clean SQLite
```

Identity, relations, revisions, activation pointers and provenance had to
rebuild without semantic loss. During that gate the spike allowed:

- no canonical write-through;
- no one-table-per-file migration;
- no hook/session/distillation-run state in Git;
- no App dependency on the proposed layout.

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

At that point this result did **not** approve a storage migration.
Mapping/distillation state, receipts and all operational tables remained
excluded until the later stable-identity review and authority migration described below.

## Merge ergonomics spike — 2026-07-20

Real Git three-way merge testing found that the v1 round-trip layout is not a
viable collaboration layout. Its content-addressed entity paths and committed
global manifest/digest make even unrelated spec edits conflict in
`manifest.yaml`.

A stable-identity candidate uses identity-derived entity paths and commits only
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
The stable-identity shape is not yet promoted: collision-safe durable provenance identity
and branch/ref cache semantics remain open. Full evidence is recorded in
`merge-ergonomics-spike.md`.

## Branch/ref cache spike and review readiness — 2026-07-20

The stable-identity follow-up closes the remaining technical research gates:

- light reads resolve arbitrary refs to exact commits and use `git show`
  without checkout mutation;
- semantic diffs report stable spec identities between refs;
- heavy queries build isolated SQLite caches keyed by repository identity,
  commit SHA and derived semantic digest;
- main and feature caches preserve their distinct KnowledgeService results;
- cache hits reuse the same validated database;
- semantic cache re-export reproduces the same semantic digest;
- provenance durable IDs derive from canonical event content plus nullable spec
  scope, independent of SQLite-local integer IDs.

The architecture review was approved on 2026-07-20. `decision-project-028` is
active and explicitly supersedes `decision-project-014`.

## Authority migration — 2026-07-20

The production cutover is repository-scoped:

- the presence of `.vibehub/semantic-store/protocol.yaml` is the explicit
  authority marker;
- every `kb.*` operation materializes the selected worktree into an isolated
  SQLite cache;
- reads query only that cache, with operational mapping context copied in;
- mutations run against a candidate cache, then atomically replace the Git
  tree only after a semantic-digest compare-and-swap;
- SQLite mutation receipts remain operational, while a minimum receipt proof
  in durable provenance closes the post-Git/pre-receipt crash gap;
- `vibehub kb migrate-store` creates a byte backup, holds a SQLite writer
  freeze, proves import/re-export parity and emits a machine-readable receipt;
- repositories without the authority marker remain on the legacy path until
  their own reviewed migration, avoiding a global flag day.

The plugin repository now carries an empty canonical protocol because its
registered runtime KB subset is empty. Existing machine SQLite rows for unrelated
repositories were inspected but not modified. See `migration-receipt.yaml`.

## Semantic checkpoints and reusable PR procedure — 2026-07-22

Durable knowledge changes now cross an explicit two-phase checkpoint boundary.
A read-only prepare receipt pins branch, HEAD, semantic digest and exact changed
paths. Commit recomputes every fact, builds a path-isolated candidate tree in a
temporary index, validates it and advances the branch with compare-and-swap.
Unrelated staged and unstaged user work never enters the checkpoint commit.

The built-in `vibehub-pr` skill packages branch sync, semantic conflict
classification, deterministic validation and PR review-brief preparation. It
can be nested by other workflow skills without exposing persistence mechanics.
Merge, squash, force-push and branch deletion remain separate human-authorized
actions. Full evidence is in `semantic-checkpoint-pr-slice.md` and
`decision-project-029`.

# Canonical Specs

- [intent-project-004] (active) Maintain Git/YAML durable semantics while
  SQLite retains operational state and rebuildable caches.
- [decision-project-028] (active) Adopt Git semantic store for durable semantic
  truth while retaining SQLite operational authority and commit-keyed caches.
- [decision-project-029] (active) Use receipt-bound semantic checkpoints and a
  reusable nested PR procedure skill.
