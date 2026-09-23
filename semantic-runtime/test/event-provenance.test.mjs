import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EVENT_CONTRACT_VERSION, EVENT_TYPES, validateRawEvent, validateNormalizedEvent,
  normalizeRawEvent, sourceObjectKey, eventObservationKey, eventIdempotencyKey,
  effectiveEventAccess, verifyEventPayload,
} from '../src/domain/sources/event-provenance.mjs';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const fresh = () => fixture('event-provenance/git-observation.json');
const options = () => ({ catalog: fixture('identity/multi-source.json'), mapping: fixture('event-provenance/mapping.json') });
const normalized = raw => normalizeRawEvent(raw ?? fresh(), options()).event;
const clone = value => structuredClone(value);
function snapshot() {
  const raw = fresh(); raw.payload = { kind: 'snapshot', snapshot_id: 'snapshot-1', digest: raw.payload.digest };
  const opts = options(); opts.snapshot_authorizations = [{ schema_version: 1, authorization_id: 'grant-1',
    partition: clone(raw.partition), snapshot_id: raw.payload.snapshot_id, digest: raw.payload.digest,
    authorized_at: '2026-09-21T10:00:00.000Z', purpose: 'runtime_replay', storage: 'immutable',
    allowed_principal_ids: ['alice'], sensitivity: 'sensitive' }];
  return { raw, opts };
}

test('raw and normalized versioned envelopes carry all explicit delivery, causal and access metadata', () => {
  const raw = fresh(); assert.equal(EVENT_CONTRACT_VERSION, 1); assert.ok(Object.isFrozen(EVENT_TYPES));
  assert.equal(validateRawEvent(raw), true);
  const result = normalizeRawEvent(raw, options());
  assert.equal(result.status, 'normalized'); assert.equal(result.identity_resolution.status, 'resolved');
  const event = result.event; assert.equal(validateNormalizedEvent(event), true);
  assert.equal(event.event_id, raw.event_id); assert.equal(event.event_type, 'GIT_COMMIT');
  for (const field of ['source_native_event_id', 'idempotency_key', 'occurred_at', 'observed_at', 'producer', 'causal_parents', 'payload', 'provenance']) {
    assert.deepEqual(event[field], raw[field]);
  }
  assert.equal(event.identity.repository_id, 'api'); assert.equal(event.identity.workspace_id, 'engineering');
  assert.equal(event.normalization.raw_event_digest.length, 71);
  assert.equal(event.normalization.catalog_digest.length, 71);
  assert.equal(event.normalization.mapping_digest.length, 71);
});

test('every required raw field is enforced; versions and unknown fields fail closed', () => {
  for (const field of Object.keys(fresh())) {
    const raw = fresh(); delete raw[field]; assert.throws(() => validateRawEvent(raw), TypeError, field);
  }
  for (const raw of [{ ...fresh(), schema_version: 2 }, { ...fresh(), canonical: true },
    { ...fresh(), provenance: { ...fresh().provenance, truth: true } }]) assert.throws(() => validateRawEvent(raw), TypeError);
  assert.throws(() => validateRawEvent(normalized()), /unsupported event schema|unknown field/);
});

test('normalization is deterministic and nonmutating with explicit immutable mapping/catalog pins', () => {
  const raw = fresh(); const opts = options(); const before = JSON.stringify({ raw, opts });
  const left = normalizeRawEvent(raw, opts); const right = normalizeRawEvent(clone(raw), clone(opts));
  assert.deepEqual(left, right); assert.equal(JSON.stringify({ raw, opts }), before);
  assert.equal(JSON.stringify(left), JSON.stringify(right));
  const newOptions = options(); newOptions.mapping.revision = 'mapping-2';
  assert.notEqual(normalizeRawEvent(raw, newOptions).event.normalization.mapping_digest, left.event.normalization.mapping_digest);
  left.event.provenance.delivery.delivery_id = 'changed-output'; assert.equal(raw.provenance.delivery.delivery_id, 'local-delivery-1');
});

test('mechanical taxonomy cannot produce semantic truth, durability, confidence or canonical status', () => {
  for (const field of ['truth', 'canonical', 'durable', 'relevant', 'confidence']) {
    const raw = fresh(); raw[field] = true; assert.throws(() => normalizeRawEvent(raw, options()), /unknown field/);
  }
  const opts = options(); opts.mapping.event_types['git.commit.created'] = 'CANONICAL';
  assert.throws(() => normalizeRawEvent(fresh(), opts), /taxonomy/);
  const unknown = fresh(); unknown.source_event_type = 'source.unknown';
  assert.deepEqual({ ...normalizeRawEvent(unknown, options()), identity_resolution: undefined },
    { status: 'unmapped', reason: 'unknown_event_type', event: null, identity_resolution: undefined });
  unknown.source_event_type = 'toString'; assert.equal(normalizeRawEvent(unknown, options()).reason, 'unknown_event_type');
});

test('nullable project is enriched only from registered identity; explicit partitions never remap', () => {
  const raw = fresh(); raw.partition.project_id = null;
  const event = normalized(raw); assert.equal(event.partition.project_id, 'product');
  assert.equal(event.normalization.raw_partition.project_id, null);
  assert.equal(eventIdempotencyKey(event), eventIdempotencyKey(raw));
  raw.partition.project_id = 'shared';
  assert.equal(normalizeRawEvent(raw, options()).event, null);
  raw.partition.project_id = 'product'; raw.partition.source_installation_id = 'connector';
  assert.equal(normalizeRawEvent(raw, options()).status, 'ambiguous');
});

test('ambiguous and missing source/project mappings remain explicit without a normalized event', () => {
  const raw = fresh(); raw.partition.project_id = null; raw.partition.source_installation_id = 'connector'; raw.identity = {};
  const ambiguous = normalizeRawEvent(raw, options()); assert.equal(ambiguous.status, 'ambiguous'); assert.equal(ambiguous.event, null);
  raw.partition.source_installation_id = 'not-enrolled';
  assert.equal(normalizeRawEvent(raw, options()).status, 'unmapped');
  raw.partition.source_installation_id = 'laptop'; raw.identity = { worktree_id: 'removed' };
  assert.equal(normalizeRawEvent(raw, options()).reason, 'unknown_identity');
});

test('four delivery observations correlate to one immutable commit without merging provenance or replay identity', () => {
  const events = ['local_git', 'fetch', 'push', 'pull_request'].map((channel, i) => {
    const raw = fresh(); raw.event_id = `observation-${i}`; raw.idempotency_key = `observation-retry-${i}`;
    raw.provenance.delivery = { channel, delivery_id: `delivery-${i}` }; raw.producer.sequence = i;
    if (i === 3) { raw.partition.source_installation_id = 'connector'; raw.identity = { repository_id: 'api' }; }
    return normalized(raw);
  });
  assert.equal(new Set(events.map(event => sourceObjectKey(event.payload.object))).size, 1);
  assert.equal(new Set(events.map(eventObservationKey)).size, 4);
  assert.equal(new Set(events.map(eventIdempotencyKey)).size, 4);
  assert.deepEqual(events.map(event => event.provenance.delivery.channel), ['local_git', 'fetch', 'push', 'pull_request']);
});

test('delivery retries preserve idempotency independently of observations and expose changed-byte fingerprints', () => {
  const original = fresh(); const retry = fresh(); retry.observed_at = '2026-09-22T10:00:01.000Z';
  retry.provenance.delivery.delivery_id = 'second-attempt';
  assert.equal(eventIdempotencyKey(original), eventIdempotencyKey(retry));
  assert.equal(eventObservationKey(original), eventObservationKey(retry));
  retry.payload.digest = `sha256:${'b'.repeat(64)}`;
  assert.equal(eventIdempotencyKey(original), eventIdempotencyKey(retry));
  assert.notEqual(normalized(original).normalization.raw_event_digest, normalized(retry).normalization.raw_event_digest);
  for (const change of [raw => raw.producer.epoch = 'startup-2', raw => raw.partition.partition_id = 'git-web-events',
    raw => raw.producer.producer_id = 'other-producer']) {
    const separate = fresh(); change(separate); assert.notEqual(eventIdempotencyKey(original), eventIdempotencyKey(separate));
  }
});

test('observation/object tuple keys preserve tenant and repository boundaries including delimiter-bearing IDs', () => {
  const raw = fresh(); const other = fresh(); other.partition.tenant_id = 'other';
  other.payload.object.tenant_id = 'other'; other.provenance.source_objects[0].object.tenant_id = 'other';
  assert.notEqual(eventObservationKey(raw), eventObservationKey(other));
  const object = raw.payload.object; assert.notEqual(sourceObjectKey(object), sourceObjectKey({ ...object, repository_id: 'api-fork' }));
  assert.notEqual(sourceObjectKey(object), sourceObjectKey({ ...object, tenant_id: 'other' }));
  assert.notEqual(sourceObjectKey({ ...object, tenant_id: 'a/b', repository_id: 'c' }),
    sourceObjectKey({ ...object, tenant_id: 'a', repository_id: 'b/c' }));
});

test('ACL propagation intersects every supporting source plus envelope and carries maximum sensitivity', () => {
  const raw = fresh(); assert.deepEqual(effectiveEventAccess(raw), { allowed_principal_ids: ['alice'], sensitivity: 'sensitive' });
  raw.provenance.source_objects.push({ object: { ...raw.payload.object, repository_id: 'web' },
    acl: { revision: 'web-acl-1', allowed_principal_ids: ['alice', 'dave'] }, sensitivity: 'restricted' });
  assert.deepEqual(normalized(raw).effective_access, { allowed_principal_ids: ['alice'], sensitivity: 'restricted' });
  raw.provenance.source_objects[1].acl.allowed_principal_ids = ['dave'];
  assert.deepEqual(normalized(raw).effective_access, { allowed_principal_ids: [], sensitivity: 'restricted' });
  raw.acl.allowed_principal_ids = []; assert.deepEqual(effectiveEventAccess(raw).allowed_principal_ids, []);
  raw.acl.allowed_principal_ids = ['*']; assert.throws(() => validateRawEvent(raw), /identifier/);
});

test('malformed access metadata and cross-tenant or unbound source objects cannot normalize', () => {
  for (const alter of [raw => delete raw.acl.revision, raw => raw.acl.allowed_principal_ids.push('alice'),
    raw => raw.sensitivity = 'public', raw => raw.provenance.source_objects[0].object.tenant_id = 'other',
    raw => raw.provenance.source_objects.push(clone(raw.provenance.source_objects[0]))]) {
    const raw = fresh(); alter(raw); assert.throws(() => validateRawEvent(raw), TypeError);
  }
  const raw = fresh(); raw.payload.object.repository_id = 'unknown'; raw.provenance.source_objects[0].object.repository_id = 'unknown';
  assert.equal(normalizeRawEvent(raw, options()).reason, 'source_object_scope_mismatch');
});

test('Git pins require full format-matching object IDs and confined relative artifact paths', () => {
  for (const oid of ['abc123', 'A'.repeat(40), 'a'.repeat(64), 'refs/heads/main']) {
    const raw = fresh(); raw.payload.object.oid = oid; assert.throws(() => validateRawEvent(raw), TypeError);
  }
  const raw = fresh(); raw.payload.object = { ...raw.payload.object, object_format: 'sha256', oid: 'b'.repeat(64) };
  raw.provenance.source_objects[0].object = clone(raw.payload.object); assert.equal(validateRawEvent(raw), true);
  for (const path of ['/etc/passwd', '../private', 'a/../secret', 'a//b', 'a/./b', 'a\\b', 'a\0b', '']) {
    raw.payload.path = path; assert.throws(() => validateRawEvent(raw), /path/);
  }
  raw.payload.path = 'src/example file.mjs'; assert.equal(normalized(raw).replay.reason, 'immutable_revision');
});

test('external source revision pins retain provider authority/object identity separately from delivery', () => {
  const raw = fresh(); raw.partition.source_installation_id = 'connector'; raw.identity = {};
  const object = { kind: 'source_object', tenant_id: 'acme', provider: 'git-host', authority: 'git.example', object_id: 'doc-1' };
  raw.payload = { kind: 'object_revision', object, revision_id: 'revision-7', digest: raw.payload.digest };
  raw.provenance.source_objects = [{ object, acl: clone(raw.acl), sensitivity: 'normal' }];
  const event = normalized(raw); assert.equal(event.replay.eligible, true); assert.equal(event.replay.reason, 'immutable_revision');
  const oldKey = sourceObjectKey(raw.payload.object); raw.payload.revision_id = 'revision-8';
  assert.equal(sourceObjectKey(raw.payload.object), oldKey);
  raw.payload.object.authority = 'other.example';
  assert.equal(normalizeRawEvent(raw, options()).reason, 'source_object_authority_mismatch');
});

test('timestamps retain occurrence and observation independently, with no causal ordering inference', () => {
  const raw = fresh(); raw.occurred_at = '2026-09-23T10:00:00.000Z';
  assert.equal(normalized(raw).occurred_at, raw.occurred_at); // Clock skew is not an error or ordering signal.
  raw.occurred_at = null; raw.producer.sequence = null; raw.source_native_event_id = null;
  assert.equal(normalized(raw).producer.sequence, null);
  for (const value of ['2026-02-30T10:00:00.000Z', '2026-09-21', '2026-09-21T10:00:00-07:00', '', 42]) {
    const event = fresh(); event.observed_at = value; assert.throws(() => validateRawEvent(event), /timestamp/);
  }
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
    const event = fresh(); event.producer.sequence = value; assert.throws(() => validateRawEvent(event), /sequence/);
  }
});

test('causal parents are explicit scoped references, never timestamps or guessed topology', () => {
  const raw = fresh(); raw.causal_parents = [{ tenant_id: 'acme', project_id: 'product', event_id: 'earlier' }];
  assert.deepEqual(normalized(raw).causal_parents, raw.causal_parents);
  for (const parent of [{ tenant_id: 'other', project_id: 'product', event_id: 'earlier' },
    { tenant_id: 'acme', project_id: 'shared', event_id: 'earlier' },
    { tenant_id: 'acme', project_id: 'product', event_id: raw.event_id }]) {
    raw.causal_parents = [parent]; assert.throws(() => validateRawEvent(raw), /causal parent/);
  }
  raw.partition.project_id = null; raw.causal_parents = [{ tenant_id: 'acme', project_id: 'shared', event_id: 'earlier' }];
  assert.equal(normalizeRawEvent(raw, options()).reason, 'causal_parent_scope_mismatch');
});

test('mutable pointers remain non-replayable even when a digest or unrelated authorization is supplied', () => {
  const { raw, opts } = snapshot(); raw.payload = { kind: 'mutable_pointer', pointer_id: 'source:current', digest: raw.payload.digest };
  assert.deepEqual(normalizeRawEvent(raw, opts).event.replay, { eligible: false, reason: 'mutable_pointer', authorization: null });
  raw.payload.digest = null; assert.equal(normalized(raw).replay.eligible, false);
  assert.throws(() => verifyEventPayload(raw.payload, Buffer.from('anything')), /unavailable/);
});

test('snapshot without separately trusted authorization remains explicitly non-replayable', () => {
  const { raw } = snapshot(); const event = normalized(raw);
  assert.deepEqual(event.replay, { eligible: false, reason: 'snapshot_authorization_missing', authorization: null });
  raw.payload.authorized = true; assert.throws(() => validateRawEvent(raw), /unknown field/);
});

test('authorized immutable snapshot pins exact partition, bytes, access and authorization identity', () => {
  const { raw, opts } = snapshot(); const event = normalizeRawEvent(raw, opts).event;
  assert.equal(event.replay.eligible, true); assert.equal(event.replay.reason, 'authorized_snapshot');
  assert.deepEqual(event.replay.authorization, opts.snapshot_authorizations[0]);
  assert.equal(validateNormalizedEvent(event), true);
  assert.equal(verifyEventPayload(event.payload, Buffer.from('synthetic commit payload\n')), true);
  for (const field of ['tenant_id', 'project_id', 'source_installation_id', 'partition_id']) {
    const other = clone(opts); other.snapshot_authorizations[0].partition[field] = 'other';
    assert.equal(normalizeRawEvent(raw, other).event.replay.reason, 'snapshot_authorization_missing');
  }
  opts.snapshot_authorizations[0].digest = `sha256:${'f'.repeat(64)}`;
  assert.throws(() => normalizeRawEvent(raw, opts), /digest mismatch/);
});

test('snapshot grant cannot broaden, narrow or contradict the exposed effective access', () => {
  for (const principals of [['alice', 'bob'], ['bob'], []]) {
    const { raw, opts } = snapshot(); opts.snapshot_authorizations[0].allowed_principal_ids = principals;
    assert.throws(() => normalizeRawEvent(raw, opts), /access mismatch/);
  }
  for (const sensitivity of ['normal', 'restricted']) {
    const { raw, opts } = snapshot(); opts.snapshot_authorizations[0].sensitivity = sensitivity;
    assert.throws(() => normalizeRawEvent(raw, opts), /access mismatch/);
  }
  const { raw, opts } = snapshot(); raw.acl.allowed_principal_ids = []; opts.snapshot_authorizations[0].allowed_principal_ids = [];
  const event = normalizeRawEvent(raw, opts).event;
  assert.equal(event.replay.eligible, true); assert.deepEqual(event.effective_access.allowed_principal_ids, []);
});

test('invalid or conflicting snapshot attestations fail rather than arbitrarily choose one', () => {
  for (const alter of [auth => auth.storage = 'mutable', auth => auth.purpose = 'any',
    auth => delete auth.authorization_id, auth => auth.schema_version = 2]) {
    const { raw, opts } = snapshot(); alter(opts.snapshot_authorizations[0]); assert.throws(() => normalizeRawEvent(raw, opts), TypeError);
  }
  const { raw, opts } = snapshot(); opts.snapshot_authorizations.push(clone(opts.snapshot_authorizations[0]));
  assert.throws(() => normalizeRawEvent(raw, opts), /conflicting/);
});

test('normalized envelope detects tampered mechanical pins, source data, mapping and replay claims', () => {
  for (const alter of [event => event.event_type = 'HUMAN_DECISION', event => event.normalization.mapping.revision = 'new',
    event => event.observed_at = '2026-09-23T10:00:00.000Z', event => event.provenance.delivery.delivery_id = 'changed',
    event => event.partition.partition_id = 'new', event => event.identity.worktree_id = 'different',
    event => event.effective_access.allowed_principal_ids.push('bob'), event => event.replay.reason = 'verified_truth']) {
    const event = normalized(); alter(event); assert.throws(() => validateNormalizedEvent(event), TypeError);
  }
  const { raw } = snapshot(); const event = normalized(raw); event.replay.eligible = true;
  assert.throws(() => validateNormalizedEvent(event), /replay classification/);
});

test('payload byte verification fails on mismatch and never silently upgrades mutable pointers', () => {
  const raw = fresh(); assert.equal(verifyEventPayload(raw.payload, Buffer.from('synthetic commit payload\n')), true);
  assert.throws(() => verifyEventPayload(raw.payload, Buffer.from('changed bytes')), /digest mismatch/);
  assert.throws(() => verifyEventPayload(raw.payload, 'synthetic commit payload\n'), /requires bytes/);
  const mutable = { kind: 'mutable_pointer', pointer_id: 'current', digest: raw.payload.digest };
  assert.equal(verifyEventPayload(mutable, Buffer.from('synthetic commit payload\n')), true);
  raw.payload = mutable; assert.equal(normalized(raw).replay.eligible, false);
});

test('non-JSON structures, executable accessors, cycles and oversized collections fail boundedly without values in errors', () => {
  for (const value of [undefined, NaN, new Date(), 1n, () => null]) {
    const raw = fresh(); raw.untrusted = value; assert.throws(() => validateRawEvent(raw), TypeError);
  }
  const getter = fresh(); Object.defineProperty(getter, 'evil', { enumerable: true, get() { throw new Error('getter executed'); } });
  assert.throws(() => validateRawEvent(getter), /JSON data properties/);
  const cycle = fresh(); cycle.cycle = cycle; assert.throws(() => validateRawEvent(cycle), /acyclic JSON/);
  const sparse = fresh(); sparse.causal_parents = new Array(2); assert.throws(() => validateRawEvent(sparse), /sparse/);
  const large = fresh(); large.acl.allowed_principal_ids = Array.from({ length: 129 }, (_, i) => `p-${i}`);
  assert.throws(() => validateRawEvent(large), /bounded array/);
  const secret = fresh(); secret.event_id = 'private-value!must-not-echo';
  try { validateRawEvent(secret); assert.fail('expected rejection'); } catch (error) { assert.ok(!error.message.includes('private-value')); }
});
