import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DomainStore, DurableIngress } from '../src/index.mjs';
import { SourceInvalidationDomain, SourceInvalidationFeed,
  sourceLifecycleInvalidationId } from '../src/application/sources/source-invalidation.mjs';
import { fixture, register, capture, hashText, SCOPE, ACTIONS } from './helpers/graph-store-fixture.mjs';

const actions = [...ACTIONS, 'ingress:handoff', 'source:invalidate', 'source:invalidation:capture',
  'source:invalidation:read', 'source:invalidation:consume'];
const denied = { enabled: false, allowed_principal_ids: [], sensitivity: 'restricted', allow_snapshots: false };
const code = (operation, expected) => assert.throws(operation, error => error.code === expected);
function setup(t) {
  const f = fixture(t); f.context = f.issue({ actions }).context;
  const source = register(f), content = capture(f, source, { sequence: 0 });
  return { f, source, content, feed: new SourceInvalidationFeed({ store: f.store, authority: f.authority }) };
}
function lifecycle(f, source, { sequence, key = `lifecycle-${sequence ?? 'null'}`, state = 'unknown',
  access = null, expectedVersion = source.version, objectId = 'decision-source', objectIds = [objectId],
  payloadKind = 'object_revision' } = {}) {
  const objects = objectIds.map(id => ({ kind: 'source_object', tenant_id: SCOPE.tenant_id, provider: 'vibehub',
    authority: 'local', object_id: id })), object = objects[0];
  const acl = { revision: `acl-${key}`, allowed_principal_ids: ['owner', 'reader'] };
  const payload = payloadKind === 'snapshot' ? { kind: 'snapshot', snapshot_id: key, digest: hashText(key) }
    : payloadKind === 'mutable_pointer' ? { kind: 'mutable_pointer', pointer_id: key, digest: null }
      : { kind: 'object_revision', object, revision_id: key, digest: hashText(key) };
  const event = { schema_version: 1, kind: 'raw_event',
    event_id: f.ingress.eventIdFor(f.context, { registration_id: source.registration_id, idempotency_key: key }),
    partition: source.registration.partition, source_native_event_id: key, idempotency_key: key,
    source_event_type: state === 'tombstoned' ? 'tombstone' : 'access', occurred_at: null,
    observed_at: '2026-09-22T16:00:00.000Z', producer: { ...source.registration.producer, sequence },
    causal_parents: [], identity: {}, payload,
    provenance: { delivery: { channel: 'system', delivery_id: key },
      source_objects: objects.map(value => ({ object: value, acl, sensitivity: 'normal' })) }, acl, sensitivity: 'normal' };
  const request = { registration_id: source.registration_id, epoch: f.epoch, event,
    expectedVersion, access_state: state, access };
  return { event, request, result: () => f.ingress.submitSourceLifecycle(f.context, request) };
}

test('same-stream ordering reopens only from a comparable newer active event', t => {
  const { f, source, content, feed } = setup(t), first = lifecycle(f, source, { sequence: 2 });
  assert.equal(first.result().invalidation.status, 'applied');
  code(() => f.ingress.readEvent(f.context, { event_id: content.event_id }), 'source_access_denied');
  const stale = lifecycle(f, source, { sequence: 1, state: 'active' }).result();
  assert.equal(stale.invalidation.status, 'superseded');
  code(() => f.ingress.readEvent(f.context, { event_id: content.event_id }), 'source_access_denied');
  const reopen = lifecycle(f, source, { sequence: 3, state: 'active' }).result();
  assert.equal(reopen.invalidation.status, 'applied');
  assert.equal(f.ingress.readEvent(f.context, { event_id: content.event_id }).event.event_id, content.event_id);
  assert.equal(feed.head(f.context).sequence, 2);
});

test('null order stays permanently incomparable and another stream cannot clear its blocker', t => {
  const { f, source, content } = setup(t);
  assert.equal(lifecycle(f, source, { sequence: null }).result().invalidation.status, 'applied');
  assert.equal(lifecycle(f, source, { sequence: 5, state: 'unknown' }).result().invalidation.status, 'superseded');
  assert.equal(lifecycle(f, source, { sequence: 6, state: 'active' }).result().invalidation.status, 'superseded');
  const other = register(f, { partition: 'other-stream', producerEpoch: 'epoch-2' });
  assert.equal(lifecycle(f, other, { sequence: 0, state: 'active', key: 'other-active' }).result().invalidation.status, 'applied');
  code(() => f.ingress.readEvent(f.context, { event_id: content.event_id }), 'source_access_denied');
});

test('tombstone is irreversible across stale replay, newer active input and other streams', t => {
  const { f, source, content } = setup(t);
  lifecycle(f, source, { sequence: 1, state: 'active', key: 'initial-active' }).result();
  const tombstone = lifecycle(f, source, { sequence: 3, state: 'tombstoned', key: 'permanent-tombstone' }).result();
  assert.equal(tombstone.invalidation.status, 'applied');
  assert.equal(lifecycle(f, source, { sequence: 2, state: 'active', key: 'stale-replay' }).result().invalidation.status,
    'superseded');
  assert.equal(lifecycle(f, source, { sequence: 4, state: 'active', key: 'newer-after-tombstone' }).result().invalidation.status,
    'superseded');
  const other = register(f, { partition: 'tombstone-other-stream', producerEpoch: 'epoch-other' });
  assert.equal(lifecycle(f, other, { sequence: 9, state: 'active', key: 'other-after-tombstone' }).result().invalidation.status,
    'superseded');
  code(() => f.ingress.readEvent(f.context, { event_id: content.event_id }), 'source_access_denied');
});

test('registration widening requires every active target transition to be comparable', t => {
  const { f, source } = setup(t);
  const restricted = { ...source.registration.access, allowed_principal_ids: ['owner'] };
  const narrowed = f.ingress.updateSourceAccess(f.context, { registration_id: source.registration_id,
    expectedVersion: source.version, access: restricted });
  lifecycle(f, source, { sequence: 1, state: 'active', key: 'active-a', objectId: 'object-a',
    expectedVersion: narrowed.version }).result();
  lifecycle(f, source, { sequence: 5, state: 'active', key: 'active-b', objectId: 'object-b',
    expectedVersion: narrowed.version }).result();
  const partial = lifecycle(f, source, { sequence: 3, state: 'active', key: 'partial-active',
    objectIds: ['object-a', 'object-b'], expectedVersion: narrowed.version, access: source.registration.access });
  code(partial.result, 'source_access_denied');
  assert.deepEqual(f.ingress.getSource(f.context, { registration_id: source.registration_id }).registration.access, restricted);
  const accepted = lifecycle(f, source, { sequence: 3, state: 'active', key: 'partial-active',
    objectIds: ['object-a', 'object-b'], expectedVersion: narrowed.version }).result();
  assert.deepEqual(accepted.invalidation.target_refs.map(target => target.applied), [true, false]);
});

test('missing summary for a known source object fails closed instead of recreating zero state', t => {
  const { f, source, content } = setup(t);
  lifecycle(f, source, { sequence: 1, state: 'unknown', key: 'block-known-object' }).result();
  const db = new DatabaseSync(f.filePath);
  try {
    const deleted = db.prepare(`DELETE FROM records WHERE tenant_id=? AND project_id=? AND namespace=?
      AND json_extract(value, '$.kind')='source_object_invalidation_summary'`).run(
      SCOPE.tenant_id, SCOPE.project_id, 'source-invalidation');
    assert.equal(deleted.changes, 1);
  } finally { db.close(); }
  code(() => f.ingress.readEvent(f.context, { event_id: content.event_id }), 'invalidation_corrupt');
  const next = capture.bind(null, f, source, { sequence: 2, key: 'content-after-summary-loss' });
  code(next, 'invalidation_corrupt');
});

test('guarded pending items are filtered while unrelated objects remain usable', t => {
  const { f, source, content } = setup(t);
  lifecycle(f, source, { sequence: 1, state: 'unknown', key: 'block-one-object' }).result();
  const unrelated = capture(f, source, { sequence: 2, key: 'unrelated-content', objectId: 'unrelated-object' });
  code(() => f.ingress.readEvent(f.context, { event_id: content.event_id }), 'source_access_denied');
  assert.equal(f.ingress.readEvent(f.context, { event_id: unrelated.event_id }).event.event_id, unrelated.event_id);
  assert.deepEqual(f.ingress.listPending(f.context).map(item => item.value.event_id), [unrelated.event_id]);
});

test('handoff rechecks object guards after a trusted callback before ACK', t => {
  const { f, source, content, feed } = setup(t);
  const change = lifecycle(f, source, { sequence: 1, state: 'unknown', key: 'callback-invalidation' });
  f.ingress.submit(f.context, { registration_id: source.registration_id, epoch: f.epoch, event: change.event });
  const admitted = f.ingress.readEvent(f.context, { event_id: change.event.event_id });
  const domain = new SourceInvalidationDomain({ store: f.store, authority: f.authority });
  code(() => f.ingress.handoff(f.context, { event_id: content.event_id }, tx => {
    domain.applyLifecycle(f.context, tx, { action: 'source:invalidate', registration_id: source.registration_id,
      event: admitted.event, receipt: admitted.receipt, access_state: 'unknown', access: null,
      request_digest: hashText('callback-invalidation') });
  }), 'source_access_denied');
  assert.equal(f.ingress.readEvent(f.context, { event_id: content.event_id }).event.event_id, content.event_id);
  code(() => feed.readLifecycleEvent(f.context, {
    invalidation_id: sourceLifecycleInvalidationId(SCOPE, admitted.event.event_id),
  }), 'missing_invalidation');
});

test('lifecycle target sets accept 32 distinct objects and reject 33 atomically', t => {
  const { f, source, feed } = setup(t);
  const accepted = lifecycle(f, source, { sequence: 1, key: 'targets-32',
    objectIds: Array.from({ length: 32 }, (_, index) => `target-${index}`) }).result();
  assert.equal(accepted.invalidation.target_refs.length, 32);
  const before = feed.head(f.context), rejected = lifecycle(f, source, { sequence: 2, key: 'targets-33',
    objectIds: Array.from({ length: 33 }, (_, index) => `overflow-${index}`) });
  code(rejected.result, 'invalid_invalidation_input');
  assert.deepEqual(feed.head(f.context), before);
  assert.equal(f.ingress.getReceipt(f.context, { event_id: rejected.event.event_id }), null);
  const ordinary32 = lifecycle(f, source, { sequence: 2, key: 'ordinary-targets-32', state: 'active',
    objectIds: Array.from({ length: 32 }, (_, index) => `ordinary-${index}`) });
  assert.equal(f.ingress.submit(f.context, { registration_id: source.registration_id,
    epoch: f.epoch, event: ordinary32.event }).status, 'accepted');
  const ordinary33 = lifecycle(f, source, { sequence: 3, key: 'ordinary-targets-33', state: 'active',
    objectIds: Array.from({ length: 33 }, (_, index) => `ordinary-overflow-${index}`) });
  code(() => f.ingress.submit(f.context, { registration_id: source.registration_id,
    epoch: f.epoch, event: ordinary33.event }), 'invalid_invalidation_input');
  assert.equal(f.ingress.getReceipt(f.context, { event_id: ordinary33.event.event_id }), null);
});

test('historical lifecycle idempotency key binds one event and exact retry result', t => {
  const { f, source } = setup(t);
  const first = lifecycle(f, source, { sequence: 1, key: 'historical-first', objectId: 'historical-a' });
  const second = lifecycle(f, source, { sequence: 2, key: 'historical-second', objectId: 'historical-b' });
  for (const item of [first, second]) f.ingress.submit(f.context, {
    registration_id: source.registration_id, epoch: f.epoch, event: item.event,
  });
  const command = { registration_id: source.registration_id, event_id: first.event.event_id,
    expectedVersion: source.version, idempotency_key: 'historical-command', access_state: 'unknown',
    access: null, activation_epoch: null };
  const applied = f.ingress.applyAdmittedSourceLifecycle(f.context, command);
  assert.deepEqual(f.ingress.applyAdmittedSourceLifecycle(f.context, command), applied);
  code(() => f.ingress.applyAdmittedSourceLifecycle(f.context, {
    ...command, event_id: second.event.event_id,
  }), 'invalidation_conflict');
});

test('materialization reads remain linear in targets and never scan retained stream guards', t => {
  const { f, source } = setup(t), objectIds = ['bounded-a', 'bounded-b', 'bounded-c'];
  for (let index = 0; index < 4; index++) {
    const other = register(f, { partition: `retained-${index}`, producerEpoch: `retained-epoch-${index}` });
    lifecycle(f, other, { sequence: 0, state: 'active', key: `retained-active-${index}`, objectIds }).result();
  }
  const current = lifecycle(f, source, { sequence: 1, state: 'active', key: 'bounded-materialization', objectIds });
  f.ingress.submit(f.context, { registration_id: source.registration_id, epoch: f.epoch, event: current.event });
  const originalRecord = f.store.getRecord.bind(f.store), originalRange = f.store.getSourceRange.bind(f.store);
  let summaryReads = 0, rangeReads = 0;
  f.store.getRecord = (context, namespace, key) => {
    if (namespace === 'source-invalidation' && key.startsWith('summary-')) summaryReads++;
    return originalRecord(context, namespace, key);
  };
  f.store.getSourceRange = (...args) => { rangeReads++; return originalRange(...args); };
  t.after(() => { f.store.getRecord = originalRecord; f.store.getSourceRange = originalRange; });
  assert.equal(f.ingress.readEvent(f.context, { event_id: current.event.event_id }).event.event_id, current.event.event_id);
  assert.equal(summaryReads, objectIds.length * 2); // selected read plus return-time fence
  assert.equal(rangeReads, 0);
});

test('administrative invalidation distinguishes capture disable from historical read denial', t => {
  const { f, source, content, feed } = setup(t);
  const captureDisabled = { ...source.registration.access, enabled: false };
  const disabled = f.ingress.updateSourceAccess(f.context, { registration_id: source.registration_id,
    expectedVersion: source.version, access: captureDisabled });
  assert.equal(f.ingress.readEvent(f.context, { event_id: content.event_id }).event.event_id, content.event_id);
  code(() => f.ingress.applyAdministrativeInvalidation(f.context, { registration_id: source.registration_id,
    expectedVersion: disabled.version, idempotency_key: 'insufficient', reason: 'visibility_changed', access: captureDisabled }),
  'source_access_denied');
  f.activation.setEnabled(f.context, { enabled: false, expectedVersion: 1 });
  const removed = f.ingress.applyAdministrativeInvalidation(f.context, { registration_id: source.registration_id,
    expectedVersion: disabled.version, idempotency_key: 'repository-removed', reason: 'repository_removed', access: denied });
  assert.equal(removed.status, 'applied');
  code(() => f.ingress.readEvent(f.context, { event_id: content.event_id }), 'source_access_denied');
  const retry = f.ingress.applyAdministrativeInvalidation(f.context, { registration_id: source.registration_id,
    expectedVersion: disabled.version, idempotency_key: 'repository-removed', reason: 'repository_removed', access: denied });
  assert.equal(retry.status, 'duplicate'); assert.deepEqual(retry.invalidation, removed.invalidation);
  assert.equal(feed.head(f.context).sequence, 2); // direct update plus repository removal
});

test('fresh lifecycle capture is activation-gated, immutable-metadata-only and exactly addressable', t => {
  const { f, source, feed } = setup(t), before = feed.head(f.context);
  f.activation.setEnabled(f.context, { enabled: false, expectedVersion: 1 });
  const blocked = lifecycle(f, source, { sequence: 1 });
  code(blocked.result, 'project_disabled'); assert.deepEqual(feed.head(f.context), before);
  const enabled = f.activation.setEnabled(f.context, { enabled: true, expectedVersion: 2 }); f.epoch = enabled.state.epoch;
  for (const payloadKind of ['snapshot', 'mutable_pointer']) {
    const bad = lifecycle(f, source, { sequence: 1, key: `bad-${payloadKind}`, payloadKind });
    code(bad.result, 'invalid_event');
  }
  const accepted = lifecycle(f, source, { sequence: 1, key: 'metadata-only' }), result = accepted.result();
  const invalidation_id = sourceLifecycleInvalidationId(SCOPE, accepted.event.event_id);
  const selected = feed.readLifecycleEvent(f.context, { invalidation_id });
  assert.equal(result.invalidation.invalidation_id, invalidation_id);
  assert.equal(selected.event.event_id, accepted.event.event_id); assert.equal(selected.receipt.snapshot_ref, null);
  assert.deepEqual(selected.captured_access, selected.event.effective_access);
});

test('feed pages use the indexed sequence range and enforce authority, stale fences and inert inputs', t => {
  const { f, source, feed } = setup(t); let version = source.version;
  for (let i = 0; i < 65; i++) {
    const result = f.ingress.updateSourceAccess(f.context, { registration_id: source.registration_id,
      expectedVersion: version, access: source.registration.access }); version = result.version;
  }
  const first = feed.page(f.context, { after: null, limit: 64 });
  assert.equal(first.items.length, 64); assert.equal(first.next_after, 64);
  const second = feed.page(f.context, { after: first.next_after, limit: 64 });
  assert.equal(second.items.length, 1); assert.equal(second.next_after, null); assert.equal(second.head_sequence, 65);
  assert.deepEqual(feed.assertFence(f.context, { sequence: 65 }), { status: 'current', sequence: 65 });
  code(() => feed.assertFence(f.context, { sequence: 64 }), 'stale_invalidation_fence');
  const lesser = f.issue({ actions: ACTIONS }).context;
  code(() => feed.head(lesser), 'invalidation_unauthorized');
  code(() => feed.page(f.context, Object.defineProperty({}, 'after', { enumerable: true, get() { throw new Error('ran'); } })),
    'invalid_invalidation_input');
  const db = new DatabaseSync(f.filePath, { readOnly: true });
  try {
    const detail = db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM sources
      WHERE tenant_id=? AND project_id=? AND namespace=? AND id>=? AND id<? ORDER BY id LIMIT ?`)
      .all(SCOPE.tenant_id, SCOPE.project_id, 'source-invalidation', 'notice-0000000000000000',
        'notice-z', 64).map(row => row.detail).join(' ');
    assert.match(detail, /SEARCH .*INDEX/); assert.doesNotMatch(detail, /SCAN/);
  } finally { db.close(); }
});

test('fence, stream tuple and derived-count corruption fail closed', t => {
  const { f, source, content, feed } = setup(t);
  lifecycle(f, source, { sequence: 1, key: 'corrupt-guard' }).result();
  const db = new DatabaseSync(f.filePath);
  try {
    assert.equal(db.prepare(`UPDATE records SET value=json_set(value,'$.stream_key','corrupt-stream')
      WHERE tenant_id=? AND project_id=? AND namespace=? AND json_extract(value,'$.kind')='source_object_stream_guard'`)
      .run(SCOPE.tenant_id, SCOPE.project_id, 'source-invalidation').changes, 1);
  } finally { db.close(); }
  code(() => lifecycle(f, source, { sequence: 2, state: 'active', key: 'cannot-use-corrupt-guard' }).result(),
    'invalidation_corrupt');
  code(() => f.ingress.readEvent(f.context, { event_id: content.event_id }), 'source_access_denied');

  const countDb = new DatabaseSync(f.filePath);
  try {
    assert.equal(countDb.prepare(`UPDATE records SET value=json_set(value,'$.blocking_stream_count',9007199254740991)
      WHERE tenant_id=? AND project_id=? AND namespace=? AND json_extract(value,'$.kind')='source_object_invalidation_summary'`)
      .run(SCOPE.tenant_id, SCOPE.project_id, 'source-invalidation').changes, 1);
    const stored = JSON.parse(countDb.prepare(`SELECT value FROM records WHERE tenant_id=? AND project_id=? AND namespace=?
      AND json_extract(value,'$.kind')='source_object_invalidation_summary'`).get(
      SCOPE.tenant_id, SCOPE.project_id, 'source-invalidation').value);
    assert.equal(stored.blocking_stream_count, Number.MAX_SAFE_INTEGER);
  } finally { countDb.close(); }
  const other = register(f, { partition: 'overflow-count', producerEpoch: 'overflow-count-epoch' });
  code(() => lifecycle(f, other, { sequence: 0, key: 'overflow-count' }).result(), 'invalidation_corrupt');

  const headDb = new DatabaseSync(f.filePath);
  try {
    const head = headDb.prepare(`SELECT value FROM records WHERE tenant_id=? AND project_id=? AND namespace=?
      AND key='project-fence'`).get(SCOPE.tenant_id, SCOPE.project_id, 'source-invalidation');
    const sequence = JSON.parse(head.value).sequence;
    assert.equal(headDb.prepare(`UPDATE records SET value=json_set(value,'$.sequence',0) WHERE tenant_id=? AND project_id=?
      AND namespace=? AND key='project-fence'`).run(SCOPE.tenant_id, SCOPE.project_id, 'source-invalidation').changes, 1);
    code(() => feed.head(f.context), 'invalidation_corrupt');
    assert.equal(headDb.prepare(`UPDATE records SET value=json_set(value,'$.sequence',?) WHERE tenant_id=? AND project_id=?
      AND namespace=? AND key='project-fence'`).run(sequence, SCOPE.tenant_id, SCOPE.project_id,
      'source-invalidation').changes, 1);
    assert.equal(feed.head(f.context).sequence, sequence);
    assert.equal(headDb.prepare(`DELETE FROM records WHERE tenant_id=? AND project_id=? AND namespace=?
      AND key='project-fence'`).run(SCOPE.tenant_id, SCOPE.project_id, 'source-invalidation').changes, 1);
  } finally { headDb.close(); }
  code(() => feed.head(f.context), 'invalidation_corrupt');
  code(() => feed.assertFence(f.context, { sequence: 0 }), 'invalidation_corrupt');
});

test('missing invalidation namespace and hostile reflected inputs fail closed', t => {
  const { f, source, feed } = setup(t);
  const base = lifecycle(f, source, { sequence: 1, key: 'zero-target' }).event;
  const event = { ...base, source_event_type: 'note', payload: {
    kind: 'snapshot', snapshot_id: 'zero-target', digest: hashText('zero-target'),
  }, provenance: { ...base.provenance, source_objects: [] } };
  const store = new DomainStore({ filePath: f.filePath, authority: f.authority,
    namespaces: ['git-enrollment', 'project-activation', 'durable-ingress'] });
  const ingress = new DurableIngress({ store, authority: f.authority, snapshotPolicy: ({ text }) => text });
  t.after(() => store.close());
  code(() => ingress.submit(f.context, { registration_id: source.registration_id, epoch: f.epoch, event }), 'unknown_namespace');
  assert.equal(f.ingress.getReceipt(f.context, { event_id: event.event_id }), null);

  let trapRan = false;
  const hostile = new Proxy({}, { getPrototypeOf() { trapRan = true; throw new Error('PROXY_CANARY'); } });
  assert.throws(() => feed.page(f.context, hostile), error =>
    error.code === 'invalid_invalidation_input' && !error.message.includes('CANARY'));
  assert.equal(trapRan, false);
  const original = f.store.getRecord;
  f.store.getRecord = () => { throw Object.defineProperty(new Error('ERROR_CANARY'), 'code', {
    enumerable: true, get() { throw new Error('CODE_GETTER_CANARY'); },
  }); };
  try {
    assert.throws(() => feed.head(f.context), error =>
      error.code === 'invalid_invalidation_input' && !error.message.includes('CANARY'));
  } finally { f.store.getRecord = original; }
});
