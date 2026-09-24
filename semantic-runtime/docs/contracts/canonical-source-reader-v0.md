# Selected canonical Git records v0

`CanonicalSourceReader` explicitly reads a small configured set of existing
Git-native records and publishes one derived `canonical-selection` assertion in
the real local Graph. Git remains the source of record. There is no watcher,
model call, source write, automatic discovery, branch adoption or ingress ACK.

## Construction and explicit refresh

The trusted local process owner supplies the existing DomainStore and authority.
Include its ordinary Graph, ingress, source-invalidation, Git-enrollment and
activation namespaces. No reader namespace, table or new dependency is added.

```js
const reader = new CanonicalSourceReader({
  store, authority, repository_path: '/explicit/selected/worktree',
  execution: { repository_id, checkout_id, worktree_id }, registration_id,
  selection: {
    schema_profile: 'vibehub-records-v1', selection_id: 'selected-project-rules',
    policy_id: 'owner-authorized-v1', object_format: 'sha1',
    records: [{ key: 'decision', kind: 'context', id: 'api-choice',
      path: '.vibehub/rooms/api/decision.yaml' }],
  },
});
const publisher = graph.registerPublisherRun(context, { epoch, run_key });
const result = reader.refresh(context, {
  epoch, publisher_ref: publisher, expected_graph,
  previous_selection: null, commit_oid: fullLowercaseCommitOid,
  idempotency_key: 'explicit-observation-1',
  observation: { observed_at: '2026-09-22T12:00:00.000Z', sequence_start: 0 },
});
```

`publisher_ref` takes the actual registration result containing `publisher_ref`,
`session_id`, and `execution_id`; optional returned `epoch`/`status` are checked.
The Graph verifies its retained publisher and execution. These are Runtime
publication identities, not invented coding-host Sessions. The source must be
execution-bound to that selected Git tuple and producer principal, and map
`canonical_record` to `DOC_CHANGED`. The source's current ACL and sensitivity
supply capture policy. Record text cannot grant its own canonical authority.

An existing local-audience grant needs `store:read`, `graph:read`, `ingress:read`
and `source:invalidation:read` for typed reads and already committed retries.
New refresh additionally requires `store:write`, `graph:write`, `ingress:submit`,
`project:inspect`, `activation:read` and `activation:admit`, with a human/service
principal matching the registered producer. Setup independently uses the existing
`project:enroll`, `activation:write`, `ingress:register` and `graph:publish` APIs;
refresh does not enroll a repository, enable capture or manufacture a publisher.
All grants remain scoped to the selected tenant/project.

Configuration is copied, validated and frozen. Paths/record keys/typed IDs must
be unique. Records are ordered by key; observation sequence is `sequence_start`
plus that position, or null for every record when order is unknown. Observation
`observed_at` is also the stable occurred-at pin. Callers own stream continuity;
no maximum sequence or Graph commit implies completed processing.

New refresh requires current activation and authorized human/service publication,
producer access, actual enrollment, and the configured canonical allowlist.
The physical worktree `.git`/`commondir` linkage and retained directory identity
must match enrollment. Bounded nonblocking metadata-file reads reject symlinks,
non-regular files and oversized data. SHA-1/SHA-256 format is explicit and checked
against retained enrolled OID widths and actual raw object hashes. This does not
claim a filesystem sandbox against a privileged directory swap.

## Source format and binding meaning

The supported profile is UTF-8 **JSON object text**, including files named
`.yaml`. Ordinary YAML is explicitly unsupported. Runtime owns its parser and
validators; it imports no sibling plugin code or project-specific records.

The referenced public protocols are Context v1 (all public types), Room v1,
bound Ticket v3, and native-bound Evidence/Outcome v2. Duplicate JSON keys,
invalid UTF-8, nonfinite values, unknown fields and malformed identities fail
explicitly. Legacy/reconstructed acceptance bindings remain unsupported for
accepted-state use. The profile retains selected decision/constraint/authority
records and exact Acceptance/Contract identities, rather than inferring an
ontology or inventing acceptance.

Evidence and Outcomes bind exact selected Ticket revisions and evidence IDs.
Human-authority acceptance needs exactly bound human-origin Evidence and its
citation. Recorded origin/independence describes a checked-in claim; this reader
does not authenticate a person, rerun tests or certify an independent closeout.
An older valid Outcome is historical when the active Contract changes.

Authority artifact paths must resolve to available regular blobs at the same
commit. Existence checks read tree/blob metadata, not artifact content. Governing
scope/rules remain distinct from Room freshness: stale Room metadata does not
revoke a valid active Authority, and `stale:false` proves no fresh alignment.
Unsupported segment-anchor forms and unavailable bindings remain explicit.

## Immutable reads, one publication, and retries

Each refresh creates one hardened `GitProvenance` instance with a trusted object
directory derived from enrollment; source configuration is never loaded for this
path. Every selected commit/tree/blob hash is checked. Its trusted commit guard
checks prospective source-object access before raw reads and returned content,
including intermediate ancestry commits. A previously revoked ancestor may be
matched by its exact retained OID without reopening that ancestor's bytes.

All selected per-record observations pass through actual DurableIngress. Their
normalized events, captured source policies and exact payload digests become the
Graph assertion's `events` and `canonical_refs`. Missing paths use verified tree
absence plus a whole-commit payload (`path:null`, raw-commit digest). Deletion is
an explicit absent/tombstoned path projection, **never a tombstone of the old Git
commit**. Missing/corrupt objects are unavailable; absent is not inferred from a
failed read. Invalid/unsupported records cannot expose old text as current.

The one assertion contains a shallow `data.records` array, sibling evaluation
status/bindings, source/tree/blob proofs, configuration and request digests, the
project fence, and exact selected admitted-observation positions. Each entry's
`canonical_ref_index` points to the assertion's exact sorted `canonical_refs`, and
`source_proof_index` identifies its immutable Git proof. `projection_state` is
`present`, `absent`, or `unusable`; evaluator status explains authority/freshness. New Graph entities start `candidate`; verified canonical provenance
is a separate typed result. `coverage:null` preserves existing Graph coverage
rules. The bundle's source watermark makes no caught-up/completion claim, and
inherited inaccessible Graph coverage remains a legitimate rejection.

Receipt keys bind selection ID, operation key and record key; each event also
pins the entire normalized request/configuration digest and captured fence.
Already admitted events are read and checked before source retries. Changed key
reuse rejects. A failure may leave immutable ingress observations and pending
intents, while the semantic selection changes only through the single atomic
Graph mutation. No cursor completion or ACK occurs.

After verified reads and admission, the facade retains one small immutable
`canonical-reader-issuance` fact in the existing `working-graph` namespace. It
binds the exact normalized assertion digest, scope/generation/entity,
configuration/request, selected commit and fence. It contains no source text.
Current activation and the fence are rechecked inside that write transaction.
Typed reads and prior-selection proofs must match this fact, so generic Graph
JSON cannot impersonate reader-verified canonical data. A copied assertion may
be published by another authorized Graph caller, but cannot change its verified
content, source support or lineage. This fact proves a verified selected read,
not completed publication. Failed publication may leave an inert issuance fact;
only the single Graph mutation publishes a selection. As elsewhere in the local
Runtime, privileged coherent database tampering is outside this trust boundary.

The caller supplies `previous_selection` as the full previously returned immutable
SemanticRevision, or null for an independent initial selection. Its digest,
scope, generation and configuration are checked; only commit/configuration and
lineage are used. The Graph verifies actual base-revision membership. Old text
and old source events are not copied into the new bundle or supporting parents.
A same-selection update requires the same commit or a proven descendant. Rewind,
divergence and missing ancestry return `not_advanced`; a separate explicitly
configured selection can inspect that commit without adopting it elsewhere.

`expected_graph` remains the actual Graph CAS. A stale Graph returns
`graph_revision_mismatch`; a stale semantic base may produce a real Graph
conflict and is reported as `conflict`, not successful refresh. New mutations,
exact retries and reconciliation include the transaction-checked integer
`expected_source_fence`. Any fence change conservatively quarantines old reader
results, even when caused by an unrelated source.

An already committed exact retry can return its original receipt under current
permissions after Project disable or removal of the filesystem checkout, without
new Git reads. A stale fence cannot return that receipt as a current result.

## Exact reads and limits

`resolve(context,{at,address})` uses exact Graph addressing and returns `current`,
`historical`, `quarantined` or `unavailable`. Current means the selected Graph
revision, not filesystem or branch-tip freshness. Current source ACL still gates
historical materialization. The full authorized revision can be retained as the
next call's prior-selection integrity proof. Already retained structured content
survives source-object GC; unavailable raw Git bytes never fall forward to latest.

Selection limits are 16 records, 32 total record/artifact paths, 64 KiB per record,
256 KiB aggregate record bytes, 16 path components, 1 MiB per tree, 4 MiB aggregate
raw Git bytes, 128 subprocesses, 10 seconds per command and 30 seconds cumulative
Git I/O. Existing ingress/Graph depth, node, support and 1 MiB aggregate plan/row/
response limits remain unchanged; overhead may reject otherwise small inputs.
Capacity rejection retains the existing bounded layer error, such as
`canonical_capacity`, `graph_capacity`, `graph_plan_rejected` or the store
serialization bound `invalid_store_input`. No content is truncated; no failed
Graph/storage transaction publishes a partial selection. Successful refresh returns actual selected-read counts
and timings, not a service-wide performance guarantee.

The [local synthetic measurement](../measurements/canonical-reader-20260922.json)
read eight records with 38 Git commands, eight blobs and three trees, both before
and after adding 1,000 unrelated files. Refresh took 532–611 ms in these two
samples. Restarted exact retry took 84–88 ms with the checkout removed; the eight
ingress intents remained pending. Crash tests separately kill the process after
partial ingress and after Graph publication to verify these recovery boundaries.
