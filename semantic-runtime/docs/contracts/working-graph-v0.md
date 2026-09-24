# Semantic Working Graph v0

Wire version `1` implements active Ticket Contract V2. The versioned schemas are
executable validators in `src/core/working-graph.mjs`, exported through the public
package entry. They reuse the accepted [identity](identity-contract-v0.md),
[event/provenance](event-provenance-v0.md), and
[causal watermark/generation](causal-ordering-v0.md) contracts.

Working Graph state is derived and recomputable. `validated` and `resolved` describe
a derived claim, not canonical truth or permission to write its source. Fast judges
have attention authority: they may identify candidates and conflicts. The caller's
explicit policy/worker determines derived lifecycle assertions; model confidence
cannot certify acceptance, adjudicate protected human decisions, or grant canonical
write authority. Canonical writes require a separate explicit promotion contract,
authorized actor and concurrency checks. This module performs no external writes,
I/O, source retrieval, provider calls, job dispatch, or storage transactions.

## Public reference API

```js
const state = createWorkingGraph({
  catalog, // accepted identity catalog, retained as this generation's exact input
  scope: { tenant_id: 'acme', project_id: 'product' },
  generation_id: 'live-1',
  watermarks, // accepted projectFreshness result
});
const result = applyGraphAssertion(state, {
  expected_graph: graphRevisionAddress(state),
  assertion: {
    schema_version: 1,
    assertion_id: 'assert-1',
    entity_kind: 'entity',
    entity_id: 'context-1',
    base_revision: null,
    parents: [],
    execution_id: 'attempt-a',
    status: 'candidate',
    content: { semantic_type: 'constraint', data: { text: 'Keep API v1' } },
    events: [normalizedEvent],
    canonical_refs: [],
    // Optional when empty. Recomputations after access changes explicitly pin
    // every relevant current lifecycle event's digest.
    access_revisions: [],
  },
});
```

Successful mutations return frozen `{status: 'applied', state, graph_revision}` plus
`revision` and `conflict` for assertions, `revision` for conflict resolution, or
`access_revision` for source lifecycle updates. Inputs are never mutated. The
reference state is bounded to 128 snapshots and 512 records in each snapshot array;
provenance/parent lists are bounded to 128. It demonstrates pure contracts, not an
unbounded production store. A later adapter owns indexing, retention, atomic commit,
concurrency, authentication and authorized materialization.

Every graph/revision/address binds tenant, Project and generation. Graph creation
validates the catalog; assertions validate their Execution's Project and every
source event's registered mapping. Project-only executions are allowed by the
accepted identity contract. Source provider/authority and repository membership
must match that catalog. Catalog continuity or new enrollment needs a deliberate
new generation in this bounded reference implementation.

| Validator or constructor | Contract |
| --- | --- |
| `validateWorkingGraph(state)` | Strict state/catalog, immutable chain and exact predecessor-only mutation admission; rejects future source/access proof. |
| `validateGraphRevision(snapshot)` | Snapshot digest, revision/provenance closure, reconstructed heads/conflicts/resolutions, source access and watermark vector; full temporal admission needs `validateWorkingGraph`. |
| `validateSemanticRevision(revision)` | Entity or relation assertion, immutable digest, exact parents, lifecycle and complete carried provenance. |
| `validateGraphConflict(conflict)` | Immutable scoped conflict with at least two distinct exact assertion revisions. |
| `validateProvenanceClosure(value)` | Complete event/access-event pins, source ACL pins, intersection and sensitivity rederivation. |
| `validateSemanticAddress(address)` | Discriminated logical or exact revision reference. |
| `validateGraphRevisionAddress(address)` | Exact graph scope plus accepted generation/snapshot digest pin. |
| `semanticAddress({scope,generation_id,entity_kind,entity_id})` | Stable logical reference within a generation. |
| `exactRevisionAddress(revision)` | Exact entity/relation revision reference. |
| `graphRevisionAddress(stateOrSnapshot)` | Exact GraphRevision reference. |
| `canonicalArtifactAddress(normalizedEvent)` | Pinned Git/native object revision association; rejects snapshots and mutable pointers as canonical artifacts. |

Validators reject unknown fields/versions, accessors without invoking them, cyclic
or oversized JSON, invalid identifiers, dangling/cross-scope references and digest
tampering. Hashes bind content, not authenticity. Trusted adapters must retain the
accepted event body and never rebind an observation identity to different contents.

## Immutable snapshots and addresses

A state contains the catalog and ordered immutable `snapshots`. A GraphRevision
contains cumulative immutable entity/relation `revisions`, the current `entities`
projection, immutable `conflicts`, explicit `resolutions`, observed `sources`,
append-only `access_updates`, and the exact accepted `watermarks` vector. Its
`sequence` orders local graph snapshots only. Each successor admits exactly one
assertion/resolution or lifecycle update; genesis is empty. The validator rederives
heads and every implied conflict/resolution from immutable assertion order, then
checks adjacent snapshots against predecessor-only source and access state. A
recomputed digest cannot hide a competing assertion, roll back a head, insert
unadmitted source facts, or use an access proof from a later transition. Its digest includes all these fields,
the previous snapshot digest, scope/generation, and catalog digest.

```js
// Logical reference: resolves the head of the selected graph snapshot.
{ schema_version: 1, kind: 'semantic_entity', scope, generation_id,
  entity_kind: 'entity', entity_id: 'context-1' }

// Immutable reference: a miss is unavailable, never latest/current.
{ schema_version: 1, kind: 'semantic_revision', scope, generation_id,
  entity_kind: 'entity', entity_id: 'context-1', revision_digest }

{ schema_version: 1, kind: 'graph_revision', scope, generation_id,
  snapshot_digest }
```

The GraphRevision's `{generation_id, snapshot_digest}` can be passed directly as
`input_graph` to the causal replay contract, with the same enclosing `scope`.
Later writes preserve old snapshots, assertions, relation endpoints, conflicts and
source-watermark vectors. Exact lookup requires the requested digest; it cannot
substitute a newer revision. Array order is part of the digest after constructors normalize set-like assertion
event/parent/canonical/access lists using explicit code-unit ordering. Provenance
events use deterministic identity ordering, without claiming causality. Arrays
inside semantic content keep their supplied order.

`resolveWorkingGraphAddress(state, address, {principal_id, current_graph,
graph_revision?})` selects an exact snapshot (defaulting to state's head), then a
logical head or exact revision. It returns `resolved` with the revision, projection,
unresolved conflicts and GraphRevision; a missing revision returns `unavailable`;
failed authorization returns `denied` without content. The current authorization
graph must retain the selected snapshot's lineage. This is a trusted adapter input:
a caller supplying an old graph as “current” does not authenticate current access.
A service must select current state inside its authorized read/transaction boundary.

Historical snapshots remain byte-reproducible internal records; historical content
retrieval is separately gated by current access. Access tightening may therefore
make an existing immutable address unreadable without deleting or rewriting it.
The state/validator API is for trusted internal state, not an unfiltered public
snapshot endpoint. Retention and lawful deletion remain adapter responsibilities.

## Assertion and transaction concurrency

`expected_graph` is transaction compare-and-set. A stale pin returns
`{status: 'graph_revision_mismatch', state, proposal, graph_revision}` and applies
nothing. `proposal` is the original unapplied request. This does not claim a
conflict record was stored and does not silently rebase an Action's request.

`assertion.base_revision` is a separate semantic base. An assertion with a matching
current head advances that entity's derived head. Assertions for another entity
are compatible and independent. An existing entity with a different base retains
the new assertion and current head, creates an immutable Conflict, and projects
`contested`. Even equivalent-looking content on a mismatched base is conservatively
retained: this pure layer does not infer semantic equivalence or choose a winner.
Further assertions on a contested entity accumulate competing exact revisions.

Each assertion requires a globally unique `assertion_id` within this generation;
changed payload under an old ID rejects. A later journal owns command idempotency.
The base reference provides concurrency lineage, not evidence that its contents
support the new claim. `parents` explicitly name supporting exact revisions and
propagate their access. This distinction permits an explicit recomputation from
freshly authorized source material without laundering inaccessible parent content.

New entities start `candidate`. Ordinary explicit assertions may carry `candidate`,
`validated`, `rejected`, `stale`, or `superseded`. These are caller-supplied derived
judgments, with no hidden model inference; changing lifecycle, content, provenance
or canonical association produces a new revision. `contested` is computed from
open conflicts. `resolved` can be created only by `resolveGraphConflict`:

```js
resolveGraphConflict(state, {
  expected_graph: graphRevisionAddress(state),
  conflict_digest,
  assertion: {
    ...resolutionAssertion,
    base_revision: currentDerivedHead,
    parents: allCompetingRevisionAddresses,
    status: 'resolved',
  },
});
```

Resolution must pin the current graph/head, preserve every currently competing
parent, and pass their current source authorization. It appends a resolution
revision and immutable resolution associations for all open conflicts of that
entity. Earlier conflicts and candidate revisions remain exact and readable under
current authorization. Ordinary assertions cannot silently clear conflict state.
The adapter authenticates who may submit these derived transitions; this contract
is not an identity credential or semantic truth oracle.

## Relations and canonical associations

Entity content is `{semantic_type, data}`. Relation content is
`{relation_type, from, to, data}`; the bounded `SEMANTIC_RELATIONS` vocabulary comes
from Tech Design §10. Each endpoint is either an exact semantic revision address
or a discriminated `canonical_artifact` address containing an accepted normalized
event with an immutable Git/native payload revision. Unscoped strings, logical
latest aliases, unavailable revisions and cross-scope endpoints reject.

Relation provenance automatically includes both endpoint closures, explicit
parents, its own events and canonical associations. Omitting explicit events
cannot erase endpoint restrictions. A relation keeps its original endpoint pins
when either entity acquires newer revisions. An endpoint change requires a new
relation assertion/revision. `canonical_refs` likewise names exact external source
artifacts and propagates their provenance; it does not grant write authority or
change the artifact's canonical state. No `canonical` lifecycle or write grant is
accepted by the assertion schema.

## Provenance and access invalidation

A provenance closure retains accepted normalized `events`, explicitly pinned
lifecycle `access_events`, source-object and per-observation envelope ACL revisions,
and `effective_access`. It intersects every supporting allowlist and takes maximum
sensitivity (`normal < sensitive < restricted`). An empty allowlist stays deny-all;
empty content provenance is also deny-all. Nonempty supporting events must identify
at least one accepted source object so lifecycle invalidation has an explicit
stable target. Adapters must enroll a source object for host/document events;
this implementation cannot invent that object from an unscoped message or URL.

Different observers of the same immutable source object remain distinct event
pins. Different per-delivery envelope ACLs are not interpreted as a global
installation ACL. A combined claim must satisfy all of them. A source lifecycle
update is supplied through `updateGraphSourceAccess(state, {expected_graph, event,
access_state})`, where `event` is accepted `SOURCE_ACCESS_CHANGED` or
`SOURCE_TOMBSTONE` and explicitly names known `provenance.source_objects`.

The adapter must authenticate the lifecycle source and its authority over those
targets. Identity/catalog membership alone is not that authority. The pure function
assumes that trusted routing has occurred, and retains the exact event as proof of
what it consumed. It deliberately does not choose the first observer as a global
source owner or accept timestamps as a cross-source authorization order.

For each source tuple/object, sequenced lifecycle updates must advance that exact
producer/epoch's observed position. Cross-source updates remain separate; current
access conservatively meets their latest restrictions. Unknown or revoked access
quarantines affected current projections before recomputation. Every descendant
inherits the original source-object closure, including relations and resolutions,
so invalidation reaches them without traversing an untrusted latest alias.
Tombstones cannot reopen within a generation, even from a later or different
observer. Unsequenced updates are refused. A lifecycle event must match an exact
source tuple already admitted in the predecessor snapshot by its captured source
watermark requirements or trusted normalized source observations; the ACL event
itself cannot mint a new producer epoch or observer. A trusted adapter can
explicitly admit another epoch through those existing contracts before submitting
its lifecycle updates. Each admission is checked against its original predecessor;
a later captured watermark view may omit that epoch without invalidating the
accepted lifecycle record or removing its restrictions. Such an admitted record
also preserves the source tuple for later sequenced updates. Old-epoch source
provenance and independent restrictions
remain intact and addressable; the new epoch never supersedes them by implication.
A normal transport retry retains its enrolled durable epoch and sequence. A
producer restart without proven epoch continuity requires explicit admission,
not a timestamp guess. Authentication, authority mapping and recovery orchestration
remain adapter duties; this module implements no migration or recovery service.

Any relevant lifecycle revision change makes old revisions unavailable, including
for principals that remain in the new ACL. Explicit recomputation must supply
`access_revisions` equal to the current relevant lifecycle event digests returned
as `access_revision`, and its new closure intersects those restrictions. It cannot
use quarantined parents/endpoints as if they were fresh. A replayed old event with
no current access pins cannot reopen the projection. Explicitly reusing immutable
source content under a fresh authorized access attestation is allowed for a new
derived assertion; it does not rewrite the old revision or restore revoked readers.

`validateWorkerGraphInput(state, {graph_revision, revisions, principal_id})` returns
`valid` only for the current exact graph, exact current uncontested heads and
currently authorized sources. It returns `stale` on graph movement, superseded
inputs, conflict, quarantine, unknown/revoked access or denied principal. Generation
and scope mismatch reject. A future worker-result ingress must perform this check
inside its commit boundary; merely checking at job start is insufficient.

## Verification and boundary

The fixture in `test/fixtures/working-graph/scenario.mjs` reuses the accepted
identity/event fixtures and adds a second registered execution. It models one
Project, API and web repositories, independently caught-up source vectors,
compatible and contradictory assertions, explicit resolution, exact relation
endpoints, historical snapshots, stale Workers, source tombstones, ACL tightening,
unknown access and two observers of the same commit.

```sh
node --test test/graph/working-graph.test.mjs test/graph/working-graph-integration.test.mjs
npm run check:boundaries
```

These are executable contracts and synthetic conformance checks. The module
creates no database, server, canonical ownership migration, broad ontology,
background process or live integration. Source watermark vectors preserve each
repository's captured-head status; neither graph sequence nor a timestamp creates
a global source order. Immutable snapshots and hashes do not prove source byte
availability, permission to call a model, or successful acceptance. Ordinary
plugin and Phase 0 replay/provider behavior remain independently usable.
