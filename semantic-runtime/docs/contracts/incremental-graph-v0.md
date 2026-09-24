# Incremental Working Graph contract

The new wire-v2 contract plans individual Graph commits and reads selected
records. It removes the V1 reference state's Project-wide 128-snapshot and
512-record lifetime ceilings without increasing those old constants or resetting
generations. It is a pure contract with an indexed synthetic conformance fixture,
not a production database or a connected semantic service.

The original [Working Graph V1](working-graph-v0.md) remains unchanged. Its
SemanticRevision, GraphConflict, exact/logical semantic addresses, canonical
artifact addresses, normalized events and provenance digests are reused.
Compatible inputs produce identical semantic revision/conflict bytes. The new
per-operation limits are stricter than V1's 128-member support lists; compatibility
is limited to inputs that satisfy both contracts. Old graph snapshot addresses
are explicitly rejected by the new API. There is no automatic snapshot import,
latest fallback or relabeling of a snapshot digest as a commit digest.

## Public functions

All functions are exported from `src/index.mjs`:

```js
const created = planGraphGenesis(port, {
  scope, generation_id: 'live-1', catalog_pin, watermarks,
});
// Trusted test fixture or future transactional adapter commits created.plan.

const proposed = planGraphMutation(port, {
  schema_version: 2,
  kind: 'graph_mutation',
  expected_graph: currentCommitAddress,
  catalog_pin,
  operation: { kind: 'assert', assertion: existingV1Assertion },
});

const selected = resolveIncrementalGraph(port, {
  at: exactCommitAddress,
  address: exactOrLogicalV1SemanticAddress,
});
const page = pageIncrementalGraph(port, {
  at: exactCommitAddress,
  collection: { kind: 'heads' },
  cursor: null,
  limit: 64,
});
```

The other mutation kinds are `{kind:'resolve',conflict_digest,assertion}` and
`{kind:'source_access',event,access_state}`. Only an ordinary assertion may supply
an updated captured `watermarks` vector. A resolution requires a `resolved`
assertion and every competing parent; ordinary assertions cannot declare
resolution. Source lifecycle requires a sequenced accepted access-change or
tombstone event with explicit targets and separately authenticated authority.

A successful plan returns `{status:'planned',plan}` plus `revision`, `conflict`
or `access_revision` where applicable. It does not claim a commit occurred.
A stale expected graph returns `{status:'graph_revision_mismatch',graph_revision,
proposal,effects:[]}` without admitting the semantic mutation. A separately
admitted semantic-base mismatch retains competing revisions and an immutable
conflict. No operation silently rebases the proposal.

Point reads return the existing V1-shaped `{status:'resolved',revision,entity,
conflicts,graph_revision}` or `{status:'unavailable'|'denied',revision:null}`.
Pages return `{items,next_cursor,graph_revision}`. Heads/history items have the
point-read shape; conflict items contain `{status:'resolved',conflict,
graph_revision}`. Missing or inconsistent required repository proof fails the
whole operation without returning partial content or an effect plan.

The executable public validators are `validateGraphManifest2`,
`validateGraphCommit2`, `validateGraphCommitAddress2`, `validateGraphMutation2`,
`validateGraphEffectPlan2` and `validateGraphPageCursor2`. Unknown fields/versions,
accessors, prototypes, cycles, sparse arrays and JSON hooks are rejected before
property access or port admission. Validated wire inputs and all returned port
facts are copied by value; a repository reusing a mutable object cannot change
the captured principal or cached evidence during an operation.

## Immutable commit and effect boundary

A new graph address is exactly:

```js
{ schema_version: 2, kind: 'graph_commit', scope, generation_id, commit_digest }
```

The immutable manifest pins scope/generation, semantic wire version 1, initial
catalog revision/digest and initial captured watermarks. It has no accumulated
entity, event, source or history array. A commit contains its sequence,
predecessor address, manifest digest, command digest, current catalog pin,
captured watermark vector, appended-record digest commitments and bounded
changed-projection values. Genesis has only its manifest. Every later commit
contains one semantic assertion/resolution or one source lifecycle transition.

Hashes use SHA-256 over recursively key-sorted inert JSON, omitting only the
record's own digest field. Kind/version are included. Set-like support lists use
V1's code-unit ordering; semantic content arrays retain their order. Conflict
competitors retain V1's head/previous-competitors/new-assertion insertion order.
Neither a hash nor a copied catalog proves identity, authorization or commitment.

An effect plan contains the exact expected graph/head version, next graph,
immutable commit, selected immutable appends, named projection CAS descriptors,
one bounded audit descriptor and one graph-change outbox descriptor. Each CAS
pins the selected prior version/digest. Its new value and origin commit match
the immutable commit's projection delta. The mutable head CAS is separate from
that delta, avoiding a self-referential digest. The validator checks record
shapes and append/CAS/audit/outbox consistency, including exact changed targets.
It cannot authorize an arbitrary plan; the future adapter must recompute/admit
under authenticated current facts before applying it.

Immutable row families are manifest, semantic revision, conflict, resolution
and access update. An access update retains its exact event, event digest,
access state, authority reference, principal and predecessor. Projection families
are entity head/competitors/open conflicts, assertion-ID uniqueness, source epoch,
source object, observed source-object/epoch positions and current source access.
No generic SQL, arbitrary namespace or executable effect is exposed. Audit/outbox
receipt does not complete a source cursor, accept a Ticket, write canonical Git
state or dispatch a Worker/model/host request.

## Trusted selected-record port

The adapter constructs one port for an authenticated caller and coherent
read/transaction view. A browser, model or source message cannot supply this
capability as JSON. The port has four synchronous methods:

| Method | Selected fact |
| --- | --- |
| `current()` | `{scope,generation_id,head,head_version,catalog_pin,access_view,principal_id}`. Head/version are null only before genesis. |
| `read({at,kind,key})` | `{at,current_head,access_view,kind,key,complete,version,value,origin}` for one exact key, or an explicit complete absence with null version/value/origin. |
| `page({at,collection,after,limit})` | Exact view/selector plus at most 64 ordered `{position,kind,key}` candidates and `next_position`. |
| `authorizeLifecycle({at,event_digest,targets})` | Exact predecessor/current/access/principal/event/target pins plus `allowed` and a retained `authority_ref`. |

`complete:true` attests the selected lineage and **latest/as-of** record for that
key, not merely that an older record exists. A valid old projection with its
valid origin commit cannot prove it is still latest. That selection remains a
trusted repository duty. Source-access completeness specifically covers all
latest independent observer/epoch restrictions for the object. Incomplete proof
fails closed; it is never interpreted as no restrictions or an empty collection.

The core checks every returned view/key, scope, generation, digest, record shape
and immutable origin commitment. It checks one immediate predecessor without
walking the full chain. Revision membership must precede the selected commit.
The adapter attests that selected/origin commits belong to the current committed
lineage; a coherently malicious repository can lie about that. Cryptographic
membership proofs or a generic checkpoint system are not claimed here. Current
principal/head/access facts are checked again before returning any result.

Keys are finite domain tuples. Examples are `revision:[revision_digest]`,
`entity:[entity_kind,entity_id]`, `catalog:[revision_id,digest]`,
`accepted_event:[eventObservationKey]`, `source_epoch:[sourcePartitionKey]`,
`source_object:[sourceObjectKey]` and
`source_object_epoch:[sourceObjectKey,sourcePartitionKey]`. The existing event
and causal helpers generate those collision-safe identity strings. A future
store can hash `[kind,key]` into its bounded internal IDs; these are not
caller-selected namespaces.

Accepted-event facts retain the exact normalized body/digest, original catalog
pin and immutable source reference. Every event is validated under its original
retained catalog, including directly reused events and parent/endpoint events.
Current catalog selection validates the new command's execution. Removing an
old execution from the current catalog does not reinterpret its past evidence;
actual revocation is enforced through current access. This contract accepts
explicit versioned catalog facts but implements no live enrollment service.
The current Git registry still creates no host Session/Execution registrations.

## Source, conflict and historical semantics

Exact parents and relation endpoints carry their full provenance. Reads and
writes reconstruct their bounded supporting closure; a rehashed revision that
omits inherited events is rejected. Selected supporting revisions must be
currently accessible to the port's principal before their content is included
in a returned plan. The complete nonempty resulting provenance must also admit
that principal, including fetched lifecycle events. Lifecycle planning similarly
requires permission to materialize retained prior lifecycle records; authority
to change a target does not implicitly grant permission to read private history.
This authorized subset is stricter than V1's caller-agnostic mutation functions.
An empty-evidence candidate remains deny-all and contains no fetched provenance.
`base_revision` proves exact lineage only: it does not
inherit its content/ACL. Fresh recomputation from newly authorized events may
therefore use an inaccessible old base without laundering its contents.

Current access meets complete captured ACLs with all relevant latest source
lifecycle revisions. Independent observer/epoch restrictions remain separate;
dropping an epoch from newer watermarks does not remove an admitted restriction.
A tombstone cannot reopen through another observer or epoch. Sequenced lifecycle
updates must follow the producer epoch's previous update globally and the target's
observed source positions; an unsequenced prior observation cannot certify order.
The lifecycle event cannot admit its own epoch. Admission uses predecessor
watermarks, observed content or previously admitted lifecycle state.

Old semantic revisions retain their original bytes. Access changes quarantine
old claims until an explicit recomputation pins all current access revisions.
This applies to parent and relation closure and every competing revision. An old
exact read is denied if the selected entity's competing revision is inaccessible,
matching V1. Resolution retains all competitors and closes all open conflicts
for the entity, not only the named conflict.

Lifecycle plans update only selected access/source records and enqueue bounded
source invalidation references. They do not scan every descendant. Reads compute
quarantine from retained provenance/current access; downstream cache/index/package
invalidation remains owned by its later integration Ticket.

## Paging, limits and verification

Collections are `{kind:'history',entity_kind,entity_id}`, `{kind:'heads'}` or
`{kind:'conflicts',entity:null|{entity_kind,entity_id}}`. A cursor pins scope,
generation, exact commit, collection and position. It is a locator, never a grant.
Each continuation reads current access again. Up to 64 candidate positions are
examined; denied or resolved-conflict candidates may yield an empty visible page
with a continuation. No unbounded scan attempts to fill it. An exact miss never
falls forward to latest.

`INCREMENTAL_GRAPH_LIMITS` publishes 1 MiB/16 levels/50,000 nodes for each request,
row, aggregate plan or returned page. Reachable support is limited to 32 revisions,
32 unique events/source objects, 32 access updates per object and 32 open
competitors/conflicts per entity. Mutation/point operations have a hard 256 port
request budget; pages have 2,048 and at most 64 candidates. A page exceeding its
aggregate byte budget is rejected; the caller can choose fewer items. Provenance
is never truncated. These limits bound one operation or closure, not the number
of independent records or transitions in a Project generation.

The test fixture uses Map point indexes, per-key sorted version arrays with
binary search, stable entity/conflict ordinals and per-entity history indexes.
It applies only named deltas and exposes actual request/candidate counters.
There is no reconstruction, cloning or filtering of the whole Graph to answer
one point operation. Its cumulative test history is retained fixture data,
not an exported in-memory production repository.

The conformance suite compares exact semantic revisions/conflicts and authorized
reads with V1 on bounded traces, then performs 1,040 transitions over at least
600 distinct semantic entity/relation records in one generation. It retains
old references/pages past both old thresholds, without reset or pruning.
Fixed small-support writes must use at most 64 total port calls early and late.
Measured runtime, maximum row/plan bytes, counts and page totals are recorded by
the fixture test; they are environment-specific conformance, not production
throughput. Tests use synthetic data with no model call or external traffic.

A real adapter must authenticate sources/lifecycle authority, retain original
catalog/event/canonical records, and atomically append records/commit, CAS the
head/projections and persist audit/outbox. It can rebuild projections by paging
immutable commits in order and applying their bounded named deltas while
verifying predecessor/digest commitments. A resumable rebuild/checkpoint,
crash durability, live enrollment, branch adoption, pruning and actual SQLite
Graph persistence remain separate work; this contract does not certify them.
