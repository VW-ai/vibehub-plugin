# Local source invalidation v0

The local source-invalidation domain makes a source tombstone or access change
effective before a Semantic Working Graph revision, downstream ACK, or background
recomputation exists. It is a fixed companion to `DurableIngress` in the same
DomainStore transaction. It does not run a connector, scheduler, cache, index,
compiler, or recomputation worker.

Every Runtime composition that constructs DurableIngress or LocalGraphStore must
include the `source-invalidation` namespace explicitly. Omitting it fails closed,
including for ordinary events with no source-object provenance. This version uses
the existing DomainStore schema and adds no database migration or second store.

## Authority and commands

DurableIngress remains the only public mutation facade. It exposes three source
lifecycle commands:

```js
ingress.submitSourceLifecycle(context, {
  registration_id, epoch, event, expectedVersion,
  access_state: 'active' | 'unknown' | 'tombstoned',
  access: null | completeRegistrationAccess,
});

ingress.applyAdmittedSourceLifecycle(context, {
  registration_id, event_id, expectedVersion, idempotency_key,
  access_state: 'active' | 'unknown' | 'tombstoned',
  access: null | completeRegistrationAccess,
  activation_epoch: null | currentEpoch,
});

ingress.applyAdministrativeInvalidation(context, {
  registration_id, expectedVersion, idempotency_key,
  reason: 'repository_removed' | 'installation_revoked'
    | 'visibility_changed' | 'author_access_redacted',
  access: completeRegistrationAccess,
});
```

`submitSourceLifecycle` requires the registered producer plus
`source:invalidation:capture`. It accepts only an immutable `object_revision` or
`git_revision` payload and a normalized `SOURCE_ACCESS_CHANGED` or
`SOURCE_TOMBSTONE` mapping. There is no snapshot-text field. The command uses
ProjectActivation capture admission and atomically admits the event, advances its
causal cursor, creates the ordinary outbox item, and applies the invalidation.
It may pass a currently restrictive source/object policy only for this metadata
envelope; ordinary content remains denied.

`applyAdmittedSourceLifecycle` requires `source:invalidate` and human/service
authority. It selects one exact already-admitted immutable event from private
ingress storage and never rereads snapshot bytes or a provider body. Unknown and
tombstoned restrictions can apply while Project capture is disabled. Active
reopening requires a current activation epoch and result-stage admission. Its
actor, registration, idempotency key, event, and request digest are bound in the
same transaction. Exact retry returns the original result; changed reuse rejects.

`applyAdministrativeInvalidation` emits no event or Graph observation.
Repository removal and installation revocation require exactly:

```js
{ enabled: false, allowed_principal_ids: [],
  sensitivity: 'restricted', allow_snapshots: false }
```

Visibility and author redaction must preserve every no-broadening dimension:
principals form a subset, sensitivity never decreases, and neither capture nor
snapshot permission changes from false to true. At least one historical-read
dimension, principal membership or sensitivity, must become stricter. Setting
`enabled:false` by itself controls future capture and does not revoke historical
reads. Existing `updateSourceAccess` keeps its request/result API and emits a
`direct_access_update` fence notice in the same transaction.

## Stream guards and object summaries

The authoritative order key is `sourcePartitionKey` over partition, producer,
and producer epoch. The domain stores one row per source object and authoritative
stream. Sequence integers are compared only inside that exact tuple. A guard also
pins its registration, object, event digest, state, sequence, and notice sequence;
a mismatched retained tuple is corruption.

An `unknown` guard contributes one blocker. `active` contributes zero. A
`tombstoned` transition sets the object's irreversible tombstone bit. A strictly
newer, non-null active sequence can replace an unknown guard from the same stream.
It cannot clear another stream's blocker. A null sequence is permanently
incomparable, cross-stream integers are never compared, and no active input can
clear a tombstone. Equal changed input conflicts; lower input is superseded.

Each object has an O(1) summary with `blocking_stream_count` and `tombstoned`.
The count is adjusted atomically from the replaced guard contribution and must
remain a safe nonnegative integer. The service never scans all retained guards to
materialize an event. A fixed immutable object-origin marker distinguishes first
admission from a missing summary: deleting a known summary fails closed instead
of recreating an unblocked value.

Lifecycle events contain at most 32 distinct source objects. Restrictive changes
may report a mix of applied and superseded targets. Registration broadening from
an active event is refused unless every target transition applied and every
resulting object summary is unblocked and not tombstoned.

## Immediate read and handoff fences

Ordinary submit, event, receipt, snapshot, cursor expansion, pending inspection,
and handoff consult current registration policy and each source-object summary.
One blocked support denies the full result. Pending inspection filters denied
items while leaving unrelated objects usable. It never returns a partial event or
a filtered cursor.

Handoff checks guards before the trusted callback and again after it, before the
consumer effect is ACKed. A guard written by synchronous trusted composition in
that transaction therefore rolls back the effect, receipt, and ACK. These checks
are independent of Project enablement: disabling capture does not make an already
authorized historical read disappear, while administrative deny-all does.

The project fence is a monotonic safe integer. Its DomainStore record version
equals the fence sequence, and a retained first notice with no head is corruption.
These bounded checks prevent a missing or rewound head from being treated as
sequence zero.

## Feed and selected Graph metadata

`SourceInvalidationFeed({store, authority})` exposes only:

- `head(context)` for the scoped current fence;
- `page(context, {after, limit})` for 1 to 64 immutable notices;
- `assertFence(context, {sequence})` for an exact current-fence check;
- `readLifecycleEvent(context, {invalidation_id})` for one selected lifecycle
  metadata record.

Notice IDs use fixed-width sequence keys and DomainStore indexed range reads,
without OFFSET or a full scan. The existing 1 MiB complete-response cap remains
the outer bound. The feed has no consumer registry, checkpoint, ACK, or claim that
a downstream projection has refreshed.

`sourceLifecycleInvalidationId(scope, event_id)` derives the exact lifecycle
record address. The selected read requires service/worker authority plus
`source:invalidation:read` and `source:invalidation:consume`. It returns normalized
security metadata, receipt/digest, captured access, state, and notice reference.
It omits the raw envelope, request digest, target planning detail, snapshot bytes,
and provider credentials.

LocalGraphStore can use this selected read only while authorizing a
`source_access` mutation. It still checks graph lifecycle authority, the captured
ACL, exact target, digest, stream, and sequence. Ordinary assertions, queries,
resolution, receipts, feed pages, and ingress reads cannot use it. A tombstone for
an object absent from Graph remains a durable ingress guard and notice; it never
manufactures a Graph observation.

Later canonical readers, compilers, caches, and indexes must pin the fence before
building and recheck it before serving. A mismatch quarantines their result until
their own Ticket defines replay or recomputation. This module only supplies the
bounded local security substrate.

## Failure and verification boundaries

Public inputs reject accessors, Proxies, cycles, excessive depth/nodes, and
oversized data before copying. Failures expose bounded codes rather than thrown
payloads or error getters. Missing namespaces, summaries, inconsistent stream
tuples, unsafe counters, corrupt receipts, and missing or rewound fence heads all
fail closed.

The focused test suites use synthetic temporary SQLite stores. They cover stream
ordering, null order, cross-stream blockers, irreversible tombstones, partial
multi-target behavior, 32/33-target bounds, 64-item pages, stale fences, current
and captured ACLs, missing namespaces, summary/head/guard/count corruption,
historical command identity, callback-time guard changes, restart, concurrent
retries/version races, and SIGKILL before and after commit. Graph tests cover the
narrow lifecycle-metadata selection and tombstone-before-content behavior. No
network, model, repository content, connector secret, or user trace is used.
