import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStorage, WORKING_GRAPH_NAMESPACE as NS, checkGraphFormat } from '../src/adapters/sqlite/graph-storage.mjs';
import { DomainStore, migrateDomainStore } from '../src/adapters/sqlite/domain-store.mjs';
import { LocalCredentialAuthority, LOCAL_AUDIENCE } from '../src/adapters/auth/local-credential-authority.mjs';
import { scopedReference } from '../src/domain/identity/service-access.mjs';
import { fingerprint } from '../src/domain/shared/contracts.mjs';
import { eventObservationKey } from '../src/domain/sources/event-provenance.mjs';
import { planGraphGenesis, planGraphMutation, resolveIncrementalGraph, pageIncrementalGraph } from '../src/domain/graph/incremental-graph.mjs';
import { semanticAddress, exactRevisionAddress } from '../src/domain/graph/working-graph.mjs';
import { catalog, scope, watermarks, event, assertion } from './fixtures/working-graph/scenario.mjs';

const generation_id = 'live-1', hash = v => `sha256:${fingerprint(v)}`;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'vh-graph-storage-')), filePath = join(directory, 'store.sqlite'); migrateDomainStore({ filePath });
  const authority = new LocalCredentialAuthority(), issued = authority.issue({ principal_id: 'alice', kind: 'service', scope, actions: ['store:read', 'store:write'], ttl_ms: 900000 });
  const context = authority.authorize(issued.credential, { scope, audience: LOCAL_AUDIENCE, action: 'store:read', kinds: ['service'], boundary: 'object', reference: scopedReference('object', scope, 'graph-storage-test') }).context;
  const options = { filePath, authority, namespaces: [NS] }; let store = new DomainStore(options);
  const c = catalog(), catalogPin = { revision_id: 'catalog-1', digest: hash(c) }, events = new Map();
  const retain = e => { events.set(eventObservationKey(e), { event: e, event_digest: hash(e), catalog_pin: catalogPin, source_ref: `accepted-${fingerprint(e)}` }); };
  const storage = view => new GraphStorage({ view, scope, generation_id });
  function port(view) {
    const s = storage(view), current = () => { const head = s.head(); return { scope, generation_id, head: head?.value.head ?? null, head_version: head?.version ?? null, catalog_pin: catalogPin, access_view: 'storage-access-view', principal_id: 'alice' }; };
    return { current, read(query) {
      const state = current(); let fact;
      if (query.kind === 'catalog') fact = query.key[0] === catalogPin.revision_id && query.key[1] === catalogPin.digest ? { version: 1, value: { pin: catalogPin, catalog: c }, origin: null } : { version: null, value: null, origin: null };
      else if (query.kind === 'accepted_event') fact = events.has(query.key[0]) ? { version: 1, value: events.get(query.key[0]), origin: null } : { version: null, value: null, origin: null };
      else fact = s.fact(query);
      return { ...query, current_head: state.head, access_view: state.access_view, complete: true, ...fact };
    }, page(query) { const { limit, ...envelope } = query; return { ...envelope, current_head: current().head, access_view: current().access_view, ...s.page(query) }; },
    authorizeLifecycle(query) { return { ...query, current_head: current().head, access_view: current().access_view, principal_id: 'alice', allowed: true, authority_ref: 'synthetic-authority' }; } };
  }
  const run = (write, operation) => {
    let original;
    try { return store[write ? 'transaction' : 'readSnapshot'](context, view => { try { return operation(storage(view), port(view), view); } catch (error) { original = error; throw error; } }); }
    catch (error) { throw original ?? error; }
  };
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { filePath, context, authority, catalogPin, retain, run, get store() { return store; },
    reopen() { store.close(); store = new DomainStore(options); },
    genesis() { return run(true, (s, p) => { const result = planGraphGenesis(p, { scope, generation_id, catalog_pin: catalogPin, watermarks: watermarks() }); s.applyPlan(result.plan); return result; }); },
    step(a) { return this.operation({ kind: 'assert', assertion: a }); },
    operation(operation) {
      for (const e of operation.assertion?.events ?? []) retain(e); if (operation.event) retain(operation.event);
      return run(true, (s, p) => { const result = planGraphMutation(p, { schema_version: 2, kind: 'graph_mutation', expected_graph: s.head().value.head, catalog_pin: catalogPin, operation });
        assert.equal(result.status, 'planned'); s.applyPlan(result.plan); return result; });
    },
    get head() { return run(false, s => s.head()); },
    read(at, id = 'context-a') { return run(false, (s, p) => resolveIncrementalGraph(p, { at, address: semanticAddress({ scope, generation_id, entity_kind: 'entity', entity_id: id }) })); },
    rebuild(request) { return run(true, s => s.rebuildStep(request)); },
    raw() { return new DatabaseSync(filePath); } };
}

const snapshotRows = raw => raw.prepare('SELECT id,kind,value FROM sources WHERE namespace=? ORDER BY id').all(NS);

test('real scoped format and genesis reject unknown metadata without replacing it; immutable commit facts survive reopening', t => {
  const f = fixture(t); assert.equal(f.run(false, (s, p, tx) => checkGraphFormat(tx)), null); assert.equal(f.head, null);
  const genesis = f.genesis(); const head = f.head; assert.equal(head.version, 1); assert.equal(head.value.sequence, 0); assert.equal(head.value.maintenance, null);
  const commit = f.run(false, s => s.fact({ at: head.value.head, kind: 'commit', key: [head.value.head.commit_digest] })); assert.deepEqual(commit.value, genesis.plan.commit);
  f.reopen(); assert.deepEqual(f.head, head); assert.deepEqual(f.run(false, s => s.fact({ at: head.value.head, kind: 'manifest', key: [genesis.plan.commit.manifest_digest] })).value, genesis.plan.append[0].value);
  const raw = f.raw(); t.after(() => raw.close()); const before = snapshotRows(raw);
  raw.prepare('UPDATE records SET value=? WHERE namespace=? AND key=?').run(JSON.stringify({ schema_version: 99 }), NS, 'format');
  assert.throws(() => f.run(false, s => s.head()), /unsupported_graph_format/); assert.throws(() => f.run(true, (s, p, tx) => checkGraphFormat(tx, { initialize: true })), /unsupported_graph_format/);
  assert.deepEqual(snapshotRows(raw), before); assert.equal(JSON.parse(raw.prepare('SELECT value FROM records WHERE key=?').get('format').value).schema_version, 99);
});

test('real finite selected reads retain exact revision and logical versions across update, conflict, resolution and restart', t => {
  const f = fixture(t); f.genesis(); const first = f.step(assertion('first')), early = f.head.value.head;
  const next = f.step(assertion('next', { base_revision: first.revision, status: 'validated' }));
  const fork = f.step(assertion('fork', { base_revision: first.revision, execution_id: 'attempt-b', events: [event('web')] }));
  const contested = f.head.value.head; assert.equal(f.read(contested).conflicts.length, 1);
  const resolution = f.operation({ kind: 'resolve', conflict_digest: fork.conflict.conflict_digest,
    assertion: assertion('resolve', { base_revision: next.revision, parents: [next.revision, fork.revision], status: 'resolved', events: [] }) });
  assert.deepEqual(exactRevisionAddress(f.read(early).revision), first.revision); assert.deepEqual(exactRevisionAddress(f.read(f.head.value.head).revision), resolution.revision);
  for (const [at, version] of [[early, 1], [contested, 3], [f.head.value.head, 4]]) {
    const row = f.run(false, s => s.fact({ at, kind: 'entity', key: ['entity', 'context-a'] })); assert.equal(row.version, version);
  }
  assert.deepEqual(f.run(false, s => s.fact({ at: early, kind: 'revision', key: [resolution.revision.revision_digest] })), { version: null, value: null, origin: null });
  const absent = f.run(false, s => s.fact({ at: early, kind: 'entity', key: ['entity', 'absent'] })); assert.equal(absent.value, null);
  f.reopen(); assert.deepEqual(exactRevisionAddress(f.read(early).revision), first.revision);
  const currentAt = f.head.value.head; const history = f.run(false, (s, p) => pageIncrementalGraph(p, { at: currentAt, collection: { kind: 'history', entity_kind: 'entity', entity_id: 'context-a' }, cursor: null, limit: 64 }));
  assert.equal(history.items.length, 4);
});

test('actual page ranges use sparse commit positions, bounded continuation and correct per-entity collections past 64 entries', t => {
  const f = fixture(t); f.genesis(); let initial;
  for (let i = 0; i < 66; i++) { f.step(assertion(`entity-${i}`, { entity_id: `entity-${i}` })); if (i === 0) initial = f.head.value.head; }
  const at = f.head.value.head, collection = { kind: 'heads' };
  const page1 = f.run(false, s => s.page({ at, collection, after: null, limit: 64 })); assert.equal(page1.rows.length, 64); assert.equal(page1.next_position, 64);
  assert.deepEqual(page1.rows.map(r => r.position), Array.from({ length: 64 }, (_, i) => i + 1));
  const page2 = f.run(false, s => s.page({ at, collection, after: page1.next_position, limit: 64 })); assert.equal(page2.rows.length, 2); assert.equal(page2.next_position, null);
  assert.equal(f.run(false, s => s.page({ at: initial, collection, after: null, limit: 64 })).rows.length, 1);
  const history = f.run(false, s => s.page({ at, collection: { kind: 'history', entity_kind: 'entity', entity_id: 'entity-65' }, after: null, limit: 1 }));
  assert.equal(history.rows[0].position, 66); assert.equal(history.next_position, 66);
  assert.deepEqual(f.run(false, s => s.page({ at, collection: { kind: 'history', entity_kind: 'entity', entity_id: 'entity-65' }, after: 66, limit: 1 })).rows, []);
  assert.throws(() => f.run(false, s => s.page({ at, collection, after: 67, limit: 64 })), /graph_storage_invalid/);
});

test('stale CAS, invalid effects, accessor/Proxy input and outer failure leave no partial records or head changes', t => {
  const f = fixture(t); f.genesis(); f.retain(event());
  const plan = f.run(false, (s, p) => planGraphMutation(p, { schema_version: 2, kind: 'graph_mutation', expected_graph: s.head().value.head, catalog_pin: f.catalogPin, operation: { kind: 'assert', assertion: assertion('stale') } }).plan);
  f.step(assertion('advance', { entity_id: 'other' })); const head = f.head, raw = f.raw(); t.after(() => raw.close()); const before = snapshotRows(raw);
  assert.throws(() => f.run(true, s => s.applyPlan(plan)), /graph_storage_conflict/);
  const invalid = structuredClone(plan); invalid.plan_digest = hash('invalid'); assert.throws(() => f.run(true, s => s.applyPlan(invalid)), /graph_storage_corrupt/);
  let hooks = 0; const proxy = new Proxy(plan, { ownKeys() { hooks++; return []; } }); assert.throws(() => f.run(true, s => s.applyPlan(proxy)), /graph_storage_invalid/);
  const getter = {}; Object.defineProperty(getter, 'at', { enumerable: true, get() { hooks++; return head.value.head; } }); assert.throws(() => f.run(false, s => s.fact(getter)), /graph_storage_invalid/); assert.equal(hooks, 0);
  assert.throws(() => f.run(true, (s, p) => {
    const next = planGraphMutation(p, { schema_version: 2, kind: 'graph_mutation', expected_graph: head.value.head, catalog_pin: f.catalogPin, operation: { kind: 'assert', assertion: assertion('rollback') } });
    s.applyPlan(next.plan); throw new Error('synthetic rollback');
  }), /synthetic rollback/);
  assert.deepEqual(f.head, head); assert.deepEqual(snapshotRows(raw), before);
});

test('bounded rebuild replays canonical rows without active indexes, survives restart, reconciles receipts and switches once', t => {
  const f = fixture(t); f.genesis(); const first = f.step(assertion('first')), firstAt = f.head.value.head;
  for (let i = 0; i < 5; i++) f.step(assertion(`extra-${i}`, { entity_id: `extra-${i}` }));
  const before = f.head, expected_graph = before.value.head, raw = f.raw(); t.after(() => raw.close());
  const canonical = snapshotRows(raw).filter(row => row.id.startsWith('c/') || row.id.startsWith('r/'));
  const startRequest = { expected_graph, cursor: null, limit: 2 }, start = f.rebuild(startRequest);
  assert.equal(start.status, 'building'); assert.equal(start.processed, 0); assert.equal(start.total, 7); assert.equal(start.cursor.next_sequence, 0);
  assert.equal(f.rebuild(startRequest).status, 'duplicate'); assert.throws(() => f.rebuild({ ...startRequest, limit: 3 }), /graph_storage_conflict/);
  assert.throws(() => f.step(assertion('maintenance')), /graph_maintenance/);
  // Maintenance does not hide the healthy prior view.
  assert.deepEqual(exactRevisionAddress(f.read(firstAt).revision), first.revision);
  const stepRequest = { expected_graph, cursor: start.cursor, limit: 2 }, step = f.rebuild(stepRequest); assert.equal(step.processed, 2);
  f.reopen(); assert.equal(f.rebuild(stepRequest).status, 'duplicate'); assert.throws(() => f.rebuild({ ...stepRequest, limit: 1 }), /graph_storage_conflict/);
  // Destroy only the prior derived view. Rebuild must still complete using c/r sources.
  const old = before.value.active_index;
  raw.prepare('DELETE FROM sources WHERE namespace=? AND (id LIKE ? OR id LIKE ? OR id LIKE ?)').run(NS, `a/${old}/%`, `v/${old}/%`, `p/${old}/%`);
  raw.prepare('DELETE FROM records WHERE namespace=? AND key LIKE ?').run(NS, `h/${old}/%`);
  assert.throws(() => f.read(firstAt), /graph_storage_corrupt/);
  let progress = step;
  while (progress.cursor) progress = f.rebuild({ expected_graph, cursor: progress.cursor, limit: 2 });
  assert.equal(progress.status, 'complete'); assert.equal(progress.processed, 7); assert.equal(f.head.value.maintenance, null);
  assert.notEqual(f.head.value.active_index, old); assert.deepEqual(f.head.value.head, expected_graph);
  assert.deepEqual(exactRevisionAddress(f.read(firstAt).revision), first.revision); assert.equal(f.rebuild(stepRequest).status, 'duplicate');
  assert.deepEqual(snapshotRows(raw).filter(row => row.id.startsWith('c/') || row.id.startsWith('r/')), canonical);
  assert.equal(f.run(false, s => s.fact({ at: firstAt, kind: 'entity', key: ['entity', 'context-a'] })).version, 1);
  const next = f.step(assertion('after-repair', { base_revision: first.revision })); assert.deepEqual(exactRevisionAddress(f.read(f.head.value.head).revision), next.revision);
  const newStart = f.rebuild({ expected_graph: f.head.value.head, cursor: null, limit: 1 }); assert.notEqual(newStart.index, progress.index);
});

test('selected corruption and a malformed canonical rebuild batch fail closed and roll back progress and new indexes', t => {
  const f = fixture(t); f.genesis(); f.step(assertion('first')); const raw = f.raw(); t.after(() => raw.close()); const head = f.head;
  const temporal = raw.prepare("SELECT id,value FROM sources WHERE namespace=? AND kind='graph-projection' AND value LIKE '%\"record_kind\":\"entity\"%' LIMIT 1").get(NS);
  const damaged = JSON.parse(temporal.value); damaged.value.entity_id = 'foreign'; raw.prepare('UPDATE sources SET value=? WHERE namespace=? AND id=?').run(JSON.stringify(damaged), NS, temporal.id);
  assert.throws(() => f.run(false, s => s.fact({ at: head.value.head, kind: 'entity', key: ['entity', 'context-a'] })), /graph_storage_corrupt/);
  const start = f.rebuild({ expected_graph: head.value.head, cursor: null, limit: 2 });
  const commit = raw.prepare("SELECT id,value FROM sources WHERE namespace=? AND kind='graph-commit' ORDER BY id DESC LIMIT 1").get(NS);
  const broken = JSON.parse(commit.value); broken.sequence = 5; raw.prepare('UPDATE sources SET value=? WHERE namespace=? AND id=?').run(JSON.stringify(broken), NS, commit.id);
  const before = snapshotRows(raw); assert.throws(() => f.rebuild({ expected_graph: head.value.head, cursor: start.cursor, limit: 2 }), /graph_storage_corrupt/);
  assert.equal(f.head.value.maintenance.next_sequence, 0); assert.deepEqual(snapshotRows(raw), before);
  raw.prepare('UPDATE sources SET value=? WHERE namespace=? AND id=?').run(commit.value, NS, commit.id);
  const done = f.rebuild({ expected_graph: head.value.head, cursor: start.cursor, limit: 2 }); assert.equal(done.status, 'complete'); assert.equal(f.read(head.value.head).status, 'resolved');
});

test('deleting the latest temporal row cannot silently substitute an earlier committed projection', t => {
  const f = fixture(t); f.genesis(); const first = f.step(assertion('first')), early = f.head.value.head;
  f.step(assertion('latest', { base_revision: first.revision })); const latest = f.head.value.head, raw = f.raw(); t.after(() => raw.close());
  const row = raw.prepare("SELECT id FROM sources WHERE namespace=? AND kind='graph-projection' AND value LIKE '%\"record_kind\":\"entity\"%' ORDER BY id DESC LIMIT 1").get(NS);
  raw.prepare('DELETE FROM sources WHERE namespace=? AND id=?').run(NS, row.id);
  // A broken adjacent chain is unavailable even where an older row remains.
  assert.throws(() => f.read(early), /graph_storage_corrupt/);
  assert.throws(() => f.read(latest), /graph_storage_corrupt/);
});

test('oversized aggregate rebuild batch rolls back with no receipt, then the same cursor accepts a smaller batch', t => {
  const f = fixture(t); f.genesis();
  for (let i = 0; i < 48; i++) {
    const wide = event('api', i, raw => { const original = raw.provenance.source_objects[0]; raw.provenance.source_objects = Array.from({ length: 32 }, (_, j) => ({ ...original, object: { ...original.object, oid: j === 0 ? original.object.oid : (j + 1).toString(16).padStart(40, '0') } })); });
    f.step(assertion(`large-${i}`, { entity_id: `large-${i}`, events: [wide] }));
  }
  const expected_graph = f.head.value.head, start = f.rebuild({ expected_graph, cursor: null, limit: 64 }), raw = f.raw(); t.after(() => raw.close());
  // Reach the dense update range (genesis is deliberately small).
  const first = f.rebuild({ expected_graph, cursor: start.cursor, limit: 1 }), before = snapshotRows(raw);
  const bytes = before.filter(row => row.kind === 'graph-commit').reduce((sum, row) => sum + Buffer.byteLength(row.value), 0);
  assert.ok(bytes > 1_048_576, `synthetic canonical batch must exceed1MiB: ${bytes}`);
  assert.throws(() => f.rebuild({ expected_graph, cursor: first.cursor, limit: 64 }), /store_page_too_large/);
  assert.equal(f.head.value.maintenance.next_sequence, 1); assert.deepEqual(snapshotRows(raw), before);
  const smaller = f.rebuild({ expected_graph, cursor: first.cursor, limit: 8 }); assert.equal(smaller.processed, 9);
  assert.equal(f.rebuild({ expected_graph, cursor: first.cursor, limit: 8 }).status, 'duplicate');
});

test('deleted middle temporal or current rows fail closed using bounded adjacency and absence proofs', t => {
  const f = fixture(t); f.genesis(); const first = f.step(assertion('first'));
  const middle = f.step(assertion('middle', { base_revision: first.revision })), middleAt = f.head.value.head;
  f.step(assertion('last', { base_revision: middle.revision })); const currentAt = f.head.value.head, raw = f.raw(); t.after(() => raw.close());
  const temporal = raw.prepare("SELECT id,value FROM sources WHERE namespace=? AND kind='graph-projection' AND value LIKE '%\"record_kind\":\"entity\"%' ORDER BY id").all(NS);
  assert.equal(temporal.length, 3); raw.prepare('DELETE FROM sources WHERE namespace=? AND id=?').run(NS, temporal[1].id);
  assert.throws(() => f.read(middleAt), /graph_storage_corrupt/);
  raw.prepare('INSERT INTO sources(tenant_id,project_id,namespace,id,kind,value) VALUES(?,?,?,?,?,?)').run(scope.tenant_id, scope.project_id, NS, temporal[1].id, 'graph-projection', temporal[1].value);
  assert.equal(f.read(middleAt).revision.revision_digest, middle.revision.revision_digest);
  raw.prepare("DELETE FROM records WHERE namespace=? AND value LIKE '%\"record_kind\":\"entity\"%'").run(NS);
  assert.throws(() => f.read(currentAt), /graph_storage_corrupt/);
});
