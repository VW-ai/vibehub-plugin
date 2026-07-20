# Git Semantic Store technical review packet

Date: 2026-07-20

Review status: ready for architecture review; no canonical flip has occurred.

## Recommended architecture

Approve this direction:

```text
Git v2 strict semantic tree
  = durable semantic source of truth

SQLite
  = operational source of truth
  + rebuildable, commit-keyed semantic query cache
```

The recommendation is limited to the proven durable semantic subset:
feature identity, spec aggregates, all revisions, evidence, anchors, relations,
current revision pointers and provenance. Sessions, hooks, events, queues,
claims, leases, cadence, distillation runs, mapping runs and live projections
remain SQLite-only.

## v2 protocol shape

```text
.vibehub/semantic-store/v2/
  protocol.yaml
  features/sha256-<feature-id>.yaml
  specs/sha256-<spec-id>.yaml
  provenance/sha256-<durable-event-id>.yaml
```

- Entity paths derive from stable identity, not content.
- `protocol.yaml` contains immutable protocol declarations, not mutable global
  inventory or a global digest.
- Inventory, file digests and the semantic digest derive deterministically from
  a checked-out Git tree or commit.
- Provenance durable identity is SHA-256 over canonical event content plus its
  nullable spec scope; SQLite integer IDs are cache-local projections.
- Canonical JSON bytes remain the accepted strict YAML 1.2 subset.

## Authority model

| State | Authority |
|---|---|
| Uncommitted semantic file | local proposal |
| Committed branch | durable branch proposal |
| Pushed branch / open PR | reviewable team proposal |
| Approved, unmerged PR | approved proposal, not shared truth |
| Merged main | shared semantic truth |

Every branch/ref read returns the resolved commit SHA. Caches key by repository
identity, commit SHA and derived semantic digest. Queries never silently union
contradictory branch knowledge.

## Query model

Light queries use Git objects without checking out another branch:

- read one spec at a ref;
- list changed spec IDs between refs;
- compare a known spec across commits.

Heavy queries materialize a local SQLite cache for one exact commit. Repeated
queries reuse the same validated cache; another commit receives another cache.
The cache is rebuildable and has no semantic authority.

## Collaboration and enforcement

A reusable team PR skill may be nested by architecture, distillation, incident
and knowledge workflows. It handles rebase, revision allocation, conflict
explanation, review briefs and PR procedure.

The skill is not the enforcement authority. A deterministic validator/CI gate
must enforce canonical bytes, stable paths, schema, identities, revision
pointers, relation/lineage integrity, provenance identity and the exclusion of
operational state.

## Evidence

1. Lossless v1 gate:
   SQLite -> strict files -> clean SQLite preserves semantic digest,
   KnowledgeService queries and byte-identical re-export.
2. Real Git merge matrix:
   v1 global manifest is a conflict hotspot; stable v2 paths cleanly merge
   unrelated specs and disjoint fields while surfacing semantic conflicts.
3. Ref/cache spike:
   reads main and feature refs without checkout mutation, produces isolated
   commit-keyed caches, preserves branch-specific KnowledgeService results,
   reuses cache hits and re-exports byte-equivalent v2 trees.
4. Provenance spike:
   identical SQLite local integers on independent branches map to distinct
   durable IDs; local integer changes do not change durable identity.

Executable evidence:

- `packages/core/test/git-semantic-store.test.ts`
- `packages/core/test/git-semantic-merge-spike.test.ts`
- `packages/core/test/git-semantic-ref-cache.test.ts`

## Review decisions requested

1. Approve stable identity-derived v2 paths.
2. Approve derived inventory/digests instead of a committed mutable manifest.
3. Approve `(repo, commit, semantic digest)` as the semantic cache key.
4. Approve content-and-scope-derived durable provenance identity.
5. Approve merged main as shared truth and branch commits as proposals.
6. Approve the no-dual-write migration discipline below.

## Autonomous overnight migration gates

An overnight migration may begin only after the draft architecture decision is
explicitly promoted. The autonomous run must use these gates:

### Preflight

- require a clean, up-to-date migration worktree;
- record main commit, SQLite schema version and source DB checksum;
- make a byte-for-byte SQLite backup outside the repository;
- verify enough disk space for backup, exported tree and caches;
- freeze semantic writers for the final cutover snapshot;
- leave operational SQLite writers available only if they cannot mutate the
  durable semantic subset.

### Build and prove

- export v2 from the frozen SQLite snapshot;
- validate canonical protocol, stable paths, identities, graph integrity and
  operational-state exclusion;
- materialize a clean SQLite cache from the exported commit;
- run digest, query and byte-re-export parity oracles;
- run the full repository build, typecheck and test suite;
- create a dedicated migration commit/PR with a machine-readable review brief.

### Cutover

- never dual-write;
- change semantic read/write authority only in the same reviewed cutover;
- keep SQLite operational tables and cache machinery intact;
- tag the pre-cutover code/data boundary;
- start with a bounded bake window and continuous parity checks.

### Automatic abort

Abort before authority flip on any dirty worktree, moving source snapshot,
validation error, parity mismatch, failed test, unreviewed conflict, cache
contamination or writer-freeze failure.

### Rollback

- before the first post-cutover semantic write, rollback is an immediate code
  and authority revert to the preserved SQLite backup;
- after Git receives semantic writes, rollback must first rebuild SQLite from
  the selected Git commit, prove parity, then revert authority;
- never discard Git commits or overwrite the preserved pre-cutover DB;
- emit a rollback receipt containing source commit, semantic digest, rebuilt DB
  checksum and verification results.

## Deferred by explicit scope

- large knowledge-base performance;
- YAML schema upgrade policy.

Neither deferred item blocks this architecture review.
