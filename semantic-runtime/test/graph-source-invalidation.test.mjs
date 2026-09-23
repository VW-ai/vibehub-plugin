import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceInvalidationFeed, sourceLifecycleInvalidationId } from '../src/application/sources/source-invalidation.mjs';
import { fixture, register, capture, initialize, assertion, mutation, rows, hashText, SCOPE, ACTIONS } from './helpers/graph-store-fixture.mjs';

const actions = [...ACTIONS, 'source:invalidate', 'source:invalidation:capture', 'source:invalidation:read', 'source:invalidation:consume'];
const deniedPolicy = { enabled: false, allowed_principal_ids: [], sensitivity: 'restricted', allow_snapshots: false };
const head = f => f.graph.getHead(f.context, { generation_id: 'generation-1' }).graph_revision;
const code = (fn, expected) => assert.throws(fn, error => error.code === expected);
function setup(t) {
  const f = fixture(t); f.context = f.issue({ actions }).context;
  const source = register(f), event = capture(f, source);
  const genesis = initialize(f), request = mutation(f, genesis.receipt.next_graph, assertion(f, event));
  const applied = f.graph.mutate(f.context, request);
  return { f, source, event, request, applied };
}
function lifecycle(f, source, { sequence, expectedVersion, state = 'unknown', access = null,
  objectId = 'decision-source', principals = ['owner', 'reader'] }) {
  const key = `lifecycle-${sequence}`, object = { kind: 'source_object', tenant_id: SCOPE.tenant_id,
    provider: 'vibehub', authority: 'local', object_id: objectId };
  const acl = { revision: key, allowed_principal_ids: principals };
  const event = { schema_version: 1, kind: 'raw_event',
    event_id: f.ingress.eventIdFor(f.context, { registration_id: source.registration_id, idempotency_key: key }),
    partition: source.registration.partition, source_native_event_id: key, idempotency_key: key,
    source_event_type: state === 'tombstoned' ? 'tombstone' : 'access', occurred_at: null,
    observed_at: '2026-09-22T15:00:00.000Z', producer: { ...source.registration.producer, sequence }, causal_parents: [], identity: {},
    payload: { kind: 'object_revision', object, revision_id: key, digest: hashText(key) },
    provenance: { delivery: { channel: 'system', delivery_id: key }, source_objects: [{ object, acl, sensitivity: 'normal' }] },
    acl, sensitivity: 'normal' };
  f.ingress.submitSourceLifecycle(f.context, { registration_id: source.registration_id, epoch: f.epoch,
    event, expectedVersion, access_state: state, access });
  const selected = new SourceInvalidationFeed({ store: f.store, authority: f.authority }).readLifecycleEvent(f.context,
    { invalidation_id: sourceLifecycleInvalidationId(SCOPE, event.event_id) });
  assert.equal(selected.status, 'applied');
  return { event: selected.event, request: { epoch: f.epoch, idempotency_key: key,
    publisher_ref: f.publisher.publisher_ref, expected_graph: head(f),
    operation: { kind: 'source_access', event: selected.event, access_state: state }, coverage: null } };
}

test('actual Graph consumes current and prior lifecycle metadata after ingress revocation, without reopening ordinary reads', t => {
  const { f, source, event, request, applied } = setup(t);
  const first = lifecycle(f, source, { sequence: 1, expectedVersion: source.version, access: deniedPolicy });
  code(() => f.ingress.readEvent(f.context, { event_id: first.event.event_id }), 'source_access_denied');
  const restricted = f.graph.mutate(f.context, first.request); assert.equal(restricted.status, 'applied');
  const second = lifecycle(f, source, { sequence: 2, expectedVersion: source.version + 1 });
  // The core must read both the new event and its previously retained access
  // update even though their shared registration now denies all content reads.
  const repeated = f.graph.mutate(f.context, second.request); assert.equal(repeated.status, 'applied');
  const before = rows(f);
  assert.deepEqual(f.graph.resolve(f.context, { at: applied.receipt.next_graph, address: applied.revision }),
    { status: 'denied', revision: null });
  for (const operation of [
    () => f.graph.getReceipt(f.context, { generation_id: 'generation-1', idempotency_key: request.idempotency_key }),
    () => f.graph.getReceipt(f.context, { generation_id: 'generation-1', idempotency_key: second.request.idempotency_key }),
    () => f.graph.page(f.context, { at: head(f), collection: { kind: 'heads' }, cursor: null, limit: 64 }),
    () => f.graph.mutate(f.context, request),
    () => f.graph.mutate(f.context, mutation(f, head(f), assertion(f, event, 'forbidden', { entity_id: 'forbidden' }))),
  ]) code(operation, 'graph_access_denied');
  assert.deepEqual(rows(f), before);

  const reopened = lifecycle(f, source, { sequence: 3, expectedVersion: source.version + 1, state: 'active', access: source.registration.access });
  assert.equal(f.graph.mutate(f.context, reopened.request).status, 'applied');
  assert.equal(f.ingress.readEvent(f.context, { event_id: event.event_id }).event.event_id, event.event_id);
  // Source permission recovery does not silently refresh an older semantic assertion.
  assert.equal(f.graph.resolve(f.context, { at: head(f), address: applied.revision }).status, 'denied');
});

test('lifecycle fallback retains operator and original captured ACL authority', t => {
  const { f, source } = setup(t);
  const update = lifecycle(f, source, { sequence: 1, expectedVersion: source.version, access: deniedPolicy });
  const lesser = f.issue({ actions: ACTIONS }).context, before = rows(f);
  code(() => f.graph.mutate(lesser, update.request), 'graph_unauthorized');
  code(() => f.graph.mutate(f.context, { ...update.request,
    operation: { ...update.request.operation, access_state: 'active' } }), 'graph_access_denied');
  assert.deepEqual(rows(f), before);
  const outsider = f.issue({ principal: 'never-captured', actions }).context;
  const publisher = f.graph.registerPublisherRun(outsider, { epoch: f.epoch, run_key: 'outside-captured-acl' });
  const afterPublisher = rows(f);
  code(() => f.graph.mutate(outsider, { ...update.request, publisher_ref: publisher.publisher_ref }), 'graph_access_denied');
  assert.deepEqual(rows(f), afterPublisher);
  assert.equal(f.graph.mutate(f.context, update.request).status, 'applied');
});

test('visibility of a new lifecycle event does not grant access to a prior captured restriction', t => {
  const { f, source } = setup(t);
  const first = lifecycle(f, source, { sequence: 1, expectedVersion: source.version, principals: ['owner'] });
  assert.equal(f.graph.mutate(f.context, first.request).status, 'applied');
  const next = lifecycle(f, source, { sequence: 2, expectedVersion: source.version });
  const reader = f.issue({ principal: 'reader', actions }).context;
  const publisher = f.graph.registerPublisherRun(reader, { epoch: f.epoch, run_key: 'only-current-metadata' });
  const before = rows(f);
  code(() => f.graph.mutate(reader, { ...next.request, publisher_ref: publisher.publisher_ref }), 'graph_access_denied');
  assert.deepEqual(rows(f), before);
  assert.equal(f.graph.mutate(f.context, next.request).status, 'applied');
});

test('a tombstone before content is durable ingress denial, not permission to manufacture a Graph object', t => {
  const { f, source } = setup(t), beforeHead = head(f);
  const update = lifecycle(f, source, { sequence: 1, expectedVersion: source.version, state: 'tombstoned', objectId: 'not-observed-by-graph' });
  const before = rows(f);
  code(() => f.graph.mutate(f.context, update.request), 'graph_plan_rejected');
  assert.deepEqual(head(f), beforeHead); assert.deepEqual(rows(f), before);
  code(() => capture(f, source, { sequence: 2, objectId: 'not-observed-by-graph' }), 'source_access_denied');
});
