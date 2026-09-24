import test from 'node:test';
import assert from 'node:assert/strict';
import { renameSync } from 'node:fs';
import { fixture, publish, contextRequest, revision, adoption, rows, boundedFailure, head, register, capture, CONTEXT_ACTIONS } from '../support/context-fixture.mjs';

test('typed create, correction, supersession and semantic invalidation retain immutable Context versions and reasons', t => {
  const f = fixture(t), first = publish(f, 'created');
  assert.equal(first.status, 'applied'); assert.equal(revision(f, first).assertion.content.data.change.kind, 'create');
  const corrected = publish(f, 'corrected', { base: first.revision, status: 'validated', typed: { role: 'constraint', detail: 'Corrected explicit meaning.' } });
  assert.equal(revision(f, corrected).assertion.content.data.role, 'constraint');
  assert.equal(revision(f, first).assertion.status, 'candidate');
  const superseded = publish(f, 'superseded', { base: corrected.revision, status: 'superseded', change: 'supersede' });
  assert.equal(revision(f, superseded).assertion.status, 'superseded');
  const stale = publish(f, 'invalidated', { base: superseded.revision, status: 'stale', change: 'invalidate' });
  assert.equal(revision(f, stale).assertion.content.data.change.kind, 'invalidate');
  assert.equal(f.ingress.readEvent(f.context, { event_id: f.event.event_id }).event.event_id, f.event.event_id,
    'semantic invalidation must not revoke its actual source');
});

test('same-generation derivation and branch preserve actual supporting refs; foreign parents cannot cross exploration', t => {
  const f = fixture(t), first = publish(f, 'parent');
  const derived = publish(f, 'derived', { parents: [first.revision] });
  const branch = publish(f, 'variant', { change: 'branch', parents: [first.revision] });
  assert.deepEqual(revision(f, derived).assertion.parents, [first.revision]);
  assert.notEqual(branch.revision.entity_id, first.revision.entity_id);
  const before = rows(f);
  boundedFailure(() => publish(f, 'foreign', { change: 'branch', parents: [first.revision] }, f.b));
  assert.deepEqual(rows(f), before);
});

test('current Graph with stale semantic base keeps conflict; complete explicit resolution alone closes it', t => {
  const f = fixture(t), first = publish(f, 'initial'), second = publish(f, 'second', { base: first.revision });
  const competing = publish(f, 'competing', { base: first.revision }); assert(competing.conflict);
  const conflict = f.graph.resolve(f.context, { at: head(f), address: competing.revision }).conflicts[0];
  const bad = contextRequest(f, f.a, 'omitted-competitor', { change: 'resolve', base: second.revision, status: 'resolved', parents: [second.revision],
    operation_kind: 'resolve', conflict_digest: conflict.conflict_digest });
  const before = rows(f); boundedFailure(() => f.contexts.mutate(f.context, bad)); assert.deepEqual(rows(f), before);
  const resolved = publish(f, 'resolved', { change: 'resolve', base: second.revision, status: 'resolved', parents: conflict.assertions,
    operation_kind: 'resolve', conflict_digest: conflict.conflict_digest });
  assert.equal(revision(f, resolved).assertion.status, 'resolved');
  assert.equal(f.graph.resolve(f.context, { at: head(f), address: resolved.revision }).conflicts.length, 0);
});

test('stale Graph produces no effects and exact typed retry shares the underlying exploration effect', t => {
  const f = fixture(t), request = contextRequest(f, f.a, 'one'), stale = contextRequest(f, f.a, 'two');
  const first = f.contexts.mutate(f.context, request), before = rows(f);
  const refusal = f.contexts.mutate(f.context, stale); assert.equal(refusal.status, 'graph_revision_mismatch'); assert.deepEqual(rows(f), before);
  assert.deepEqual(f.contexts.mutate(f.context, request), { ...first, status: 'duplicate' });
  assert.deepEqual(f.explorations.mutate(f.context, request), { ...first, status: 'duplicate' });
  const { shared, ...receipt } = f.contexts.getReceipt(f.context, { idempotency_key: request.idempotency_key });
  assert.deepEqual(receipt, first.receipt); assert.equal(shared.current_project.version, null);
  assert.equal(shared.origin_base.status, 'unavailable');
  boundedFailure(() => f.contexts.mutate(f.context, { ...request, operation: { ...request.operation,
    assertion: { ...request.operation.assertion, content: { ...request.operation.assertion.content, data: { ...request.operation.assertion.content.data, summary: 'changed intent' } } } } }));
  assert.deepEqual(rows(f), before);
});

test('A supersession leaves the explicitly adopted B instance and source origin unchanged', t => {
  const f = fixture(t), first = publish(f, 'source');
  const copied = f.contexts.adopt(f.context, adoption(f, { source: first, key: 'context-adoption' }));
  const beforeB = revision(f, copied), superseded = publish(f, 'source-superseded', { base: first.revision, status: 'superseded', change: 'supersede' });
  assert.equal(revision(f, superseded).assertion.status, 'superseded');
  assert.deepEqual(revision(f, copied), beforeB); assert.equal(beforeB.assertion.status, 'candidate');
  assert.equal(copied.adoption.source.operation_origin_ref, first.operation_origin_ref);
  assert.deepEqual(beforeB.assertion.content, revision(f, first).assertion.content);
});

test('fresh support correction may use inaccessible old base while an explicit parent cannot inherit denied sources', t => {
  const f = fixture(t), secret = register(f, { partition: 'private-old', principals: ['owner'] });
  const oldEvent = capture(f, secret, { key: 'private-old', principals: ['owner'] });
  const old = publish(f, 'old-private', { events: [oldEvent] });
  f.context = f.issue({ principal: 'reader', actions: CONTEXT_ACTIONS }).context;
  f.publisher = f.graph.registerPublisherRun(f.context, { epoch: f.epoch, run_key: 'reader-correction' });
  assert.equal(f.graph.resolve(f.context, { at: old.receipt.next_graph, address: old.revision }).status, 'denied');
  const corrected = publish(f, 'public-correction', { base: old.revision, events: [f.event] });
  assert.equal(revision(f, corrected).assertion.content.data.summary, 'Synthetic public-correction');
  const before = rows(f);
  boundedFailure(() => publish(f, 'forbidden-parent', { parents: [old.revision] })); assert.deepEqual(rows(f), before);
});

test('typed committed retry survives restart, disabled project and missing worktree before new physical inspection', t => {
  const f = fixture(t), request = contextRequest(f, f.a, 'before-restart'), result = f.contexts.mutate(f.context, request);
  const activation = f.activation.get(f.context); f.activation.setEnabled(f.context, { enabled: false, expectedVersion: activation.version });
  renameSync(f.folder, `${f.folder}-gone`); const before = rows(f); f.store.close(); const next = f.reopen();
  assert.deepEqual(next.contexts.mutate(next.context, request), { ...result, status: 'duplicate' });
  const { shared, ...receipt } = next.contexts.getReceipt(next.context, { idempotency_key: request.idempotency_key });
  assert.deepEqual(receipt, result.receipt); assert.equal(shared.current_project.version, null);
  assert.deepEqual(rows(next), before);
});
