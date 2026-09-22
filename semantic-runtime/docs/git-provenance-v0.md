# Git commits, ref movements and observation provenance v0

The public package entry exports `GitProvenance`, `GIT_PROVENANCE_VERSION`,
`createGitCommit`, `validateGitCommit`, `createGitCommitObservation`,
`correlateGitCommitObservations`, `createRefMovement`, `validateRefMovement`, and
`assessGitClaimAfterMovement`. This offline adapter and pure contracts consume the
accepted identity, event and causal APIs. They have no host, model, store or plugin
dependency and perform no canonical writes.

## Reading exact objects

```js
import { GitProvenance, createGitCommitObservation } from '@vibehub/semantic-runtime';

const git = new GitProvenance({
  repository_path: '/explicit/authorized/repository',
  repository: { tenant_id: 'acme', repository_id: 'api', object_format: 'sha1' },
});
const commit = git.readCommit(fullLowercaseOid);
const observation = createGitCommitObservation({ commit, event: normalizedEvent });
```

Repository identity is the caller's explicit registered mapping. The adapter
checks the actual object format; a filesystem path or remote URL cannot establish
tenant ownership or repository membership. Pass complete lowercase SHA-1 or
SHA-256 OIDs. Symbolic refs, revision expressions and abbreviated OIDs are refused.

A resolved `git_commit_record` contains:

| Field | Meaning |
| --- | --- |
| `schema_version`, `kind` | Version 1 of the commit snapshot representation. |
| `object` | The accepted `git_commit` tuple: tenant, repository, object format, full OID. `sourceObjectKey(object)` supplies identity. |
| `tree_oid`, `parent_oids` | Exact header tree and ordered parent OIDs. Roots have an empty parent list; merges retain every parent in header order. |
| `author`, `committer` | Each has lossless `name_base64`, `email_base64`, integer `timestamp_seconds` and original `timezone`. Commit clocks do not order observations or establish ancestry. |
| `message_base64`, `raw_commit_digest` | Exact message bytes and SHA-256 of the complete raw commit body, including headers/signatures the projection does not interpret. |
| `changed_paths` | One ordered diff result per parent, or one explicit empty-tree base for a root. |

Each changed-path result contains `base: {kind: 'parent' | 'empty_tree', oid}`,
`status: 'resolved' | 'unresolved'`, `reason`, and `changes`. A parent base names
the exact parent commit; the adapter extracts that parent's raw tree. For a root,
the empty-tree OID is computed for the repository's object format. The adapter
diffs those exact tree OIDs, avoiding shallow or graft rewriting of commit
traversal. A merge has separate parent comparisons; there is no ambiguous
combined-diff or invented universal changed-path list.

Each change carries `status: A | D | M | T`, `path_base64`, `old_mode`, `new_mode`,
`old_oid`, and `new_oid`. Missing sides use mode `000000` and OID `null`.
NUL-delimited raw Git output and base64 preserve newline, tab, leading-dash and
non-UTF-8 filenames. Rename detection is deliberately disabled: a rename appears
as deletion plus addition, without a heuristic similarity claim. Gitlink changes
remain visible even if local diff configuration ignores submodules.

If the object cannot be read, the result is
`{schema_version: 1, kind: 'unresolved_git_commit', object, reason}`. Reasons are
`object_unavailable`, `not_commit`, `read_failed`, `limit_exceeded`, or
`unsupported_commit`. `object_unavailable` does not distinguish an absent,
garbage-collected or inaccessible object from every Git operational error with
the same exit status. No commit/tree/parent/path content is invented. An existing
commit with an unreadable parent or tree retains its verified metadata and an
unresolved per-base diff (`base_unavailable`, `tree_unavailable`, `read_failed`,
or `limit_exceeded`). An empty resolved diff is therefore distinct from an
unavailable diff.

The adapter verifies the actual Git object hash and records the raw-body digest.
`createGitCommit` and its validator enforce schema/invariants on supplied JSON;
they cannot authenticate a caller's facts without the original bytes. Constructors
return deeply frozen copies. Unsupported metadata is retained as an unresolved
pointer instead of entering ancestry. Per-command reads have a ten-second timeout
and eight-MiB output cap; commits support up to 128 parents, 4096 changes per
base, and 4096 path bytes per change. An oversized path or unsupported diff stays
an unresolved per-base result while preserving the verified commit metadata.
Limits produce explicit unresolved data, never silently truncated content.

## Bounded selected record reads

`readFileAtCommit({commit_oid, path})` reads one regular blob through verified
commit/tree objects. `readEntryAtCommit` returns its membership and available
blob metadata without reading the artifact body. Both distinguish `resolved`,
proved `absent`, `unsupported` and `unavailable`, retaining exact object/digest
pins. `proveDescendant({ancestor_oid, descendant_oid})` follows bounded raw
commit parents; missing ancestry never proves a rewind or divergence. A retained
ancestor OID is a comparison pin and its body need not be reopened.

The trusted local reader may provide `object_directory` from actual enrollment
to enter the private Git view immediately, plus an `authorize_commit` callback
that must allow each raw commit expansion. These constructor capabilities are
not client-supplied JSON. One adapter instance shares caches and fixed budgets
across a refresh; `metrics()` reports actual reads and `GIT_SELECTED_READ_LIMITS`
exports the limits. The [canonical reader](canonical-source-reader-v0.md)
documents the complete bound and authority contract. It performs no recursive
project import, source config read, fetch, or automatic refresh.

## Correlating observations

`createGitCommitObservation({commit, event})` requires a valid normalized
`GIT_COMMIT` event in the same tenant and repository, with source support for the
commit. A whole-commit `git_revision` payload uses `path: null` and
`digest: commit.raw_commit_digest`. The constructor rejects a different digest.
A missing object can be observed with a non-replayable mutable pointer; its source
support still names the full commit identity.

An observation retains the full normalized event, its scoped observation ref,
`eventObservationKey`, event digest, and commit snapshot. Local commit, fetch,
push-webhook and PR-update fixture events each retain their own delivery,
producer, sequence, ACL, sensitivity and observation identity.

`correlateGitCommitObservations(observations)` groups by the existing
`sourceObjectKey`, returning one group with `object`, `object_key`, immutable
`content`, `observation_refs`, and complete `observations`. Exact duplicate
observations deduplicate; altered observation pins and conflicting immutable
content fail. Group content excludes per-base diff availability, which belongs
to each retained observation. A later missing object cannot erase earlier known
content; an earlier unresolved observation remains visible after resolution.
Same OID in another tenant, repository/fork, or format is a different identity.

Correlation is not an ACL union or permission grant. Callers must authorize
observations and content for their consumer, preserve normalized events, and
verify payload bytes on retrieval. Grouping does not authenticate a synthetic
remote payload or make it durably stored. The four remote/local observer shapes
here are fixture inputs; there is no network connector or webhook authentication.

## Mutable refs and immutable history

`readAncestry({oids, max_commits = 4096})` returns frozen `commits`, `unresolved`
pointers and `truncated`. It follows ordered raw commit headers, independently
of Git shallow and replacement traversal. Missing ancestors and budget boundaries
leave graph nodes absent, so the accepted classifier returns unknown unless a
known path already proves ancestry. `parents_complete` means the raw commit
header supplied its entire parent list, not that every parent object is locally
available.

`readRefMovement({ref, before_oid, after_oid, reported_operation, event,
max_commits})` accepts explicitly observed endpoints and a full `refs/...` name;
it does not read or update a current ref. Use `null` for an absent endpoint,
rather than webhook zero-OID conventions. A normalized `GIT_REF_CHANGED` event
must name the same repository and support both present endpoint objects. The
adapter returns `{movement, unresolved, truncated}`.

`createRefMovement({ref, before, after, commits, reported_operation, event})` is
the pure equivalent using accepted full commit identities and DAG records.
`validateRefMovement` recomputes the result and digest pins. Each frozen movement
retains endpoints, ancestry evidence, normalized event and event digest, source
reported operation, ancestry verdicts, and a content-bound `movement_id`.

| Classification | Ancestry fact |
| --- | --- |
| `create`, `delete` | One observed endpoint is absent. |
| `fast-forward` | Before is an ancestor of after (`movement: advance`). |
| `rewind` | After is an ancestor of before. |
| `force` | Both complete ancestry checks prove neither endpoint is an ancestor of the other (`movement: diverge`). |
| `unchanged` | Both endpoints name the same immutable object. |
| `unknown` | Available ancestry cannot establish the relationship. |

`force` labels divergent topology; it does not infer that a particular CLI command
ran. The separate `reported_operation` is `update`, `force_push`, or `rebase`.
A reported force push can be a fast-forward. A rebase creates new immutable
commit identities and a ref observation; neither it nor a ref deletion removes
the old commit snapshots, observation refs, or audit records.

`assessGitClaimAfterMovement(claim, movement)` returns an auditable proposal:

```js
const moving = { claim_id: 'current-head', basis: {
  kind: 'ref_head', ref: movement.ref, object: movement.before,
} };
const historical = { claim_id: 'historical-fact', basis: {
  kind: 'exact_commit', object: movement.before,
} };
```

A `ref_head` claim about the same ref and exact old object becomes `stale`
relative to an observed changed endpoint, even when ancestry is unknown. An
unchanged ref, another ref or revision, and every `exact_commit` claim remain
`unaffected`. This is a proposal relative to that movement, not a mutation or
claim that an out-of-order delivery is the current ref state. Callers must use
accepted source ordering and concurrency checks before applying it to a live
claim. The function carries movement/observation pins and preserves its inputs.
There is no unsupported claim that a rebase has disproved historical content.

## Operational boundary and verification

The adapter executes only argument-vector `git rev-parse`, `cat-file` and
`diff-tree` reads for the explicit absolute repository path. It never runs
a shell, writes refs/config/index/worktree, merges, rebases, fetches or pushes.
It discards ambient Git environment routing, disables system/global config,
replacement refs, hooks, fsmonitor, lazy fetching, external diff and textconv,
and uses an empty `GIT_ALLOW_PROTOCOL` allowlist to deny every transport, including
repository-configured file protocols and remote helpers. Source discovery reads
the repository's format and absolute object-directory path with `rev-parse`.
Each object/diff command uses a disposable minimal bare metadata directory of the
same object format, with `GIT_OBJECT_DIRECTORY` pointing to the source store.
This private view has no source configuration or remotes. It avoids both lazy
downloads and pre-fetch config writes on older Git versions that ignore
`GIT_NO_LAZY_FETCH`; command-line `protocol.allow=never` alone is insufficient
because local per-protocol settings can override it. Scratch metadata is removed
in `finally` and is never installed into the source repository. Locally available
partial-clone objects remain readable; missing ones remain unresolved.
This is a read-only adapter for an authorized repository, not a sandbox for a
malicious Git executable or filesystem. Source authentication, ACL enforcement,
durable storage and atomic projection remain the owning integrations' duties.

The conformance suite creates deterministic temporary repositories with isolated
configuration and signing/hooks disabled. It covers SHA-1 and SHA-256, real
root/merge/rebase objects, local bare-repository force pushes, shallow history,
garbage collection, absent trees, raw filename bytes, oversized Git tree paths,
graft/replacement/config interference, partial-clone local transport and helper
denial with entire source metadata fingerprints, endpoint classifications,
correlation and strict schema/pin
rejections. It never changes the user's real refs or invokes external services.

```sh
node --test test/git-provenance.test.mjs test/git-provenance-integration.test.mjs
npm run check:boundaries
```

The public integration also passes actual commit observations into accepted
source cursors and freshness vectors, preserving one commit identity alongside
four independent observation positions. These checks establish the bounded
offline contract, not a deployed Git service or PR-review semantics.
