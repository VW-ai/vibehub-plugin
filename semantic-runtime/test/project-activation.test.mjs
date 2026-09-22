import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectActivation, ACTIVATION_NAMESPACE as NS, ACTIVATION_STAGES,
  DomainStore, migrateDomainStore, LocalCredentialAuthority, LOCAL_AUDIENCE, scopedReference,
  GitProjectRegistry, createWorkerJobState, transitionWorkerJob, validateWorkerAdmission } from '../src/index.mjs';
import { scenario, context as workerContext, running, result } from './fixtures/worker-protocol/scenario.mjs';
import { assertion, apply } from './fixtures/working-graph/scenario.mjs';

const ACTIONS = ['activation:read', 'activation:write', 'activation:admit', 'project:inspect', 'project:enroll', 'store:read', 'store:write'];
const WORK = 'fixture-work';
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
}
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vh-activation-'))), folder = join(root, 'project'); mkdirSync(folder);
  git(folder, 'init', '--initial-branch=main'); writeFileSync(join(folder, 'keep.txt'), 'synthetic original\n');
  git(folder, 'add', 'keep.txt'); git(folder, 'commit', '-m', 'synthetic initial');
  const clock = { now: 1000 }, authority = new LocalCredentialAuthority({ now: () => clock.now }), filePath = join(root, 'domain.sqlite');
  migrateDomainStore({ filePath });
  const options = { filePath, authority, namespaces: [NS, 'git-enrollment', WORK] }, handles = [];
  const open = () => { const store = new DomainStore(options); handles.push(store); return { store,
    activation: new ProjectActivation({ store, authority, now: () => clock.now }), registry: new GitProjectRegistry({ store, authority }) }; };
  const issue = ({ actions = ACTIONS, tenant = 'acme', project = 'product', kind = 'human', principal = 'owner', ttl_ms = 60000 } = {}) => {
    const scope = { tenant_id: tenant, project_id: project }, issued = authority.issue({ principal_id: principal, kind, scope, actions, ttl_ms });
    const access = authority.authorize(issued.credential, { scope, audience: LOCAL_AUDIENCE, action: actions[0], kinds: [kind],
      boundary: 'http', reference: scopedReference('http', scope, 'activation') }); assert(access.allowed);
    return { context: access.context, issued };
  };
  const f = { root, folder, clock, authority, options, issue, open, ...open(), ...issue() };
  f.enroll = (ctx = f.context) => f.registry.enroll(ctx, { folder, expectedVersion: f.registry.get(ctx)?.version ?? null });
  f.enable = () => { f.enroll(); return f.activation.setEnabled(f.context, { enabled: true, expectedVersion: f.activation.get(f.context).version }); };
  t.after(() => { handles.forEach(h => h.close()); rmSync(root, { recursive: true, force: true }); }); return f;
}
const sourceCount = (f, context = f.context) => f.store.sourceCounts(context, NS).counts.reduce((sum, item) => sum + item.count, 0);
const execution = checkout => ({ repository_id: checkout.repository_id, checkout_id: checkout.checkout_id, worktree_id: checkout.worktrees.find(w => w.state === 'active').worktree_id });
const work = (tx, key) => { tx.compareAndSwap(WORK, key, null, { written: true }); tx.appendSource(WORK, key, 'synthetic-effect', { written: true }); tx.enqueue(WORK, key, { intent: true }); return key; };

test('public Project activation starts disabled and only an explicit enrolled command persists a transition', t => {
  const f = fixture(t); assert.deepEqual(f.activation.get(f.context), { version: null, state: { schema_version: 1, enabled: false, epoch: 0,
    transition_ref: null, disabled_since: null, last_gap: null, updated_at_ms: null } });
  assert.equal(f.activation.setEnabled(f.context, { enabled: false, expectedVersion: null }).changed, false);
  assert.throws(() => f.activation.setEnabled(f.context, { enabled: true, expectedVersion: null }), { code: 'project_not_enrolled' });
  assert.equal(sourceCount(f), 0); f.enroll(); assert.equal(f.activation.get(f.context).state.enabled, false);
  const enabled = f.activation.setEnabled(f.context, { enabled: true, expectedVersion: null });
  assert.equal(enabled.state.epoch, 1); assert.equal(enabled.version, 1); assert.equal(enabled.changed, true);
  const retained = f.store.getSource(f.context, NS, 'transition-1'); assert.equal(retained.value.actor, 'owner');
  assert.deepEqual(f.activation.setEnabled(f.context, { enabled: true, expectedVersion: 1 }), { ...enabled, changed: false });
  assert.equal(sourceCount(f), 1); assert.equal(f.store.pendingOutbox(f.context, NS).length, 0);
  f.store.close(); const resumed = f.open(); assert.deepEqual(resumed.activation.get(f.context), { version: enabled.version, state: enabled.state });
  assert.deepEqual(resumed.store.getSource(f.context, NS, 'transition-1'), retained);
});

test('stale switch CAS leaves state, immutable transition history and cancellation notice unchanged', t => {
  const f = fixture(t); f.enable(); const before = f.activation.get(f.context);
  for (const expectedVersion of [null, 9]) assert.throws(() => f.activation.setEnabled(f.context, { enabled: false, expectedVersion }), { code: 'cas_conflict' });
  assert.deepEqual(f.activation.get(f.context), before); assert.equal(sourceCount(f), 1); assert.deepEqual(f.store.pendingOutbox(f.context, NS), []);
  f.clock.now = 1200; const disabled = f.activation.setEnabled(f.context, { enabled: false, expectedVersion: 1 });
  assert.equal(disabled.state.epoch, 2); assert.equal(sourceCount(f), 2);
  const notice = f.store.pendingOutbox(f.context, NS)[0]; assert.equal(notice.id, 'cancel-2'); assert.equal(notice.value.ack_owner, 'app-cancellation-coordinator');
  assert.equal(f.activation.setEnabled(f.context, { enabled: false, expectedVersion: 2 }).changed, false); assert.equal(f.store.pendingOutbox(f.context, NS).length, 1);
});

test('new worktrees inherit the Project switch; removed and unknown execution IDs never gain admission', t => {
  const f = fixture(t); f.enable(); const first = f.registry.get(f.context), checkout = first.value.checkouts[0], original = execution(checkout);
  const linked = join(f.root, 'new linked'); git(f.folder, 'worktree', 'add', '-b', 'feature', linked);
  let called = 0; const op = () => called++;
  assert.throws(() => f.activation.withAdmission(f.context, { epoch: 1, stage: 'capture', execution: { ...original, worktree_id: 'unknown' } }, op), { code: 'invalid_execution_membership' });
  const refreshed = f.registry.refresh(f.context, { checkout_id: checkout.checkout_id, expectedVersion: first.version });
  const newId = refreshed.catalog.checkouts[0].worktrees.find(w => w.path === linked).worktree_id;
  const linkedExecution = { ...original, worktree_id: newId };
  assert.equal(f.activation.withAdmission(f.context, { epoch: 1, stage: 'capture', execution: linkedExecution }, op).admitted, true);
  assert.equal(f.activation.get(f.context).state.epoch, 1);
  for (const bad of [{ ...original, repository_id: 'other' }, { ...original, checkout_id: 'other' }, {}, null, { ...original, path: linked }]) {
    assert.throws(() => f.activation.withAdmission(f.context, { epoch: 1, stage: 'result', execution: bad }, op), { code: 'invalid_execution_membership' });
  }
  git(f.folder, 'worktree', 'remove', linked); f.registry.refresh(f.context, { checkout_id: checkout.checkout_id, expectedVersion: refreshed.version });
  assert.throws(() => f.activation.withAdmission(f.context, { epoch: 1, stage: 'delivery', execution: linkedExecution }, op), { code: 'invalid_execution_membership' });
  assert.equal(called, 1);
});

test('tenant and Project switches are independent even when the same Git folder is enrolled', t => {
  const f = fixture(t); f.enable();
  for (const alternate of [{ tenant: 'other' }, { project: 'other' }]) {
    const { context } = f.issue(alternate); f.enroll(context); assert.equal(f.activation.get(context).state.epoch, 0);
    assert.equal(f.activation.withAdmission(context, { epoch: 1, stage: 'capture' }, () => assert.fail()).admitted, false);
    f.activation.setEnabled(context, { enabled: true, expectedVersion: null });
    f.activation.setEnabled(context, { enabled: false, expectedVersion: 1 });
    assert.equal(f.activation.get(context).state.epoch, 2); assert.equal(f.activation.get(f.context).state.epoch, 1);
  }
});

test('all four stages fence disabled and stale cached epochs without invoking effects; re-enable records a gap', t => {
  const f = fixture(t); f.enable(); const original = f.store.getSource(f.context, NS, 'transition-1');
  for (const stage of ACTIVATION_STAGES) assert.equal(f.activation.withAdmission(f.context, { epoch: 1, stage }, tx => work(tx, `before-${stage}`)).admitted, true);
  f.clock.now = 1400; f.activation.setEnabled(f.context, { enabled: false, expectedVersion: 1 });
  for (const stage of ACTIVATION_STAGES) assert.deepEqual(f.activation.withAdmission(f.context, { epoch: 1, stage }, () => assert.fail('disabled callback')), { admitted: false, reason: 'project_disabled', epoch: 2 });
  f.clock.now = 1600; const resumed = f.activation.setEnabled(f.context, { enabled: true, expectedVersion: 2 });
  assert.deepEqual(resumed.state.last_gap, { from_transition: 'transition-2', to_transition: 'transition-3', from_ms: 1400, to_ms: 1600, backfill: 'none' });
  for (const stage of ACTIVATION_STAGES) assert.deepEqual(f.activation.withAdmission(f.context, { epoch: 1, stage }, () => assert.fail('stale callback')), { admitted: false, reason: 'stale_activation_epoch', epoch: 3 });
  assert.equal(f.store.pendingOutbox(f.context, WORK).length, 4); assert.deepEqual(f.store.getSource(f.context, NS, 'transition-1'), original);
  for (const stage of ACTIVATION_STAGES) assert(f.store.getRecord(f.context, WORK, `before-${stage}`));
  assert.equal(f.activation.withAdmission(f.context, { epoch: 3, stage: 'capture' }, tx => work(tx, 'fresh')).admitted, true);
});

test('denied, expired, revoked and host/worker contexts cannot switch or invoke unauthorized callbacks', t => {
  const f = fixture(t); f.enable(); const dead = f.issue(); f.authority.revoke(dead.issued.credential_id);
  const expired = f.issue({ ttl_ms: 1 }); f.clock.now++;
  const foreign = new LocalCredentialAuthority(), grant = foreign.issue({ principal_id: 'owner', kind: 'human', scope: { tenant_id: 'acme', project_id: 'product' }, actions: ACTIONS });
  const alien = foreign.authorize(grant.credential, { scope: { tenant_id: 'acme', project_id: 'product' }, audience: LOCAL_AUDIENCE, action: 'activation:read', kinds: ['human'], boundary: 'http', reference: scopedReference('http', { tenant_id: 'acme', project_id: 'product' }, 'activation') }).context;
  for (const context of [{}, { ...f.context }, dead.context, expired.context, alien]) {
    assert.throws(() => f.activation.get(context), { code: 'activation_unauthorized' });
    assert.throws(() => f.activation.setEnabled(context, { enabled: false, expectedVersion: 1 }), { code: 'activation_unauthorized' });
    assert.throws(() => f.activation.withAdmission(context, { epoch: 1, stage: 'capture' }, () => assert.fail()), { code: 'activation_unauthorized' });
  }
  for (const kind of ['host-adapter', 'worker', 'connector']) {
    const { context } = f.issue({ kind });
    assert.throws(() => f.activation.setEnabled(context, { enabled: false, expectedVersion: 1 }), { code: 'activation_unauthorized' });
  }
  for (const missing of ['activation:admit', 'store:read', 'store:write', 'project:inspect']) {
    const { context } = f.issue({ actions: ACTIONS.filter(a => a !== missing) });
    assert.throws(() => f.activation.withAdmission(context, { epoch: 1, stage: 'result' }, () => assert.fail()), { code: 'activation_unauthorized' });
  }
  for (const missing of ['activation:write', 'store:read', 'store:write']) {
    const { context } = f.issue({ actions: ACTIONS.filter(a => a !== missing) });
    assert.throws(() => f.activation.setEnabled(context, { enabled: false, expectedVersion: 1 }), { code: 'activation_unauthorized' });
  }
  const service = f.issue({ kind: 'service' }); assert.equal(f.activation.setEnabled(service.context, { enabled: false, expectedVersion: 1 }).changed, true);
});

test('admission rolls back exceptions, async/thenables, expired grants and stale transaction handles', async t => {
  const f = fixture(t); f.enable(); let stale;
  assert.throws(() => f.activation.withAdmission(f.context, { epoch: 1, stage: 'result' }, tx => { stale = tx; work(tx, 'throw'); throw Error('CANARY'); }), error => !String(error).includes('CANARY'));
  assert.throws(() => stale.getRecord(WORK, 'throw'), { code: 'stale_transaction' });
  let called = 0;
  assert.throws(() => f.activation.withAdmission(f.context, { epoch: 1, stage: 'result' }, async () => { called++; }), { code: 'async_activation_callback' });
  assert.equal(called, 0);
  assert.throws(() => f.activation.withAdmission(f.context, { epoch: 1, stage: 'result' }, tx => { work(tx, 'thenable'); return Promise.resolve('value'); }), { code: 'async_activation_callback' });
  const expiring = f.issue({ ttl_ms: 1 });
  assert.throws(() => f.activation.withAdmission(expiring.context, { epoch: 1, stage: 'result' }, tx => { work(tx, 'expired'); f.clock.now++; }));
  const revoked = f.issue(); assert.throws(() => f.activation.withAdmission(revoked.context, { epoch: 1, stage: 'result' }, tx => { work(tx, 'revoked'); f.authority.revoke(revoked.issued.credential_id); }));
  await Promise.resolve();
  for (const key of ['throw', 'thenable', 'expired', 'revoked']) { assert.equal(f.store.getRecord(f.context, WORK, key), null); assert.equal(f.store.getSource(f.context, WORK, key), null); }
  assert.deepEqual(f.store.pendingOutbox(f.context, WORK), []);
  f.activation.withAdmission(f.context, { epoch: 1, stage: 'capture' }, tx => { stale = tx; });
  assert.throws(() => stale.compareAndSwap(WORK, 'late', null, {}), { code: 'stale_transaction' });
});

test('callback changes to activation or enrollment roll back their own effects and both authority records', t => {
  const f = fixture(t); f.enable();
  for (const [namespace, key] of [[NS, 'state'], ['git-enrollment', 'catalog']]) {
    const before = f.store.getRecord(f.context, namespace, key), effect = `changed-${key}`;
    assert.throws(() => f.activation.withAdmission(f.context, { epoch: 1, stage: 'result' }, tx => {
      work(tx, effect); const row = tx.getRecord(namespace, key);
      tx.compareAndSwap(namespace, key, row.version, row.value); // Even a same-value rewrite changes the authoritative version.
    }), { code: 'invalid_activation_state' });
    assert.deepEqual(f.store.getRecord(f.context, namespace, key), before);
    assert.equal(f.store.getRecord(f.context, WORK, effect), null); assert.equal(f.store.getSource(f.context, WORK, effect), null);
  }
  assert.deepEqual(f.store.pendingOutbox(f.context, WORK), []);
});

test('separate SQLite writers order an admitted commit before disable and fence delayed result/delivery', t => {
  const f = fixture(t); f.enable(); const other = f.open();
  const admitted = f.activation.withAdmission(f.context, { epoch: 1, stage: 'dispatch' }, tx => {
    work(tx, 'already-dispatched');
    assert.throws(() => other.activation.setEnabled(f.context, { enabled: false, expectedVersion: 1 }), { code: 'store_busy' });
  }); assert.equal(admitted.admitted, true);
  other.activation.setEnabled(f.context, { enabled: false, expectedVersion: 1 });
  for (const stage of ['result', 'delivery']) assert.equal(f.activation.withAdmission(f.context, { epoch: 1, stage }, tx => work(tx, `late-${stage}`)).admitted, false);
  assert(f.store.getRecord(f.context, WORK, 'already-dispatched'));
  assert.deepEqual(f.store.pendingOutbox(f.context, WORK).map(x => x.id), ['already-dispatched']);
  assert.equal(f.store.getRecord(f.context, WORK, 'late-result'), null); assert.equal(f.store.getRecord(f.context, WORK, 'late-delivery'), null);
  assert.throws(() => f.activation.setEnabled(f.context, { enabled: true, expectedVersion: 1 }), { code: 'cas_conflict' });
});

test('membership is rechecked in the transaction and disabling remains possible with unavailable paths', t => {
  const f = fixture(t); f.enable(); const original = f.registry.get(f.context), ids = execution(original.value.checkouts[0]), other = f.open();
  const transaction = f.store.transaction.bind(f.store);
  f.store.transaction = (ctx, callback) => {
    f.store.transaction = transaction;
    other.store.transaction(ctx, tx => { const row = tx.getRecord('git-enrollment', 'catalog'); row.value.checkouts[0].state = 'unavailable'; tx.compareAndSwap('git-enrollment', 'catalog', row.version, row.value); });
    return transaction(ctx, callback);
  };
  assert.throws(() => f.activation.withAdmission(f.context, { epoch: 1, stage: 'capture', execution: ids }, () => assert.fail()), { code: 'project_not_enrolled' });
  rmSync(f.folder, { recursive: true });
  assert.equal(f.activation.setEnabled(f.context, { enabled: false, expectedVersion: 1 }).state.enabled, false);
  assert.throws(() => f.activation.setEnabled(f.context, { enabled: true, expectedVersion: 2 }), { code: 'project_not_enrolled' });
});

test('bounded invalid input/state and epoch overflow fail closed; closed Runtime does not stop native coding', t => {
  const f = fixture(t); f.enable();
  for (const input of [{ stage: 'capture' }, { epoch: -1, stage: 'capture' }, { epoch: 1, stage: 'unknown' }, { epoch: Infinity, stage: 'capture' }]) assert.throws(() => f.activation.withAdmission(f.context, input, () => assert.fail()), { code: 'invalid_activation_input' });
  for (const input of [{ enabled: 'yes', expectedVersion: 1 }, { enabled: false }, { enabled: false, expectedVersion: -1 }]) assert.throws(() => f.activation.setEnabled(f.context, input), { code: 'invalid_activation_input' });
  const baseline = f.activation.get(f.context).state;
  for (const corrupt of [{ ...baseline, epoch: 0 }, { ...baseline, enabled: 'yes' }, { ...baseline, transition_ref: 'wrong' }, { ...baseline, last_gap: { backfill: 'all' } }]) {
    f.store.transaction(f.context, tx => { const row = tx.getRecord(NS, 'state'); tx.compareAndSwap(NS, 'state', row.version, corrupt); });
    assert.throws(() => f.activation.get(f.context), { code: 'invalid_activation_state' });
    assert.throws(() => f.activation.withAdmission(f.context, { epoch: 1, stage: 'capture' }, () => assert.fail()), { code: 'invalid_activation_state' });
  }
  f.store.transaction(f.context, tx => { const row = tx.getRecord(NS, 'state'); tx.compareAndSwap(NS, 'state', row.version, { ...baseline, epoch: Number.MAX_SAFE_INTEGER, transition_ref: `transition-${Number.MAX_SAFE_INTEGER}` }); });
  const version = f.activation.get(f.context).version;
  assert.throws(() => f.activation.setEnabled(f.context, { enabled: false, expectedVersion: version }), { code: 'activation_epoch_exhausted' });
  assert.equal(sourceCount(f), 1); assert.deepEqual(f.store.pendingOutbox(f.context, NS), []);
  f.store.close(); assert.throws(() => f.activation.get(f.context), { code: 'store_closed' });
  assert.throws(() => f.activation.withAdmission(f.context, { epoch: 1, stage: 'capture' }, () => assert.fail()), { code: 'store_closed' });
  writeFileSync(join(f.folder, 'keep.txt'), 'ordinary coding still works\n'); assert.equal(git(f.folder, 'status', '--porcelain'), 'M keep.txt');
  assert.equal(readFileSync(join(f.folder, 'keep.txt'), 'utf8'), 'ordinary coding still works\n');
});

// Fixture-only consumer composition. These helpers are not a production queue,
// scheduler or recovery API; the authenticated App is the sole notice owner.
function coordinator(f, ctx, noticeId, { batch = 2, crash = false, now = 1500 } = {}) {
  const grant = f.authority.inspect(ctx);
  if (grant?.kind !== 'service' || grant.principal_id !== 'app-cancellation-coordinator') throw Error('fixture_coordinator_denied');
  if (!Number.isInteger(batch) || batch < 1 || batch > 2) throw Error('fixture_batch_limit');
  return f.store.transaction(ctx, tx => {
    const progress = tx.getRecord(WORK, noticeId); if (progress?.value.done) return { duplicate: true, done: true };
    const notice = f.store.pendingOutbox(ctx, NS).find(n => n.id === noticeId); if (!notice) throw Error('fixture_notice_missing');
    const queue = tx.getRecord(WORK, 'queue');
    const checkpoint = progress?.value ?? { targets: queue.value.filter(e => e.activation_epoch < notice.value.before_epoch).map(e => e.ref), cursor: 0, done: false };
    const start = checkpoint.cursor, end = Math.min(checkpoint.targets.length, start + batch);
    for (const ref of checkpoint.targets.slice(checkpoint.cursor, end)) {
      const entry = queue.value.find(e => e.ref === ref);
      if (['queued', 'leased', 'running'].includes(entry.state.status)) {
        const type = now >= entry.state.job.deadline_ms ? 'expire' : 'cancel';
        const changed = transitionWorkerJob(entry.state, { type, expected_revision: entry.state.revision }, workerContext({ job: entry.state.job, admission: null }, now));
        assert.equal(changed.status, 'applied'); entry.state = changed.state;
      }
    }
    checkpoint.cursor = end; checkpoint.done = end === checkpoint.targets.length;
    tx.compareAndSwap(WORK, 'queue', queue.version, queue.value); tx.compareAndSwap(WORK, noticeId, progress?.version ?? null, checkpoint);
    if (checkpoint.done) assert.equal(tx.ack(NS, noticeId), true);
    if (crash) throw Error('fixture_interrupted_before_commit');
    return { duplicate: false, done: checkpoint.done, processed: end - start };
  });
}
function seedQueue(f) {
  const base = scenario(); const queue = ['queued', 'running', 'succeeded', 'expired'].map((status, index) => {
    const s = structuredClone(base); s.job.job_id = `old-job-${index}`; s.job.idempotency_key = `old-${index}`;
    let state = status === 'queued' || status === 'expired' ? createWorkerJobState(s.job) : running(s);
    if (status === 'succeeded') { const response = result(s, state); state = transitionWorkerJob(state, { type: 'complete', expected_revision: state.revision, attempt_id: state.attempts[0].attempt_id, fencing_token: 1, result: response }, workerContext(s, 1110, 'worker')).state; }
    // An old queued job with an expired deadline exercises the expire transition.
    if (status === 'expired') { s.job.deadline_ms = 1300; state = createWorkerJobState(s.job); }
    return { ref: `pending-${index}`, activation_epoch: 1, was_pending: true, state };
  });
  f.activation.withAdmission(f.context, { epoch: 1, stage: 'dispatch' }, tx => tx.compareAndSwap(WORK, 'queue', null, queue)); return base;
}
function recoverSelected(f, { explicit, refs, epoch, current }) {
  if (explicit !== true || !Array.isArray(refs) || !refs.length || refs.length > 64 || new Set(refs).size !== refs.length) throw Error('fixture_recovery_selection');
  return f.activation.withAdmission(f.context, { epoch, stage: 'dispatch' }, tx => {
    const queue = tx.getRecord(WORK, 'queue'), fresh = [];
    for (const ref of refs) {
      const old = queue.value.find(e => e.ref === ref);
      if (!old || old.was_pending !== true || old.activation_epoch >= epoch || !['cancelled', 'expired'].includes(old.state.status)) throw Error('fixture_recovery_ineligible');
      const job = { ...structuredClone(old.state.job), job_id: `recovery-${epoch}-${ref}`, idempotency_key: `recovery:${epoch}:${ref}`, created_at_ms: f.clock.now, deadline_ms: f.clock.now + 9000 };
      if (validateWorkerAdmission(job, current).status !== 'allowed') throw Error('fixture_recovery_revalidation');
      if (queue.value.some(e => e.state.job.job_id === job.job_id)) throw Error('fixture_recovery_duplicate');
      fresh.push({ ref: `new-${epoch}-${ref}`, recovered_from: ref, activation_epoch: epoch, was_pending: true, state: createWorkerJobState(job) });
    }
    tx.compareAndSwap(WORK, 'queue', queue.version, [...queue.value, ...fresh]); return fresh.map(e => e.state.job.job_id);
  });
}

test('sole coordinator cancels bounded batches with durable checkpoints, atomic ack, restart and duplicates', t => {
  const f = fixture(t); f.enable(); seedQueue(f); f.clock.now = 1500; f.activation.setEnabled(f.context, { enabled: false, expectedVersion: 1 });
  const owner = f.issue({ kind: 'service', principal: 'app-cancellation-coordinator' }).context;
  for (const ctx of [f.context, f.issue({ kind: 'worker' }).context, f.issue({ kind: 'service', principal: 'other' }).context]) assert.throws(() => coordinator(f, ctx, 'cancel-2'), /fixture_coordinator_denied/);
  const before = f.store.getRecord(f.context, WORK, 'queue');
  assert.throws(() => coordinator(f, owner, 'cancel-2', { crash: true }));
  assert.deepEqual(f.store.getRecord(f.context, WORK, 'queue'), before); assert.equal(f.store.getRecord(f.context, WORK, 'cancel-2'), null);
  assert.equal(f.store.pendingOutbox(f.context, NS).length, 1);
  assert.equal(coordinator(f, owner, 'cancel-2').done, false); const first = f.store.getRecord(f.context, WORK, 'queue');
  assert.deepEqual(first.value.map(e => e.state.status), ['cancelled', 'cancelled', 'succeeded', 'queued']);
  assert.equal(f.store.pendingOutbox(f.context, NS).length, 1);
  const checkpoint = f.store.getRecord(f.context, WORK, 'cancel-2');
  assert.throws(() => coordinator(f, owner, 'cancel-2', { crash: true })); // Would ACK the final batch, then rolls everything back.
  assert.deepEqual(f.store.getRecord(f.context, WORK, 'queue'), first);
  assert.deepEqual(f.store.getRecord(f.context, WORK, 'cancel-2'), checkpoint);
  assert.equal(f.store.pendingOutbox(f.context, NS).length, 1);
  f.store.close(); Object.assign(f, f.open());
  assert.equal(coordinator(f, owner, 'cancel-2').done, true); assert.deepEqual(f.store.pendingOutbox(f.context, NS), []);
  const terminal = f.store.getRecord(f.context, WORK, 'queue'); assert.deepEqual(terminal.value.map(e => e.state.status), ['cancelled', 'cancelled', 'succeeded', 'expired']);
  assert.deepEqual(terminal.value[2], before.value[2]);
  assert.deepEqual(coordinator(f, owner, 'cancel-2'), { duplicate: true, done: true });
  assert.deepEqual(f.store.getRecord(f.context, WORK, 'queue'), terminal);
});

test('explicit bounded recovery uses fresh validation and new Jobs; terminals and old envelopes stay unchanged', t => {
  const f = fixture(t); f.enable(); const base = seedQueue(f); f.clock.now = 1500;
  f.activation.setEnabled(f.context, { enabled: false, expectedVersion: 1 }); const owner = f.issue({ kind: 'service', principal: 'app-cancellation-coordinator' }).context;
  coordinator(f, owner, 'cancel-2'); coordinator(f, owner, 'cancel-2');
  const old = f.store.getRecord(f.context, WORK, 'queue'); f.clock.now = 2000;
  f.activation.setEnabled(f.context, { enabled: true, expectedVersion: 2 }); assert.deepEqual(f.store.getRecord(f.context, WORK, 'queue'), old);
  const request = { explicit: true, refs: ['pending-0'], epoch: 3, current: base.admission };
  for (const change of [{ explicit: false }, { refs: Array.from({ length: 65 }, (_, i) => `ref-${i}`) }, { refs: ['pending-0', 'pending-0'] }, { refs: [] }, { refs: ['unknown'] }, { refs: ['pending-2'] }]) assert.throws(() => recoverSelected(f, { ...request, ...change }));
  const revoked = structuredClone(base.admission); revoked.authorization.revoked = true;
  assert.throws(() => recoverSelected(f, { ...request, current: revoked }));
  const moved = structuredClone(base.admission); moved.current_graph = apply(moved.current_graph, assertion('later', { entity_id: 'other' })).state;
  assert.throws(() => recoverSelected(f, { ...request, current: moved }));
  assert.equal(recoverSelected(f, { ...request, epoch: 1 }).admitted, false); assert.deepEqual(f.store.getRecord(f.context, WORK, 'queue'), old);
  const recovered = recoverSelected(f, { ...request, refs: ['pending-0', 'pending-3'] }); assert.equal(recovered.admitted, true);
  const after = f.store.getRecord(f.context, WORK, 'queue'); assert.deepEqual(after.value.slice(0, 4), old.value);
  assert.deepEqual(after.value.slice(4).map(e => e.recovered_from), ['pending-0', 'pending-3']);
  for (const entry of after.value.slice(4)) { assert.equal(entry.activation_epoch, 3); assert.equal(entry.state.status, 'queued'); assert(!old.value.some(e => e.state.job.job_id === entry.state.job.job_id)); }
  assert.throws(() => recoverSelected(f, request)); assert.deepEqual(f.store.getRecord(f.context, WORK, 'queue'), after);
});
