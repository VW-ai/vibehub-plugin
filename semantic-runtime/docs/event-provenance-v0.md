# Event and provenance contract v0

Wire version: `schema_version: 1`; normalizer implementation version: `1`.
The public exports in `src/index.mjs` implement strict, pure contracts for RawEvent,
NormalizedEvent and observation/source-object correlation. They consume the
[identity catalog](identity-contract-v0.md). The existing Phase 0 replay format and
`normalizeEvent` API are unchanged.

This slice covers Tech Design §§6, 8.1–8.2, 11, 20–21. It performs no source reads,
network requests, model calls, persistence, authentication, causal scheduling,
canonical writes or semantic inference. Gateway and adapter implementations must
supply authenticated identities and verified source/storage facts. Shape validation
cannot establish that a producer or a supplied authorization is trustworthy.

## Raw observation envelope

`validateRawEvent(event)` returns `true` or throws a bounded `TypeError` that does
not echo values. All listed fields are required; unknown fields/versions are errors.
JSON must be acyclic and bounded; executable accessors, sparse arrays, non-finite
numbers, unsupported prototypes and non-JSON values are rejected. Metadata arrays
are limited to 128 items; IDs use the identity contract's opaque, case-sensitive
200-character grammar. There is no freeform metadata bag for inferred assertions.

| Field | Meaning |
| --- | --- |
| `schema_version`, `kind` | `1`, `raw_event` |
| `event_id` | Tenant-unique logical observation ID, retained on delivery retry |
| `partition` | `{tenant_id, project_id, source_installation_id, partition_id}`; Project alone may be `null` before exact resolution |
| `source_native_event_id` | Source event ID, or explicit `null` when absent; preserved without substituting object ID |
| `idempotency_key` | Producer's stable key for retrying this observation |
| `source_event_type` | Exact adapter-native event code; mapped mechanically to the normalized taxonomy |
| `occurred_at` | Reported occurrence time, or `null` if unknown |
| `observed_at` | Recorded observation time; required |
| `producer` | `{producer_id, epoch, sequence}`; sequence is a nonnegative safe integer or explicit `null` |
| `causal_parents` | Array of `{tenant_id, project_id, event_id}` references, same tenant and resolved Project; no self/duplicate parent |
| `identity` | Optional registered IDs: workspace, repository, membership, checkout, worktree, session, execution; scope and source come from partition |
| `payload` | Exactly one of the four reference kinds below; raw content is not embedded |
| `provenance` | `{delivery: {channel, delivery_id}, source_objects: [{object, acl, sensitivity}]}` |
| `acl` | `{revision, allowed_principal_ids}` from the captured delivery source |
| `sensitivity` | `normal`, `sensitive` or `restricted`, in increasing order |

Times use canonical millisecond UTC (`2026-09-21T10:00:00.000Z`). The adapter must
convert a source timezone representation mechanically before constructing this
wire envelope. Clock skew is allowed: occurrence may follow observation. Neither
time implies causal ordering or fills a missing producer sequence.

`partition_id` identifies a stable stream within one installation. Multiple streams
must use distinct IDs even when they share a repository or session. `producer.epoch`
is an explicit incarnation identifier; sequence reset requires a new epoch.
Allocation, retention, epoch continuity and duplicate conflicts belong to the
causal/ingress protocols. This validator checks one envelope, not absent history.

Delivery channel is one of `local_git`, `fetch`, `push`, `pull_request`, `host`,
`webhook`, `poll`, `backfill`, `human`, `system`. It describes observation transport,
not truth authority. Even `HUMAN_DECISION` or `OUTCOME_CREATED` taxonomy indicates
what was observed; it does not validate a decision or accept an Outcome.

## Source objects and access

A source object is either:

```js
{ kind: 'git_commit', tenant_id: 'acme', repository_id: 'api',
  object_format: 'sha1', oid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
{ kind: 'source_object', tenant_id: 'acme', provider: 'git-host',
  authority: 'git.example', object_id: 'document-1' }
```

Git object format is `sha1` or `sha256`, with exactly 40 or 64 lowercase hexadecimal
characters. Abbreviations, branches and mutable names cannot serve as Git pins.
The external source tuple uses an enrolled provider and authority plus its durable
object ID. The normalizer requires that authority to match the source installation.
A Git object's repository must have a Project membership mapped to this installation.
Cross-tenant objects, duplicate support objects and unbound payload objects fail.

`sourceObjectKey(object)` emits a collision-free JSON tuple. It includes tenant and
repository (Git), or tenant/provider/authority/object ID (external); it excludes
Project, clone, delivery and ACL. The same commit can therefore receive local,
fetch, push and PR observations without collapsing their provenance. A fork's
repository identity remains distinct even when its commit bytes match upstream.
External object revision is a payload pin, separate from durable object identity.

Every supporting source retains its ACL revision and sensitivity. The ACL's
principal IDs are interpreted within the envelope tenant; this contract has no
wildcard or implicit public principal. `effectiveEventAccess(event)` returns the
intersection of **all** support allowlists and the delivery allowlist, with their
maximum sensitivity. Empty intersection means deny-all. Source links and ACL
revisions remain intact so later invalidation can recheck them. Captured ACLs are
historical evidence, not a substitute for checking current authorization before
retrieval, replay or delivery. This protocol does not implement those checks.

## Payload pins and replay classification

| `payload.kind` | Required additional fields | Mechanical replay classification |
| --- | --- | --- |
| `git_revision` | `object` (Git commit), `path` (relative path or `null` for the commit payload), `digest` | Eligible immutable revision |
| `object_revision` | `object` (external object), `revision_id`, `digest` | Eligible source-native immutable revision |
| `snapshot` | `snapshot_id`, `digest` | Eligible only with separately supplied, matching authorization |
| `mutable_pointer` | `pointer_id`, `digest` (or explicit `null`) | Always non-replayable until an authorized immutable snapshot is captured |

A digest is `sha256:` followed by 64 lowercase hex characters, over the exact
payload bytes. Git OID identifies the source revision; it does not replace the
payload digest. Relative artifact paths reject parent/dot segments, absolute
paths, backslashes, control characters and empty segments. Actual path confinement,
symlinks, source deletion and immutable object availability must be enforced by
the later source/materialization adapters.

An adapter may emit `object_revision` only if the source guarantees that the
provided native revision token resolves immutable bytes. A mutable URL, branch,
ETag without such a guarantee, or an alias such as “latest” must use
`mutable_pointer`, even if a digest was once observed. The pure validator cannot
inspect the provider to establish a token's immutability. Replay must retrieve the
exact pin, reject unavailable or changed bytes, and never fall back to current.

`verifyEventPayload(payload, Uint8Array)` verifies the supplied bytes against the
digest and throws on mismatch or missing digest. Retrieval is separately authorized
and happens outside this function. Verifying bytes for a mutable pointer does not
make the reference replayable or persist them.

Snapshot authorization is a separately trusted adapter input, never an `authorized`
flag supplied inside the raw event. Each attestation contains exactly:

```js
{
  schema_version: 1, authorization_id: 'grant-1',
  partition: { tenant_id: 'acme', project_id: 'product',
    source_installation_id: 'laptop', partition_id: 'git-api-events' },
  snapshot_id: 'snapshot-1', digest: 'sha256:<64 lowercase hex characters>',
  authorized_at: '2026-09-21T10:00:00.000Z',
  purpose: 'runtime_replay', storage: 'immutable',
  allowed_principal_ids: ['alice'], sensitivity: 'sensitive'
}
```

The attestation pins the exact resolved partition, snapshot and bytes. Its principal
set and sensitivity must **equal** the source-derived effective access; either
broader or narrower mismatches fail closed. To use a narrower storage grant, the
adapter first narrows the captured envelope ACL so the exposed event and stored
payload have one consistent access boundary. An explicitly matching deny-all grant
is valid and remains deny-all. Duplicate matching attestations are an error.
Missing or differently scoped grants produce `snapshot_authorization_missing` and
`eligible: false`. Storage persistence, immutability enforcement, authority to
capture, retention and current access are external obligations, not proven by
including this structure.

## Mechanical normalization and provenance pins

```js
const result = normalizeRawEvent(raw, {
  catalog, // explicit authenticated/retained identity snapshot
  mapping: {
    schema_version: 1, mapping_id: 'git-adapter', revision: 'mapping-1',
    event_types: { 'git.commit.created': 'GIT_COMMIT' },
  },
  snapshot_authorizations: [], // optional, separately trusted attestations
});
```

Successful `status: 'normalized'` returns an `event` and the identity resolver's
result. Unknown or contradictory identity returns `unmapped` or `ambiguous`, with
`event: null`; no preferred Project is guessed. Missing source-type mapping returns
`unmapped / unknown_event_type`. A declared Project/source/identity cannot silently
change. A missing Project may be enriched only through exact registered mapping.

V1 is strictly **one raw observation → one normalized event**, retaining event ID,
producer position and causal parents. It does not split events. Future split
support needs a new explicit contract for child identities and watermark completion.
The mapping is exact and limited to `EVENT_TYPES`, the Tech Design taxonomy plus
source tombstone, source-access-change and Git-ref-change codes. Unknown properties,
semantic truth/durability/relevance flags and invented taxonomy values are rejected.

A normalized envelope has `kind: 'normalized_event'`, resolved Project/identity,
`event_type`, `effective_access`, `replay`, and a `normalization` record. The latter
contains the original partition and identity, raw envelope digest, exact catalog
digest, full mapping plus digest, and normalizer version. All other raw fields are
preserved. Digests hash compact UTF-8 JSON with recursively sorted object keys and
preserved array order; timestamps and source order are never invented. Inputs are
not mutated, and output order is deterministic for identical inputs. The digest
pins the supplied catalog snapshot, including its array order, rather than a
current catalog looked up later.

`validateNormalizedEvent(event)` checks carried schema, raw/mapping pins, access
intersection, asserted identity preservation and replay classification. It cannot
prove an enriched identity without its catalog, authenticate an attestation, or
prevent an attacker from recomputing arbitrary hashes. Trusted ingestion/storage
must retain provenance and catalog/mapping revisions. Unknown wire/normalizer
versions are rejected; migrations must be explicit and preserve prior inputs.

## Observation and retry identity

`eventObservationKey(event)` is the versioned tuple of tenant and event ID.
The caller allocates a different event ID for an independent observation, including
a separate local/fetch/push/PR occurrence of the same object. A delivery retry of
that observation retains the event ID and idempotency key.

`eventIdempotencyKey(event)` includes tenant, captured Project, installation, stream,
producer, epoch and producer key. It excludes receipt time, attempt delivery ID,
payload and source-object ID. For normalized events it uses the captured raw
partition, so enrichment from an unknown Project does not change the key. Unknown
scope still requires explicit resolution before semantic processing. Native IDs,
sequence and payload digests remain available for the ingress/causal owner to
check consistency; this module neither deduplicates nor accepts conflicting writes.

The raw envelope digest includes receipt metadata as well as payload. Different
receipt time or delivery attempt therefore changes that digest; this difference
alone is not proof of a conflicting payload. Same retry identity with different
payload digest remains detectable. The durable ingress protocol owns the precise
logical observation comparison and rejection behavior.

## Verification

Synthetic fixtures in `test/fixtures/event-provenance/` use the accepted identity
fixture, not real project traces. Contract and public-entry tests cover malformed
schemas, tenant/project/source contradictions, immutable pins, receipt retries,
four observations of one commit, deny-all propagation, snapshot authorization,
mutable pointers, payload tampering, deterministic output and nonmutation.

```sh
node --test test/sources/event-provenance.test.mjs test/sources/event-integration.test.mjs
npm run check:boundaries
```

These checks establish protocol behavior only. Online ingress, storage durability,
current ACL enforcement, causal ordering and actual replay retention remain later
Tickets.
