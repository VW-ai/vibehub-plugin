import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, symlinkSync, renameSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainStore, migrateDomainStore } from '../src/adapters/sqlite/domain-store.mjs';
import { LocalCredentialAuthority, LOCAL_AUDIENCE } from '../src/adapters/auth/local-credential-authority.mjs';
import { scopedReference } from '../src/core/service-access.mjs';
import { validateIdentityCatalog } from '../src/core/identity.mjs';
import { GitProjectRegistry } from '../src/index.mjs';

const ALL_ACTIONS = ['project:inspect', 'project:enroll', 'project:initialize', 'store:read', 'store:write'];
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}
function repository(root, name = 'main repo', { unborn = false, bare = false } = {}) {
  const path = join(root, name); mkdirSync(path);
  git(path, 'init', '--initial-branch=main', ...(bare ? ['--bare'] : []));
  if (!unborn && !bare) {
    writeFileSync(join(path, 'README.txt'), 'synthetic project only\n');
    git(path, 'add', 'README.txt'); git(path, 'commit', '-m', 'synthetic initial');
  }
  return realpathSync(path);
}
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vh-git-registry-'))), filePath = join(root, 'domain.sqlite');
  const clock = { now: 1000 }, authority = new LocalCredentialAuthority({ now: () => clock.now });
  migrateDomainStore({ filePath });
  const options = { filePath, authority, namespaces: ['git-enrollment'] };
  const store = new DomainStore(options), registry = new GitProjectRegistry({ store, authority });
  const credential = (actions = ALL_ACTIONS, tenant = 'tenant', project = 'project') => {
    const scope = { tenant_id: tenant, project_id: project };
    const issued = authority.issue({ principal_id: 'test-user', kind: 'human', scope, actions, ttl_ms: 60000 });
    const context = authority.authorize(issued.credential, { scope, audience: LOCAL_AUDIENCE,
      action: actions[0], kinds: ['human'], boundary: 'http', reference: scopedReference('http', scope, 'projects') }).context;
    return { context, issued };
  };
  const { context } = credential();
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, filePath, store, registry, authority, context, credential, clock, options };
}
const selectedCheckout = (result, id = result.checkout_id) => result.catalog.checkouts.find(item => item.checkout_id === id);
const sourceCount = (store, context) => store.sourceCounts(context, 'git-enrollment').counts.reduce((sum, item) => sum + item.count, 0);

test('explicit main, nested, linked, external and symlink selection share one observed checkout', async t => {
  const { root, registry, context, store } = fixture(t), main = repository(root, 'main repo '), linked = join(root, 'external worktree');
  git(main, 'worktree', 'add', '-b', 'feature', linked);
  git(main, 'branch', 'no-checkout');
  const nested = join(main, 'a', 'b'); mkdirSync(nested, { recursive: true });
  const symlink = join(root, 'link to selected'); symlinkSync(nested, symlink);
  const mainView = await registry.inspect(context, symlink);
  assert.equal(mainView.status, 'git'); assert.equal(mainView.worktree_path, main);
  assert(mainView.worktrees.some(item => item.path === realpathSync(linked)));
  assert(mainView.branches.some(item => item.name === 'refs/heads/no-checkout'));
  const linkedView = await registry.inspect(context, linked);
  assert.equal(mainView.common_dir, linkedView.common_dir);
  const first = await registry.enroll(context, { folder: symlink, expectedVersion: null });
  const sources = sourceCount(store, context);
  const again = await registry.enroll(context, { folder: linked, expectedVersion: first.version });
  assert.equal(again.checkout_id, first.checkout_id); assert.equal(again.reused, true);
  assert.equal(again.version, first.version); assert.equal(sourceCount(store, context), sources);
  assert.equal(again.catalog.checkouts.length, 1);
  assert.equal(selectedCheckout(again).worktrees.length, 2);
  assert.equal(validateIdentityCatalog(await registry.identityCatalog(context)), true);
});

test('same-name same-OID ref recreation between observations stays explicitly uncertified', async t => {
  const { root, registry, context } = fixture(t), main = repository(root);
  git(main, 'branch', 'experiment');
  const first = await registry.enroll(context, { folder: main, expectedVersion: null });
  const original = selectedCheckout(first).refs.find(ref => ref.name === 'refs/heads/experiment');
  git(main, 'branch', '-D', 'experiment'); git(main, 'branch', 'experiment', original.oid);
  const refreshed = await registry.refresh(context, { checkout_id: first.checkout_id, expectedVersion: first.version });
  const checkout = selectedCheckout(refreshed), observed = checkout.refs.find(ref => ref.name === original.name && ref.state === 'active');
  assert.equal(observed.ref_incarnation_id, original.ref_incarnation_id);
  assert.equal(checkout.assurance, 'observed');
  assert.equal(checkout.historical_continuity, 'uncertified_between_observations');
});

test('explicit initialization preserves files and leaves unborn HEAD without remote, commit or activation', async t => {
  const { root, registry, context } = fixture(t), folder = join(root, 'new project'); mkdirSync(folder);
  const bytes = Buffer.from('synthetic existing file\n'); writeFileSync(join(folder, 'keep.txt'), bytes);
  assert.equal((await registry.inspect(context, folder)).status, 'not_git');
  await registry.initialize(context, folder);
  assert.deepEqual(readFileSync(join(folder, 'keep.txt')), bytes);
  assert.equal(git(folder, 'remote'), ''); assert.throws(() => git(folder, 'rev-parse', '--verify', 'HEAD'));
  const inspected = await registry.inspect(context, folder);
  assert.equal(inspected.status, 'git'); assert(inspected.worktrees.some(item => item.unborn === true));
  assert.equal(await registry.get(context), null); // Git initialization is not enrollment/activation.
  const nested = join(folder, 'nested'); mkdirSync(nested);
  await assert.rejects(async () => registry.initialize(context, nested));
  assert.equal(existsSync(join(nested, '.git')), false);
  await assert.rejects(async () => registry.initialize(context, folder));
  const enrolled = await registry.enroll(context, { folder, expectedVersion: null });
  assert.equal(selectedCheckout(enrolled).worktrees[0].unborn, true);
});

test('bare repositories are an explicit unsupported state and cannot enroll', async t => {
  const { root, registry, context } = fixture(t), bare = repository(root, 'bare.git', { bare: true });
  assert.equal((await registry.inspect(context, bare)).status, 'bare');
  await assert.rejects(async () => registry.enroll(context, { folder: bare, expectedVersion: null }));
  assert.equal(await registry.get(context), null);
});

test('corrupt Git metadata and unavailable storage return bounded failures while preserving user files', async t => {
  const { root, registry, context, store } = fixture(t), bad = join(root, 'corrupt selected'); mkdirSync(bad);
  writeFileSync(join(bad, '.git'), 'synthetic-private-invalid-pointer'); writeFileSync(join(bad, 'keep.txt'), 'keep');
  await assert.rejects(async () => registry.inspect(context, bad), error => !String(error).includes('synthetic-private'));
  await assert.rejects(async () => registry.initialize(context, bad));
  assert.equal(readFileSync(join(bad, '.git'), 'utf8'), 'synthetic-private-invalid-pointer');
  assert.equal(readFileSync(join(bad, 'keep.txt'), 'utf8'), 'keep');
  const main = repository(root), before = readFileSync(join(main, 'README.txt')); store.close();
  await assert.rejects(async () => registry.enroll(context, { folder: main, expectedVersion: null }), /store_closed/);
  assert.deepEqual(readFileSync(join(main, 'README.txt')), before);
});

test('unchanged refresh/restart preserve operational IDs; branch switch and detached HEAD preserve worktree identity', async t => {
  const { root, registry, context, options, authority, store } = fixture(t), main = repository(root);
  let result = await registry.enroll(context, { folder: main, expectedVersion: null });
  const checkoutId = result.checkout_id, original = selectedCheckout(result), worktreeId = original.worktrees[0].worktree_id;
  const initialSourceId = `catalog-v${result.version}`, initialSource = store.getSource(context, 'git-enrollment', initialSourceId);
  assert(initialSource);
  result = await registry.refresh(context, { checkout_id: checkoutId, expectedVersion: result.version });
  assert.equal(selectedCheckout(result).worktrees[0].worktree_id, worktreeId);
  assert.equal(selectedCheckout(result).refs.find(ref => ref.name === 'refs/heads/main').ref_incarnation_id, original.refs.find(ref => ref.name === 'refs/heads/main').ref_incarnation_id);
  git(main, 'switch', '-c', 'alternate');
  result = await registry.refresh(context, { checkout_id: checkoutId, expectedVersion: result.version });
  assert.equal(selectedCheckout(result).worktrees.find(w => w.worktree_id === worktreeId).branch, 'refs/heads/alternate');
  git(main, 'commit', '--allow-empty', '-m', 'synthetic head advance');
  result = await registry.refresh(context, { checkout_id: checkoutId, expectedVersion: result.version });
  assert.notEqual(selectedCheckout(result).worktrees.find(w => w.worktree_id === worktreeId).head, original.worktrees[0].head);
  assert.deepEqual(store.getSource(context, 'git-enrollment', initialSourceId), initialSource);
  assert.equal(initialSource.value.catalog.checkouts[0].worktrees[0].branch, 'refs/heads/main');
  git(main, 'checkout', '--detach');
  result = await registry.refresh(context, { checkout_id: checkoutId, expectedVersion: result.version });
  assert.equal(selectedCheckout(result).worktrees.find(w => w.worktree_id === worktreeId).detached, true);
  store.close(); const reopened = new DomainStore(options); t.after(() => reopened.close());
  const resumed = new GitProjectRegistry({ store: reopened, authority });
  const fresh = await resumed.enroll(context, { folder: main, expectedVersion: result.version });
  assert.equal(fresh.checkout_id, checkoutId); assert.equal(fresh.reused, true);
  assert.equal(selectedCheckout(fresh).worktrees.find(w => w.worktree_id === worktreeId).detached, true);
});

test('locked/missing registered worktrees and observed removal/recreation keep old provenance', async t => {
  const { root, registry, context } = fixture(t), main = repository(root), linked = join(root, 'external');
  git(main, 'worktree', 'add', '-b', 'feature', linked); git(main, 'worktree', 'lock', linked);
  const inspected = await registry.inspect(context, main); assert(inspected.worktrees.find(w => w.path === linked).locked);
  let result = await registry.enroll(context, { folder: main, expectedVersion: null });
  const id = result.checkout_id, oldWorktree = selectedCheckout(result).worktrees.find(w => w.path === linked);
  git(main, 'worktree', 'unlock', linked); rmSync(linked, { recursive: true });
  const missing = await registry.inspect(context, main), registeredMissing = missing.worktrees.find(w => w.path === linked);
  assert(registeredMissing.prunable || registeredMissing.status !== 'available');
  result = await registry.refresh(context, { checkout_id: id, expectedVersion: result.version });
  assert(JSON.stringify(selectedCheckout(result).history).includes(oldWorktree.worktree_id));
  git(main, 'worktree', 'prune');
  result = await registry.refresh(context, { checkout_id: id, expectedVersion: result.version });
  const afterMissing = selectedCheckout(result); assert(JSON.stringify(afterMissing).includes(oldWorktree.worktree_id));
  git(main, 'worktree', 'add', linked, 'feature');
  result = await registry.refresh(context, { checkout_id: id, expectedVersion: result.version });
  const current = selectedCheckout(result).worktrees.filter(w => w.path === linked && w.state === 'active');
  assert.equal(current.length, 1); assert.notEqual(current[0].worktree_id, oldWorktree.worktree_id);
  assert(JSON.stringify(selectedCheckout(result)).includes(oldWorktree.worktree_id));
});

test('observed ref rename/deletion/recreation records new incarnation while retaining prior IDs', async t => {
  const { root, registry, context } = fixture(t), main = repository(root);
  git(main, 'branch', 'experiment');
  let result = await registry.enroll(context, { folder: main, expectedVersion: null });
  const checkoutId = result.checkout_id, oldRef = selectedCheckout(result).refs.find(r => r.name === 'refs/heads/experiment');
  git(main, 'branch', '-m', 'experiment', 'renamed');
  result = await registry.refresh(context, { checkout_id: checkoutId, expectedVersion: result.version });
  assert(JSON.stringify(selectedCheckout(result)).includes(oldRef.ref_incarnation_id));
  const renamed = selectedCheckout(result).refs.find(r => r.name === 'refs/heads/renamed' && r.state === 'active');
  assert(renamed); assert.notEqual(renamed.ref_incarnation_id, oldRef.ref_incarnation_id);
  git(main, 'branch', '-D', 'renamed');
  result = await registry.refresh(context, { checkout_id: checkoutId, expectedVersion: result.version });
  git(main, 'branch', 'renamed');
  result = await registry.refresh(context, { checkout_id: checkoutId, expectedVersion: result.version });
  const recreated = selectedCheckout(result).refs.find(r => r.name === 'refs/heads/renamed' && r.state === 'active');
  assert.notEqual(recreated.ref_incarnation_id, renamed.ref_incarnation_id);
  assert(JSON.stringify(selectedCheckout(result)).includes(renamed.ref_incarnation_id));
});

test('independent clones with the same remote are separate explicit repositories in one Project', async t => {
  const { root, registry, context } = fixture(t), main = repository(root), clone = join(root, 'independent clone');
  git(root, 'clone', '--local', '--no-hardlinks', main, clone);
  git(main, 'remote', 'add', 'origin', 'https://example.invalid/synthetic/shared.git');
  git(clone, 'remote', 'set-url', 'origin', 'https://example.invalid/synthetic/shared.git');
  const first = await registry.enroll(context, { folder: main, expectedVersion: null });
  const second = await registry.enroll(context, { folder: clone, expectedVersion: first.version });
  assert.equal(second.catalog.checkouts.length, 2);
  assert.notEqual(second.checkout_id, first.checkout_id);
  assert.notEqual(selectedCheckout(second).repository_id, selectedCheckout(first).repository_id);
  const catalog = await registry.identityCatalog(context); assert.equal(validateIdentityCatalog(catalog), true);
  assert.equal(catalog.repositories.length, 2); assert.equal(catalog.memberships.length, 2);
});

test('stale expected version rolls back catalog and immutable source changes', async t => {
  const { root, registry, context, store } = fixture(t), main = repository(root), other = repository(root, 'other');
  const first = await registry.enroll(context, { folder: main, expectedVersion: null });
  const before = await registry.get(context), sources = sourceCount(store, context);
  await assert.rejects(async () => registry.enroll(context, { folder: other, expectedVersion: null }), /cas_conflict/);
  assert.deepEqual(await registry.get(context), before); assert.equal(sourceCount(store, context), sources);
  await assert.rejects(async () => registry.refresh(context, { checkout_id: first.checkout_id, expectedVersion: 9999 }), /cas_conflict/);
  assert.deepEqual(await registry.get(context), before); assert.equal(sourceCount(store, context), sources);
});

test('catalog CAS lost after discovery cannot append a partial enrollment source row', async t => {
  const { root, registry, context, store, options } = fixture(t), main = repository(root);
  const first = await registry.enroll(context, { folder: main, expectedVersion: null });
  git(main, 'branch', 'raced-ref');
  const otherWriter = new DomainStore(options); t.after(() => otherWriter.close());
  const before = store.getRecord(context, 'git-enrollment', 'catalog'), sources = sourceCount(store, context);
  const originalTransaction = store.transaction.bind(store);
  store.transaction = (ctx, callback) => {
    store.transaction = originalTransaction;
    otherWriter.transaction(context, tx => tx.compareAndSwap('git-enrollment', 'catalog', before.version, before.value));
    return originalTransaction(ctx, callback);
  };
  await assert.rejects(async () => registry.refresh(context, { checkout_id: first.checkout_id, expectedVersion: first.version }), /cas_conflict/);
  assert.equal(store.getRecord(context, 'git-enrollment', 'catalog').version, before.version + 1);
  assert.deepEqual(store.getRecord(context, 'git-enrollment', 'catalog').value, before.value);
  assert.equal(sourceCount(store, context), sources);
});

test('explicit move declaration preserves selected IDs and prior path history', async t => {
  const { root, registry, context } = fixture(t), main = repository(root), moved = join(root, 'moved repo');
  const first = await registry.enroll(context, { folder: main, expectedVersion: null });
  const prior = selectedCheckout(first), oldWorktreeId = prior.worktrees[0].worktree_id;
  renameSync(main, moved);
  const next = await registry.associateMove(context, { checkout_id: first.checkout_id, prior_path: main, folder: moved, expectedVersion: first.version });
  assert.equal(next.checkout_id, first.checkout_id); assert.equal(selectedCheckout(next).repository_id, prior.repository_id);
  assert(selectedCheckout(next).worktrees.some(w => w.worktree_id === oldWorktreeId));
  assert(JSON.stringify(selectedCheckout(next).history).includes(main));
  assert.equal(validateIdentityCatalog(await registry.identityCatalog(context)), true);
});

test('forged, foreign, revoked, expired and insufficient permissions fail before private-path discovery or writes', async t => {
  const { root, registry, context, credential, authority, clock } = fixture(t), main = repository(root), missing = join(root, 'private-canary-not-a-folder');
  const readonly = credential(['project:inspect', 'store:read']);
  const revoked = credential(); authority.revoke(revoked.issued.credential_id);
  const foreignAuthority = new LocalCredentialAuthority();
  const foreignScope = { tenant_id: 'tenant', project_id: 'project' };
  const foreignIssued = foreignAuthority.issue({ principal_id: 'test-user', kind: 'human', scope: foreignScope, actions: ALL_ACTIONS });
  const foreign = foreignAuthority.authorize(foreignIssued.credential, { scope: foreignScope, audience: LOCAL_AUDIENCE,
    action: 'project:inspect', kinds: ['human'], boundary: 'http', reference: scopedReference('http', foreignScope, 'projects') }).context;
  const forged = { principal_id: 'test-user', kind: 'human' };
  for (const denied of [{}, forged, revoked.context, foreign]) {
    let validError, missingError;
    try { await registry.inspect(denied, main); } catch (error) { validError = error; }
    try { await registry.inspect(denied, missing); } catch (error) { missingError = error; }
    assert(validError && missingError); assert.equal(validError.code, missingError.code);
    assert.equal(String(missingError).includes('private-canary'), false);
  }
  assert.equal(foreignAuthority.inspect(context), null);
  await assert.rejects(async () => registry.enroll(readonly.context, { folder: main, expectedVersion: null }));
  await assert.rejects(async () => registry.initialize(readonly.context, missing));
  assert.equal(await registry.get(context), null);
  clock.now += 60001;
  await assert.rejects(async () => registry.inspect(context, main));
  await assert.rejects(async () => registry.enroll(context, { folder: main, expectedVersion: null }));
});

test('Project registry catalogs are scoped and independent when selecting the same local Git folder', async t => {
  const { root, registry, context, credential } = fixture(t), main = repository(root);
  const first = await registry.enroll(context, { folder: main, expectedVersion: null });
  const other = credential(ALL_ACTIONS, 'other-tenant', 'project').context;
  assert.equal(await registry.get(other), null);
  const second = await registry.enroll(other, { folder: main, expectedVersion: null });
  assert.equal(second.catalog.checkouts.length, 1);
  assert.equal((await registry.get(context)).version, first.version);
  assert.equal((await registry.identityCatalog(other)).tenants[0].tenant_id, 'other-tenant');
});

test('inherited GIT overrides cannot redirect the explicitly selected folder', async t => {
  const { root, registry, context } = fixture(t), main = repository(root), unrelated = repository(root, 'other');
  const overrides = { GIT_DIR: join(unrelated, '.git'), GIT_WORK_TREE: unrelated, GIT_COMMON_DIR: join(unrelated, '.git'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true' };
  const prior = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, overrides);
    const inspected = await registry.inspect(context, main);
    assert.equal(inspected.status, 'git'); assert.equal(inspected.worktree_path, main);
    assert.equal(inspected.common_dir, realpathSync(join(main, '.git')));
  } finally { for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});


test('Git metadata changed during discovery rejects enrollment without a partial catalog/source', t => {
  const { root, registry, context, store } = fixture(t), main = repository(root);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = join(root, 'fixture-bin'), wrapper = join(bin, 'git'), sentinel = join(root, 'changed');
  mkdirSync(bin);
  writeFileSync(wrapper, `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realGit)}, args, { env: process.env, encoding: 'utf8' });
if (args.includes('for-each-ref') && !fs.existsSync(${JSON.stringify(sentinel)})) {
  fs.writeFileSync(${JSON.stringify(sentinel)}, 'yes');
  spawnSync(${JSON.stringify(realGit)}, ['-C', ${JSON.stringify(main)}, 'branch', 'racing-ref'], { env: process.env });
}
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1);
`);
  chmodSync(wrapper, 0o700);
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${oldPath}`;
    assert.throws(() => registry.enroll(context, { folder: main, expectedVersion: null }), { code: 'discovery_changed' });
  } finally { process.env.PATH = oldPath; }
  assert.equal(registry.get(context), null); assert.equal(sourceCount(store, context), 0);
  assert.equal(readFileSync(join(main, 'README.txt'), 'utf8'), 'synthetic project only\n');
});

test('unchanged rescan still rejects a catalog version changed before transaction admission', t => {
  const { root, registry, context, store, options } = fixture(t), main = repository(root);
  const first = registry.enroll(context, { folder: main, expectedVersion: null });
  const other = new DomainStore(options); t.after(() => other.close());
  const originalTransaction = store.transaction.bind(store), before = sourceCount(store, context);
  store.transaction = (ctx, callback) => {
    other.transaction(ctx, tx => {
      const current = tx.getRecord('git-enrollment', 'catalog');
      tx.compareAndSwap('git-enrollment', 'catalog', current.version, current.value);
    });
    return originalTransaction(ctx, callback);
  };
  assert.throws(() => registry.refresh(context, { checkout_id: first.checkout_id, expectedVersion: first.version }), { code: 'cas_conflict' });
  assert.equal(sourceCount(store, context), before);
});


test('removing the originally selected linked worktree preserves its healthy enrolled sibling', t => {
  const { root, registry, context } = fixture(t), main = repository(root), linked = join(root, 'feature-worktree');
  git(main, 'worktree', 'add', '-b', 'feature', linked);
  const first = registry.enroll(context, { folder: linked, expectedVersion: null });
  const old = selectedCheckout(first), mainId = old.worktrees.find(w => w.path === main).worktree_id;
  const removedId = old.worktrees.find(w => w.path === linked).worktree_id;
  git(main, 'worktree', 'remove', linked);
  const next = registry.refresh(context, { checkout_id: first.checkout_id, expectedVersion: first.version });
  const current = selectedCheckout(next);
  assert.equal(current.state, 'active'); assert.equal(current.selected_path, main);
  assert.equal(current.worktrees.find(w => w.path === main).worktree_id, mainId);
  assert.equal(current.worktrees.find(w => w.worktree_id === removedId).state, 'removed');
  assert(current.history.some(h => h.kind === 'selected_worktree_changed' && h.prior_path === linked));
  assert.deepEqual(registry.identityCatalog(context).worktrees.map(w => w.worktree_id), [mainId]);
});
