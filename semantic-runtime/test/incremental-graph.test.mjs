import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { canonical } from '../src/core/contracts.mjs';
import { graph, assertion, event, scope, catalog, watermarks } from './fixtures/working-graph/scenario.mjs';
import { semanticAddress, canonicalArtifactAddress, graphRevisionAddress, applyGraphAssertion, resolveGraphConflict,
  updateGraphSourceAccess, resolveWorkingGraphAddress } from '../src/core/working-graph.mjs';
import { planGraphGenesis, planGraphMutation, resolveIncrementalGraph, pageIncrementalGraph } from '../src/core/incremental-graph.mjs';
import { IndexedGraphFixture } from './helpers/incremental-graph-fixture.mjs';

const canonicalBytes = value => Buffer.from(JSON.stringify(canonical(value)));
const logical = (entity_id = 'context-a', entity_kind = 'entity') => semanticAddress({ scope, generation_id: 'live-1', entity_kind, entity_id });
function fixture() {
  const f = new IndexedGraphFixture({ catalog: catalog(), scope, watermarks: watermarks() });
  const genesis = planGraphGenesis(f.port, { scope, generation_id: 'live-1', catalog_pin: f.catalogPin, watermarks: f.watermarks });
  assert.equal(genesis.status, 'planned'); f.commit(genesis.plan); return f;
}
function command(f, operation) { return { schema_version: 2, kind: 'graph_mutation', expected_graph: f.head, catalog_pin: f.catalogPin, operation }; }
function retainOperation(f, operation) {
  if (operation.kind === 'source_access') f.retainEvent(operation.event);
  for (const e of operation.assertion?.events ?? []) f.retainEvent(e);
  for (const ref of operation.assertion?.canonical_refs ?? []) f.retainEvent(ref.event);
  if (operation.assertion?.entity_kind === 'relation') for (const ref of [operation.assertion.content.from, operation.assertion.content.to]) if (ref.kind === 'canonical_artifact') f.retainEvent(ref.event);
}
function applyIncremental(f, operation) {
  retainOperation(f, operation); const result = planGraphMutation(f.port, command(f, operation));
  assert.equal(result.status, 'planned'); f.commit(result.plan); return result;
}
function pair() {
  const f = fixture(); let v1 = graph();
  return { f, get v1() { return v1; },
    step(operation) {
      // V1 has no caller-auth input; compare admitted semantics under the allowed synthetic principal.
      f.setPrincipal('alice');
      retainOperation(f, operation);
      const next1 = operation.kind === 'assert' ? applyGraphAssertion(v1, { expected_graph: graphRevisionAddress(v1), assertion: operation.assertion, ...(operation.watermarks ? { watermarks: operation.watermarks } : {}) })
        : operation.kind === 'resolve' ? resolveGraphConflict(v1, { expected_graph: graphRevisionAddress(v1), assertion: operation.assertion, conflict_digest: operation.conflict_digest })
        : updateGraphSourceAccess(v1, { expected_graph: graphRevisionAddress(v1), event: operation.event, access_state: operation.access_state });
      const next2 = planGraphMutation(f.port, command(f, operation)); assert.equal(next2.status, 'planned');
      if (next1.revision) {
        assert.deepEqual(next2.revision, next1.revision);
        const immutable = next2.plan.append.find(row => row.kind === 'revision').value;
        assert.deepEqual(canonicalBytes(immutable), canonicalBytes(next1.state.snapshots.at(-1).revisions.at(-1)));
      }
      if (next1.conflict) assert.deepEqual(canonicalBytes(next2.conflict), canonicalBytes(next1.conflict));
      if (next1.access_revision) assert.equal(next2.access_revision, next1.access_revision);
      v1 = next1.state; f.commit(next2.plan);
      return { ...next2, v1_graph: next1.graph_revision, graph: f.head };
    },
    read(address, { at = f.head, v1_at = graphRevisionAddress(v1), principal = 'alice' } = {}) {
      f.setPrincipal(principal);
      const a = resolveWorkingGraphAddress(v1, address, { principal_id: principal, current_graph: v1, graph_revision: v1_at });
      const b = resolveIncrementalGraph(f.port, { at, address }); assert.equal(b.status, a.status);
      assert.deepEqual(b.revision, a.revision);
      if (a.status === 'resolved') { assert.deepEqual(b.entity, a.entity); assert.deepEqual(b.conflicts, a.conflicts); assert.deepEqual(b.graph_revision, at); }
      return b;
    },
    rejects(operation) {
      f.setPrincipal('alice');
      retainOperation(f, operation);
      const original = f.head;
      assert.throws(() => operation.kind === 'source_access' ? updateGraphSourceAccess(v1, { expected_graph: graphRevisionAddress(v1), event: operation.event, access_state: operation.access_state })
        : operation.kind === 'resolve' ? resolveGraphConflict(v1, { expected_graph: graphRevisionAddress(v1), assertion: operation.assertion, conflict_digest: operation.conflict_digest })
        : applyGraphAssertion(v1, { expected_graph: graphRevisionAddress(v1), assertion: operation.assertion }));
      assert.throws(() => planGraphMutation(f.port, command(f, operation))); assert.deepEqual(f.head, original);
    } };
}
const lifecycle = (sequence = 1, access_state = 'active', alter = () => {}) => ({ kind: 'source_access', access_state,
  event: event('api', sequence, raw => { raw.source_event_type = access_state === 'tombstoned' ? 'source.deleted' : 'access.changed';
    raw.acl.revision = `acl-${sequence + 8}`; raw.provenance.source_objects[0].acl.revision = `object-acl-${sequence + 4}`;
    raw.provenance.source_objects[0].acl.allowed_principal_ids = ['alice']; alter(raw); }) });

test('indexed immutable semantic revisions/conflicts equal V1 bytes through compatible, competing, resolution and exact relation updates', () => {
  const p = pair(); const first = p.step({ kind: 'assert', assertion: assertion('first') });
  const second = p.step({ kind: 'assert', assertion: assertion('second', { base_revision: first.revision, status: 'validated' }) });
  const third = p.step({ kind: 'assert', assertion: assertion('third', { base_revision: first.revision, execution_id: 'attempt-b', events: [event('web')], content: { semantic_type: 'constraint', data: { text: 'A competing direction' } } }) });
  const fourth = p.step({ kind: 'assert', assertion: assertion('fourth', { base_revision: second.revision }) });
  p.read(logical()); p.read(first.revision, { at: first.graph, v1_at: first.v1_graph });
  const resolve = assertion('resolve', { base_revision: second.revision, parents: [second.revision, third.revision, fourth.revision], status: 'resolved', events: [] });
  p.rejects({ kind: 'resolve', conflict_digest: third.conflict.conflict_digest, assertion: { ...resolve, parents: [second.revision, third.revision] } });
  const resolved = p.step({ kind: 'resolve', conflict_digest: third.conflict.conflict_digest, assertion: resolve });
  p.read(logical());
  const linked = p.step({ kind: 'assert', assertion: assertion('relation', { entity_kind: 'relation', entity_id: 'supports', events: [],
    content: { relation_type: 'SUPPORTS', from: resolved.revision, to: canonicalArtifactAddress(event('web')), data: {} } }) });
  p.read(linked.revision); p.read(first.revision);
  assert.notEqual(first.graph.kind, first.v1_graph.kind); assert.equal(first.graph.schema_version, 2);
  const oldConflictPage = pageIncrementalGraph(p.f.port, { at: fourth.graph, collection: { kind: 'conflicts', entity: null }, cursor: null, limit: 64 });
  assert.equal(oldConflictPage.items.length, 2);
  const currentConflictPage = pageIncrementalGraph(p.f.port, { at: p.f.head, collection: { kind: 'conflicts', entity: { entity_kind: 'entity', entity_id: 'context-a' } }, cursor: null, limit: 1 });
  assert.equal(currentConflictPage.items.length, 0); assert.ok(currentConflictPage.next_cursor);
});

test('historical reads, ACL tightening, explicit recomputation and tombstones retain V1 semantics', () => {
  const p = pair(); const first = p.step({ kind: 'assert', assertion: assertion() });
  const related = p.step({ kind: 'assert', assertion: assertion('dependent', { entity_kind: 'relation', entity_id: 'depends', events: [],
    content: { relation_type: 'DEPENDS_ON', from: first.revision, to: canonicalArtifactAddress(event('web')), data: {} } }) });
  p.read(first.revision, { principal: 'bob' }); const changed = p.step(lifecycle());
  assert.equal(p.read(first.revision, { at: first.graph, v1_at: first.v1_graph }).status, 'denied');
  assert.equal(p.read(related.revision).status, 'denied');
  const fresh = event('api', 2, raw => { raw.acl.revision = 'acl-9'; raw.provenance.source_objects[0].acl.revision = 'object-acl-5'; raw.provenance.source_objects[0].acl.allowed_principal_ids = ['alice']; });
  const rebuilt = p.step({ kind: 'assert', assertion: assertion('recomputed', { base_revision: first.revision, events: [fresh], access_revisions: [changed.access_revision] }) });
  assert.equal(p.read(rebuilt.revision).status, 'resolved'); assert.equal(p.read(rebuilt.revision, { principal: 'bob' }).status, 'denied');
  p.step(lifecycle(3, 'tombstoned')); assert.equal(p.read(rebuilt.revision).status, 'denied');
  p.rejects(lifecycle(4));
});

test('old-epoch restrictions survive omitted watermarks and a newly admitted observer; lifecycle cannot self-admit', () => {
  const p = pair(); const first = p.step({ kind: 'assert', assertion: assertion() }); const old = p.step(lifecycle());
  const epochEvent = (sequence, type = 'git.commit.created') => event('api', sequence, raw => {
    raw.event_id = `next-epoch-${sequence}`; raw.idempotency_key = `next-epoch-retry-${sequence}`; raw.source_native_event_id = `next-epoch-native-${sequence}`;
    raw.producer.epoch = 'next-epoch'; raw.source_event_type = type;
  });
  const update = { kind: 'source_access', event: epochEvent(1, 'access.changed'), access_state: 'active' }; p.rejects(update);
  p.step({ kind: 'assert', assertion: assertion('admit-next-epoch', { entity_id: 'next-epoch-source', events: [epochEvent(0)], access_revisions: [old.access_revision] }), watermarks: watermarks([event('web')]) });
  const newer = p.step(update);
  const fresh = p.step({ kind: 'assert', assertion: assertion('both-epochs', { base_revision: first.revision, events: [event()], access_revisions: [old.access_revision, newer.access_revision] }) });
  assert.equal(p.read(fresh.revision).status, 'resolved'); assert.equal(p.read(fresh.revision, { principal: 'bob' }).status, 'denied');
  p.rejects({ kind: 'assert', assertion: assertion('forgot-old-epoch', { entity_id: 'forgot', events: [epochEvent(0)], access_revisions: [newer.access_revision] }) });
});

test('per-producer ordering and unsequenced observations reject the same lifecycle transitions as V1', () => {
  const p = pair(); p.step({ kind: 'assert', assertion: assertion('unsequenced', { events: [event('api', 0, raw => { raw.producer.sequence = null; })] }) });
  p.rejects(lifecycle());
  const q = pair(); q.step({ kind: 'assert', assertion: assertion('first-object') });
  const secondObject = raw => { raw.payload.object.oid = 'b'.repeat(40); raw.provenance.source_objects[0].object.oid = 'b'.repeat(40); };
  q.step({ kind: 'assert', assertion: assertion('second-object', { entity_id: 'second', events: [event('api', 3, secondObject)] }) });
  q.step(lifecycle(5)); q.rejects(lifecycle(4, 'active', secondObject));
});

test('base-only concurrency pins do not inherit ACL, while explicit parents retain all source restrictions', () => {
  const p = pair();
  const privateRevision = p.step({ kind: 'assert', assertion: assertion('private', { events: [event('api', 0, raw => { raw.acl.allowed_principal_ids = ['alice']; })] }) });
  const baseOnly = p.step({ kind: 'assert', assertion: assertion('base-only', { base_revision: privateRevision.revision, events: [event('web')], execution_id: 'attempt-b' }) });
  assert.equal(p.read(baseOnly.revision, { principal: 'bob' }).status, 'resolved');
  const inherited = p.step({ kind: 'assert', assertion: assertion('explicit-parent', { base_revision: baseOnly.revision, parents: [privateRevision.revision], events: [event('web')] }) });
  assert.equal(p.read(inherited.revision, { principal: 'bob' }).status, 'denied');
  assert.equal(p.read(inherited.revision).status, 'resolved');
});

test('new current catalog keeps accepted event original catalog pins and preserves equal V1 semantic bytes', () => {
  const f = fixture(), oldPin = f.catalogPin, e = event(); f.retainEvent(e, oldPin);
  const firstAssertion = assertion('catalog-original');
  const first = planGraphMutation(f.port, command(f, { kind: 'assert', assertion: firstAssertion })); f.commit(first.plan);
  const v1first = applyGraphAssertion(graph(), { expected_graph: graphRevisionAddress(graph()), assertion: firstAssertion });
  const nextCatalog = catalog(); nextCatalog.sessions.push({ ...nextCatalog.sessions[0], session_id: 'later-session' });
  const nextPin = f.retainCatalog(nextCatalog, 'catalog-v2'); f.setCatalog(nextPin);
  const nextAssertion = assertion('catalog-retained-event', { base_revision: first.revision });
  const next = planGraphMutation(f.port, command(f, { kind: 'assert', assertion: nextAssertion }));
  const v1next = applyGraphAssertion(v1first.state, { expected_graph: v1first.graph_revision, assertion: nextAssertion });
  assert.deepEqual(next.plan.commit.catalog_pin, nextPin);
  assert.deepEqual(canonicalBytes(next.plan.append.find(r => r.kind === 'revision').value), canonicalBytes(v1next.state.snapshots.at(-1).revisions.at(-1)));
  f.commit(next.plan); assert.equal(resolveIncrementalGraph(f.port, { at: f.head, address: first.revision }).status, 'resolved');
  assert.equal(e.normalization.catalog_digest, oldPin.digest); assert.notEqual(oldPin.digest, nextPin.digest);
});

test('history index is selected by exact commit and current caller, without latest fallback', () => {
  const f = fixture(), refs = [], graphs = [];
  for (let i = 0; i < 6; i++) {
    const r = applyIncremental(f, { kind: 'assert', assertion: assertion(`history-${i}`, { base_revision: refs.at(-1) ?? null }) });
    refs.push(r.revision); graphs.push(f.head);
  }
  const collection = { kind: 'history', entity_kind: 'entity', entity_id: 'context-a' };
  let cursor = null, found = [];
  do { const page = pageIncrementalGraph(f.port, { at: graphs[3], collection, cursor, limit: 2 }); found.push(...page.items.map(row => row.revision.revision_digest)); cursor = page.next_cursor; } while (cursor);
  assert.deepEqual(found, refs.slice(0, 4).map(ref => ref.revision_digest));
  assert.equal(resolveIncrementalGraph(f.port, { at: graphs[0], address: refs[5] }).status, 'unavailable');
  assert.equal(resolveIncrementalGraph(f.port, { at: graphs[0], address: logical() }).revision.revision_digest, refs[0].revision_digest);
  const firstPage = pageIncrementalGraph(f.port, { at: f.head, collection, cursor: null, limit: 2 });
  f.setPrincipal('mallory'); const denied = pageIncrementalGraph(f.port, { at: f.head, collection, cursor: firstPage.next_cursor, limit: 2 });
  assert.deepEqual(denied.items, []); assert.ok(denied.next_cursor);
});

test('one generation retains 1040 transitions and 600 semantic objects with indexed pages and bounded small-support work', t => {
  const started = performance.now(), f = fixture(), refs = [], graphs = [], samples = [], totals = { current: 0, read: 0, page: 0, authority: 0, candidate_rows: 0 };
  let base = null, maxReads = 0, maxRequests = 0;
  for (let i = 0; i < 1040; i++) {
    let a;
    if (i === 2) a = assertion(`scale-${i}`, { entity_kind: 'relation', entity_id: 'relation-2', events: [], content: { relation_type: 'SUPPORTS', from: refs[0], to: refs[1], data: {} } });
    else a = assertion(`scale-${i}`, { entity_id: i < 600 ? `entity-${i}` : 'entity-0', base_revision: i < 600 ? null : base,
      content: { semantic_type: 'constraint', data: { text: `Synthetic assertion ${i}` } } });
    retainOperation(f, { kind: 'assert', assertion: a }); f.resetMetrics();
    const r = planGraphMutation(f.port, command(f, { kind: 'assert', assertion: a }));
    assert.equal(r.status, 'planned'); const m = f.metrics; maxReads = Math.max(maxReads, m.read); maxRequests = Math.max(maxRequests, m.requests.length);
    assert.ok(m.read <= 64, `transition ${i + 1}: ${m.read} selected fact reads`);
    assert.ok(m.requests.length <= 64, `transition ${i + 1}: ${m.requests.length} total port requests`);
    for (const key of Object.keys(totals)) totals[key] += m[key];
    if (i < 4 || i >= 1036 || [127, 511, 599].includes(i)) samples.push({ transition: i + 1, current: m.current, read: m.read, authority: m.authority, all_port_requests: m.requests.length });
    f.commit(r.plan); if (i < 3) { refs.push(r.revision); graphs.push(f.head); } if (i === 0 || i >= 600) base = r.revision;
  }
  const runtime_ms = Math.round((performance.now() - started) * 100) / 100, scaleHead = f.head, retained = f.metrics;
  assert.equal(retained.committed_transitions, 1040); assert.equal(retained.record_counts.revision, 1040);
  assert.equal(retained.record_counts.commit, 1041); assert.equal(retained.record_counts.manifest, 1);
  assert.equal(resolveIncrementalGraph(f.port, { at: scaleHead, address: refs[0] }).revision.assertion.content.data.text, 'Synthetic assertion 0');
  assert.equal(resolveIncrementalGraph(f.port, { at: graphs[0], address: logical('entity-0') }).revision.revision_digest, refs[0].revision_digest);
  assert.equal(resolveIncrementalGraph(f.port, { at: scaleHead, address: refs[2] }).revision.assertion.content.from.revision_digest, refs[0].revision_digest);
  const pages = { heads: 0, history: 0 }, seen = [];
  let cursor = null;
  f.resetMetrics();
  do {
    const page = pageIncrementalGraph(f.port, { at: scaleHead, collection: { kind: 'heads' }, cursor, limit: 64 }); pages.heads++; seen.push(...page.items.map(row => `${row.revision.entity_kind}:${row.revision.entity_id}`)); cursor = page.next_cursor;
  } while (cursor);
  assert.equal(seen.length, 600); assert.equal(new Set(seen).size, 600); assert.equal(f.metrics.candidate_rows, 600);
  const headsMetrics = f.metrics; cursor = null; let historyRows = 0;
  do {
    const page = pageIncrementalGraph(f.port, { at: scaleHead, collection: { kind: 'history', entity_kind: 'entity', entity_id: 'entity-0' }, cursor, limit: 64 }); pages.history++; historyRows += page.items.length; cursor = page.next_cursor;
  } while (cursor);
  assert.equal(historyRows, 441);
  const firstPage = pageIncrementalGraph(f.port, { at: scaleHead, collection: { kind: 'heads' }, cursor: null, limit: 64 });
  applyIncremental(f, lifecycle(1, 'unknown'));
  f.resetMetrics(); const denied = pageIncrementalGraph(f.port, { at: scaleHead, collection: { kind: 'heads' }, cursor: firstPage.next_cursor, limit: 64 });
  assert.deepEqual(denied.items, []); assert.ok(denied.next_cursor); assert.equal(f.metrics.candidate_rows, 64);
  const measurement = { schema_version: 1, dataset: 'synthetic-incremental-graph', generation_id: 'live-1', transitions: 1040, distinct_semantic_objects: 600,
    runtime_ms, node: process.version, platform: process.platform, max_selected_fact_reads: maxReads, max_all_port_requests: maxRequests,
    max_plan_bytes: retained.max_plan_bytes, max_row_bytes: retained.max_row_bytes, record_counts: retained.record_counts, mutation_totals: totals, samples,
    pages: { ...pages, head_rows: seen.length, history_rows: historyRows, head_candidate_rows: headsMetrics.candidate_rows },
    current_acl_continuation: { additional_lifecycle_transitions: 1, candidates: f.metrics.candidate_rows, visible_items: denied.items.length, continues: Boolean(denied.next_cursor) },
    bounds: { selected_fact_reads_small_support: 64, page_candidates: 64, row_and_plan_bytes: 1048576 },
    scope: 'In-memory indexed synthetic conformance only; no persistence, throughput, production authorization, network or model claim.' };
  assert.ok(measurement.max_plan_bytes <= 1048576); assert.ok(measurement.max_row_bytes <= 1048576);
  if (process.env.VH_WRITE_INCREMENTAL_MEASUREMENT === '1') {
    const directory = new URL('./fixtures/incremental-graph/', import.meta.url); mkdirSync(directory, { recursive: true });
    writeFileSync(new URL('scale-measurement.json', directory), `${JSON.stringify(measurement, null, 2)}\n`);
  }
  t.diagnostic(JSON.stringify({ transitions: 1040, distinct: 600, runtime_ms, maxReads, maxRequests, max_plan_bytes: retained.max_plan_bytes, pages }));
});
