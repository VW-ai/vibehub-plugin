import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { DurableIngress, verifyEventPayload, validateNormalizedEvent, sourceObjectKey, sourceEventFingerprint,
  validateSourceCursor } from '../src/index.mjs';
import { fixture, sourceInput, register, observation, execution, counts, effect, rejected, clone,
  digest, git, NS, WORK, ACTIONS, SCOPE } from './fixtures/durable-ingress/scenario.mjs';

const eventRef = request => ({ event_id: request.event.event_id });
const cursor = (f, source) => f.ingress.getSource(f.context, { registration_id: source.registration_id }).cursor;
const submit = (f, request) => f.ingress.submit(f.context, request);
const rawRows = f => { const db = new DatabaseSync(f.filePath, { readOnly: true });
  try { return JSON.stringify(['records', 'sources', 'outbox'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())); }
  finally { db.close(); } };

test('approved redacted bytes, raw/normalized envelopes and first pins survive a committed ACK and restart', t => {
  const canary = 'RAW_CREDENTIAL_CANARY_NEVER_STORE';
  const f = fixture(t, { snapshotPolicy: ({ text }) => text.includes(canary) ? null : text }); const source = register(f);
  const raw = `Decision: use local workers. key=${canary}`;
  const rejectedRequest = observation(f, source, { text: raw }); const initial = counts(f);
  let diagnostic = ''; try { submit(f, rejectedRequest); assert.fail('raw body accepted'); } catch (error) { diagnostic = String(error); assert.equal(error.code, 'sanitization_required'); }
  assert(!diagnostic.includes(canary)); assert(!rawRows(f).includes(canary)); assert.deepEqual(counts(f), initial);
  // Upstream sanitization happens before building the approved snapshot reference and its digest.
  const selected = raw.replace(/key=\S+/, 'key=[redacted]');
  const request = observation(f, source, { text: selected }); const accepted = submit(f, request);
  assert.equal(accepted.status, 'accepted'); assert.equal(accepted.receipt.activation_epoch, 1);
  assert.equal(accepted.receipt.event_id, request.event.event_id);
  const original = f.ingress.readEvent(f.context, eventRef(request));
  assert.deepEqual(original.raw, request.event); assert.equal(validateNormalizedEvent(original.event), true);
  assert.equal(original.event.replay.eligible, true); assert.equal(original.event.replay.authorization.storage, 'immutable');
  assert.equal(sourceEventFingerprint(original.event), accepted.receipt.source_fingerprint);
  assert.equal(accepted.receipt.registration_version, source.version);
  assert(f.store.getSource(f.context, NS, accepted.receipt.source_access_ref));
  assert(f.store.getSource(f.context, NS, accepted.receipt.catalog_ref));
  assert(f.store.getSource(f.context, NS, accepted.receipt.mapping_ref));
  assert(f.store.getSource(f.context, NS, accepted.receipt.snapshot_authorization_ref));
  f.store.close(); const reopened = f.reopen();
  assert.deepEqual(reopened.ingress.getReceipt(reopened.context, eventRef(request)), accepted.receipt);
  assert.deepEqual(reopened.ingress.readEvent(reopened.context, eventRef(request)), original);
  const snapshot = reopened.ingress.readSnapshot(reopened.context, eventRef(request));
  assert.equal(snapshot.text, selected); assert.equal(snapshot.digest, request.event.payload.digest);
  assert.equal(verifyEventPayload(request.event.payload, Buffer.from(snapshot.text)), true);
  assert.equal(reopened.ingress.listPending(reopened.context).length, 1);
  assert.equal(cursor(reopened, source).state.completed_through, null);
  const firstCounts = counts(reopened); assert.deepEqual(submit(reopened, request), { status: 'duplicate', receipt: accepted.receipt });
  assert.deepEqual(counts(reopened), firstCounts);
  assert(!rawRows(reopened).includes(canary));
});

test('harmless receipt retry preserves original full pins after an unrelated Git catalog update', t => {
  const f = fixture(t), source = register(f), request = observation(f, source), accepted = submit(f, request);
  const original = f.ingress.readEvent(f.context, eventRef(request)); const pinned = counts(f), beforeCursor = cursor(f, source);
  git(f.folder, 'branch', 'unrelated'); const registry = f.registry.get(f.context);
  f.registry.refresh(f.context, { checkout_id: registry.value.checkouts[0].checkout_id, expectedVersion: registry.version });
  const retry = clone(request); retry.event.observed_at = '2026-09-23T20:00:00.000Z'; retry.event.provenance.delivery.delivery_id = 'new-delivery-attempt';
  assert.deepEqual(submit(f, retry), { status: 'duplicate', receipt: accepted.receipt });
  assert.deepEqual(f.ingress.readEvent(f.context, eventRef(request)), original);
  assert.deepEqual(counts(f), pinned); assert.deepEqual(cursor(f, source), beforeCursor);
});

test('logical retry, payload, sequence, ACL and cross-entry conflicts cannot advance or append', t => {
  const f = fixture(t), source = register(f), first = observation(f, source), second = observation(f, source, { sequence: 1 });
  submit(f, first); submit(f, second); const saved = counts(f), savedCursor = cursor(f, source);
  const cases = [
    r => { r.snapshot_text = 'different bytes'; r.event.payload.digest = digest(r.snapshot_text); },
    r => { r.event.producer.sequence = 8; },
    r => { r.event.acl.revision = 'changed-acl'; },
    r => { r.event.acl.allowed_principal_ids = ['owner']; },
    r => { r.event.sensitivity = 'sensitive'; },
    r => { r.event.occurred_at = '2026-09-22T12:00:00.000Z'; },
    r => { r.event.source_native_event_id = 'changed-native'; },
    r => { r.event.producer.sequence = 1; },
    r => { r.event.event_id = second.event.event_id; },
  ];
  for (const alter of cases) { const retry = clone(first); alter(retry); rejected(() => submit(f, retry)); }
  const positionConflict = observation(f, source, { sequence: 0, key: 'another-key' }); rejected(() => submit(f, positionConflict));
  assert.deepEqual(counts(f), saved); assert.deepEqual(cursor(f, source), savedCursor);
});

test('explicit sequence origin, out-of-order 0,2,1 and null retain receipt gaps independently of projection', t => {
  const f = fixture(t), source = register(f);
  for (const [sequence, acceptedThrough, gaps] of [[0, 0, []], [2, 0, [{ from: 1, through: 1 }]], [1, 2, []], [null, 2, []]]) {
    const request = observation(f, source, { sequence }); submit(f, request);
    const current = cursor(f, source).state; assert.equal(current.accepted_through, acceptedThrough);
    assert.deepEqual(current.gaps, gaps); assert.equal(current.completed_through, null);
  }
  const current = cursor(f, source).state; assert.equal(current.unordered_count, 1); assert.equal(current.maximum_sequence, 2);
  const alternate = register(f, { producer: { producer_id: 'fixture-adapter', epoch: 'start-10' }, start_sequence: 10 });
  submit(f, observation(f, alternate, { sequence: 12 }));
  assert.equal(cursor(f, alternate).state.accepted_through, null);
  assert.deepEqual(cursor(f, alternate).state.gaps, [{ from: 10, through: 11 }]);
  rejected(() => submit(f, observation(f, alternate, { sequence: 9 })));
  const absentOrigin = sourceInput(f); delete absentOrigin.start_sequence; rejected(() => f.ingress.registerSource(f.context, absentOrigin));
});

test('separate local/fetch/push observations correlate the same Git object without deduplication', t => {
  const f = fixture(t), source = register(f), ids = execution(f);
  const object = { kind: 'git_commit', tenant_id: SCOPE.tenant_id, repository_id: ids.repository_id,
    object_format: 'sha1', oid: git(f.folder, 'rev-parse', 'HEAD') };
  const events = ['local_git', 'fetch', 'push'].map((channel, sequence) => {
    const request = observation(f, source, { sequence, snapshot: false, source_event_type: 'git.commit', identity: ids });
    request.event.payload = { kind: 'git_revision', object, path: null, digest: digest('selected commit description') };
    request.event.provenance = { delivery: { channel, delivery_id: `git-${channel}` }, source_objects: [{ object,
      acl: clone(request.event.acl), sensitivity: 'normal' }] };
    assert.equal(submit(f, request).status, 'accepted'); return f.ingress.readEvent(f.context, eventRef(request)).event;
  });
  assert.equal(new Set(events.map(e => e.event_id)).size, 3);
  assert.equal(new Set(events.map(e => sourceObjectKey(e.payload.object))).size, 1);
  assert.equal(f.ingress.listPending(f.context).length, 3);
});

test('reference-only intake never reads mutable file/URL pointers or manufactures a snapshot', t => {
  const f = fixture(t), source = register(f); let fetched = 0; const original = globalThis.fetch;
  globalThis.fetch = () => { fetched++; throw new Error('unexpected fetch'); }; t.after(() => { globalThis.fetch = original; });
  for (const [sequence, pointer_id] of ['https://invalid.example/selected', 'file:/missing/selected'].entries()) {
    const request = observation(f, source, { sequence, snapshot: false }); request.event.payload.pointer_id = pointer_id;
    const accepted = submit(f, request); assert.equal(accepted.receipt.snapshot_ref, null);
    assert.equal(f.ingress.readSnapshot(f.context, eventRef(request)), null);
    assert.equal(f.ingress.readEvent(f.context, eventRef(request)).event.replay.eligible, false);
  }
  assert.equal(fetched, 0);
});

test('service-owned source tuple/mapping/origin are immutable and duplicate registration cannot fork continuity', t => {
  const f = fixture(t), source = register(f), original = f.ingress.getSource(f.context, { registration_id: source.registration_id });
  rejected(() => register(f), 'duplicate_source');
  const duplicate = sourceInput(f, { start_sequence: 99, producer_principal_id: 'other', mapping: {
    schema_version: 1, mapping_id: 'changed', revision: '2', event_types: { 'user.note': 'USER_INTENT' } } });
  rejected(() => f.ingress.registerSource(f.context, duplicate), 'duplicate_source');
  rejected(() => f.ingress.updateSourceAccess(f.context, { registration_id: source.registration_id, expectedVersion: source.version,
    access: source.registration.access, start_sequence: 99 }));
  const before = counts(f); rejected(() => f.ingress.updateSourceAccess(f.context, { registration_id: source.registration_id, expectedVersion: 99, access: source.registration.access }));
  assert.deepEqual(counts(f), before); assert.deepEqual(f.ingress.getSource(f.context, { registration_id: source.registration_id }), original);
  for (const kind of ['host-adapter', 'connector', 'worker']) {
    const { context } = f.issue({ kind });
    rejected(() => f.ingress.registerSource(context, sourceInput(f, { producer: { producer_id: 'other', epoch: '1' } })));
    rejected(() => f.ingress.updateSourceAccess(context, { registration_id: source.registration_id, expectedVersion: source.version, access: source.registration.access }));
  }
});

test('unknown, foreign, missing-action, expired and revoked contexts cannot create records or invoke snapshot policy', t => {
  let calls = 0; const f = fixture(t, { snapshotPolicy: ({ text }) => { calls++; return text; } }), source = register(f), request = observation(f, source);
  const foreign = f.reopen(), expired = f.issue({ ttl_ms: 1 }), revoked = f.issue(); f.clock.now++;
  f.authority.revoke(revoked.issued.credential_id);
  const contexts = [{}, { ...f.context }, foreign.context, expired.context, revoked.context,
    f.issue({ scope: { ...SCOPE, project_id: 'other' } }).context,
    f.issue({ principal: 'reader' }).context,
    ...['ingress:submit', 'store:write', 'activation:admit', 'project:inspect'].map(action => f.issue({ actions: ACTIONS.filter(a => a !== action) }).context)];
  const before = rawRows(f);
  for (const context of contexts) rejected(() => f.ingress.submit(context, request));
  assert.equal(calls, 0); assert.equal(rawRows(f), before);
});

test('unregistered Session and contradictory scope/producer/execution fail before persistent intake', t => {
  const f = fixture(t), source = register(f, { execution: execution(f) }), request = observation(f, source); const before = counts(f);
  for (const mutate of [r => { r.event.identity.session_id = 'unknown-session'; }, r => { r.event.identity.execution_id = 'unknown-execution'; },
    r => { r.event.partition.project_id = 'other'; }, r => { r.event.partition.tenant_id = 'other'; },
    r => { r.event.producer.epoch = 'other'; }, r => { r.event.producer.producer_id = 'other'; },
    r => { r.event.identity.worktree_id = 'unknown'; }, r => { r.event.identity = {}; },
    r => { r.event.acl.allowed_principal_ids.push('unregistered-reader'); }, r => { r.registration = source.registration; }]) {
    const altered = clone(request); mutate(altered); rejected(() => submit(f, altered));
  }
  assert.deepEqual(counts(f), before);
});

test('current source access intersects captured access; disable preserves historical receipt and rejects new work', t => {
  const f = fixture(t), source = register(f), request = observation(f, source), accepted = submit(f, request), reader = f.issue({ principal: 'reader' });
  assert.equal(f.ingress.readSnapshot(reader.context, eventRef(request)).text, request.snapshot_text);
  let updated = f.ingress.updateSourceAccess(f.context, { registration_id: source.registration_id, expectedVersion: source.version,
    access: { ...source.registration.access, allowed_principal_ids: ['owner'] } });
  rejected(() => f.ingress.readSnapshot(reader.context, eventRef(request))); rejected(() => f.ingress.readEvent(reader.context, eventRef(request)));
  updated = f.ingress.updateSourceAccess(f.context, { registration_id: source.registration_id, expectedVersion: updated.version,
    access: { ...source.registration.access, enabled: false } });
  const before = counts(f), beforeCursor = cursor(f, source); let calls = 0;
  rejected(() => submit(f, observation(f, source, { sequence: 1 })));
  rejected(() => f.ingress.handoff(f.context, eventRef(request), () => calls++)); assert.equal(calls, 0);
  assert.deepEqual(f.ingress.getReceipt(f.context, eventRef(request)), accepted.receipt);
  assert.deepEqual(counts(f), before); assert.deepEqual(cursor(f, source), beforeCursor);
  f.ingress.updateSourceAccess(f.context, { registration_id: source.registration_id, expectedVersion: updated.version,
    access: { ...source.registration.access, allowed_principal_ids: ['owner', 'reader', 'new-reader'] } });
  rejected(() => f.ingress.readSnapshot(f.issue({ principal: 'new-reader' }).context, eventRef(request)));
});

test('project disable/re-enable and unavailable worktree fence original capture and downstream epochs', t => {
  const f = fixture(t), source = register(f, { execution: execution(f) }), request = observation(f, source), accepted = submit(f, request);
  f.activation.setEnabled(f.context, { enabled: false, expectedVersion: 1 }); const before = counts(f); let calls = 0;
  rejected(() => submit(f, request)); rejected(() => f.ingress.handoff(f.context, eventRef(request), () => calls++));
  assert.deepEqual(f.ingress.getReceipt(f.context, eventRef(request)), accepted.receipt);
  f.activation.setEnabled(f.context, { enabled: true, expectedVersion: 2 });
  rejected(() => submit(f, request)); rejected(() => f.ingress.handoff(f.context, eventRef(request), () => calls++));
  assert.equal(calls, 0); assert.deepEqual(counts(f), before);
  const next = observation(f, source, { sequence: 1 }); next.epoch = 3; submit(f, next);
  const enrolled = f.registry.get(f.context); renameSync(f.folder, join(f.root, 'unavailable'));
  f.registry.refresh(f.context, { checkout_id: enrolled.value.checkouts[0].checkout_id, expectedVersion: enrolled.version });
  const noMembership = observation(f, source, { sequence: 2 }); noMembership.epoch = 3;
  rejected(() => submit(f, noMembership)); rejected(() => f.ingress.handoff(f.context, eventRef(next), () => calls++));
  assert.equal(calls, 0); assert.equal(f.ingress.listPending(f.context).length, 2);
});

test('snapshot policy must approve exact text synchronously; digest, UTF-8 and inert input bounds fail closed', t => {
  const canary = 'REJECTED_BODY_CANARY'; const f = fixture(t), source = register(f), request = observation(f, source); const before = counts(f);
  for (const policy of [undefined, () => null, ({ text }) => text + 'rewritten', async ({ text }) => text,
    () => { throw new Error(canary); }]) {
    const service = new DurableIngress({ store: f.store, authority: f.authority, ...(policy ? { snapshotPolicy: policy } : {}) });
    assert.throws(() => service.submit(f.context, request), error => error.category === 'rejected' && !String(error).includes(canary));
  }
  let hooks = 0; const getter = clone(request); Object.defineProperty(getter.event, 'kind', { enumerable: true, get() { hooks++; return 'raw_event'; } });
  const injected = clone(request); injected.event.toJSON = () => { hooks++; return request.event; };
  const cases = [getter, injected, { ...request, snapshot_text: Buffer.from([0xff]) },
    { ...request, snapshot_text: '\ud800' }, { ...request, snapshot_text: { raw_transcript: canary } },
    { ...request, raw_log: canary }, { ...request, snapshot_text: 'x'.repeat(65_537) },
    { ...request, snapshot_text: 'wrong digest' }];
  const forged = clone(request); forged.event.payload.authorized = true; cases.push(forged);
  for (const invalid of cases) assert.throws(() => submit(f, invalid), error => error.category === 'rejected' && !String(error).includes(canary));
  assert.equal(hooks, 0); assert.deepEqual(counts(f), before); assert(!rawRows(f).includes(canary));
  // Exact 64 KiB is supported; JSON escaping makes a different 64 KiB string exceed the independent 128 KiB envelope bound.
  const maximum = observation(f, source, { text: 'x'.repeat(65_536) }); assert.equal(submit(f, maximum).status, 'accepted');
  const oversizedEnvelope = observation(f, source, { sequence: 1, text: '\u0000'.repeat(65_536) }); rejected(() => submit(f, oversizedEnvelope));
  for (const limit of [0, 65, 1.5]) rejected(() => f.ingress.listPending(f.context, { limit }));
});

test('handoff commits one durable consumer effect and ACK together; retry never invokes another callback or projection completion', t => {
  const f = fixture(t), source = register(f), request = observation(f, source); submit(f, request); let calls = 0, retained;
  const result = f.ingress.handoff(f.context, eventRef(request), (tx, input) => { calls++; retained = input; effect(tx, input); });
  assert.equal(result.status, 'handed_off'); assert.equal(result.receipt.consumer, 'ingress-policy');
  assert.equal(retained.snapshot.text, request.snapshot_text); assert.deepEqual(retained.raw, request.event);
  assert.equal(f.ingress.listPending(f.context).length, 0); assert.equal(cursor(f, source).state.completed_through, null);
  f.store.close(); const reopened = f.reopen();
  assert.deepEqual(reopened.ingress.handoff(reopened.context, eventRef(request), () => calls++), { status: 'duplicate', receipt: result.receipt });
  assert.equal(calls, 1); assert.equal(reopened.store.getRecord(reopened.context, WORK, request.event.event_id).version, 1);
  assert.equal(typeof reopened.ingress.ack, 'undefined');
});

test('handoff exceptions/async/expiry/revocation roll back effect and receipt, retain intent, and permit a fresh retry', async t => {
  const f = fixture(t), source = register(f), request = observation(f, source); submit(f, request); const before = counts(f); let stale;
  for (const mode of ['throw', 'async', 'revoke', 'expire']) {
    const actor = f.issue({ ttl_ms: mode === 'expire' ? 1 : 60000 });
    assert.throws(() => f.ingress.handoff(actor.context, eventRef(request), (tx, input) => {
      stale = tx; effect(tx, input);
      if (mode === 'throw') throw new Error('PRIVATE_CALLBACK_CANARY');
      if (mode === 'async') return Promise.resolve();
      if (mode === 'revoke') f.authority.revoke(actor.issued.credential_id);
      if (mode === 'expire') f.clock.now++;
    }), error => !String(error).includes('PRIVATE_CALLBACK_CANARY'));
    assert.equal(f.store.getRecord(f.context, WORK, request.event.event_id), null); assert.deepEqual(counts(f), before);
    assert.throws(() => stale.enqueue(WORK, 'late', {}), /stale_transaction/);
  }
  assert.equal(f.ingress.handoff(f.context, eventRef(request), effect).status, 'handed_off');
});

test('snapshot identity cannot be rebound by a different observation, while identical bytes can support separate events', t => {
  const f = fixture(t), source = register(f), first = observation(f, source); submit(f, first);
  const same = observation(f, source, { sequence: 1 }); same.event.payload.snapshot_id = first.event.payload.snapshot_id;
  const second = submit(f, same); assert.equal(second.status, 'accepted');
  assert.equal(second.receipt.snapshot_ref, f.ingress.getReceipt(f.context, eventRef(first)).snapshot_ref);
  const conflicting = observation(f, source, { sequence: 2, text: 'different snapshot meaning' });
  conflicting.event.payload.snapshot_id = first.event.payload.snapshot_id; const before = counts(f), priorCursor = cursor(f, source);
  rejected(() => submit(f, conflicting), 'snapshot_conflict');
  assert.deepEqual(counts(f), before); assert.deepEqual(cursor(f, source), priorCursor);
  assert.equal(f.ingress.readSnapshot(f.context, eventRef(first)).text, first.snapshot_text);
});

test('tightened source sensitivity fences historical materialization without rewriting its captured classification or digest', t => {
  const f = fixture(t), source = register(f), normal = observation(f, source), restricted = observation(f, source, { sequence: 1, sensitivity: 'restricted' });
  const a = submit(f, normal), b = submit(f, restricted), stored = f.ingress.readEvent(f.context, eventRef(normal));
  const db = new DatabaseSync(f.filePath, { readOnly: true });
  const priorRows = db.prepare("SELECT id,value FROM sources WHERE namespace=? AND kind='admitted-event' ORDER BY id").all(NS); db.close();
  f.ingress.updateSourceAccess(f.context, { registration_id: source.registration_id, expectedVersion: source.version,
    access: { ...source.registration.access, sensitivity: 'restricted' } });
  for (const method of ['readEvent', 'readSnapshot', 'getReceipt']) rejected(() => f.ingress[method](f.context, eventRef(normal)), 'source_access_denied');
  assert.deepEqual(f.ingress.listPending(f.context).map(item => item.value.event_id), [restricted.event.event_id]);
  assert.deepEqual(f.ingress.getReceipt(f.context, eventRef(restricted)), b.receipt);
  assert.equal(f.ingress.readSnapshot(f.context, eventRef(restricted)).text, restricted.snapshot_text);
  const dbAfter = new DatabaseSync(f.filePath, { readOnly: true });
  assert.deepEqual(dbAfter.prepare("SELECT id,value FROM sources WHERE namespace=? AND kind='admitted-event' ORDER BY id").all(NS), priorRows); dbAfter.close();
  assert.equal(stored.event.effective_access.sensitivity, 'normal'); assert.equal(a.receipt.event_digest, stored.receipt.event_digest);
});

test('source cursor does not leak entries excluded by the individual captured ACL', t => {
  const f = fixture(t), source = register(f), request = observation(f, source); request.event.acl.allowed_principal_ids = ['owner'];
  submit(f, request); const reader = f.issue({ principal: 'reader' });
  rejected(() => f.ingress.getSource(reader.context, { registration_id: source.registration_id }), 'source_access_denied');
  assert.deepEqual(f.ingress.listPending(reader.context), []);
  assert.equal(cursor(f, source).state.entries.length, 1);
});

test('handoff fences callback changes to source, activation and enrollment rows together with consumer effects', t => {
  const f = fixture(t), source = register(f), request = observation(f, source); submit(f, request); const before = counts(f);
  const db = new DatabaseSync(f.filePath, { readOnly: true });
  const sourceKey = db.prepare("SELECT key FROM records WHERE namespace=? AND json_extract(value,'$.registration_id')=? AND json_extract(value,'$.schema_version')=1").get(NS, source.registration_id).key; db.close();
  for (const [namespace, key] of [[NS, sourceKey], ['project-activation', 'state'], ['git-enrollment', 'catalog']]) {
    const original = f.store.getRecord(f.context, namespace, key);
    assert.throws(() => f.ingress.handoff(f.context, eventRef(request), (tx, input) => {
      effect(tx, input); tx.compareAndSwap(namespace, key, original.version, original.value);
    }));
    assert.deepEqual(f.store.getRecord(f.context, namespace, key), original);
    assert.equal(f.store.getRecord(f.context, WORK, request.event.event_id), null); assert.deepEqual(counts(f), before);
  }
  assert.equal(f.ingress.handoff(f.context, eventRef(request), effect).status, 'handed_off');
});

test('pending read has an enforced 64-item cap and a tighter store cursor capacity rolls back every new source', t => {
  const f = fixture(t), source = register(f);
  for (let sequence = 0; sequence < 65; sequence++) submit(f, observation(f, source, { sequence, snapshot: false }));
  assert.equal(f.ingress.listPending(f.context).length, 64);
  assert.equal(f.ingress.listPending(f.context, { limit: 3 }).length, 3);
  // Seed an independently schema-validated synthetic near-limit cursor through the ordinary store API.
  // This isolates the store's tighter byte bound without thousands of unrelated intake calls.
  const current = cursor(f, source), near = clone(current.state), template = clone(near.entries[0]);
  near.entries = []; near.maximum_sequence = null; near.accepted_through = null; near.completed_through = null; near.gaps = [];
  const append = i => near.entries.push({ ...clone(template), event_ref: { ...SCOPE, event_id: `capacity-fixture-${i}` },
    sequence: null, idempotency_key: `capacity-${i}-` + 'x'.repeat(1800), causal_parents: [] });
  while (Buffer.byteLength(JSON.stringify(near)) < 1_045_000) append(near.entries.length);
  while (Buffer.byteLength(JSON.stringify(near)) > 1_048_300) near.entries.pop();
  near.unordered_count = near.entries.length;
  // Pad the last schema-valid retry key to leave less than one ordinary new entry available.
  while (Buffer.byteLength(JSON.stringify(near)) < 1_048_400) {
    const entry = near.entries.find(e => e.idempotency_key.length < 1999);
    const room = 1_048_400 - Buffer.byteLength(JSON.stringify(near));
    entry.idempotency_key += 'p'.repeat(Math.min(room, 1999 - entry.idempotency_key.length));
  }
  assert.equal(validateSourceCursor(near), true); assert(near.entries.length < 4096);
  const db = new DatabaseSync(f.filePath, { readOnly: true });
  const key = db.prepare("SELECT key FROM records WHERE namespace=? AND json_extract(value,'$.kind')='source_cursor'").get(NS).key; db.close();
  f.store.transaction(f.context, tx => tx.compareAndSwap(NS, key, current.version, near));
  const saved = counts(f), request = observation(f, source, { sequence: null, key: 'past-capacity' });
  const savedCursor = f.store.getRecord(f.context, NS, key);
  rejected(() => submit(f, request), 'ingress_capacity');
  assert.equal(f.ingress.getReceipt(f.context, eventRef(request)), null);
  assert.deepEqual(counts(f), saved); assert.deepEqual(f.store.getRecord(f.context, NS, key), savedCursor);
});

test('closed store reports a bounded retryable failure and does not require any model or host activity', t => {
  const f = fixture(t), source = register(f), request = observation(f, source); f.store.close();
  assert.throws(() => submit(f, request), error => error.category === 'retryable_failure' && error.code === 'store_closed');
  const recovered = f.reopen(); assert.equal(recovered.ingress.submit(recovered.context, request).status, 'accepted');
});
