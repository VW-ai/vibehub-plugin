import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { DomainStore, planDomainStore, migrateDomainStore } from '../src/adapters/sqlite/domain-store.mjs';
import { LocalCredentialAuthority, LOCAL_AUDIENCE } from '../src/adapters/auth/local-credential-authority.mjs';
import { scopedReference } from '../src/core/service-access.mjs';

const ns = 'git-enrollment';
function identity(auth, tenant = 'tenant', project = 'project', options = {}) {
  const scope = { tenant_id: tenant, project_id: project };
  const issued = auth.issue({ principal_id: 'test-owner', kind: 'service', scope,
    actions: ['store:read', 'store:write'], ...options });
  const policy = { scope, audience: options.audience ?? LOCAL_AUDIENCE, action: (options.actions ?? ['store:read'])[0],
    kinds: ['service'], boundary: 'object', reference: scopedReference('object', scope, 'domain-store') };
  return { issued, context: auth.authorize(issued.credential, policy).context };
}
function fixture(t, version = 2) {
  const dir = mkdtempSync(join(tmpdir(), 'vh-domain-')), filePath = join(dir, 'domain.sqlite');
  migrateDomainStore({ filePath, targetVersion: version });
  const authority = new LocalCredentialAuthority();
  const options = { filePath, authority, namespaces: [ns] };
  const store = new DomainStore(options), { context } = identity(authority);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, filePath, authority, store, context, options };
}

test('migration plan is read-only, explicit forward migrations retain source data and reject downgrade', t => {
  const dir = mkdtempSync(join(tmpdir(), 'vh-plan-')), filePath = join(dir, 'not-created', 'domain.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(planDomainStore({ filePath }).steps.map(x => x.version), [1, 2]);
  assert.equal(existsSync(join(dir, 'not-created')), false);
  migrateDomainStore({ filePath, targetVersion: 1 });
  const before = readFileSync(filePath);
  assert.equal(planDomainStore({ filePath }).from_version, 1);
  assert.deepEqual(readFileSync(filePath), before);
  const authority = new LocalCredentialAuthority(), { context } = identity(authority);
  let store = new DomainStore({ filePath, authority, namespaces: [ns] });
  store.transaction(context, tx => tx.appendSource(ns, 'source-1', 'observation', { text: 'synthetic retained source' }));
  assert.throws(() => store.sourceCounts(context, ns), /migration_required/); store.close();
  assert.deepEqual(migrateDomainStore({ filePath }).steps.map(x => x.version), [2]);
  assert.deepEqual(migrateDomainStore({ filePath }).steps, []);
  store = new DomainStore({ filePath, authority, namespaces: [ns] });
  assert.deepEqual(store.sourceCounts(context, ns).counts, [{ kind: 'observation', count: 1 }]);
  assert.deepEqual(store.getSource(context, ns, 'source-1').value, { text: 'synthetic retained source' }); store.close();
  assert.throws(() => migrateDomainStore({ filePath, targetVersion: 1 }), /incompatible_store/);
});

test('foreign, newer and corrupt files are rejected without replacement', t => {
  const dir = mkdtempSync(join(tmpdir(), 'vh-foreign-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const type of ['foreign', 'newer', 'corrupt']) {
    const filePath = join(dir, `${type}.sqlite`);
    if (type === 'corrupt') writeFileSync(filePath, 'private-synthetic-corrupt-content');
    else {
      if (type === 'newer') migrateDomainStore({ filePath });
      const db = new DatabaseSync(filePath);
      db.exec(type === 'newer' ? 'PRAGMA user_version=999;' : 'CREATE TABLE unrelated(value TEXT); PRAGMA application_id=123;'); db.close();
    }
    const before = readFileSync(filePath);
    assert.throws(() => planDomainStore({ filePath }), error => !String(error).includes('private-synthetic'));
    assert.throws(() => migrateDomainStore({ filePath }));
    assert.deepEqual(readFileSync(filePath), before);
  }
});

test('missing or malformed required core tables reject plan/open/migration without changing the file', t => {
  const authority = new LocalCredentialAuthority();
  const dir = mkdtempSync(join(tmpdir(), 'vh-schema-shape-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mutations = [
    'DROP TABLE records;',
    'DROP TABLE records; CREATE TABLE records(tenant_id TEXT,project_id TEXT,namespace TEXT,key TEXT,version INTEGER,value TEXT) STRICT;',
    'DROP TABLE sources; CREATE TABLE sources(tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,namespace TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(tenant_id,project_id,namespace,id)) STRICT;',
    'DROP TABLE outbox; CREATE TABLE outbox(sequence INTEGER PRIMARY KEY,tenant_id TEXT,project_id TEXT,namespace TEXT,id TEXT,value TEXT,acked INTEGER);',
  ];
  for (let index = 0; index < mutations.length; index++) {
    const filePath = join(dir, `damaged-${index}.sqlite`); migrateDomainStore({ filePath });
    const db = new DatabaseSync(filePath); db.exec(mutations[index]); db.close();
    const before = readFileSync(filePath);
    assert.throws(() => planDomainStore({ filePath }), /incompatible_store/);
    assert.throws(() => new DomainStore({ filePath, authority, namespaces: [ns] }), /incompatible_store/);
    assert.throws(() => migrateDomainStore({ filePath }), /incompatible_store/);
    assert.deepEqual(readFileSync(filePath), before);
  }
});

test('failed forward migration rolls back schema version and retries without losing immutable sources', t => {
  const { store, context, filePath } = fixture(t, 1);
  store.transaction(context, tx => tx.appendSource(ns, 'retained', 'decision', { text: 'retained-before-migration' }));
  store.close();
  const db = new DatabaseSync(filePath);
  db.exec(`CREATE TABLE source_kind_index(tenant_id TEXT,project_id TEXT,namespace TEXT,kind TEXT,source_count INTEGER);
    CREATE TRIGGER migration_failure BEFORE INSERT ON source_kind_index BEGIN SELECT RAISE(ABORT,'synthetic-migration-private-error'); END;`);
  assert.throws(() => migrateDomainStore({ filePath }), error => error.code === 'store_unavailable' && !String(error).includes('synthetic-migration'));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(db.prepare('SELECT value FROM sources').get().value, '{"text":"retained-before-migration"}');
  db.exec('DROP TABLE source_kind_index'); db.close();
  assert.equal(migrateDomainStore({ filePath }).from_version, 1);
  assert.equal(planDomainStore({ filePath }).from_version, 2);
});

test('CAS, immutable source and outbox commit atomically, reject duplicates and survive restart', t => {
  const { store, context, options } = fixture(t);
  assert.equal(store.transaction(context, tx => {
    tx.appendSource(ns, 'source-1', 'decision', { text: 'synthetic' });
    tx.enqueue(ns, 'notify-1', { record: 'catalog' });
    return tx.compareAndSwap(ns, 'catalog', null, { worktrees: [] });
  }), 1);
  assert.throws(() => store.transaction(context, tx => tx.compareAndSwap(ns, 'catalog', null, {})), /cas_conflict/);
  assert.throws(() => store.transaction(context, tx => tx.appendSource(ns, 'source-1', 'decision', {})), /duplicate_identity/);
  assert.throws(() => store.transaction(context, tx => tx.enqueue(ns, 'notify-1', {})), /duplicate_identity/);
  assert.equal(store.transaction(context, tx => tx.compareAndSwap(ns, 'catalog', 1, { worktrees: ['w1'] })), 2);
  store.close(); const reopened = new DomainStore(options); t.after(() => reopened.close());
  assert.deepEqual(reopened.getRecord(context, ns, 'catalog'), { version: 2, value: { worktrees: ['w1'] } });
  assert.equal(reopened.getSource(context, ns, 'source-1').kind, 'decision');
  assert.equal(reopened.pendingOutbox(context, ns).length, 1);
  assert.equal(reopened.transaction(context, tx => tx.ack(ns, 'notify-1')), true);
  assert.equal(reopened.transaction(context, tx => tx.ack(ns, 'notify-1')), false);
  assert.deepEqual(reopened.pendingOutbox(context, ns), []);
  assert.throws(() => reopened.transaction(context, tx => tx.enqueue(ns, 'notify-1', {})), /duplicate_identity/);
});

test('callback exceptions, async callbacks, nested transactions and stale handles cannot leave partial work', async t => {
  const { store, context } = fixture(t); let captured;
  assert.throws(() => store.transaction(context, tx => {
    captured = tx; tx.compareAndSwap(ns, 'catalog', null, {}); tx.enqueue(ns, 'o', {}); tx.appendSource(ns, 's', 'kind', {});
    throw new Error('synthetic-secret-must-not-escape');
  }), error => error.code === 'store_unavailable' && !String(error).includes('synthetic-secret'));
  assert.equal(store.getRecord(context, ns, 'catalog'), null); assert.equal(store.getSource(context, ns, 's'), null); assert.deepEqual(store.pendingOutbox(context, ns), []);
  assert.throws(() => captured.enqueue(ns, 'later', {}), /stale_transaction/);
  assert.throws(() => store.transaction(context, async tx => tx.enqueue(ns, 'async', {})), /async_transaction/);
  assert.throws(() => store.transaction(context, tx => { tx.enqueue(ns, 'thenable', {}); return Promise.resolve('done'); }), /async_transaction/);
  assert.throws(() => store.transaction(context, () => store.transaction(context, () => {})), /nested_transaction/);
  assert.deepEqual(store.pendingOutbox(context, ns), []);
});

test('scoped methods reject forged, revoked, expired, wrong-audience and insufficient-action contexts', t => {
  const { store, authority } = fixture(t);
  const a = identity(authority), b = identity(authority, 'tenant', 'other-project'), c = identity(authority, 'other-tenant', 'project');
  for (const [who, value] of [[a, 'a'], [b, 'b'], [c, 'c']]) store.transaction(who.context, tx => { tx.compareAndSwap(ns, 'shared-key', null, value); tx.enqueue(ns, 'same-id', value); });
  assert.equal(store.getRecord(a.context, ns, 'shared-key').value, 'a');
  assert.deepEqual(store.pendingOutbox(b.context, ns), [{ id: 'same-id', value: 'b' }]);
  const readonly = identity(authority, 'tenant', 'project', { actions: ['store:read'] });
  assert.throws(() => store.transaction(readonly.context, () => {}), /store_unauthorized/);
  const wrong = identity(authority, 'tenant', 'project', { audience: 'other' });
  for (const context of [{}, { ...a.context }, wrong.context]) {
    for (const call of [() => store.getRecord(context, ns, 'shared-key'), () => store.getSource(context, ns, 's'),
      () => store.pendingOutbox(context, ns), () => store.sourceCounts(context, ns),
      () => store.rebuildSourceKindIndex(context), () => store.transaction(context, () => {})]) assert.throws(call, /store_unauthorized/);
  }
  authority.revoke(a.issued.credential_id);
  assert.throws(() => store.getRecord(a.context, ns, 'shared-key'), /store_unauthorized/);
  assert.throws(() => store.transaction(c.context, tx => { tx.enqueue(ns, 'late', {}); authority.revoke(c.issued.credential_id); }), /store_unauthorized/);
  const renewed = identity(authority, 'other-tenant', 'project');
  assert.deepEqual(store.pendingOutbox(renewed.context, ns), [{ id: 'same-id', value: 'c' }]);
  store.close(); assert.throws(() => store.getRecord(b.context, ns, 'shared-key'), /store_closed/);
});

test('expiry during a transaction is checked again before commit', t => {
  const { filePath } = fixture(t); let now = 100;
  const authority = new LocalCredentialAuthority({ now: () => now }), { context } = identity(authority, 'tenant', 'project', { ttl_ms: 1 });
  const store = new DomainStore({ filePath, authority, namespaces: [ns] }); t.after(() => store.close());
  assert.throws(() => store.transaction(context, tx => { tx.compareAndSwap(ns, 'late', null, {}); now = 102; }), /store_unauthorized/);
  assert.throws(() => store.getRecord(context, ns, 'late'), /store_unauthorized/);
  assert.equal(store.getRecord(identity(authority).context, ns, 'late'), null);
});

test('unknown namespace, invalid identities, non-JSON/oversized values and corrupted JSON produce bounded failures', t => {
  const { store, context, filePath } = fixture(t);
  let hooks = 0;
  const accessor = [0]; Object.defineProperty(accessor, '0', { get() { hooks++; return 'secret'; }, enumerable: true });
  const transformed = [0]; transformed.toJSON = () => { hooks++; return 'secret'; };
  const objectHook = { toJSON() { hooks++; return 'secret'; } };
  const symbolArray = []; symbolArray[Symbol('private')] = 'secret';
  for (const value of [accessor, transformed, objectHook, symbolArray]) assert.throws(() => store.transaction(context, tx => tx.compareAndSwap(ns, 'hooks', null, value)), /invalid_store_input/);
  assert.equal(hooks, 0);
  for (const value of [undefined, NaN, 1n, new Date(), { bad: undefined }, new Array(2), { text: 'x'.repeat(1_048_577) }]) assert.throws(() => store.transaction(context, tx => tx.compareAndSwap(ns, 'bad', null, value)), /invalid_store_input/);
  assert.throws(() => store.getRecord(context, 'unknown', 'key'), /unknown_namespace/);
  assert.throws(() => store.transaction(context, tx => tx.enqueue(ns, 'invalid key synthetic-secret', {})), error => !String(error).includes('synthetic-secret'));
  assert.throws(() => store.pendingOutbox(context, ns, { limit: 257 }), /invalid_store_input/);
  store.transaction(context, tx => tx.compareAndSwap(ns, 'bad', null, {}));
  const db = new DatabaseSync(filePath); db.exec("PRAGMA ignore_check_constraints=ON; UPDATE records SET value='synthetic-private-invalid-json';"); db.close();
  assert.throws(() => store.getRecord(context, ns, 'bad'), error => error.code === 'store_unavailable' && !String(error).includes('synthetic-private'));
});

test('disposable projection corruption/drop can be rebuilt without changing source bytes or leaking another scope', t => {
  const { store, context, authority, filePath } = fixture(t), other = identity(authority, 'tenant', 'other').context;
  for (const ctx of [context, other]) store.transaction(ctx, tx => { tx.appendSource(ns, 's1', 'decision', { text: 'unchanged' }); tx.appendSource(ns, 's2', 'observation', { text: 'unchanged-2' }); });
  const db = new DatabaseSync(filePath);
  const before = db.prepare('SELECT * FROM sources ORDER BY tenant_id,project_id,namespace,id').all();
  db.exec('UPDATE source_kind_index SET source_count=99;');
  store.rebuildSourceKindIndex(context);
  assert.deepEqual(store.sourceCounts(context, ns).counts, [{ kind: 'decision', count: 1 }, { kind: 'observation', count: 1 }]);
  assert.equal(store.sourceCounts(other, ns).counts[0].count, 99); // Other Project unchanged.
  db.exec('DROP TABLE source_kind_index');
  assert.throws(() => store.sourceCounts(context, ns), /store_unavailable/);
  store.rebuildSourceKindIndex(context);
  assert.deepEqual(store.sourceCounts(other, ns).counts, []); // No cross-scope reconstruction.
  store.rebuildSourceKindIndex(other);
  assert.deepEqual(db.prepare('SELECT * FROM sources ORDER BY tenant_id,project_id,namespace,id').all(), before); db.close();
});

const domainUrl = pathToFileURL(new URL('../src/adapters/sqlite/domain-store.mjs', import.meta.url).pathname).href;
const authUrl = new URL('../src/adapters/auth/local-credential-authority.mjs', import.meta.url).href;
const accessUrl = new URL('../src/core/service-access.mjs', import.meta.url).href;
function childProgram(filePath, body) {
  return `import {DomainStore} from ${JSON.stringify(domainUrl)};import {LocalCredentialAuthority,LOCAL_AUDIENCE} from ${JSON.stringify(authUrl)};import {scopedReference} from ${JSON.stringify(accessUrl)};
  const authority=new LocalCredentialAuthority(),scope={tenant_id:'tenant',project_id:'project'};const issued=authority.issue({principal_id:'child',kind:'service',scope,actions:['store:read','store:write']});
  const context=authority.authorize(issued.credential,{scope,audience:LOCAL_AUDIENCE,kinds:['service'],action:'store:write',boundary:'object',reference:scopedReference('object',scope,'store')}).context;
  const store=new DomainStore({filePath:${JSON.stringify(filePath)},authority,namespaces:['git-enrollment']});${body}`;
}
function launch(program) {
  return spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
}
test('two independent processes race CAS and exactly one record plus its outbox commits', { timeout: 10_000 }, async t => {
  const { store, context, filePath } = fixture(t);
  store.transaction(context, tx => tx.compareAndSwap(ns, 'catalog', null, { initial: true }));
  const body = `process.send('ready');process.once('message',label=>{try{store.transaction(context,tx=>{tx.compareAndSwap('git-enrollment','catalog',1,{winner:label});tx.enqueue('git-enrollment',label,{});});process.send('won');}catch(e){process.send(e.code);}finally{store.close();process.disconnect();}});`;
  const children = [launch(childProgram(filePath, body)), launch(childProgram(filePath, body))];
  const exits = children.map(child => once(child, 'exit'));
  t.after(() => children.forEach(child => child.kill('SIGKILL')));
  await Promise.all(children.map(child => once(child, 'message')));
  const results = children.map(child => once(child, 'message'));
  children.forEach((child, index) => child.send(`writer-${index}`));
  assert.deepEqual((await Promise.all(results)).map(([result]) => result).sort(), ['cas_conflict', 'won']);
  await Promise.all(exits);
  assert.equal(store.getRecord(context, ns, 'catalog').version, 2);
  assert.equal(store.pendingOutbox(context, ns).length, 1);
});

test('SIGKILL before commit rolls back record/source/outbox and releases lock; busy failures stay bounded', { timeout: 10_000 }, async t => {
  const { store, context, filePath, options } = fixture(t);
  const child = launch(childProgram(filePath, `store.transaction(context,tx=>{tx.compareAndSwap('git-enrollment','crash',null,{text:'synthetic'});tx.appendSource('git-enrollment','crash-source','kind',{});tx.enqueue('git-enrollment','crash-outbox',{});process.send('written');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);});`));
  t.after(() => child.kill('SIGKILL'));
  await once(child, 'message');
  assert.throws(() => store.transaction(context, tx => tx.compareAndSwap(ns, 'busy', null, {})), error => error.code === 'store_busy');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  store.close(); const reopened = new DomainStore(options); t.after(() => reopened.close());
  assert.equal(reopened.getRecord(context, ns, 'crash'), null);
  assert.equal(reopened.getSource(context, ns, 'crash-source'), null);
  assert.deepEqual(reopened.pendingOutbox(context, ns), []);
  reopened.transaction(context, tx => tx.compareAndSwap(ns, 'recovered', null, {}));
  assert.equal(reopened.getRecord(context, ns, 'recovered').version, 1);
});
