import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainStore, DOMAIN_SCHEMA_VERSION, planDomainStore, migrateDomainStore } from '../src/local/domain-store.mjs';
import { LocalCredentialAuthority, LOCAL_AUDIENCE } from '../src/adapters/auth/local-credential-authority.mjs';
import { scopedReference } from '../src/core/service-access.mjs';
import { DomainStore as PublicDomainStore } from '../src/index.mjs';

const namespace = 'selected-source';
function identity(authority, { tenant = 'tenant', project = 'project', actions = ['store:read', 'store:write'], ttl_ms = 900000, audience = LOCAL_AUDIENCE } = {}) {
  const scope = { tenant_id: tenant, project_id: project };
  const issued = authority.issue({ principal_id: 'synthetic-owner', kind: 'service', scope, actions, ttl_ms, audience });
  return { issued, context: authority.authorize(issued.credential, { scope, audience, action: actions[0], kinds: ['service'], boundary: 'object',
    reference: scopedReference('object', scope, 'selected-test') }).context };
}
function fixture(t, targetVersion = 2) {
  const directory = mkdtempSync(join(tmpdir(), 'vh-selected-')), filePath = join(directory, 'store.sqlite'), clock = { now: 1000 };
  migrateDomainStore({ filePath, targetVersion });
  const authority = new LocalCredentialAuthority({ now: () => clock.now }), options = { filePath, authority, namespaces: [namespace, 'other-space'] };
  const store = new DomainStore(options), { context } = identity(authority), connections = [store];
  t.after(() => { for (const connection of connections) connection.close(); rmSync(directory, { recursive: true, force: true }); });
  return { filePath, authority, store, context, clock, connect() { const connection = new DomainStore(options); connections.push(connection); return connection; } };
}
const range = (overrides = {}) => ({ lower: 'row-', upper: 'row.', order: 'asc', limit: 64, after: null, ...overrides });
function seed(store, context, ids, ns = namespace) { store.transaction(context, tx => { for (const id of ids) tx.appendSource(ns, id, 'synthetic', { id }); }); }
const ids = page => page.rows.map(row => row.id);
const safeCode = (code, privateText = 'synthetic-private-canary') => error => error.code === code && !String(error).includes(privateText);

test('source range is BINARY ordered, scoped, bounded and direction-relative exclusive at every continuation', t => {
  const { store, context } = fixture(t), values = ['row-a', 'row-A', 'row-0', 'row-Z', 'row-z', 'row._outside', 'row-b']; seed(store, context, values);
  const expected = values.filter(id => id >= 'row-' && id < 'row.').sort();
  const asc = store.getSourceRange(context, namespace, range({ limit: 2 })); assert.deepEqual(ids(asc), expected.slice(0, 2)); assert.equal(asc.last_id, expected[1]);
  const asc2 = store.getSourceRange(context, namespace, range({ limit: 2, after: asc.last_id })); assert.deepEqual(ids(asc2), expected.slice(2, 4));
  const asc3 = store.getSourceRange(context, namespace, range({ after: asc2.last_id })); assert.deepEqual(ids(asc3), expected.slice(4));
  assert.deepEqual(store.getSourceRange(context, namespace, range({ after: expected.at(-1) })), { rows: [], last_id: null });
  const desc = store.getSourceRange(context, namespace, range({ order: 'desc', limit: 3 })); assert.deepEqual(ids(desc), expected.toReversed().slice(0, 3));
  const desc2 = store.getSourceRange(context, namespace, range({ order: 'desc', after: desc.last_id })); assert.deepEqual(ids(desc2), expected.toReversed().slice(3));
  assert.deepEqual(ids(store.getSourceRange(context, namespace, range({ after: 'row-C' }))), expected.filter(id => id > 'row-C'));
  assert.deepEqual(ids(store.getSourceRange(context, namespace, range({ order: 'desc', after: 'row-C' }))), expected.filter(id => id < 'row-C').toReversed());
  assert.deepEqual(store.getSourceRange(context, namespace, range({ lower: 'row-A', upper: 'row-Z' })).rows.map(row => row.id), ['row-A']);
  assert.deepEqual(store.getSourceRange(context, namespace, range({ lower: 'empty-', upper: 'empty.' })), { rows: [], last_id: null });
  assert.deepEqual(asc.rows[0], { id: expected[0], kind: 'synthetic', value: { id: expected[0] } });
});

test('range exact inert options reject bounds, escaped continuation, accessors and oversized data without evaluating hooks', t => {
  const { store, context } = fixture(t); let invoked = 0;
  const getter = range(); Object.defineProperty(getter, 'lower', { enumerable: true, get() { invoked++; return 'row-'; } });
  const hook = { ...range(), toJSON() { invoked++; return {}; } }, inherited = Object.create(range());
  const proxy = new Proxy(range(), { get() { invoked++; }, getPrototypeOf() { invoked++; return Object.prototype; }, ownKeys() { invoked++; return []; } });
  const missing = Object.keys(range()).map(key => { const options = range(); delete options[key]; return options; });
  const invalid = [undefined, null, {}, getter, hook, inherited, proxy, ...missing, { ...range(), arbitrary_scope: 'other' }, range({ lower: 'row.', upper: 'row-' }), range({ lower: 'row-', upper: 'row-' }),
    range({ lower: 'with space' }), range({ upper: 'é' }), range({ upper: 'z'.repeat(201) }), range({ limit: 0 }), range({ limit: 65 }), range({ limit: 1.5 }), range({ order: 'DESC' }),
    range({ after: 'row.' }), range({ after: 'r' }), range({ after: '' }), range({ after: 'row-\nsynthetic-private-canary' }), range({ lower: 'x'.repeat(1048577) })];
  for (const options of invalid) assert.throws(() => store.getSourceRange(context, namespace, options), safeCode('invalid_store_input'));
  assert.equal(invoked, 0); assert.deepEqual(store.getSourceRange(context, namespace, range()), { rows: [], last_id: null });
});

test('scope/namespace and current opaque read grant apply to ranges and snapshots independently of continuation IDs', t => {
  const { store, context, authority } = fixture(t);
  const otherProject = identity(authority, { project: 'other' }), otherTenant = identity(authority, { tenant: 'other' }), reader = identity(authority, { actions: ['store:read'] });
  for (const [ctx, marker] of [[context, 'a'], [otherProject.context, 'b'], [otherTenant.context, 'c']]) store.transaction(ctx, tx => tx.appendSource(namespace, 'row-A', 'synthetic', { marker }));
  seed(store, context, ['row-B'], 'other-space');
  assert.equal(store.getSourceRange(reader.context, namespace, range()).rows[0].value.marker, 'a');
  assert.equal(store.getSourceRange(otherProject.context, namespace, range()).rows[0].value.marker, 'b');
  assert.equal(store.getSourceRange(otherTenant.context, namespace, range()).rows[0].value.marker, 'c');
  assert.deepEqual(ids(store.getSourceRange(context, 'other-space', range())), ['row-B']);
  assert.throws(() => store.getSourceRange(context, 'unregistered', range()), /unknown_namespace/);
  assert.equal(store.readSnapshot(reader.context, tx => tx.getSource(namespace, 'row-A')).value.marker, 'a');
  const writerOnly = identity(authority, { actions: ['store:write'] });
  const foreign = identity(new LocalCredentialAuthority()).context, wrongAudience = identity(authority, { audience: 'not-local-api' }).context;
  for (const ctx of [{}, { ...context }, foreign, wrongAudience, writerOnly.context]) {
    assert.throws(() => store.getSourceRange(ctx, namespace, range()), /store_unauthorized/);
    let invoked = false; assert.throws(() => store.readSnapshot(ctx, () => { invoked = true; }), /store_unauthorized/); assert.equal(invoked, false);
  }
  assert.throws(() => store.transaction(writerOnly.context, tx => tx.getSourceRange(namespace, range())), /store_unauthorized/);
  authority.revoke(reader.issued.credential_id); assert.throws(() => store.getSourceRange(reader.context, namespace, range()), /store_unauthorized/);
});

test('real WAL snapshot retains first-read records and ranges while an independent writer commits, then a fresh view advances', t => {
  const { store, context, filePath, connect } = fixture(t), writer = connect(), raw = new DatabaseSync(filePath); t.after(() => raw.close());
  assert.equal(raw.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  store.transaction(context, tx => { tx.compareAndSwap(namespace, 'head', null, { value: 'before' }); tx.appendSource(namespace, 'row-A', 'synthetic', { value: 'before' }); });
  let snapshot;
  const value = store.readSnapshot(context, tx => {
    snapshot = tx; assert.equal(Object.isFrozen(tx), true); assert.deepEqual(Object.keys(tx).sort(), ['getRecord', 'getSource', 'getSourceRange']);
    assert.deepEqual(tx.getRecord(namespace, 'head'), { version: 1, value: { value: 'before' } });
    writer.transaction(context, w => { w.compareAndSwap(namespace, 'head', 1, { value: 'after' }); w.appendSource(namespace, 'row-B', 'synthetic', { value: 'after' }); });
    assert.equal(tx.getRecord(namespace, 'head').version, 1); assert.equal(store.getRecord(context, namespace, 'head').version, 1);
    assert.equal(tx.getSource(namespace, 'row-B'), null); assert.deepEqual(ids(tx.getSourceRange(namespace, range())), ['row-A']);
    return tx.getSource(namespace, 'row-A');
  });
  assert.equal(value.value.value, 'before'); assert.throws(() => snapshot.getSource(namespace, 'row-A'), /stale_transaction/);
  assert.equal(store.getRecord(context, namespace, 'head').version, 2);
  assert.deepEqual(store.readSnapshot(context, tx => ids(tx.getSourceRange(namespace, range()))), ['row-A', 'row-B']);
  // BEGIN DEFERRED pins at the first actual read, not callback entry.
  store.readSnapshot(context, tx => {
    writer.transaction(context, w => w.appendSource(namespace, 'row-C', 'synthetic', {}));
    assert.equal(tx.getSource(namespace, 'row-C').kind, 'synthetic');
  });
});

test('write handles expose exact source/range read-your-writes, commit atomically and go stale after success or rollback', t => {
  const { store, context } = fixture(t); let retained, rejected;
  store.transaction(context, tx => {
    retained = tx; tx.appendSource(namespace, 'row-A', 'synthetic', { value: 1 });
    assert.equal(tx.getSource(namespace, 'row-A').value.value, 1); assert.deepEqual(ids(tx.getSourceRange(namespace, range())), ['row-A']);
    tx.compareAndSwap(namespace, 'head', null, { value: 1 }); tx.enqueue(namespace, 'notice', {});
  });
  assert.throws(() => retained.getSource(namespace, 'row-A'), /stale_transaction/); assert.throws(() => retained.getSourceRange(namespace, range()), /stale_transaction/);
  assert.throws(() => store.transaction(context, tx => { rejected = tx; tx.appendSource(namespace, 'row-B', 'synthetic', {}); assert.deepEqual(ids(tx.getSourceRange(namespace, range())), ['row-A', 'row-B']); throw new Error('synthetic-private-canary'); }), safeCode('store_unavailable'));
  assert.equal(store.getSource(context, namespace, 'row-B'), null); assert.throws(() => rejected.getSource(namespace, 'row-A'), /stale_transaction/);
  assert.equal(store.pendingOutbox(context, namespace).length, 1);
});

test('nested read/write, close and rebuild reject before any first read and leave the original transaction usable', t => {
  const { store, context } = fixture(t);
  for (const outer of ['readSnapshot', 'transaction']) {
    for (const operation of [() => store.readSnapshot(context, () => {}), () => store.transaction(context, () => {}), () => store.close(), () => store.rebuildSourceKindIndex(context)]) {
      assert.throws(() => store[outer](context, () => operation()), /nested_transaction/);
      assert.deepEqual(store.readSnapshot(context, tx => tx.getSourceRange(namespace, range())), { rows: [], last_id: null });
    }
    store[outer](context, tx => { assert.throws(() => store.readSnapshot(context, () => {}), /nested_transaction/); assert.equal(tx.getRecord(namespace, 'missing'), null); });
  }
  assert.equal(store.transaction(context, tx => tx.compareAndSwap(namespace, 'after', null, {})), 1);
});

test('expiry/revocation are checked on every handle read and again before snapshot return without leaking callback results', t => {
  const { store, context, authority, clock } = fixture(t); seed(store, context, ['row-A']);
  for (const expire of [false, true]) {
    const who = identity(authority, { ttl_ms: 5 }); let captured;
    const invalidate = () => { if (expire) clock.now += 6; else authority.revoke(who.issued.credential_id); };
    assert.throws(() => store.readSnapshot(who.context, tx => { captured = tx; const result = tx.getSourceRange(namespace, range()); invalidate(); return result; }), /store_unauthorized/);
    assert.throws(() => captured.getSourceRange(namespace, range()), /stale_transaction/);
    const another = identity(authority, { ttl_ms: 5 });
    assert.throws(() => store.readSnapshot(another.context, tx => { if (expire) clock.now += 6; else authority.revoke(another.issued.credential_id); tx.getSource(namespace, 'row-A'); }), /store_unauthorized/);
    assert.equal(store.readSnapshot(identity(authority).context, tx => tx.getSource(namespace, 'row-A')).kind, 'synthetic');
  }
});

test('async/thenable callback results never run accessors, invalidate handles and rollback ordinary write effects', t => {
  const { store, context } = fixture(t); let hooks = 0, asyncCalls = 0;
  const getter = {}; Object.defineProperty(getter, 'then', { get() { hooks++; return () => {}; } });
  const inherited = Object.create(Object.defineProperty({}, 'then', { get() { hooks++; return () => {}; } }));
  const proxy = new Proxy({}, { get() { hooks++; }, getPrototypeOf() { hooks++; return Object.prototype; }, getOwnPropertyDescriptor() { hooks++; }, ownKeys() { hooks++; return []; } });
  const values = [Promise.resolve(1), { then() { hooks++; } }, getter, inherited, proxy];
  for (const outer of ['readSnapshot', 'transaction']) {
    const asyncOperation = async () => { asyncCalls++; };
    for (const operation of [asyncOperation, asyncOperation.bind(null)]) assert.throws(() => store[outer](context, operation), /async_transaction/);
    for (let i = 0; i < values.length; i++) {
      let handle;
      assert.throws(() => store[outer](context, tx => { handle = tx; if (outer === 'transaction') tx.appendSource(namespace, `row-${i}`, 'synthetic', {}); return values[i]; }), /async_transaction/);
      assert.throws(() => handle.getSource(namespace, 'row-A'), /stale_transaction/);
      assert.deepEqual(store.getSourceRange(context, namespace, range()), { rows: [], last_id: null });
    }
    assert.equal(store[outer](context, tx => tx.getRecord(namespace, 'missing')), null);
  }
  assert.equal(hooks, 0); assert.equal(asyncCalls, 0);
});

test('thrown callback error accessors/proxies cannot run code or leak diagnostics; every connection and handle recovers', t => {
  const { store, context } = fixture(t); let hooks = 0;
  const code = Object.defineProperty({}, 'code', { get() { hooks++; throw new Error('synthetic-private-canary'); } });
  const errcode = Object.defineProperty({}, 'errcode', { get() { hooks++; throw new Error('synthetic-private-canary'); } });
  const proxy = new Proxy({}, { get() { hooks++; throw new Error('synthetic-private-canary'); }, getOwnPropertyDescriptor() { hooks++; throw new Error('synthetic-private-canary'); }, getPrototypeOf() { hooks++; throw new Error('synthetic-private-canary'); } });
  for (const outer of ['readSnapshot', 'transaction']) for (const error of [code, errcode, proxy]) {
    let handle;
    assert.throws(() => store[outer](context, tx => { handle = tx; if (outer === 'transaction') tx.appendSource(namespace, 'row-error', 'synthetic', {}); throw error; }), safeCode('store_unavailable'));
    assert.throws(() => handle.getSource(namespace, 'row-error'), /stale_transaction/);
    assert.equal(store.readSnapshot(context, tx => tx.getSource(namespace, 'row-error')), null);
  }
  assert.equal(hooks, 0);
});

test('aggregate byte overflow rejects the whole range; explicit smaller requests succeed and snapshots remain reusable', t => {
  const { store, context } = fixture(t), large = { text: 'x'.repeat(540000) };
  store.transaction(context, tx => { tx.appendSource(namespace, 'row-A', 'synthetic', large); tx.appendSource(namespace, 'row-B', 'synthetic', large); });
  let page;
  assert.throws(() => { page = store.getSourceRange(context, namespace, range()); }, safeCode('store_page_too_large')); assert.equal(page, undefined);
  assert.throws(() => store.readSnapshot(context, tx => tx.getSourceRange(namespace, range())), /store_page_too_large/);
  assert.throws(() => store.transaction(context, tx => { tx.appendSource(namespace, 'row-C', 'synthetic', {}); tx.getSourceRange(namespace, range()); }), /store_page_too_large/);
  assert.equal(store.getSource(context, namespace, 'row-C'), null);
  const first = store.getSourceRange(context, namespace, range({ limit: 1 })); assert.equal(first.rows.length, 1); assert.equal(first.rows[0].value.text.length, 540000);
  assert.deepEqual(ids(store.getSourceRange(context, namespace, range({ limit: 1, after: first.last_id }))), ['row-B']);
});

test('the complete response accepts exactly1MiB and rejects one additional byte even when the individual source value fits', t => {
  const { store, context } = fixture(t), maximum = 1048576;
  const blank = { rows: [{ id: 'row-A', kind: 'synthetic', value: { text: '' } }], last_id: 'row-A' };
  const length = maximum - Buffer.byteLength(JSON.stringify(blank));
  store.transaction(context, tx => {
    tx.appendSource(namespace, 'row-A', 'synthetic', { text: 'x'.repeat(length) });
    tx.appendSource(namespace, 'row-B', 'synthetic', { text: 'x'.repeat(length + 1) });
  });
  const exact = store.getSourceRange(context, namespace, range({ limit: 1 })); assert.equal(Buffer.byteLength(JSON.stringify(exact)), maximum);
  assert.ok(Buffer.byteLength(JSON.stringify(store.getSource(context, namespace, 'row-B').value)) < maximum);
  assert.throws(() => store.getSourceRange(context, namespace, range({ limit: 1, after: 'row-A' })), /store_page_too_large/);
});

test('selected reads use the existing public class and schema without introducing an implicit migration, and closed handles reject', t => {
  const { store, context, filePath } = fixture(t, 1); assert.equal(PublicDomainStore, DomainStore);
  seed(store, context, ['row-A']); assert.deepEqual(ids(store.readSnapshot(context, tx => tx.getSourceRange(namespace, range()))), ['row-A']);
  const db = new DatabaseSync(filePath); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1); db.close();
  assert.deepEqual(planDomainStore({ filePath }).steps.map(step => step.version), [2]);
  store.close(); assert.throws(() => store.getSourceRange(context, namespace, range()), /store_closed/);
  assert.throws(() => store.readSnapshot(context, () => {}), /store_closed/);
});

test('malformed selected persisted JSON is bounded, unrelated rows remain readable and callback failure releases snapshot', t => {
  const { store, context, filePath } = fixture(t); seed(store, context, ['row-A', 'row-B']);
  const db = new DatabaseSync(filePath); t.after(() => db.close());
  db.exec('PRAGMA ignore_check_constraints=ON'); db.prepare('UPDATE sources SET value=? WHERE id=?').run('synthetic-private-canary-not-json', 'row-B');
  assert.throws(() => store.getSourceRange(context, namespace, range()), safeCode('store_unavailable'));
  assert.throws(() => store.readSnapshot(context, tx => tx.getSource(namespace, 'row-B')), safeCode('store_unavailable'));
  assert.deepEqual(ids(store.readSnapshot(context, tx => tx.getSourceRange(namespace, range({ upper: 'row-B' })))), ['row-A']);
  db.prepare('UPDATE sources SET value=? WHERE id=?').run(JSON.stringify({ repaired: true }), 'row-B');
  let captured; assert.throws(() => store.readSnapshot(context, tx => { captured = tx; throw new Error('synthetic-private-canary'); }), safeCode('store_unavailable'));
  assert.throws(() => captured.getRecord(namespace, 'x'), /stale_transaction/);
  assert.equal(store.getSource(context, namespace, 'row-B').value.repaired, true);
  assert.deepEqual(planDomainStore({ filePath }), { from_version: 2, to_version: 2, steps: [] }); assert.equal(DOMAIN_SCHEMA_VERSION, 2);
});

test('2048 actual SQLite rows use scoped PK SEARCH both ways, iterate at most64 and never materialize a full collection', t => {
  const { store, context, filePath } = fixture(t), raw = new DatabaseSync(filePath); t.after(() => raw.close());
  seed(store, context, Array.from({ length: 2048 }, (_, index) => `row-${String(index).padStart(5, '0')}`));
  const prepare = DatabaseSync.prototype.prepare, queries = [];
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    const statement = prepare.call(this, sql);
    if (!/^\s*SELECT\b[\s\S]*\bFROM\s+sources\b[\s\S]*\bORDER BY\b/i.test(sql)) return statement;
    const sample = { sql, args: [], iterated: 0, next_calls: 0 }; queries.push(sample);
    return new Proxy(statement, { get(target, property) {
      if (property === 'all') return () => assert.fail('range must iterate a bounded SQL result, not call all()');
      if (property === 'iterate') return (...args) => {
        sample.args = args; const iterator = target.iterate(...args);
        return { [Symbol.iterator]() { return this; }, next() { sample.next_calls++; const step = iterator.next(); if (!step.done) sample.iterated++; return step; }, return() { return iterator.return?.() ?? { done: true }; } };
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
  });
  const ascending = store.getSourceRange(context, namespace, range({ after: 'row-00999' }));
  const descending = store.getSourceRange(context, namespace, range({ order: 'desc', after: 'row-01064' }));
  assert.equal(ascending.rows.length, 64); assert.equal(descending.rows.length, 64);
  assert.equal(ascending.rows[0].id, 'row-01000'); assert.equal(descending.rows[0].id, 'row-01063');
  assert.equal(queries.length, 2);
  const plans = queries.map(query => {
    assert.equal(query.iterated, 64); assert.ok(query.next_calls <= 65); assert.doesNotMatch(query.sql, /\bOFFSET\b/i);
    const explain = prepare.call(raw, `EXPLAIN QUERY PLAN ${query.sql}`).all(...query.args).map(row => row.detail);
    const text = explain.join(' '); assert.match(text, /SEARCH sources USING INDEX sqlite_autoindex_sources_1/i);
    assert.match(text, /tenant_id=\? AND project_id=\? AND namespace=\? AND id[><]/i); assert.doesNotMatch(text, /\bSCAN\b|TEMP B-TREE/i);
    return { iterated: query.iterated, plan: explain };
  });
  t.diagnostic(JSON.stringify({ rows: 2048, asc: plans[0], desc: plans[1], schema_version: raw.prepare('PRAGMA user_version').get().user_version }));
});
