import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ExplorationInputs, EXPLORATION_NAMESPACE } from '../../src/application/explorations/exploration-inputs.mjs';
import { composeLocalServices } from '../../src/application/support/local-runtime-composition.mjs';
import { graphHash, graphErrorCode } from '../../src/application/graph/graph-inputs.mjs';
import { fixture, adoption, ADOPTION_ACTIONS } from '../support/adoption-fixture.mjs';
import { bind, mutation, pin, rows } from '../support/exploration-fixture.mjs';

function inputs(f) {
  return composeLocalServices({ store: f.store, authority: f.authority, canonical_reader: f.config }).inputs;
}
function read(f, callback, context = f.context) {
  let code;
  try { return f.store.readSnapshot(context, view => { try { return callback(view); } catch (error) { code = graphErrorCode(error); throw error; } }); }
  catch (error) { if (code) throw Object.assign(new Error(code), { code }); throw error; }
}
// These tests exercise only the fixed metadata port. The summary is assembled
// from actual publication refs; selected semantic proof is tested by the public suite.
function route(f, port, request = adoption(f), observation = port.preflight(f.context, { kind: 'adopt', request })) {
  const summary = { source: { ...request.source, generation_id: request.source.at.generation_id,
    operation_origin_ref: f.original.operation_origin_ref }, endpoint_map: [] };
  return read(f, view => port.adoption(view, f.context, { request, observation, adoption: summary,
    shared: { source_fence: request.expected_source_fence, origin_base: observation.origin_base, project_selection: observation.project_selection } }).route);
}

test('adoption parsing is inert and normalizes endpoint maps without changing caller data', t => {
  const f = fixture(t), port = inputs(f), request = adoption(f);
  const relation = { ...request.source.address, entity_kind: 'relation' };
  const a1 = { ...request.source.address, entity_id: 'a1' }, a2 = { ...request.source.address, entity_id: 'a2' };
  const b1 = { ...a1, generation_id: f.b.generation_id }, b2 = { ...a2, generation_id: f.b.generation_id };
  const left = { ...request, source: { ...request.source, address: relation },
    endpoint_map: [{ source: a2, destination: b2 }, { source: a1, destination: b1 }] };
  const before = structuredClone(left), right = { ...left, endpoint_map: [...left.endpoint_map].reverse() };
  assert.deepEqual(port.parse('adopt', left), port.parse('adopt', right)); assert.deepEqual(left, before);
  assert(Object.isFrozen(port.parse('adopt', left).endpoint_map[0].source));
  let reads = 0;
  const getter = { ...request }; Object.defineProperty(getter, 'source', { enumerable: true, get() { reads++; return request.source; } });
  for (const invalid of [getter, { ...request, content: 'untrusted' },
    { ...left, endpoint_map: [left.endpoint_map[0], left.endpoint_map[0]] },
    { ...request, source: { ...request.source, expected_head: request.destination.expected_graph } }]) assert.throws(() => port.parse('adopt', invalid));
  assert.equal(reads, 0);
});

test('adoption preflight proof binds the entire request and cannot be copied', t => {
  const f = fixture(t), port = inputs(f), request = adoption(f), observation = port.preflight(f.context, { kind: 'adopt', request });
  const before = rows(f);
  assert.throws(() => route(f, port, request, { ...observation }), { code: 'invalid_exploration_input' });
  const changed = { ...request, source: { ...request.source, expected_head: f.a.graph_revision } };
  assert.throws(() => route(f, port, changed, observation), { code: 'invalid_exploration_input' });
  const prepared = route(f, port, request, observation);
  assert.equal(prepared.kind, 'adopt'); assert.equal(prepared.exploration_id, f.b.exploration_id);
  assert.equal(prepared.adoption.source.operation_origin_ref, f.original.operation_origin_ref);
  assert.throws(() => read(f, view => port.assertUnchanged(view, f.context, { ...prepared })), { code: 'invalid_exploration_input' });
  assert.deepEqual(rows(f), before);
});

test('adoption private route rechecks the immutable source origin and explicit authority', t => {
  const f = fixture(t), port = inputs(f), prepared = route(f, port), before = f.store.getSource(f.context, EXPLORATION_NAMESPACE, f.a.exploration_id);
  const db = new DatabaseSync(f.filePath); t.after(() => db.close());
  const { identity, ...body } = structuredClone(before.value);
  body.origin.epoch += 1;
  const changed = { ...body, identity: graphHash(body) };
  const update = db.prepare('UPDATE sources SET value=? WHERE namespace=? AND id=?');
  update.run(JSON.stringify(changed), EXPLORATION_NAMESPACE, f.a.exploration_id);
  assert.throws(() => read(f, view => port.assertUnchanged(view, f.context, prepared)), { code: 'exploration_source_conflict' });
  update.run(JSON.stringify(before.value), EXPLORATION_NAMESPACE, f.a.exploration_id);
  assert.equal(read(f, view => port.assertUnchanged(view, f.context, prepared)), true);
  const missingAction = f.issue({ actions: ADOPTION_ACTIONS.filter(action => action !== 'exploration:adopt') }).context;
  assert.throws(() => read(f, view => port.assertUnchanged(view, missingAction, prepared), missingAction), { code: 'exploration_unauthorized' });
});

test('stored unsorted origin base pins remain immutable and equivalent normalized requests retry exactly', t => {
  const f = fixture(t, { canonical: true }), base = pin(f.canonical, ['decision', 'authority']);
  f.a = bind(f, { key: 'pinned-a', shared_base: base });
  f.b = bind(f, { key: 'pinned-b', execution: f.executionB, shared_base: base });
  f.original = f.explorations.mutate(f.context, mutation(f, f.a, 'pinned-source'));
  const request = adoption(f), beforeA = f.store.getSource(f.context, EXPLORATION_NAMESPACE, f.a.exploration_id);
  const beforeB = f.store.getSource(f.context, EXPLORATION_NAMESPACE, f.b.exploration_id);
  const result = f.explorations.adopt(f.context, request);
  const reversed = structuredClone(request); reversed.source.shared_base.record_keys.reverse(); reversed.destination.shared_base.record_keys.reverse();
  assert.deepEqual(f.explorations.adopt(f.context, reversed), { ...result, status: 'duplicate' });
  assert.deepEqual(f.store.getSource(f.context, EXPLORATION_NAMESPACE, f.a.exploration_id), beforeA);
  assert.deepEqual(f.store.getSource(f.context, EXPLORATION_NAMESPACE, f.b.exploration_id), beforeB);
  assert.deepEqual(beforeA.value.origin.shared_base.record_keys, ['decision', 'authority']);
});

test('retained adoption receipt keeps normalized request and still requires adoption plus source-read authority', t => {
  const f = fixture(t), port = inputs(f), request = adoption(f), result = f.explorations.adopt(f.context, request);
  const readActions = ADOPTION_ACTIONS.filter(action => !action.endsWith(':write'));
  const reader = f.issue({ actions: readActions }).context;
  const retained = read(f, view => port.receipt(view, reader, { idempotency_key: request.idempotency_key }), reader);
  assert.deepEqual(retained.request, port.parse('adopt', request)); assert.deepEqual(retained.result.revision, result.revision);
  for (const omitted of ['exploration:adopt', 'source:read']) {
    const limited = f.issue({ actions: readActions.filter(action => action !== omitted) }).context;
    assert.throws(() => read(f, view => port.receipt(view, limited, { idempotency_key: request.idempotency_key }), limited), { code: 'exploration_unauthorized' });
  }
});
