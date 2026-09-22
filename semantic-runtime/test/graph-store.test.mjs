import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixture, register, capture, initialize, assertion, mutation, rows, git, SCOPE, ACTIONS, NS } from './helpers/graph-store-fixture.mjs';
import { semanticAddress, createWorkingGraph, applyGraphAssertion, graphRevisionAddress } from '../src/core/working-graph.mjs';

const logical = (entity_id = 'context-a', generation_id = 'generation-1') => semanticAddress({ scope: SCOPE, generation_id, entity_kind: 'entity', entity_id });
const head = f => f.graph.getHead(f.context, { generation_id: 'generation-1' }).graph_revision;
const point = (f, address, at = head(f), context = f.context) => f.graph.resolve(context, { at, address });
function first(t, options = {}) {
  const f = fixture(t), source = register(f), event = capture(f, source, options), genesis = initialize(f);
  const request = mutation(f, genesis.receipt.next_graph, assertion(f, event));
  const applied = f.graph.mutate(f.context, request);
  return { f, source, event, genesis, request, applied };
}
function code(call, expected) {
  assert.throws(call, error => { assert.match(error.code, /^[a-z][a-z_]+$/); if (expected) assert.equal(error.code, expected); return true; });
}

test('actual Git enrollment, publisher and admitted source produce persistent semantic revisions and exact receipts', t => {
  const { f, event, genesis, request, applied } = first(t);
  assert.equal(applied.status, 'applied'); assert.equal(point(f, applied.revision).status, 'resolved');
  assert.deepEqual(point(f, applied.revision).revision.provenance.events, [event]);
  assert.equal(point(f, logical(), genesis.receipt.next_graph).status, 'unavailable');
  assert.deepEqual(f.graph.getReceipt(f.context, { generation_id: 'generation-1', idempotency_key: request.idempotency_key }), applied.receipt);
  assert.equal(f.graph.getHead(f.context, { generation_id: 'generation-1' }).maintenance, null);
  const old = head(f), saved = point(f, applied.revision);
  f.store.close(); const reopened = f.reopen();
  assert.deepEqual(head(reopened), old); assert.deepEqual(point(reopened, applied.revision), saved);
  assert.equal(reopened.store.pendingOutbox(reopened.context, NS).length, 2);
  assert.equal(reopened.ingress.listPending(reopened.context).length, 1, 'Graph publication cannot ACK ingress ownership');
});

test('exact actor/request retries retain original pins after Git metadata changes and disable; changed requests write nothing', t => {
  const { f, request, applied } = first(t), before = rows(f);
  assert.deepEqual(f.graph.mutate(f.context, request), { ...applied, status: 'duplicate' }); assert.deepEqual(rows(f), before);
  const changed = structuredClone(request); changed.operation.assertion.content.data.text = 'changed'; code(() => f.graph.mutate(f.context, changed)); assert.deepEqual(rows(f), before);
  git(f.folder, 'branch', 'another-branch'); const enrollment = f.registry.get(f.context);
  f.registry.refresh(f.context, { checkout_id: enrollment.value.checkouts[0].checkout_id, expectedVersion: enrollment.version });
  const activation = f.activation.get(f.context); f.activation.setEnabled(f.context, { enabled: false, expectedVersion: activation.version });
  assert.deepEqual(f.graph.mutate(f.context, request), { ...applied, status: 'duplicate' }); assert.deepEqual(rows(f), before);
  assert.deepEqual(f.graph.getReceipt(f.context, { generation_id: 'generation-1', idempotency_key: request.idempotency_key }), applied.receipt);
  code(() => f.graph.mutate(f.context, mutation(f, head(f), { ...request.operation.assertion, assertion_id: 'new-disabled' })));
  assert.deepEqual(rows(f), before);
});

test('graph CAS rejection has no effects; semantic base conflict retains alternatives until explicit full resolution', t => {
  const { f, event, genesis, request, applied } = first(t), before = rows(f);
  const stale = mutation(f, genesis.receipt.next_graph, assertion(f, event, 'stale'));
  const rejected = f.graph.mutate(f.context, stale);
  assert.equal(rejected.status, 'graph_revision_mismatch'); assert.deepEqual(rejected.proposal, stale); assert.deepEqual(rejected.effects, []); assert.deepEqual(rows(f), before);
  const second = f.graph.mutate(f.context, mutation(f, head(f), assertion(f, event, 'competitor')));
  assert(second.conflict); const contested = point(f, logical()); assert.equal(contested.entity.status, 'contested'); assert.equal(contested.entity.competing.length, 2);
  const resolution = assertion(f, event, 'resolution', { base_revision: applied.revision, parents: contested.entity.competing, status: 'resolved' });
  const missing = mutation(f, head(f), { ...resolution, parents: [applied.revision] }, { operation: { kind: 'resolve', conflict_digest: second.conflict.conflict_digest ?? second.conflict, assertion: { ...resolution, parents: [applied.revision] } } });
  const conflictedRows = rows(f); code(() => f.graph.mutate(f.context, missing)); assert.deepEqual(rows(f), conflictedRows);
  const resolved = f.graph.mutate(f.context, mutation(f, head(f), resolution, { operation: { kind: 'resolve', conflict_digest: second.conflict.conflict_digest ?? second.conflict, assertion: resolution } }));
  assert.equal(point(f, resolved.revision).entity.status, 'resolved'); assert.equal(point(f, logical()).conflicts.length, 0);
  assert.equal(point(f, applied.revision, applied.receipt.next_graph).entity.status, 'candidate');
  assert.deepEqual(f.graph.mutate(f.context, request), { ...applied, status: 'duplicate' });
});

test('forged normalized source, publisher execution, catalog fields and getters cannot create admitted graph facts', t => {
  const { f, event } = first(t), before = rows(f);
  const fake = structuredClone(event); fake.payload.snapshot_id = 'not-an-admitted-snapshot';
  const operations = [assertion(f, fake, 'forged'), assertion(f, event, 'execution', { execution_id: 'invented-host-execution' })];
  for (const a of operations) code(() => f.graph.mutate(f.context, mutation(f, head(f), a)));
  code(() => f.graph.mutate(f.context, { ...mutation(f, head(f), assertion(f, event, 'catalog')), catalog: {} }));
  code(() => f.graph.mutate(f.context, mutation(f, head(f), assertion(f, event, 'raw-vector'), { coverage: { completed_through: 100 } })));
  let hooks = 0; const getter = mutation(f, head(f), assertion(f, event, 'getter'));
  Object.defineProperty(getter, 'epoch', { enumerable: true, get() { hooks++; return f.epoch; } });
  code(() => f.graph.mutate(f.context, getter)); assert.equal(hooks, 0); assert.deepEqual(rows(f), before);
});

test('current ingress restrictions deny historical Graph reads, receipts and pages while Project capture is disabled', t => {
  const { f, source, applied, request } = first(t), reader = f.issue({ principal: 'reader', actions: ['graph:read', 'store:read', 'ingress:read'] }).context;
  assert.equal(point(f, applied.revision, head(f), reader).status, 'resolved');
  const oldHead = head(f), activation = f.activation.get(f.context); f.activation.setEnabled(f.context, { enabled: false, expectedVersion: activation.version });
  assert.equal(point(f, applied.revision, oldHead, reader).status, 'resolved');
  f.ingress.updateSourceAccess(f.context, { registration_id: source.registration_id, expectedVersion: source.version,
    access: { ...source.registration.access, allowed_principal_ids: [] } });
  assert.deepEqual(point(f, applied.revision, oldHead, reader), { status: 'denied', revision: null });
  for (const call of [() => f.graph.getReceipt(f.context, { generation_id: 'generation-1', idempotency_key: request.idempotency_key }),
    () => f.graph.page(reader, { at: oldHead, collection: { kind: 'heads' }, cursor: null, limit: 64 }),
    () => f.graph.mutate(f.context, request)]) code(call, 'graph_access_denied');
  assert.deepEqual(head(f), oldHead);
});

test('live ACL broadening cannot broaden an original event and current sensitivity tightening denies copied evidence', t => {
  const { f, source, applied } = first(t, { principals: ['owner'] });
  const reader = f.issue({ principal: 'reader', actions: ['graph:read', 'store:read', 'ingress:read'] }).context;
  assert.deepEqual(point(f, applied.revision, head(f), reader), { status: 'denied', revision: null });
  const broadened = f.ingress.updateSourceAccess(f.context, { registration_id: source.registration_id, expectedVersion: source.version,
    access: { ...source.registration.access, allowed_principal_ids: ['owner', 'reader', 'extra'] } });
  assert.deepEqual(point(f, applied.revision, head(f), reader), { status: 'denied', revision: null });
  f.ingress.updateSourceAccess(f.context, { registration_id: source.registration_id, expectedVersion: broadened.version,
    access: { ...broadened.registration.access, sensitivity: 'restricted' } });
  assert.deepEqual(point(f, applied.revision), { status: 'denied', revision: null });
});

test('actual lifecycle events require a separate current operator grant and tombstones remain irreversible', t => {
  const { f, source, event, applied } = first(t);
  const tombstone = capture(f, source, { sequence: 1, type: 'tombstone' });
  const request = { epoch: f.epoch, idempotency_key: 'tombstone', publisher_ref: f.publisher.publisher_ref, expected_graph: head(f), operation: { kind: 'source_access', event: tombstone, access_state: 'tombstoned' }, coverage: null };
  const lesser = f.issue({ actions: ACTIONS.filter(x => x !== 'graph:lifecycle') }).context, before = rows(f);
  code(() => f.graph.mutate(lesser, request)); assert.deepEqual(rows(f), before);
  const result = f.graph.mutate(f.context, request); assert(result.access_revision); assert.equal(point(f, applied.revision).status, 'denied');
  const after = rows(f); code(() => f.graph.mutate(f.context, mutation(f, head(f), assertion(f, event, 'reopen', { base_revision: applied.revision })))); assert.deepEqual(rows(f), after);
});

test('real cursor coverage preserves accepted gaps and unknown heads without inventing source completion', t => {
  const f = fixture(t), source = register(f), event0 = capture(f, source), event2 = capture(f, source, { sequence: 2 });
  const selectors = [{ registration_id: source.registration_id, target_event_id: event2.event_id }];
  const genesis = initialize(f, selectors); const commitRows = rows(f).sources.filter(r => r.kind.includes('commit'));
  assert(commitRows.length > 0);
  const sourceCursor = f.ingress.getSource(f.context, { registration_id: source.registration_id }).cursor.state;
  assert.equal(sourceCursor.accepted_through, 0); assert.equal(sourceCursor.completed_through, null);
  const first = f.graph.mutate(f.context, mutation(f, genesis.receipt.next_graph, assertion(f, event0)));
  assert(first.revision); assert.equal(f.ingress.getSource(f.context, { registration_id: source.registration_id }).cursor.state.completed_through, null);
  const receiptText = JSON.stringify(genesis.receipt); assert(!receiptText.includes('caught-up'));
  code(() => f.graph.mutate(f.context, mutation(f, head(f), assertion(f, event0, 'coverage-forged'), { coverage: [{ registration_id: source.registration_id, target_event_id: 'missing' }] })));
  code(() => initialize(f, [...selectors, ...selectors], 'duplicate-coverage'));
});

test('publication identities are actor/installation/epoch scoped and never impersonate a coding host', t => {
  const f = fixture(t), before = rows(f);
  assert.deepEqual(f.graph.registerPublisherRun(f.context, { epoch: f.epoch, run_key: 'synthetic-run' }), { ...f.publisher, status: 'duplicate' }); assert.deepEqual(rows(f), before);
  const source = register(f), event = capture(f, source), genesis = initialize(f);
  const stranger = f.issue({ principal: 'reader' }).context;
  code(() => f.graph.mutate(stranger, mutation(f, genesis.receipt.next_graph, assertion(f, event))));
  const disabled = f.activation.setEnabled(f.context, { enabled: false, expectedVersion: f.activation.get(f.context).version });
  const enabled = f.activation.setEnabled(f.context, { enabled: true, expectedVersion: disabled.version });
  code(() => f.graph.mutate(f.context, mutation(f, genesis.receipt.next_graph, assertion(f, event, 'old-run'), { epoch: enabled.state.epoch })));
  code(() => f.graph.registerPublisherRun(f.context, { epoch: enabled.state.epoch, run_key: 'synthetic-run' }));
  const fresh = f.graph.registerPublisherRun(f.context, { epoch: enabled.state.epoch, run_key: 'fresh-run' });
  assert.notEqual(fresh.execution_id, f.publisher.execution_id);
});

test('scoped authorization, revoked credentials and invalid cursors do not grant cross-Project access', t => {
  const { f, applied } = first(t), address = applied.revision, at = head(f), saved = rows(f);
  const foreign = f.issue({ scope: { ...SCOPE, project_id: 'other-project' } }).context;
  for (const context of [{ ...f.context }, foreign]) code(() => f.graph.resolve(context, { at, address }));
  const issued = f.issue(); f.authority.revoke(issued.issued.credential_id); code(() => f.graph.resolve(issued.context, { at, address }));
  const page = f.graph.page(f.context, { at, collection: { kind: 'heads' }, cursor: null, limit: 1 });
  if (page.next_cursor) { const cursor = { ...page.next_cursor, scope: { ...SCOPE, project_id: 'other-project' } }; code(() => f.graph.page(f.context, { at, collection: { kind: 'heads' }, cursor, limit: 1 })); }
  assert.deepEqual(rows(f), saved);
});

test('bounded rebuild preserves immutable rows and exact views across interruption, duplicate steps and atomic index switch', t => {
  const { f: original, event, applied } = first(t); let f = original, current = applied;
  for (let i = 0; i < 7; i++) current = f.graph.mutate(f.context, mutation(f, head(f), assertion(f, event, `update-${i}`, { base_revision: current.revision })));
  const expected_graph = head(f), exactBefore = point(f, applied.revision, applied.receipt.next_graph), headBefore = point(f, logical());
  const immutableBefore = rows(f).sources;
  const startRequest = { generation_id: 'generation-1', expected_graph, epoch: f.epoch, cursor: null, limit: 2 };
  const start = f.graph.rebuildProjection(f.context, startRequest); assert.equal(start.status, 'building'); assert.equal(start.processed, 0); assert.equal(start.total, 9);
  assert.equal(f.graph.getHead(f.context, { generation_id: 'generation-1' }).maintenance, 'building');
  assert.deepEqual(point(f, applied.revision, applied.receipt.next_graph), exactBefore);
  const saved = rows(f); code(() => f.graph.mutate(f.context, mutation(f, expected_graph, assertion(f, event, 'while-building', { base_revision: current.revision })))); assert.deepEqual(rows(f), saved);
  const firstStep = { ...startRequest, cursor: start.cursor }, step = f.graph.rebuildProjection(f.context, firstStep);
  assert.equal(step.processed, 2);
  const duplicate = f.graph.rebuildProjection(f.context, firstStep); assert.equal(duplicate.status, 'duplicate'); assert.deepEqual({ ...duplicate, status: step.status }, step);
  original.store.close(); f = { ...original, ...original.reopen() };
  let progress = step, calls = 0;
  while (progress.cursor !== null) { assert(++calls < 10); progress = f.graph.rebuildProjection(f.context, { ...startRequest, cursor: progress.cursor }); }
  assert.equal(progress.status, 'complete'); assert.equal(progress.processed, progress.total); assert.equal(f.graph.getHead(f.context, { generation_id: 'generation-1' }).maintenance, null);
  assert.deepEqual(head(f), expected_graph); assert.deepEqual(point(f, applied.revision, applied.receipt.next_graph), exactBefore); assert.deepEqual(point(f, logical()), headBefore);
  const after = new Map(rows(f).sources.map(row => [row.id, row])); for (const retained of immutableBefore) assert.deepEqual(after.get(retained.id), retained);
  const lateRetry = f.graph.rebuildProjection(f.context, firstStep); assert.equal(lateRetry.status, 'duplicate'); assert.deepEqual({ ...lateRetry, status: step.status }, step);
});

test('current opaque authority expiry aborts Graph operations and no provider or host side effect is part of publication', t => {
  const { f, event } = first(t), short = f.issue({ ttl_ms: 1 }), before = rows(f);
  f.clock.now += 2;
  code(() => f.graph.mutate(short.context, mutation(f, head(f), assertion(f, event, 'expired'))));
  assert.deepEqual(rows(f), before); assert.equal(point(f, logical()).status, 'resolved');
});

test('supported single-catalog empty-evidence assertions retain the unchanged V1 semantic revision addresses', t => {
  const f = fixture(t), genesis = initialize(f), catalog = f.registry.identityCatalog(f.context);
  catalog.sessions.push({ tenant_id: SCOPE.tenant_id, session_id: f.publisher.session_id, project_id: SCOPE.project_id, source_installation_id: catalog.source_installations[0].source_installation_id });
  catalog.executions.push({ tenant_id: SCOPE.tenant_id, execution_id: f.publisher.execution_id, session_id: f.publisher.session_id });
  const watermarks = { schema_version: 1, scope: SCOPE, status: 'unknown', watermarks: [] };
  let oracle = createWorkingGraph({ catalog, scope: SCOPE, generation_id: 'generation-1', watermarks }), previous = null;
  for (let i = 0; i < 4; i++) {
    const a = assertion(f, null, `oracle-${i}`, { events: [], base_revision: previous });
    const expected = applyGraphAssertion(oracle, { expected_graph: graphRevisionAddress(oracle), assertion: a }); oracle = expected.state;
    const actual = f.graph.mutate(f.context, mutation(f, head(f), a)); assert.deepEqual(actual.revision, expected.revision); previous = actual.revision;
  }
  assert.equal(point(f, previous).status, 'denied', 'empty evidence has no implicit access grant');
  assert.equal(genesis.receipt.previous_graph, null);
});

test('publication needs its documented write/source actions without an extra Graph read grant', t => {
  const f = fixture(t), source = register(f), event = capture(f, source), writer = f.issue({ actions: ACTIONS.filter(x => x !== 'graph:read') }).context;
  const genesis = f.graph.initialize(writer, { generation_id: 'generation-1', epoch: f.epoch, idempotency_key: 'initialize', publisher_ref: f.publisher.publisher_ref, coverage: [] });
  const result = f.graph.mutate(writer, mutation(f, genesis.receipt.next_graph, assertion(f, event)));
  assert.equal(result.status, 'applied'); assert.equal(point(f, result.revision).status, 'resolved');
  code(() => f.graph.resolve(writer, { at: head(f), address: result.revision }), 'graph_unauthorized');
});

test('receipt and retry authorization includes inherited parent and captured coverage sources', t => {
  const f = fixture(t), restrictedSource = register(f, { partition: 'parent-source' }), publicSource = register(f, { partition: 'child-source' });
  const parentEvent = capture(f, restrictedSource, { objectId: 'parent-object' }), childEvent = capture(f, publicSource, { objectId: 'child-object' });
  const genesis = initialize(f, [{ registration_id: restrictedSource.registration_id, target_event_id: parentEvent.event_id }]);
  const parent = f.graph.mutate(f.context, mutation(f, genesis.receipt.next_graph, assertion(f, parentEvent, 'parent')));
  const request = mutation(f, head(f), assertion(f, childEvent, 'child', { entity_id: 'child', parents: [parent.revision] }));
  const child = f.graph.mutate(f.context, request);
  const coverageOnly = mutation(f, head(f), assertion(f, childEvent, 'coverage-only', { entity_id: 'coverage-only' }));
  const independent = f.graph.mutate(f.context, coverageOnly);
  assert.equal(point(f, child.revision).revision.provenance.events.length, 2);
  f.ingress.updateSourceAccess(f.context, { registration_id: restrictedSource.registration_id, expectedVersion: restrictedSource.version,
    access: { ...restrictedSource.registration.access, allowed_principal_ids: [] } });
  assert.deepEqual(point(f, child.revision), { status: 'denied', revision: null });
  for (const item of [request, coverageOnly]) {
    code(() => f.graph.getReceipt(f.context, { generation_id: 'generation-1', idempotency_key: item.idempotency_key }), 'graph_access_denied');
    code(() => f.graph.mutate(f.context, item), 'graph_access_denied');
  }
  assert.equal(independent.status, 'applied');
});

for (const access_state of ['active', 'unknown', 'tombstoned']) {
  test(`current Graph ${access_state} lifecycle prevents receipt/retry from bypassing evidence quarantine`, t => {
    const { f, source, applied, request, genesis } = first(t);
    const event = capture(f, source, { sequence: 1, type: access_state === 'tombstoned' ? 'tombstone' : 'access' });
    f.graph.mutate(f.context, { epoch: f.epoch, idempotency_key: `lifecycle-${access_state}`,
      publisher_ref: f.publisher.publisher_ref, expected_graph: head(f),
      operation: { kind: 'source_access', event, access_state }, coverage: null });
    assert.equal(point(f, applied.revision).status, 'denied');
    const before = rows(f);
    code(() => f.graph.getReceipt(f.context, { generation_id: 'generation-1', idempotency_key: request.idempotency_key }), 'graph_access_denied');
    const writer = f.issue({ actions: ACTIONS.filter(x => x !== 'graph:read') }).context;
    code(() => f.graph.mutate(writer, request), 'graph_access_denied');
    assert.deepEqual(f.graph.getReceipt(f.context, { generation_id: 'generation-1', idempotency_key: 'initialize' }), genesis.receipt);
    assert.deepEqual(rows(f), before);
  });
}

test('a corrupted retained coverage snapshot cannot erase receipt authorization inputs', t => {
  const f = fixture(t), source = register(f), event = capture(f, source);
  const genesis = initialize(f, [{ registration_id: source.registration_id, target_event_id: event.event_id }]);
  const request = mutation(f, genesis.receipt.next_graph, assertion(f, event));
  const applied = f.graph.mutate(f.context, request);
  const pin = applied.receipt.coverage_pins[0];
  const db = new DatabaseSync(f.filePath);
  try {
    const value = JSON.parse(db.prepare('SELECT value FROM sources WHERE tenant_id=? AND project_id=? AND namespace=? AND id=?')
      .get(SCOPE.tenant_id, SCOPE.project_id, NS, pin.snapshot_ref).value);
    value.cursor.entries = [];
    db.prepare('UPDATE sources SET value=? WHERE tenant_id=? AND project_id=? AND namespace=? AND id=?')
      .run(JSON.stringify(value), SCOPE.tenant_id, SCOPE.project_id, NS, pin.snapshot_ref);
  } finally { db.close(); }
  const before = rows(f);
  code(() => f.graph.getReceipt(f.context, { generation_id: 'generation-1', idempotency_key: request.idempotency_key }), 'graph_corrupt');
  code(() => f.graph.mutate(f.context, request), 'graph_corrupt');
  assert.deepEqual(rows(f), before);
});

test('missing Graph format in a populated namespace cannot be repaired by normal reads, retries or new publication', t => {
  const { f, request } = first(t);
  const db = new DatabaseSync(f.filePath);
  try { db.prepare('DELETE FROM records WHERE tenant_id=? AND project_id=? AND namespace=? AND key=?').run(SCOPE.tenant_id, SCOPE.project_id, NS, 'format'); }
  finally { db.close(); }
  const before = rows(f);
  for (const call of [() => head(f), () => f.graph.mutate(f.context, request),
    () => f.graph.registerPublisherRun(f.context, { epoch: f.epoch, run_key: 'synthetic-run' }),
    () => f.graph.registerPublisherRun(f.context, { epoch: f.epoch, run_key: 'new-after-corruption' }),
    () => initialize(f, [], 'new-generation-after-corruption')]) {
    code(call, 'graph_storage_corrupt'); assert.deepEqual(rows(f), before);
  }
});
