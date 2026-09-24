# Causal ordering and replay generations v0

This delivery provides executable, provider/host/store-independent contracts and
pure reference transitions through `src/index.mjs`. It consumes the accepted
[event contract](event-provenance-v0.md) and [Policy artifacts](policy-artifacts-v0.md).
It does not add an online store, event subscription, Git subprocess, worker,
model call, checkpoint implementation or distributed consensus. Existing Phase 0
replay and its stored audit format remain unchanged.

## Source order and receipt

A source sequence belongs to the exact tuple:

```
(tenant_id, project_id, source_installation_id, partition_id, producer_id, epoch)
```

`validateSourcePartition` validates `{partition, producer}`;
`sourcePartitionKey` produces a collision-safe versioned tuple key. Different
producers, epochs, Projects, installations or partitions never share continuity.
The adapter authenticates those claims and guarantees sequences identify positions
in one producer incarnation. Epoch creation is not inferred from a time or branch.

`createSourceCursor({...source, start_sequence})` requires an explicit,
adapter-attested epoch origin. Normally this is `0`. A different origin means the
producer sequence actually starts there; callers must not use it to hide missing
history or pretend a replay checkpoint exists. The first arrival never selects it.

`acceptSourceEvent(cursor, normalizedEvent)` returns `{status, state}`. Its compact
ledger carries exact scoped event references, source fingerprints, the first
normalized-event digest, retry keys, causal parents and completion markers.
The bounded reference state holds at most 4,096 observations and rejects overflow;
durable storage and authenticated checkpoint/retention belong to later Tickets.
It must not be used as an unbounded production ledger.

| Field | Meaning |
| --- | --- |
| `maximum_sequence` | Largest accepted sequenced position; never evidence that earlier positions arrived. |
| `accepted_through` | Continuous accepted prefix from the attested start; `null` until its first position arrives. |
| `completed_through` | Continuous prefix whose semantic projections have separately completed. |
| `gaps` | Compact inclusive missing-position ranges through the current maximum. |
| `unordered_count` | Accepted observations whose producer sequence is `null`. |

For arrival order `0, 2, 1`, accepted progress is `0, 0, 2`; maximum progress is
`0, 2, 2`. Position `1` is accepted as `late`, fills the hole and does not replace
position `2`. Duplicate deliveries never move progress or replace the first event
pin. Sequence `0` is valid. A `null` sequence is retained as `unordered` and cannot
prove continuity. Huge holes remain ranges; no function iterates every integer.
All positions must be safe, nonnegative JavaScript integers, including the maximum.

`occurred_at` and `observed_at` remain provenance. Neither grants order, fills a
hole, selects a winner nor creates a total order across repositories.

## Duplicate identity and changed source contents

A duplicate can match an existing scoped event identity, producer position, or
scoped retry key. All such matches must identify the same ledger entry and the
same `sourceEventFingerprint`; otherwise acceptance rejects the observation.
One raw observation still produces exactly one normalized event. No split-event
interpretation is introduced.

The fingerprint binds asserted raw partition/identity, resolved identity, logical
observation/native/retry IDs, producer position, occurrence time, original and
normalized event types, payload identity/digest, causal parents, source objects,
delivery channel, ACL revisions/allowlists, sensitivity and effective access.
Set-like parent, source and principal lists are normalized for hashing.

It excludes only receipt time, delivery-attempt ID, normalization implementation/
catalog/mapping pins, and replay-authorization metadata. These latter inputs are
pinned separately in the *full* normalized event used by replay. A harmless retry
therefore need not conflict because `raw_event_digest` includes receipt metadata.
Changed payload, event identity, effective or asserted source identity, taxonomy,
ACL or sensitivity is a conflict; it must become a new valid source observation,
not overwrite an earlier position. A normalization upgrade that changes resolved
meaning also cannot silently replace accepted state.

The cursor preserves `first_event_digest`, not the event body. The storage adapter
must preserve the immutable normalized event associated with that digest; retry
acceptance is not permission to replace it. A replay manifest includes the body
and full digest, including receipt metadata.

## Causal completion

`completeSourceEvent(cursor, {event_id, completed_parents})` is a caller attestation
that this event's projection committed, independent of receipt. The caller must
supply the exact `{tenant_id, project_id, event_id}` parent set; unscoped strings
or a parent from another Project cannot satisfy it. If a parent is present in this
cursor, it must already be completed. Cross-partition completion requires the
adapter to verify parent projection facts from the corresponding partition.
A parent first admitted locally after such an attestation retains its own pending
completion marker; late admission neither invalidates the completed child nor
fabricates local parent completion. The adapter can then record the parent
projection explicitly, allowing the completed prefix to advance.

Known local cycles and causal parents at equal/later sequenced positions are
rejected. Partial cross-partition information is not converted into an inferred
timestamp order. Cursor validation checks known consistency; it cannot authenticate
external attestations or prove a database transaction committed. A durable adapter
must atomically couple completion to actual projection, rather than ACK receipt
and call this transition early.

## Project and Context freshness vectors

`projectFreshness({scope, requirements, cursors})` computes a serializable snapshot.
Each requirement is `{source, target_sequence}` and represents an explicitly
captured source head for that Project/Context view. Requirements enumerate every
source the view intends to cover. The function never substitutes the largest
locally observed position for a captured head. An empty requirement set is unknown.

Each watermark carries the source tuple, captured target, epoch start, maximum,
accepted and completed prefixes, unsequenced count, input/projection gap ranges,
status and reason. `validateFreshnessVector` lets Graph/Context contracts reuse the
same strict representation. It checks scope, unique source tuples, prefix bounds,
compact gap ordering, source/projection relationships and aggregate status.
Known cursor facts must be internally consistent even without a captured head:
a maximum at the first missing position necessarily extends the accepted prefix.
Unaccepted positions must also be missing from projection; the unobserved tail
cannot be reported present, and the known maximum cannot be reported missing.
These checks establish internal consistency, not authenticity of source facts.

| State | Interpretation |
| --- | --- |
| `unknown` | Source missing, head not captured, target outside the attested epoch, or unsequenced observations prevent continuity claims. |
| `known-gap` | Captured head is known, but accepted input or completed projection has not reached it. |
| `caught-up` | Every required sequenced position through the captured head is accepted and projected. |

Project status is unknown if any member is unknown, otherwise known-gap if any
member has a gap, otherwise caught-up. Individual entries always remain visible;
an aggregate never hides a different repository's lag. Caught-up is relative to
the captured heads, not a promise that remote sources have not advanced since.
Freshness says what a projection has consumed; it does not make its claims true
or canonical. A Context can retain the vector of its exact input snapshot.

## Git immutable DAG and mutable refs

`classifyGitRefMovement({ref, before, after, commits, reported_operation})` accepts
a full ref identity `{tenant_id, repository_id, object_format, name}` and exact
commit identities from `sourceObjectKey`. Commits retain the tuple
`(tenant, repository, object_format, full lowercase OID)` across observations.
Same OID in a fork, another tenant or another object format is not the same object.

DAG records are `{commit, parents, parents_complete}`. Missing records or incomplete
ancestry yield `unknown` unless the supplied path already proves ancestry.
Duplicates, self-parents and cycles fail. A full-root traversal can prove `no`;
a missing/shallow ancestor cannot. Commit clocks are not accepted as evidence.

The returned movement is `create`, `advance`, `rewind`, `delete`, `unchanged`,
`diverge` or `unknown`. `reported_operation` carries the source's `update`,
`force_push` or `rebase` assertion independently of ancestry. A forced update can
still be an advance; a diverging DAG does not identify which command caused it.
A rebase creates different immutable commits; this contract preserves old commits
and the ref movement instead of rewriting their identities. Actual ref reads,
shallow-object retrieval, races and source authentication belong to the Git adapter.

## Replay pinning and effect isolation

`createReplayManifest` accepts:

- `replay_id`, Project `scope`, and `input_graph` with exact `generation_id` plus
  `snapshot_digest`; `validateGraphGenerationPin` exports this reusable pin shape.
- A distinct `output_generation_id` for replay output.
- An ordered list of exact, validated normalized `events`, each replay-eligible.
  Observation/retry/producer-position duplicates fail instead of splitting input.
- A compiled `policy` artifact. The constructor recompiles its definition and
  operation descriptors, verifies the whole artifact, and retains content and
  executable hashes, operation implementations and compiler identity.
- `models` descriptors containing `model_id`, `provider`, `model`, `model_revision`,
  `adapter_id`, `adapter_version` and `parameters_digest`; `model_bindings` maps
  every JudgeNode ID to one of those descriptors. No missing/extra node bindings.

The frozen manifest retains event bodies, full event/payload digests, policy and
model descriptors, bindings, graph pins and a digest of the entire manifest.
`validateReplayManifest` rederives these pins; mutated event metadata, descriptors,
model routing, generation or digest fails. Policy or model comparisons use
separate manifests. Input array order is an explicit replay schedule, not a
claimed global causal order. A model alias is only the descriptor supplied at
capture: pinning it does not make a future live provider deterministic.

The caller retrieves authorized immutable payload/graph snapshots and verifies
actual bytes against their digests before execution (`verifyEventPayload` verifies
event payloads). A hash is a content binding, not source authentication, current
access permission or proof that remote bytes remain available. This API does not
retrieve bytes or turn replay eligibility into permission for a live model call.

`assertReplayEffect` admits only `replay_derived_write` and `replay_audit_append`.
Every intent contains `record_id`, `replay_id`, `manifest_digest`, `scope`,
`generation_id` and JSON `data`. All four replay/scope/generation pins must match.
Live graph mutation, source/connector cursor advance, jobs, callbacks, canonical
writes and provider calls are rejected by default. Worker decisions may be
recorded as replay data, but cannot dispatch a real worker job.

`createReplayState` and `applyReplayEffect` provide an executable reference
boundary: they apply accepted intents only to a new frozen replay-generation
record set, accept no live handles/callbacks, preserve inputs, and reject conflicting
record IDs or imported state from another generation. Production adapters must
invoke equivalent admission before dispatch and fence the storage namespace; this
pure contract is not an operating-system sandbox for arbitrary third-party code.

Run the synthetic conformance and public integration checks with:

```sh
node --test test/sources/causal-ordering.test.mjs test/sources/causal-integration.test.mjs
npm run check:boundaries
```
