# Git Semantic Store merge ergonomics spike

Date: 2026-07-20

Status: experimental evidence, not an architecture decision.

## Question

Can normal Git three-way merge provide a useful mechanical base for a reusable
team PR skill, without silently merging semantic conflicts?

The experiment uses real repositories, branches, commits and `git merge`.
`packages/core/test/git-semantic-merge-spike.test.ts` is the executable oracle.

## Compared layouts

### v1 round-trip layout

```text
.vibehub/semantic-store/v1/
  manifest.yaml                  # complete inventory + global semantic digest
  specs/sha256-<content>.yaml    # path changes whenever content changes
```

This layout remains valid evidence for the lossless SQLite round trip, but it
is not merge-friendly:

- every semantic edit changes the global digest;
- every content edit changes the entity path;
- even branches editing different specs conflict in `manifest.yaml`;
- the manifest becomes a repository-wide serialization point.

### v2 merge candidate

```text
.vibehub/semantic-store/v2/
  protocol.yaml                  # immutable protocol declaration only
  specs/sha256-<spec-id>.yaml    # stable path derived from stable identity
```

Candidate rules:

- entity paths derive from stable IDs, not document bytes;
- protocol metadata is committed, but mutable global inventory/digests are not;
- per-document canonical validation remains mandatory;
- complete inventory and semantic digest are derived from the checked-out Git
  tree when validating or building a query cache;
- Git object integrity protects committed bytes; VibeHub validation protects
  protocol and semantic integrity.

The v2 shape is a candidate discovered by this spike. It has not replaced the
v1 round-trip prototype.

## Real Git results

| Concurrent change | v1 | v2 candidate | Required handling |
|---|---|---|---|
| Different specs | Global manifest conflict | Clean merge | Automatic |
| Same spec, disjoint fields | Path/manifest conflict | Clean merge preserving both edits | Automatic plus validator |
| Same spec, same field | Conflict | Conflict | PR semantic decision |
| Both create the same next revision | Conflict | Conflict | Rebase/renumber in PR procedure |
| Conflicting lifecycle transition | Conflict | Conflict | PR semantic decision |
| Concurrent relation append | Conflict | Conflict | PR resolution plus graph validation |
| Delete versus amend | Conflict | Modify/delete conflict | PR semantic decision |

The desired boundary is therefore achievable:

```text
Git clean merge
  -> strict validator proves the merged tree
  -> PR may proceed

Git conflict or semantic validation failure
  -> reusable PR skill explains affected specs and required decision
  -> human/agent resolves explicitly
```

## PR skill and enforcement boundary

The reusable team PR procedure should:

- identify changed spec IDs and their authority level;
- rebase before assigning a new revision number;
- explain same-field, lifecycle, relation and delete/amend conflicts;
- run canonical, referential and graph validation;
- emit a review brief and validation receipt.

The skill is procedure, not authority. CI or a deterministic validator must
enforce schema, stable paths, identity uniqueness, revision pointers, relation
integrity, provenance integrity and exclusion of operational state.

## Open item exposed by the spike

Repo-scoped provenance currently inherits SQLite integer event IDs. Independent
branches can allocate the same next integer. A merge-friendly Git protocol
therefore needs collision-safe durable provenance identity before the v2
candidate can replace the v1 prototype. This should be addressed alongside the
branch-aware cache spike, not hidden inside PR prose.

## Recommendation

Carry the v2 stable-identity/derived-index shape into the next spike. Do not
promote v1 content-addressed paths plus a mutable global manifest as the
collaboration protocol. Next, prove branch/ref reads and a commit-keyed local
SQLite cache while resolving durable provenance identity.
