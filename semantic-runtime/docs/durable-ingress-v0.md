# Local durable ingress v0

`DurableIngress` accepts explicitly enrolled local observations into the existing
DomainStore. It retains approved content and its first normalization pins, advances
the source receipt cursor, and creates one pending downstream intent in a single
ProjectActivation transaction. Its receipt means durable intake. It does not mean
semantic processing, successful host delivery, or accepted project truth.

This module adds no listener, Collector, polling loop, dependency, broker or Worker.
The App composes it with the already accepted Git registry, local credentials and
project switch. Ordinary coding remains independent of the service's availability.

## Construction and authority

```js
import { DurableIngress, INGRESS_NAMESPACE } from './src/index.mjs';

// The same DomainStore includes git-enrollment, project-activation,
// durable-ingress and the eventual consumer's own namespace.
const ingress = new DurableIngress({ store, authority,
  snapshotPolicy: ({ text }) => explicitlyApprovedSyntheticTexts.has(text) ? text : null,
});
```

Construction internally creates GitProjectRegistry and ProjectActivation using
exactly that store and authority. It cannot accept an activation handle attached
to a different database. Database initialization/migration remains an explicit
owner operation. No namespace is automatically added to an existing store.

Every method requires an opaque context issued by LocalCredentialAuthority for
the local API audience and `store:read`. The caller's tenant and Project scope
select the store partition; input IDs cannot broaden it.

| Operation | Additional actions and restrictions |
| --- | --- |
| registerSource | `ingress:register`, `store:write`, `project:inspect`; human/service only |
| updateSourceAccess | `ingress:register`, `store:write`; human/service only |
| eventIdFor | `ingress:submit`; registered producer principal only |
| submit | `ingress:submit`, `store:write`, `project:inspect`, `activation:admit`; registered producer principal only |
| getSource/getReceipt/readEvent/readSnapshot/listPending | `ingress:read`; current source ACL, plus captured event ACL for event reads |
| handoff | `ingress:handoff`, `store:write`, `project:inspect`, `activation:admit`; human/service only; current and captured ACL |

The App owns registration and policy configuration. These process-local objects
and synchronous composition callbacks are trusted; never expose a DomainStore
handle or transaction callback to an HTTP/plugin client.

## Enrolled source and observation identity

```js
const registered = ingress.registerSource(context, {
  partition: { tenant_id, project_id,
    source_installation_id: enrolled.catalog.installation_id, partition_id: 'selected-input' },
  producer: { producer_id: 'local-adapter', epoch: 'explicit-incarnation-1' },
  producer_principal_id: 'local-adapter-principal',
  start_sequence: 0,
  mapping: { schema_version: 1, mapping_id: 'local-events', revision: 'v1',
    event_types: { message: 'AGENT_MESSAGE' } },
  // Optional execution: exact enrolled repository_id, checkout_id, worktree_id.
  access: { enabled: true, allowed_principal_ids: ['local-adapter-principal'],
    sensitivity: 'normal', allow_snapshots: true },
});
```

The result is `{registration_id, version, registration}`. The ID is service
allocated. An empty cursor is persisted immediately with the explicitly attested
`start_sequence`. Registration does not enable the Project. Current local Git
enrollment provides one installation; arbitrary installations cannot be asserted.

Source partition, producer/epoch, origin, producer principal, mapping and optional
execution tuple are immutable. A unique sourcePartitionKey guard prevents a fresh
registration from resetting an existing stream. Changing identity or mapping
requires an explicitly new source incarnation/partition and registration; old
references remain available. `updateSourceAccess(context, {registration_id,
expectedVersion, access})` replaces only the live access policy with CAS and an
immutable audit record. It returns the registration result shape above.

`getSource(context, {registration_id})` returns that shape plus
`cursor: {version, state}`. The cursor is an accepted-source cursor, not a host file
offset or a producer resume token. It never treats maximum_sequence as continuity.
It rejects the whole read when any cursor entry's captured/current access excludes
the caller; filtering a cursor would invent a false account of continuity.

Before constructing a RawEvent, the producer calls:

```js
const event_id = ingress.eventIdFor(context, { registration_id,
  idempotency_key: 'producer-selected-stable-retry-key' });
```

The observation ID is a SHA-256 key over the versioned collision-safe tuple
`[1, authenticated tenant, authenticated Project, registration_id, idempotency_key]`.
Submit enforces this exact ID. Native source IDs remain in source_native_event_id.
This avoids relying on a global uniqueness query across Project-scoped stores.
Separate retry keys observing the same Git/source object remain independent;
sourceObjectKey supplies correlation, never deduplication by object.

## Approved bytes and reference-only intake

```js
const result = ingress.submit(context, { registration_id, epoch: activationEpoch,
  event: rawEventV1, snapshot_text: alreadySanitizedText });
// {status: 'accepted' | 'duplicate', receipt}
```

RawEvent must satisfy the strict public v1 contract. Unknown fields, raw log or
transcript objects, executable getters, opaque objects, invalid identity and
unknown taxonomy are rejected. There is no Session/Execution registry in the
current Git catalog, so asserting those IDs cannot enroll a host session. An
execution-bound source must supply its exact enrolled Git tuple in each event.

For snapshots, the producer forms the final digest from the final, already
sanitized UTF-8 text. At most 64 KiB of text may be supplied; lone UTF-16 surrogates
are rejected so encode/decode preserves exact text. verifyEventPayload checks the
exact bytes against the reference digest. A configured trusted synchronous policy
must return that same string unchanged. No policy, rewritten text, a Promise or
policy failure rejects with `sanitization_required`. The policy is an App-side
approval boundary, not a claim that arbitrary secrets can be automatically found.
Upstream adapters must redact selected content before constructing its observation.
The service never silently changes a message or rebinds its digest.

The source must permit snapshot capture. Effective captured access intersects
the event and all supporting source ACLs, with the highest sensitivity. It must
fit the source's current allowed principals and sensitivity floor. The service
constructs its own replay authorization from those exact effective attributes;
an event cannot supply its own authorization/sanitized flag. Snapshot bytes,
authorization and normalized event commit together. No usable authorization or
receipt escapes an aborted transaction.

An immutable snapshot pin is keyed by partition plus snapshot_id. Reusing it with
different bytes/digest rejects; the same bytes can support separate observations
and separate capture grants. Existing payload references may be submitted without
snapshot_text. The service never fetches a path or URL and never auto-snapshots a
mutable pointer. Reference-only snapshots have no newly attested local bytes and
remain non-replayable under the core contract; immutable revision references and
mutable pointers retain their existing replay classifications.

The entire intake JSON is limited to 128 KiB, 25,000 nodes and depth 16 in addition
to the stricter per-field event checks and DomainStore limits. Diagnostics contain
only bounded codes, never the rejected body or a provider error. Rejections create
no denial record, payload, cursor gap or intent in this slice.

## Commit, retry and reads

Accepted intake stores the first raw/normalized envelope and full normalized
digest, retained identity catalog and mapping, approved bytes/grant if supplied,
cursor CAS and one intent. The activation epoch and current source/Git identity
are checked inside this same synchronous transaction. A source-policy change
during a trusted callback invalidates the transaction. Activation also checks
its own and Git catalog versions before commit. Revocation and expiry fail at
precommit. No ACK is returned before DomainStore commits.

Receipt fields are `schema_version`, `event_id`, `registration_id`, `registration_version`, `source_access_ref`,
`activation_epoch`, `accepted_at`, `event_digest`, `source_fingerprint`,
`idempotency_key` (the core scoped retry key), `cursor_status`, `catalog_ref`,
`mapping_ref`, `snapshot_ref` and `snapshot_authorization_ref` (last two nullable).
The stored cursor entry has the same first_event_digest as event_digest.
The source_access_ref pins the original registration or exact access revision
used for capture, avoiding inference from timestamps after later policy changes.

Only observed_at and delivery-attempt metadata may vary on a logical retry.
sourceEventFingerprint, eventIdempotencyKey and acceptSourceEvent enforce the
existing semantics. A retry returns the original receipt and first event/payload
pins without changing cursor, sources or outbox. Changed contents, identity,
sequence, ACL, sensitivity, or colliding retry/sequence positions reject.
Arrivals 0,2,1 retain the real accepted prefix/gap; sequence null remains unordered.
Neither admission nor handoff calls completeSourceEvent.

`getReceipt(context, {event_id})` returns the historical receipt or null.
`readEvent` returns `{raw,event,receipt}`; `readSnapshot` returns
`{text,digest,snapshot_id}` or null for reference-only intake. These reads are
available after Project/source disable if the principal retains both captured
and current source access. Broadening a live source ACL cannot broaden a prior
event's captured ACL. Historical read access does not authorize new work.
Raising the live source sensitivity above the captured classification also denies
materialization; the immutable event is never relabelled. Snapshot reads recheck
live source access and the opaque authority after retrieving bytes and before
returning them.

The 4096-entry core cursor and tighter DomainStore limits are explicit capacity
boundaries. There is no silent truncation, checkpoint, pruning, origin reset,
automatic epoch rotation, payload deletion or database migration. Until a future
audited retention/checkpoint protocol exists, authorized intake can reach a
capacity error and must stop that stream without inventing progress.

## One downstream consumer

`listPending(context, {limit:64})` returns at most 64 `{id,value}` intents, filtered
to the caller's current/captured access. Filtering occurs after the bounded store
read, so a caller can receive fewer than its limit. It is an inspection/composition
API for the service owner, not a paging scheduler. Each value has schema_version,
event_id, registration_id, activation_epoch and event_digest.

```js
const result = ingress.handoff(context, { event_id }, (tx, accepted) => {
  // accepted = {raw, event, receipt, snapshot}; deeply frozen.
  tx.compareAndSwap('policy-consumer', 'selected-inbox-key', null,
    { event_id: accepted.event.event_id, digest: accepted.receipt.event_digest });
});
```

The callback records the downstream consumer's durable effect using the same
transaction. It must be synchronous and contain no host, filesystem, network or
model work. The ingress then writes an immutable handoff receipt and ACKs its
outbox. Callback failure/Promise, authority changes, source version changes,
activation/Git changes or process loss before commit roll back all three.
Repeated successful handoff returns its first receipt without running the effect.
There is no public bare ACK which could discard an intent without consumer work.

The result is `{status:'handed_off'|'duplicate',receipt}`; this receipt contains
schema_version, event_id, event_digest, activation_epoch, handed_off_at and
`consumer:'ingress-policy'`. It means durable consumer ownership only.

Handoff uses the original activation epoch, current enrolled identity and source
access. Tightening source capture access can fence a pending old observation;
it cannot rewrite the captured event. Disable prevents pending intake from
starting work. Re-enable cannot relabel an old epoch, delete its intent, inspect
private sessions or auto-backfill gaps. Historical pending records stay visible;
future explicit selected recovery uses ProjectActivation's recovery protocol.

The still-draft ticket-runtime-policy-journal-v0 owns consumer leases, expiration,
retry/backoff/defer, poison isolation/dead-letter and audited operator replay.
This module implements none of those and adds no competing Worker scheduler.

## Failure and verification boundary

Methods throw bounded errors with `code` and `category`. `store_busy`,
`store_unavailable`, `store_closed`, and `consumer_failed` are
`retryable_failure`; no automatic retry happens. Invalid input/scope, source or
activation rejection, stale CAS, async callbacks and capacity errors have
category `rejected`. Errors never include supplied content. Successful durable
receipts are returned values, distinct from both failure categories. If a client
loses the response after commit, it retries the same observation or reads its
receipt; it cannot infer rollback from transport failure.

Conformance uses real temporary Git/SQLite with selected synthetic text, separate
writers and process death. It covers exact approved bytes across restart,
upstream redaction, rejected-content canaries, retries/conflicts/gaps, source and
Git fences, current materialization access, consumer rollback and duplicate
handoff. It exercises no live Judge, model, private trace, credential, Collector
or complete Policy service. The separately opt-in persisted JEV smoke is outside
these deterministic acceptance tests.
