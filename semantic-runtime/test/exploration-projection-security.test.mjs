import test from 'node:test';
import assert from 'node:assert/strict';
import { renameSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DomainStore, LocalExplorationStore, sourceLifecycleInvalidationId } from '../src/index.mjs';
import { fixture, connect, bind, bindRequest, mutation, resolve, pin, rows, rejected, records, writeRecords, git, capture, assertion, ACTIONS, NAMESPACES, SCOPE } from './helpers/exploration-fixture.mjs';
import { hashText } from './helpers/graph-store-fixture.mjs';

test('actual canonical origin/current pins stay distinct and optional filters cannot hide configured Authority', t => {
  const f = fixture(t, { canonical: true }), firstPin = pin(f.canonical), a = bind(f, { shared_base: firstPin });
  const local = f.explorations.mutate(f.context, mutation(f, a, 'local-choice'));
  let view = resolve(f, a, local, { shared_keys: [] });
  assert.equal(view.shared.origin_base.status, 'current'); assert.equal(view.shared.current_project.status, 'unavailable');
  assert.deepEqual(view.shared.origin_base.pin, firstPin);
  assert(view.shared.origin_base.returned_record_keys.includes('authority'));
  assert(view.shared.origin_base.data.records.some(item => item.key === 'authority' && item.record.type === 'authority'));
  assert.equal(view.local.revision.assertion.content.data.text, 'Synthetic local-choice');
  const selectionRequest = { epoch: f.epoch, idempotency_key: 'select-project-initial', expected_version: null, pin: firstPin };
  const selected = f.explorations.setProjectSelection(f.context, selectionRequest);
  assert.equal(selected.status, 'applied');
  const staleWrite = mutation(f, a, 'stale-project-selection', { expected_graph: local.receipt.next_graph });
  const before = rows(f); rejected(() => f.explorations.mutate(f.context, staleWrite)); assert.deepEqual(rows(f), before);
  const values = records(); values.authority.authority.validation = ['Review changed synthetic rule.']; values.decision.summary = 'Second synthetic canonical decision';
  writeRecords(f.folder, values); git(f.folder, 'add', '.'); git(f.folder, 'commit', '-m', 'second selected canonical state');
  const second = f.captureCanonical(f.canonical, 'canonical-next'), secondPin = pin(second, []);
  const newSelection = f.explorations.setProjectSelection(f.context, { epoch: f.epoch, idempotency_key: 'select-project-next', expected_version: selected.version, pin: secondPin });
  view = resolve(f, a, local, { shared_keys: [] });
  assert.equal(view.shared.origin_base.status, 'historical'); assert.equal(view.shared.current_project.status, 'current');
  assert.deepEqual(view.shared.origin_base.pin, firstPin); assert.deepEqual(view.shared.current_project.pin, secondPin);
  assert(view.shared.current_project.data.records.some(item => item.key === 'authority' && item.record.authority.validation.includes('Review changed synthetic rule.')));
  assert.deepEqual(f.graph.getHead(f.context, { generation_id: a.generation_id }).graph_revision, local.receipt.next_graph);
  const after = rows(f);
  rejected(() => f.explorations.setProjectSelection(f.context, { epoch: f.epoch, idempotency_key: 'stale-pointer', expected_version: selected.version, pin: secondPin }));
  rejected(() => f.explorations.setProjectSelection(f.context, { ...selectionRequest, pin: secondPin }));
  assert.deepEqual(rows(f), after); assert(newSelection.version > selected.version);
});

test('revoking current canonical or local source access withholds payloads and exact operation receipts', t => {
  const f = fixture(t, { canonical: true }), selectedPin = pin(f.canonical), a = bind(f, { shared_base: selectedPin });
  const command = mutation(f, a, 'private-synthetic'), result = f.explorations.mutate(f.context, command);
  f.ingress.updateSourceAccess(f.context, { registration_id: f.canonicalSource.registration_id, expectedVersion: f.canonicalSource.version,
    access: { ...f.canonicalSource.registration.access, enabled: false } });
  const canonicalDenied = resolve(f, a, result);
  assert(['quarantined', 'unavailable'].includes(canonicalDenied.shared.origin_base.status));
  assert.equal(canonicalDenied.shared.origin_base.data, null);
  rejected(() => f.explorations.getReceipt(f.context, { idempotency_key: command.idempotency_key }));
  rejected(() => f.explorations.mutate(f.context, command));
  f.ingress.updateSourceAccess(f.context, { registration_id: f.source.registration_id, expectedVersion: f.source.version,
    access: { ...f.source.registration.access, enabled: false, allowed_principal_ids: [] } });
  const localDenied = resolve(f, a, result); assert.equal(localDenied.local.status, 'denied');
  assert(!JSON.stringify(localDenied).includes('Synthetic private-synthetic'));
});

test('legacy Graph capability cannot initialize or assert into an owned generation, even without exploration namespace', t => {
  const f = fixture(t), a = bind(f), request = mutation(f, a, 'owned-bypass');
  const legacy = connect(f.filePath, null, { namespaces: NAMESPACES.filter(ns => ns !== 'exploration-projection') });
  t.after(() => { legacy.store.close(); legacy.authority.close(); });
  const before = rows(f);
  rejected(() => legacy.graph.initialize(legacy.context, { generation_id: a.generation_id, epoch: f.epoch, idempotency_key: 'legacy-owned-init', publisher_ref: f.publisher.publisher_ref, coverage: [] }));
  rejected(() => legacy.graph.mutate(legacy.context, { epoch: f.epoch, idempotency_key: 'legacy-owned-mutate', publisher_ref: f.publisher.publisher_ref,
    expected_graph: a.graph_revision, operation: request.operation, coverage: null }));
  assert.deepEqual(rows(f), before);
  const unowned = legacy.graph.initialize(legacy.context, { generation_id: 'ordinary-unowned', epoch: f.epoch, idempotency_key: 'ordinary-unowned-init', publisher_ref: f.publisher.publisher_ref, coverage: [] });
  const ordinary = legacy.graph.mutate(legacy.context, { epoch: f.epoch, idempotency_key: 'ordinary-unowned-assert', publisher_ref: f.publisher.publisher_ref,
    expected_graph: unowned.receipt.next_graph, operation: request.operation, coverage: null });
  assert.equal(ordinary.status, 'applied');
});

test('losing one ownership marker cannot turn an owned generation into an ordinary Graph', t => {
  const f = fixture(t), a = bind(f), command = mutation(f, a, 'missing-owner');
  const db = new DatabaseSync(f.filePath);
  assert.equal(db.prepare('DELETE FROM sources WHERE namespace=? AND kind=?').run('working-graph', 'exploration-generation-owner').changes, 1);
  db.close();
  const legacy = connect(f.filePath, null, { namespaces: NAMESPACES.filter(ns => ns !== 'exploration-projection') });
  t.after(() => { legacy.store.close(); legacy.authority.close(); });
  const before = rows(f);
  rejected(() => legacy.graph.mutate(legacy.context, { epoch: f.epoch, idempotency_key: 'lost-owner-bypass', publisher_ref: f.publisher.publisher_ref,
    expected_graph: a.graph_revision, operation: command.operation, coverage: null }));
  rejected(() => f.explorations.mutate(f.context, command));
  assert.deepEqual(rows(f), before);
});

test('a missing or regressed append horizon cannot silently hide retained explorations', async t => {
  for (const fault of ['missing', 'zero', 'lower']) await t.test(fault, t => {
    const f = fixture(t); for (let i = 0; i < 3; i++) bind(f, { key: `horizon-${i}` });
    const db = new DatabaseSync(f.filePath);
    if (fault === 'missing') db.prepare('DELETE FROM records WHERE namespace=? AND key=?').run('exploration-projection', 'index-head');
    else db.prepare('UPDATE records SET value=? WHERE namespace=? AND key=?').run(JSON.stringify({ sequence: fault === 'zero' ? 0 : 1 }), 'exploration-projection', 'index-head');
    db.close(); const before = rows(f);
    rejected(() => f.explorations.list(f.context, { cursor: null, limit: 32 }));
    rejected(() => bind(f, { key: 'after-damaged-horizon' }));
    assert.deepEqual(rows(f), before);
  });
});

test('losing a declared Project selection cannot clear its required Authority or permit a null selection write', t => {
  const f = fixture(t, { canonical: true }), a = bind(f), selectedPin = pin(f.canonical);
  const local = f.explorations.mutate(f.context, mutation(f, a, 'before-selection'));
  f.explorations.setProjectSelection(f.context, { epoch: f.epoch, idempotency_key: 'required-selection', expected_version: null, pin: selectedPin });
  const db = new DatabaseSync(f.filePath);
  assert.equal(db.prepare('DELETE FROM records WHERE namespace=? AND key=?').run('exploration-projection', 'project-selection').changes, 1);
  db.close(); const before = rows(f);
  rejected(() => resolve(f, a, local, { shared_keys: [] }));
  rejected(() => f.explorations.mutate(f.context, mutation(f, a, 'cleared-selection', { expected_graph: local.receipt.next_graph })));
  rejected(() => f.explorations.setProjectSelection(f.context, { epoch: f.epoch, idempotency_key: 'replace-lost-selection', expected_version: null, pin: selectedPin }));
  assert.deepEqual(rows(f), before);
});

test('missing or rolled-back workspace binding is corruption rather than a new unmapped workspace', async t => {
  for (const fault of ['missing', 'rollback']) await t.test(fault, t => {
    const f = fixture(t), a = bind(f), db = new DatabaseSync(f.filePath);
    const original = db.prepare('SELECT key,version,value FROM records WHERE namespace=? AND key LIKE ?').get('exploration-projection', 'binding-current/%');
    assert(original); bind(f, { key: 'binding-successor' });
    if (fault === 'missing') db.prepare('DELETE FROM records WHERE namespace=? AND key=?').run('exploration-projection', original.key);
    else db.prepare('UPDATE records SET value=?,version=? WHERE namespace=? AND key=?').run(original.value, original.version, 'exploration-projection', original.key);
    db.close(); const before = rows(f);
    rejected(() => f.explorations.getBinding(f.context, { execution: f.execution }));
    rejected(() => f.explorations.bind(f.context, { epoch: f.epoch, idempotency_key: 'damaged-binding-new', publisher_ref: f.publisher.publisher_ref,
      execution: f.execution, expected_catalog_version: f.registry.get(f.context).version, expected_binding_version: fault === 'missing' ? null : a.binding_version,
      exploration_id: null, shared_base: null }));
    assert.deepEqual(rows(f), before);
  });
});

test('owned routing rejects caller-supplied core watermarks instead of replacing trusted ingress coverage', t => {
  const f = fixture(t), a = bind(f), command = mutation(f, a, 'forged-watermarks');
  const watermarks = { schema_version: 1, scope: SCOPE, status: 'unknown', watermarks: [] };
  const before = rows(f);
  rejected(() => f.explorations.mutate(f.context, { ...command, operation: { ...command.operation, watermarks } }));
  assert.deepEqual(rows(f), before);
  assert.equal(f.explorations.getReceipt(f.context, { idempotency_key: command.idempotency_key }), null);
  assert.equal(f.explorations.mutate(f.context, command).status, 'applied');
});

test('real scoped grants reject foreign actors/tenants, missing permissions, expiry and revoked authority without effects', t => {
  const f = fixture(t), a = bind(f), command = mutation(f, a, 'authorized-only');
  const missing = f.issue({ actions: ACTIONS.filter(action => action !== 'exploration:write') }).context;
  const foreignActor = f.issue({ principal: 'different-writer' }).context;
  const foreignTenant = f.issue({ scope: { ...SCOPE, tenant_id: 'other-tenant' } }).context;
  const expires = f.issue({ ttl_ms: 1 }).context;
  const revoked = f.issue(); f.authority.revoke(revoked.issued.credential_id);
  f.clock.now += 2;
  const before = rows(f);
  for (const context of [missing, foreignActor, foreignTenant, expires, revoked.context]) rejected(() => f.explorations.mutate(context, command));
  assert.deepEqual(rows(f), before);
});

test('activation disable between observation and writer lock leaves no partial exploration write', t => {
  const f = fixture(t), a = bind(f), command = mutation(f, a, 'disable-race'), transaction = DomainStore.prototype.transaction;
  const other = f.reopen(); let raced = false;
  t.mock.method(f.store, 'transaction', function (context, callback) {
    if (!raced) { raced = true; const state = other.activation.get(other.context); other.activation.setEnabled(other.context, { enabled: false, expectedVersion: state.version }); }
    return transaction.call(this, context, callback);
  });
  rejected(() => f.explorations.mutate(f.context, command)); assert(raced);
  assert.deepEqual(f.graph.getHead(f.context, { generation_id: a.generation_id }).graph_revision, a.graph_revision);
  assert.equal(f.explorations.getReceipt(f.context, { idempotency_key: command.idempotency_key }), null);
});

test('credential expiry or revocation after preflight is rechecked before any writer effects', async t => {
  for (const race of ['expiry', 'revocation']) await t.test(race, t => {
    const f = fixture(t), a = bind(f), command = mutation(f, a, `authority-${race}`), before = rows(f);
    const transaction = DomainStore.prototype.transaction; let raced = false;
    t.mock.method(f.store, 'transaction', function (context, callback) {
      raced = true;
      if (race === 'expiry') f.clock.now += 3_600_001;
      else f.authority.revoke(f.issued.credential_id);
      return transaction.call(this, context, callback);
    });
    rejected(() => f.explorations.mutate(f.context, command)); assert(raced); assert.deepEqual(rows(f), before);
  });
});

test('construction is inert; configuration/data accessors, proxies and oversized inputs are rejected before execution', t => {
  const f = fixture(t), before = rows(f); let calls = 0;
  new LocalExplorationStore({ store: f.store, authority: f.authority, canonical_reader: structuredClone(f.config) });
  assert.deepEqual(rows(f), before);
  const accessor = { ...f.config }; Object.defineProperty(accessor, 'repository_path', { enumerable: true, get() { calls++; return f.folder; } });
  rejected(() => new LocalExplorationStore({ store: f.store, authority: f.authority, canonical_reader: accessor }));
  rejected(() => new LocalExplorationStore({ store: f.store, authority: f.authority, canonical_reader: new Proxy(f.config, { get() { calls++; return null; } }) }));
  const request = bindRequest(f); Object.defineProperty(request, 'exploration_id', { enumerable: true, get() { calls++; return null; } });
  rejected(() => f.explorations.bind(f.context, request)); assert.equal(calls, 0);
  rejected(() => f.explorations.bind(f.context, { ...bindRequest(f), idempotency_key: 'x'.repeat(1_048_577) }));
  rejected(() => f.explorations.list(f.context, { cursor: null, limit: 33 }));
  assert.deepEqual(rows(f), before);
});

test('changed frozen canonical composition and plausible foreign Graph pins cannot reinterpret durable origins', t => {
  const f = fixture(t, { canonical: true }), a = bind(f, { shared_base: pin(f.canonical) });
  const config = { ...f.config, selection: { ...f.config.selection, policy_id: 'changed-policy-identity' } };
  const changed = new LocalExplorationStore({ store: f.store, authority: f.authority, canonical_reader: config });
  const before = rows(f); rejected(() => changed.list(f.context, { cursor: null, limit: 32 }));
  const local = f.explorations.mutate(f.context, mutation(f, a, 'fake-canonical'));
  const fakePin = { at: local.receipt.next_graph, address: local.revision, record_keys: ['authority'] };
  const after = rows(f); rejected(() => f.explorations.setProjectSelection(f.context, { epoch: f.epoch, idempotency_key: 'fake-shared-selection', expected_version: null, pin: fakePin }));
  assert.deepEqual(rows(f), after); assert(before.sources.length < after.sources.length);
});

test('owned projection maintenance remains available after its bound Git folder disappears', t => {
  const f = fixture(t), a = bind(f), applied = f.explorations.mutate(f.context, mutation(f, a, 'before-removal'));
  renameSync(f.folder, `${f.folder}-removed`);
  let cursor = null, count = 0;
  do { const page = f.graph.rebuildProjection(f.context, { generation_id: a.generation_id, expected_graph: applied.receipt.next_graph, epoch: f.epoch, cursor, limit: 32 }); cursor = page.cursor; assert(++count < 10); } while (cursor !== null);
  assert.equal(resolve(f, a, applied).local.status, 'resolved');
});

test('a disappeared binding does not block the narrow authenticated source lifecycle route or permit ordinary assertions', t => {
  const f = fixture(t), a = bind(f), applied = f.explorations.mutate(f.context, mutation(f, a, 'lifecycle-protected'));
  const key = 'explicit-source-revocation', object = f.event.provenance.source_objects[0].object;
  const acl = { revision: key, allowed_principal_ids: ['owner', 'reader'] };
  const event = { schema_version: 1, kind: 'raw_event',
    event_id: f.ingress.eventIdFor(f.context, { registration_id: f.source.registration_id, idempotency_key: key }),
    partition: f.source.registration.partition, source_native_event_id: key, idempotency_key: key, source_event_type: 'access',
    occurred_at: null, observed_at: '2026-09-22T15:00:00.000Z', producer: { ...f.source.registration.producer, sequence: 1 }, causal_parents: [], identity: {},
    payload: { kind: 'object_revision', object, revision_id: key, digest: hashText(key) },
    provenance: { delivery: { channel: 'system', delivery_id: key }, source_objects: [{ object, acl, sensitivity: 'normal' }] }, acl, sensitivity: 'normal' };
  f.ingress.submitSourceLifecycle(f.context, { registration_id: f.source.registration_id, epoch: f.epoch, event,
    expectedVersion: f.source.version, access_state: 'unknown', access: { enabled: false, allowed_principal_ids: [], sensitivity: 'restricted', allow_snapshots: false } });
  const selected = f.feed.readLifecycleEvent(f.context, { invalidation_id: sourceLifecycleInvalidationId(SCOPE, event.event_id) });
  renameSync(f.folder, `${f.folder}-removed`);
  const lifecycle = f.graph.mutate(f.context, { epoch: f.epoch, idempotency_key: key, publisher_ref: f.publisher.publisher_ref,
    expected_graph: applied.receipt.next_graph, operation: { kind: 'source_access', event: selected.event, access_state: 'unknown' }, coverage: null });
  assert.equal(lifecycle.status, 'applied'); assert.equal(resolve(f, a, applied).local.status, 'denied');
  rejected(() => f.graph.mutate(f.context, { epoch: f.epoch, idempotency_key: 'lifecycle-is-not-assertion-permission', publisher_ref: f.publisher.publisher_ref,
    expected_graph: lifecycle.receipt.next_graph, operation: mutation(f, a, 'forbidden-ordinary').operation, coverage: null }));
});

test('inherited inaccessible support and actor-owned receipts remain protected through exploration routing', t => {
  const f = fixture(t), a = bind(f), secret = capture(f, f.source, { sequence: 1, key: 'owner-only-support', principals: ['owner'], objectId: 'private-source' });
  const parent = f.explorations.mutate(f.context, mutation(f, a, 'private-parent', { operation: { kind: 'assert', assertion: assertion(f, secret, 'private-parent') } }));
  const reader = f.issue({ principal: 'reader' }).context, publisher = f.graph.registerPublisherRun(reader, { epoch: f.epoch, run_key: 'reader-publisher' });
  const command = mutation(f, a, 'inherited-secret', { publisher_ref: publisher.publisher_ref, expected_graph: parent.receipt.next_graph,
    operation: { kind: 'assert', assertion: assertion(f, f.event, 'inherited-secret', { execution_id: publisher.execution_id, entity_id: 'another-object', parents: [parent.revision] }) } });
  const before = rows(f); rejected(() => f.explorations.mutate(reader, command)); assert.deepEqual(rows(f), before);
  assert.equal(f.explorations.getReceipt(reader, { idempotency_key: 'mutate-private-parent' }), null);
  const view = f.explorations.resolve(reader, { exploration_id: a.exploration_id, at: parent.receipt.next_graph, address: parent.revision, shared_keys: null });
  assert.equal(view.local.status, 'denied'); assert(!JSON.stringify(view).includes('Synthetic private-parent'));
});

test('missing format, unsupported format and missing selected index fail closed without automatic repair', async t => {
  for (const fault of ['missing-format', 'future-format', 'missing-index']) await t.test(fault, t => {
    const f = fixture(t); bind(f);
    const db = new DatabaseSync(f.filePath);
    if (fault === 'missing-format') db.prepare('DELETE FROM records WHERE namespace=? AND key=?').run('exploration-projection', 'format');
    else if (fault === 'future-format') {
      const row = db.prepare('SELECT value FROM records WHERE namespace=? AND key=?').get('exploration-projection', 'format');
      db.prepare('UPDATE records SET value=? WHERE namespace=? AND key=?').run(JSON.stringify({ ...JSON.parse(row.value), schema_version: 9000 }), 'exploration-projection', 'format');
    } else db.prepare('DELETE FROM sources WHERE namespace=? AND kind=?').run('exploration-projection', 'exploration-index');
    db.close(); const before = rows(f);
    rejected(() => f.explorations.list(f.context, { cursor: null, limit: 32 })); assert.deepEqual(rows(f), before);
  });
});
