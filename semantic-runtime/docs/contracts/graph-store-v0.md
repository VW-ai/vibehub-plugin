# Local Graph Store v0

`LocalGraphStore`, exported from `src/index.mjs`, stores the incremental Working
Graph in the existing scoped SQLite `DomainStore`. It composes actual local
authority, Git enrollment, Project activation and admitted ingress records.
The public surface is an authenticated in-process API. The App, host plugins,
Policy scheduler, context compiler and branch adoption are later integrations.

The [incremental contract](incremental-graph-v0.md) remains the semantic authority:
immutable revisions, exact historical references, explicit competing assertions,
and current access checks. A candidate never silently becomes canonical Context
or an accepted Ticket. No Graph operation acknowledges an ingress event.

## Open and publish

Open a migrated DomainStore with `working-graph`, `durable-ingress`, `source-invalidation`,
`git-enrollment` and `project-activation` namespaces. Pass that store and its real
`LocalCredentialAuthority` to `new LocalGraphStore({store, authority})`. Enroll an
actual Git project and enable its current epoch before new publication.

1. `registerPublisherRun(context, {epoch, run_key})` returns `publisher_ref`,
   `session_id` and `execution_id`. This is a logical runtime publication run,
   bound to the actor, installation, workspace and activation epoch. It does not
   claim a Codex/Claude host session, run a worker or maintain a live-session list.
2. `initialize(context, {generation_id, epoch, idempotency_key, publisher_ref,
   coverage: []})` appends genesis and returns its receipt and `next_graph`.
3. `mutate(context, {epoch, idempotency_key, publisher_ref, expected_graph,
   operation, coverage: null})` accepts an incremental `assert`, `resolve` or
   `source_access` operation. Assertions use the registered `execution_id`.
   Source events must exactly match actual immutable ingress records. Caller
   JSON, paths, copied catalogs or a plausible event shape provide no authority.

New writes require a human/service principal with `graph:write`, `store:read`,
`store:write`, `ingress:read`, `project:inspect` and `activation:admit` actions.
Publisher registration uses `graph:publish`; maintenance uses `graph:rebuild`.
Source lifecycle mutation additionally requires `graph:lifecycle`. Reads require
`graph:read`, `store:read` and `ingress:read`, without an enabled Project or a
currently accessible checkout directory.

Generations owned by the [exploration service](exploration-projection-v0.md)
require its guarded binding route for ordinary initialization and semantic
writes. The marker lives in `working-graph`, so opening a legacy facade without
the exploration namespace does not bypass it. Authorized unowned generations,
historical reads, source lifecycle and rebuild retain their existing behavior.

After current source access is denied, a service principal with
`source:invalidation:read` and `source:invalidation:consume` may still apply an
exact retained lifecycle event through `source_access`. This path reads only
security metadata, checks the original captured ACL, and matches the retained
invalidation state. Prior lifecycle proofs come only from the current target
projections. Ordinary assertions, reads, receipts, pages and coverage never use
this path. An absent Graph object is not created by a tombstone notification.

Graph head CAS and semantic conflict are different outcomes. A stale
`expected_graph` returns `graph_revision_mismatch`, the unchanged proposal and
empty effects. A current Graph command asserting against an old entity revision
may retain competing semantic claims. Resolving them requires an explicit
resolution naming the complete set of competitors.

The command, source/catalog pins, canonical records, projections, head, audit,
receipt and outbox commit in one SQLite transaction. Exact actor/key/request
retries return the original receipt, including after Project disable or Git
metadata changes; a changed request cannot reuse the key. Current permissions
still apply to retry and receipt reads. No model, network call or source-file
fetch occurs inside the transaction.

Selected-source consumers may include `expected_source_fence` on `mutate`. This
optional nonnegative integer is part of the exact request identity. The Graph
checks it against the source-invalidation feed before planning, inside the write
transaction and before commit. Duplicate, receipt and reconciliation paths also
check the retained pin; a later fence rejects with `stale_invalidation_fence`.
These calls additionally require `source:invalidation:read`. Requests without
this field retain the existing source-closure checks and behavior. The pin is
conservative: an unrelated source change can invalidate a selected result too.

## Read and retain provenance

- `getHead(context, {generation_id})` returns the graph address and whether a
  projection rebuild is active.
- `resolve(context, {at, address})` reads a logical or exact semantic reference
  at an exact graph commit. An exact miss never falls forward to latest.
- `page(context, {at, collection, cursor, limit})` pages `heads`, entity
  `history`, or `conflicts`. Cursors pin the commit/collection and confer no
  permission. At most 64 candidates are read; an empty page can have a cursor.
- `getReceipt(context, {generation_id, idempotency_key})` returns the caller's
  immutable receipt after checking its source and retained coverage inputs.

Each call uses a coherent SQLite read view. Original event ACLs intersect current
ingress restrictions and Graph lifecycle state, including inherited parent and
relation evidence. Disabling collection preserves history but does not freeze
permissions. A denied point returns `{status:'denied', revision:null}`; source
denial during paging/receipt reads rejects the whole response. Tombstones and
uncaptured access revisions cannot be bypassed through old receipt metadata.

Coverage selects up to eight `{registration_id, target_event_id}` pairs from
real ingress cursors. Null targets mean unknown heads. Gaps and uncompleted
processing remain explicit. An assertion can refresh these selectors; null
inherits the exact prior coverage pins. The Graph does not manufacture source
completion from its own commit sequence. Existing ingress capacity remains
4,096 entries and 1 MiB per stream.

## Storage and repair

No database migration, new table, arbitrary SQL API or added dependency is
needed. A `format` record pins semantic wire 1, commit wire 2 and index version 1.
Canonical commits/revisions use immutable source rows; current projections/head
use CAS records. Temporal and collection keys use scoped primary-key ranges.
Ordinary reads select records and bounded ranges without reconstructing history.
Malformed formats, missing required indexes and corrupt selected records fail
closed. This detects damaged local records, not a privileged actor coherently
rewriting the entire database.

To repair derived indexes, explicitly call `rebuildProjection(context,
{generation_id, expected_graph, epoch, cursor:null, limit})`. The first call pins
a build with zero commits processed. Continue with its returned cursor and a
limit of 1–64. Each durable step replays bounded canonical deltas, verifies their
sequence/digests and records exact retry progress. Reduce the limit if a page
exceeds 1 MiB. A failed step changes nothing. Restart resumes the same build.

New semantic mutations are fenced during repair; healthy old indexes remain
readable until the final atomic switch at the pinned head. Every maintenance
request requires current activation admission. After re-enable, explicit fresh
maintenance requests can resume the build; old semantic results are not relabeled
with a new epoch. Canonical corruption refuses repair. Old index prefixes remain
retained, so repair increases disk usage. Pruning needs a separate retention
contract; no automatic cleanup or background rebuild is provided.

## Verification and live JEV composition

Deterministic tests use real temporary Git repositories and SQLite files. They
cover source/publisher authority, historical views, access changes, conflict
resolution, exact retries, corruption, paged repair, concurrent processes and
SIGKILL before commit and after commit before reply. The retained
[SQLite measurement](../measurements/graph-store-sqlite-20260922.json) exercises
1,040 transitions and 600 objects in one generation, including actual query plans,
bounded early/late reads, page sizes and rebuild/storage costs. Timings describe
one local synthetic run, not a throughput guarantee.

`npm run check:jev:graph` is a separate opt-in check using a locally supplied
`TYPESAFE_API_KEY`. It sends only eight fixed synthetic event texts and their
visible target text to the official TypeSafe endpoint. Nine target states are
first persisted with their own admitted sources, then materialized from Graph.
The eight model judgments become candidate revisions that pin every target
revision they considered, including targets not selected by the model. Their
provenance therefore inherits every input source. Restart verifies all 17
exact reads/retries and checks this source closure. Labels, ACLs, runtime/storage IDs, paths, provenance and credentials are not
sent as model input. Network calls run after all database views close.

The [2026-09-22 live run](../measurements/jev-graph-round-trip-20260922.json) completed
8/8 expected judgments, 96–347 ms per successful request, with no retries or rate
limits. All 17 source intents remain pending. This verifies composition; it does
not establish extraction quality, an automatic Policy loop or plugin coverage.

The [source-closure follow-up](../measurements/jev-graph-source-closure-20260922.json)
also completed 8/8 expected judgments, 127–337 ms per successful request, with
no retries or rate limits. It verifies 17 supporting source pins across the
eight judgment revisions after reopening the database. Both runs use the same
small synthetic corpus; the follow-up corrects missing target-revision parents
in the smoke harness, without changing the Graph Store or model adapter.

`npm run check:jev:source-fence` tests a separate fixed synthetic case: materialize
a Graph context, dispatch one JEV call, revoke that context's registration before
awaiting the response, and attempt to publish the result with its exact parent.
The [live source-fence run](../measurements/jev-inflight-source-fence-20260922.json)
completed a correct JEV judgment in 296 ms, then rejected publication with
`graph_access_denied`. The direct event remained readable, the Graph head did
not change and no result receipt was created. Automatic retries are disabled.
This tests the local result fence; it does not recall already-dispatched input
or implement production dispatch authorization, cancellation or a Policy loop.

The [final invalidation composition run](../measurements/jev-invalidation-composition-final-20260922.json)
repeated both checks after the source-invalidation changes: 8/8 Graph judgments
matched at 107–241 ms per successful attempt, and the in-flight revocation case
completed at 344 ms but was rejected on publication. Both checks had no retries;
the eight-call route reported no rate limits. These are fixed synthetic checks,
with the same limits as the earlier runs.

The [canonical-reader Graph regression](../measurements/jev-canonical-graph-regression-20260922.json)
ran these existing synthetic routes after adding the optional mutation fence:
8/8 judgments matched at 127–379 ms, with zero retries or rate limits. The
325 ms in-flight request was rejected on publication with the Graph unchanged.
This verifies compatibility of the existing JEV route; the canonical reader
itself performs no model calls.
