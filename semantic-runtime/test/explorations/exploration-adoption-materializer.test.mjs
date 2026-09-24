import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixture, adoption, ADOPTION_ACTIONS } from '../support/adoption-fixture.mjs';
import { mutation, assertion, rows, resolve, capture, register, bind, SCOPE } from '../support/exploration-fixture.mjs';
import { GraphInputs, graphKey, graphHash } from '../../src/application/graph/graph-inputs.mjs';
import { GraphStorage } from '../../src/adapters/sqlite/graph-storage.mjs';
import { materializeExplorationAdoption } from '../../src/application/explorations/exploration-adoption.mjs';
import { ExplorationInputs } from '../../src/application/explorations/exploration-inputs.mjs';
import { composeLocalServices } from '../../src/application/support/local-runtime-composition.mjs';
import { canonicalArtifactAddress } from '../../src/domain/graph/working-graph.mjs';
import { sourceLifecycleInvalidationId } from '../../src/application/sources/source-invalidation.mjs';

function selected(f, request) {
  return { source: f.graph.resolve(f.context, { at: request.source.at, address: request.source.address }),
    endpoints: request.endpoint_map.map(pair => ({ ...pair, resolved: f.graph.resolve(f.context,
      { at: request.destination.expected_graph, address: pair.destination }) })) };
}
function materialize(f, request, selections = selected(f, request)) {
  const config_digest = composeLocalServices({ store: f.store, authority: f.authority, canonical_reader: f.config }).canonical.config_digest;
  const inputs = new ExplorationInputs({ store: f.store, authority: f.authority, config_digest });
  const normalized = inputs.parse('adopt', request);
  let code;
  try { return f.store.readSnapshot(f.context, view => {
    try { return materializeExplorationAdoption({ view, context: f.context,
      inputs: new GraphInputs({ store: f.store, authority: f.authority }), request: normalized, ...selections,
      source_storage: new GraphStorage({ view, scope: SCOPE, generation_id: request.source.at.generation_id }),
      destination_storage: new GraphStorage({ view, scope: SCOPE, generation_id: request.destination.expected_graph.generation_id }),
      grant: f.authority.inspect(f.context), execution_id: f.publisher.execution_id, config_digest,
      source_exploration: inputs.getExploration(view, f.context, { exploration_id: request.source.exploration_id }),
      destination_exploration: inputs.getExploration(view, f.context, { exploration_id: request.destination.exploration_id }) }); }
    catch (error) { code = error.code; throw error; }
  }); } catch (error) { if (code) throw Object.assign(new Error(code), { code }); throw error; }
}
function write(f, binding, name, overrides = {}) {
  const expected_graph = f.graph.getHead(f.context, { generation_id: binding.generation_id }).graph_revision;
  return f.explorations.mutate(f.context, mutation(f, binding, name, { expected_graph,
    operation: { kind: 'assert', assertion: assertion(f, f.event, name, overrides) } }));
}
function relation(f, from, to, name = 'rel') {
  return write(f, f.a, name, { entity_kind: 'relation', entity_id: name,
    content: { relation_type: 'RELEVANT_TO', from, to, data: { strength: 'synthetic' } }, events: [] });
}
function immutableEvent(f, { key, sequence, type = 'note', principals = ['owner', 'reader'], source = f.source } = {}) {
  const original = f.ingress.readEvent(f.context, { event_id: f.event.event_id }).raw;
  const raw = structuredClone(original), acl = { revision: `acl-${key}`, allowed_principal_ids: principals };
  Object.assign(raw, { event_id: f.ingress.eventIdFor(f.context, { registration_id: source.registration_id, idempotency_key: key }),
    partition: source.registration.partition, source_native_event_id: key, idempotency_key: key, source_event_type: type,
    producer: { ...source.registration.producer, sequence }, acl });
  raw.provenance.delivery.delivery_id = key; raw.provenance.source_objects.forEach(s => { s.acl = acl; });
  raw.payload = { kind: 'object_revision', object: raw.provenance.source_objects[0].object, revision_id: key, digest: graphHash({ key }) };
  if (type === 'access') {
    f.ingress.submitSourceLifecycle(f.context, { registration_id: source.registration_id, epoch: f.epoch, event: raw,
      expectedVersion: f.ingress.getSource(f.context, { registration_id: source.registration_id }).version, access_state: 'active', access: null });
    return f.feed.readLifecycleEvent(f.context, { invalidation_id: sourceLifecycleInvalidationId(SCOPE, raw.event_id) }).event;
  }
  f.ingress.submit(f.context, { registration_id: source.registration_id, epoch: f.epoch, event: raw });
  return f.ingress.readEvent(f.context, { event_id: raw.event_id }).event;
}
function applyLifecycle(f, binding, event) {
  return f.graph.mutate(f.context, { epoch: f.epoch, idempotency_key: `apply-${binding.exploration_id}-${event.event_id}`,
    publisher_ref: f.publisher.publisher_ref, expected_graph: f.graph.getHead(f.context, { generation_id: binding.generation_id }).graph_revision,
    operation: { kind: 'source_access', event, access_state: 'active' }, coverage: null, expected_source_fence: f.feed.head(f.context).sequence });
}

test('internal materializer returns deterministic candidate content without any durable writes', t => {
  const f = fixture(t), request = adoption(f), before = rows(f), first = materialize(f, request);
  assert.deepEqual(materialize(f, request), first); assert.deepEqual(rows(f), before);
  assert.equal(first.operation.kind, 'assert'); assert.equal(first.operation.assertion.status, 'candidate');
  assert.deepEqual(first.operation.assertion.parents, []); assert.equal(first.operation.assertion.base_revision, null);
  assert.deepEqual(first.operation.assertion.events, selected(f, request).source.revision.provenance.events);
  assert.equal(first.adoption.source.operation_origin_ref, f.original.operation_origin_ref);
  assert.notEqual(materialize(f, { ...request, idempotency_key: 'different-intent' }).operation.assertion.entity_id,
    first.operation.assertion.entity_id);
});

test('an actual derived A assertion flattens inherited ordinary evidence without introducing a foreign parent', t => {
  const f = fixture(t), derived = write(f, f.a, 'derived', { entity_id: 'derived', parents: [f.original.revision], events: [] });
  const result = materialize(f, adoption(f, { source: derived }));
  assert.deepEqual(result.operation.assertion.parents, []);
  assert.deepEqual(result.operation.assertion.events, resolve(f, f.a, derived).local.revision.provenance.events);
  assert.equal(result.operation.assertion.events.length, 1);
});

for (const kind of ['graph-commit-receipt', 'graph-receipt', 'graph-command', 'exploration-operation-origin', 'exploration-operation']) {
  test(`selected source publication refuses missing ${kind} without rewriting anything`, t => {
    const f = fixture(t), request = adoption(f), selections = selected(f, request);
    const receipt = f.original.receipt;
    const key = [1, SCOPE, receipt.actor, f.a.generation_id, receipt.idempotency_key];
    const id = kind === 'graph-commit-receipt' ? graphKey('commit-receipt', receipt.next_graph)
      : kind === 'graph-receipt' ? graphKey('receipt', key)
      : kind === 'graph-command' ? graphKey('command', key)
      : kind === 'exploration-operation-origin' ? f.original.operation_origin_ref
      : graphKey('operation', [SCOPE, 'owner', 'mutate-adoption-source']);
    const db = new DatabaseSync(f.filePath);
    try { assert.equal(db.prepare('DELETE FROM sources WHERE tenant_id=? AND project_id=? AND id=? AND kind=?').run(
      SCOPE.tenant_id, SCOPE.project_id, id, kind).changes, 1); } finally { db.close(); }
    const before = rows(f); assert.throws(() => materialize(f, request, selections), { code: 'exploration_corrupt' });
    assert.deepEqual(rows(f), before);
  });
}

test('rewriting a selected receipt cannot evade the actual command digest binding', t => {
  const f = fixture(t), request = adoption(f), selections = selected(f, request), receipt = structuredClone(f.original.receipt);
  receipt.operation_origin_ref = 'fabricated-origin';
  const id = graphKey('receipt', [1, SCOPE, receipt.actor, f.a.generation_id, receipt.idempotency_key]);
  const db = new DatabaseSync(f.filePath);
  try { assert.equal(db.prepare('UPDATE sources SET value=? WHERE namespace=? AND id=?').run(JSON.stringify(receipt), 'working-graph', id).changes, 1); }
  finally { db.close(); }
  const before = rows(f); assert.throws(() => materialize(f, request, selections), { code: 'exploration_corrupt' }); assert.deepEqual(rows(f), before);
});

test('a previously authorized selection is rechecked against actual current ingress permissions', t => {
  const f = fixture(t), request = adoption(f), selections = selected(f, request);
  f.ingress.updateSourceAccess(f.context, { registration_id: f.source.registration_id, expectedVersion: f.source.version,
    access: { ...f.source.registration.access, allowed_principal_ids: ['reader'] } });
  const before = rows(f); assert.throws(() => materialize(f, request, selections), { code: 'graph_access_denied' }); assert.deepEqual(rows(f), before);
});

test('relation endpoints require successful adoption of the same exact A endpoints, even for equal B text', t => {
  const f = fixture(t), second = write(f, f.a, 'second-endpoint', { entity_id: 'second-endpoint' });
  const rel = relation(f, f.original.revision, second.revision), firstB = f.explorations.adopt(f.context, adoption(f, { key: 'endpoint-one' }));
  const secondB = f.explorations.adopt(f.context, adoption(f, { key: 'endpoint-two', source: second }));
  const endpoint_map = [{ source: f.original.revision, destination: firstB.revision }, { source: second.revision, destination: secondB.revision }];
  const request = adoption(f, { key: 'relation', source: rel, endpoint_map }), before = rows(f);
  const material = materialize(f, request);
  assert.deepEqual(material.operation.assertion.content.from, firstB.revision);
  assert.deepEqual(material.operation.assertion.content.to, secondB.revision);
  assert.deepEqual(rows(f), before);
  const copied = write(f, f.b, 'same-text-unadopted', { entity_id: 'same-text-unadopted', content: resolve(f, f.a, f.original).local.revision.assertion.content });
  const fake = adoption(f, { key: 'not-adopted-endpoint', source: rel, endpoint_map: [
    { source: f.original.revision, destination: copied.revision }, { source: second.revision, destination: secondB.revision }] });
  assert.throws(() => materialize(f, fake), { code: 'invalid_exploration_input' });
  const wrong = adoption(f, { key: 'swapped-endpoints', source: rel, endpoint_map: [
    { source: f.original.revision, destination: secondB.revision }, { source: second.revision, destination: firstB.revision }] });
  assert.throws(() => materialize(f, wrong), { code: 'invalid_exploration_input' });
});

test('another authorized actor can use immutable prior endpoint adoption without owner-private receipts', t => {
  const f = fixture(t), rel = relation(f, f.original.revision, f.original.revision);
  const firstB = f.explorations.adopt(f.context, adoption(f, { key: 'owner-endpoint' }));
  f.context = f.issue({ principal: 'reader', actions: ADOPTION_ACTIONS }).context;
  f.publisher = f.graph.registerPublisherRun(f.context, { epoch: f.epoch, run_key: 'reader-publication' });
  const request = adoption(f, { key: 'reader-relation', source: rel,
    endpoint_map: [{ source: f.original.revision, destination: firstB.revision }] });
  const result = f.explorations.adopt(f.context, request);
  assert.equal(result.status, 'applied'); assert.equal(result.receipt.actor, 'reader');
  assert.equal(result.adoption.endpoint_map[0].operation_origin_ref, firstB.operation_origin_ref);
  assert.deepEqual(resolve(f, f.b, result).local.revision.assertion.content.from, firstB.revision);
});

test('materializer rejects accessor data before invoking its getters', t => {
  const f = fixture(t), request = adoption(f), selections = selected(f, request); let getters = 0;
  Object.defineProperty(selections.source.revision.assertion.content.data, 'attack', { enumerable: true, get() { getters++; return 'no'; } });
  assert.throws(() => materialize(f, request, selections)); assert.equal(getters, 0);
});

test('canonical associations and canonical relation endpoints retain exact source artifacts', t => {
  const f = fixture(t), event = immutableEvent(f, { key: 'canonical-object', sequence: 1 }), artifact = canonicalArtifactAddress(event);
  const item = write(f, f.a, 'canonical-associated', { entity_id: 'canonical-associated', canonical_refs: [artifact] });
  const itemB = f.explorations.adopt(f.context, adoption(f, { key: 'canonical-associated-adoption', source: item }));
  assert.deepEqual(resolve(f, f.b, itemB).local.revision.assertion.canonical_refs, [artifact]);
  const rel = relation(f, item.revision, artifact, 'canonical-endpoint');
  const result = f.explorations.adopt(f.context, adoption(f, { key: 'canonical-relation', source: rel,
    endpoint_map: [{ source: item.revision, destination: itemB.revision }] }));
  const content = resolve(f, f.b, result).local.revision.assertion.content;
  assert.deepEqual(content.from, itemB.revision); assert.deepEqual(content.to, artifact);
});

test('missing B lifecycle projection refuses; actual pre-admitted B restriction is preserved separately from ordinary support', t => {
  const f = fixture(t); write(f, f.b, 'warm-destination', { entity_id: 'warm-destination' });
  const event = immutableEvent(f, { key: 'owner-access', sequence: 1, type: 'access', principals: ['owner'] });
  applyLifecycle(f, f.a, event);
  const updated = write(f, f.a, 'restricted-source', { entity_id: 'restricted-source', access_revisions: [graphHash(event)] });
  const request = adoption(f, { source: updated, key: 'restricted-adoption' }), before = rows(f);
  assert.throws(() => f.explorations.adopt(f.context, request), { code: 'graph_access_denied' }); assert.deepEqual(rows(f), before);
  applyLifecycle(f, f.b, event);
  const result = f.explorations.adopt(f.context, adoption(f, { source: updated, key: 'restricted-adoption' }));
  const revision = resolve(f, f.b, result).local.revision;
  assert.deepEqual(revision.provenance.access_events, [event]); assert.deepEqual(revision.assertion.access_revisions, [graphHash(event)]);
  assert(revision.assertion.events.every(e => e.event_type !== 'SOURCE_ACCESS_CHANGED'));
  assert.deepEqual(revision.provenance.effective_access.allowed_principal_ids, ['owner']);
  const other = f.issue({ principal: 'reader', actions: ADOPTION_ACTIONS }).context;
  assert.equal(f.graph.resolve(other, { at: result.receipt.next_graph, address: result.revision }).status, 'denied');
});

test('aggregate ordinary plus lifecycle support admits32 but rejects33 without truncation or effects', t => {
  const f = fixture(t), events = [f.event];
  for (let sequence = 1; sequence <= 31; sequence++) events.push(capture(f, f.source, { sequence, key: `bounded-${sequence}` }));
  write(f, f.a, 'observe-all', { entity_id: 'observe-all', events });
  write(f, f.b, 'observe-all-b', { entity_id: 'observe-all-b', events });
  const access = immutableEvent(f, { key: 'bounded-access', sequence: 32, type: 'access' });
  applyLifecycle(f, f.a, access); applyLifecycle(f, f.b, access);
  const inside = write(f, f.a, 'inside-bound', { entity_id: 'inside-bound', events: events.slice(0, 31), access_revisions: [graphHash(access)] });
  const accepted = f.explorations.adopt(f.context, adoption(f, { source: inside, key: 'inside-adoption' }));
  assert.equal(resolve(f, f.b, accepted).local.revision.provenance.events.length, 31);
  const outside = write(f, f.a, 'outside-bound', { entity_id: 'outside-bound', events, access_revisions: [graphHash(access)] });
  const request = adoption(f, { source: outside, key: 'outside-adoption' }), before = rows(f);
  assert.throws(() => f.explorations.adopt(f.context, request), { code: 'exploration_capacity' }); assert.deepEqual(rows(f), before);
});

test('extra B lifecycle restrictions remain effective through adopted relation endpoints', t => {
  const f = fixture(t), other = register(f, { partition: 'other-observer', producerEpoch: 'observer-2' });
  const ordinary = capture(f, other, { key: 'other-evidence', sequence: 0 });
  write(f, f.b, 'observe-second-stream', { entity_id: 'observe-second-stream', events: [ordinary] });
  const access = immutableEvent(f, { source: other, key: 'other-private-access', sequence: 1, type: 'access', principals: ['owner'] });
  applyLifecycle(f, f.b, access);
  const endpoint = f.explorations.adopt(f.context, adoption(f, { key: 'private-destination-endpoint' }));
  const rel = relation(f, f.original.revision, f.original.revision, 'restricted-endpoint-relation');
  const request = adoption(f, { source: rel, key: 'with-extra-destination-restriction',
    endpoint_map: [{ source: f.original.revision, destination: endpoint.revision }] });
  const result = f.explorations.adopt(f.context, request), revision = resolve(f, f.b, result).local.revision;
  assert.deepEqual(revision.provenance.access_events, [access]);
  assert.deepEqual(revision.provenance.effective_access.allowed_principal_ids, ['owner']);
  assert.deepEqual(revision.assertion.access_revisions, [graphHash(access)]);
  const reader = f.issue({ principal: 'reader', actions: ADOPTION_ACTIONS }).context;
  assert.equal(f.graph.resolve(reader, { at: result.receipt.next_graph, address: result.revision }).status, 'denied');
  assert.equal(f.graph.resolve(reader, { at: rel.receipt.next_graph, address: rel.revision }).status, 'resolved');
  const registration = f.ingress.getRegistration(f.context, { registration_id: other.registration_id });
  f.ingress.updateSourceAccess(f.context, { registration_id: other.registration_id, expectedVersion: registration.version,
    access: { ...registration.registration.access, allowed_principal_ids: [] } });
  assert.equal(f.graph.resolve(f.context, { at: rel.receipt.next_graph, address: rel.revision }).status, 'resolved');
  const fresh = adoption(f, { source: rel, key: 'after-b-only-endpoint-revocation',
    endpoint_map: [{ source: f.original.revision, destination: endpoint.revision }] }), before = rows(f);
  assert.throws(() => f.explorations.adopt(f.context, fresh), { code: 'graph_access_denied' });
  assert.deepEqual(rows(f), before);
});

test('an already adopted relation may be an explicit endpoint without recursively adopting anything', t => {
  const f = fixture(t), entity = f.explorations.adopt(f.context, adoption(f, { key: 'entity-endpoint' }));
  const rel = relation(f, f.original.revision, f.original.revision, 'relation-as-endpoint');
  const mapped = f.explorations.adopt(f.context, adoption(f, { source: rel, key: 'adopt-relation-endpoint',
    endpoint_map: [{ source: f.original.revision, destination: entity.revision }] }));
  const nested = relation(f, rel.revision, f.original.revision, 'nested-relation');
  const result = f.explorations.adopt(f.context, adoption(f, { source: nested, key: 'adopt-nested-relation', endpoint_map: [
    { source: rel.revision, destination: mapped.revision }, { source: f.original.revision, destination: entity.revision }] }));
  const revision = resolve(f, f.b, result).local.revision;
  assert.deepEqual(revision.assertion.content.from, mapped.revision); assert.deepEqual(revision.assertion.content.to, entity.revision);
  assert.equal(result.adoption.endpoint_map.length, 2);
});

test('canonical service metadata and ineligible assertion states never become adopted candidates', t => {
  const f = fixture(t);
  for (const status of ['rejected', 'stale', 'superseded']) {
    const initial = write(f, f.a, `initial-${status}`, { entity_id: `ineligible-${status}` });
    const item = write(f, f.a, `ineligible-${status}`, { entity_id: `ineligible-${status}`, status, base_revision: initial.revision });
    const request = adoption(f, { source: item, key: `adopt-${status}` }), before = rows(f);
    assert.throws(() => f.explorations.adopt(f.context, request), { code: 'graph_access_denied' }); assert.deepEqual(rows(f), before);
  }
  const metadata = write(f, f.a, 'service-metadata', { entity_id: 'service-metadata', content: { semantic_type: 'canonical-selection', data: {} } });
  const request = adoption(f, { source: metadata, key: 'adopt-metadata' }), before = rows(f);
  assert.throws(() => f.explorations.adopt(f.context, request), { code: 'invalid_exploration_input' }); assert.deepEqual(rows(f), before);
});

test('legitimate A to B to C re-adoption preserves separate exact publication origins', t => {
  const f = fixture(t), b = f.explorations.adopt(f.context, adoption(f, { key: 'first-adoption' }));
  const c = bind(f, { key: 'third-exploration', execution: f.executionB });
  const request = adoption(f, { source: b, a: f.b, b: c, key: 'second-adoption' });
  const result = f.explorations.adopt(f.context, request);
  assert.equal(result.status, 'applied');
  assert.equal(result.adoption.source.operation_origin_ref, b.operation_origin_ref);
  const bOrigin = f.store.getSource(f.context, 'exploration-projection', b.operation_origin_ref).value;
  assert.equal(bOrigin.adoption.source.operation_origin_ref, f.original.operation_origin_ref);
  assert.deepEqual(resolve(f, c, result).local.revision.assertion.content, resolve(f, f.a, f.original).local.revision.assertion.content);
  assert.deepEqual(f.explorations.adopt(f.context, request), { ...result, status: 'duplicate' });
});
