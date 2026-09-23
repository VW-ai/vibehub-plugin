import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, symlinkSync, unlinkSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LocalAppSetup, setupProviderKey } from '../src/app/local/app-setup.mjs';
import { LocalCredentialAuthority } from '../src/adapters/auth/local-credential-authority.mjs';
import { PROVIDER_MODELS } from '../src/adapters/providers/provider-settings.mjs';
import { MacOSSecretStore } from '../src/adapters/secrets/macos-secret-store.mjs';

function git(folder, ...args) {
  return execFileSync('git', ['-c', 'user.name=Setup Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=', ...args], { cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: folder, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
}
const config = provider => ({ primary: { provider, model: PROVIDER_MODELS[provider], capability: 'semantic-judge-v0' }, fallbacks: [], timeout_ms: 15000, max_attempts: 2 });
function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vh-app-setup-'))), dataDir = join(root, 'data');
  const keys = new Map(), calls = [], owner = Object.freeze({ expires_at: 3601000 }), clock = { now: 1000, allowed: true };
  const secretStore = options.secretStore ?? { async put(ref, value) { calls.push('put'); keys.set(ref, value); },
    async remove(ref) { calls.push('remove'); keys.delete(ref); }, async status(ref) { calls.push('status'); return keys.has(ref) ? 'configured' : 'missing'; },
    async use() { assert.fail('setup must never read a credential'); } };
  const handles = [], authorities = [];
  const open = overrides => {
    const authority = new LocalCredentialAuthority({ now: () => clock.now }); authorities.push(authority);
    const app = new LocalAppSetup({ dataDir, authority, secretStore, now: () => clock.now, ...options, ...overrides }); handles.push(app); return app;
  };
  const f = { root, dataDir, clock, keys, calls, secretStore, open, owner, app: open() };
  f.assertOwner = () => { if (!clock.allowed) throw new Error('expired'); return owner; };
  f.run = (action, input = {}) => f.app.execute(action, input, f.assertOwner);
  f.folder = (name = 'project', committed = false) => {
    const path = join(root, name); mkdirSync(path); writeFileSync(join(path, 'keep.txt'), 'synthetic original\n');
    if (committed) { git(path, 'init', '--initial-branch=main'); git(path, 'add', 'keep.txt'); git(path, 'commit', '-m', 'synthetic'); }
    return path;
  };
  f.enroll = async (folder, name = 'Synthetic project') => {
    let p = await f.run('folder.inspect', { folder });
    if (p.inspection.status === 'not_git') p = await f.run('folder.initialize', { preview_id: p.preview_id });
    return f.run('projects.enroll', { preview_id: p.preview_id, name });
  };
  t.after(async () => { await Promise.all(handles.map(h => h.close())); authorities.forEach(a => a.close()); rmSync(root, { recursive: true, force: true }); });
  return f;
}

test('setup inspects and explicitly initializes without overwriting, enrolls nested/symlink paths and reuses physical repository', async t => {
  const f = fixture(t), folder = f.folder('space project'), nested = join(folder, 'nested'); mkdirSync(nested);
  const preview = await f.run('folder.inspect', { folder });
  assert.equal(preview.inspection.status, 'not_git'); assert.equal(existsSync(join(folder, '.git')), false);
  assert.deepEqual((await f.run('projects.list')).projects, []);
  const initialized = await f.run('folder.initialize', { preview_id: preview.preview_id });
  assert.equal(initialized.inspection.worktrees[0].unborn, true);
  assert.equal(readFileSync(join(folder, 'keep.txt'), 'utf8'), 'synthetic original\n');
  const first = await f.run('projects.enroll', { preview_id: initialized.preview_id, name: 'Project A' });
  const linkedPath = join(f.root, 'alias'); symlinkSync(nested, linkedPath);
  const again = await f.enroll(linkedPath);
  assert.equal(first.project_id, again.project_id); assert.equal(again.reused, true);
  const state = await f.run('project.read', { project_id: first.project_id });
  assert.equal(state.activation.state.enabled, false); assert.equal(state.providers.config, null);
  assert.equal(state.git.value.checkouts[0].worktrees[0].unborn, true);
  assert.equal(state.capabilities.plugins, 'not_connected'); assert.equal(state.capabilities.workers, 'not_connected');
});

test('real external/new worktrees and independent clone Projects retain CAS state across restart', async t => {
  const f = fixture(t), folder = f.folder('A', true), outside = join(f.root, 'external-worktree');
  git(folder, 'worktree', 'add', '-b', 'feature', outside);
  const a = await f.enroll(outside, 'A');
  const cloned = join(f.root, 'clone'); git(f.root, 'clone', '--local', folder, cloned);
  const b = await f.enroll(cloned, 'B'); assert.notEqual(a.project_id, b.project_id);
  let view = await f.run('project.read', { project_id: a.project_id }); assert.equal(view.git.value.checkouts[0].worktrees.length, 2);
  const c = view.git.value.checkouts[0], newer = join(f.root, 'later'); git(folder, 'worktree', 'add', '-b', 'later', newer);
  const refreshed = await f.run('project.refresh', { project_id: a.project_id, checkout_id: c.checkout_id, expectedVersion: view.git.version });
  assert.equal(refreshed.catalog.checkouts[0].worktrees.length, 3);
  await assert.rejects(f.run('project.refresh', { project_id: a.project_id, checkout_id: c.checkout_id, expectedVersion: view.git.version }), { code: 'cas_conflict' });
  const enabled = await f.run('project.activation', { project_id: a.project_id, enabled: true, expectedVersion: null });
  await assert.rejects(f.run('project.activation', { project_id: a.project_id, enabled: false, expectedVersion: null }), { code: 'cas_conflict' });
  assert.equal((await f.run('project.read', { project_id: b.project_id })).activation.state.enabled, false);
  await f.app.close(); f.app = f.open(); view = await f.run('project.read', { project_id: a.project_id });
  assert.deepEqual(view.activation, { version: enabled.version, state: enabled.state });
  assert.equal((await f.run('projects.list')).projects.length, 2);
  git(folder, 'worktree', 'remove', outside);
  await f.run('project.refresh', { project_id: a.project_id, checkout_id: c.checkout_id, expectedVersion: view.git.version });
  assert.equal((await f.run('project.read', { project_id: a.project_id })).git.value.checkouts[0].worktrees.find(w => w.path === outside).state, 'removed');
});

test('preview is one-use, owner-bound, expires and rejects replaced symlink or changed Git base', async t => {
  const f = fixture(t), folder = f.folder('A', true), other = f.folder('B', true), alias = join(f.root, 'alias'); symlinkSync(folder, alias);
  let p = await f.run('folder.inspect', { folder: alias });
  const foreignOwner = { expires_at: 3601000 };
  await assert.rejects(f.app.execute('projects.enroll', { preview_id: p.preview_id, name: 'A' }, () => foreignOwner), { code: 'preview_expired' });
  unlinkSync(alias); symlinkSync(other, alias);
  await assert.rejects(f.run('projects.enroll', { preview_id: p.preview_id, name: 'A' }), { code: 'preview_changed' });
  p = await f.run('folder.inspect', { folder }); f.clock.now += 120000;
  await assert.rejects(f.run('projects.enroll', { preview_id: p.preview_id, name: 'A' }), { code: 'preview_expired' });
  p = await f.run('folder.inspect', { folder }); git(folder, 'branch', 'new-branch');
  await assert.rejects(f.run('projects.enroll', { preview_id: p.preview_id, name: 'A' }), { code: 'preview_changed' });
  assert.equal((await f.run('projects.list')).projects.length, 0);
});

for (const stage of ['after_reservation', 'before_enrollment', 'after_enrollment']) test(`enrollment recovers ${stage} failure under same Project without Git rollback`, async t => {
  let armed = true;
  const f = fixture(t, { fault: actual => { if (actual === stage && armed) { armed = false; throw new Error('synthetic crash boundary'); } } });
  const folder = f.folder(); await assert.rejects(f.enroll(folder), { code: 'setup_failed' });
  assert(existsSync(join(folder, '.git')));
  await f.app.close(); f.app = f.open();
  const list = await f.run('projects.list'), p = list.projects[0]; assert.equal(list.projects.length, 1);
  if (stage === 'after_enrollment') assert.equal(p.state, 'ready');
  const repaired = await f.run('projects.retry', { project_id: p.project_id }); assert.equal(repaired.project_id, p.project_id);
  assert.equal((await f.run('projects.list')).projects[0].state, 'ready');
  assert.equal((await f.enroll(folder)).project_id, p.project_id);
});

test('fresh preview renews changed unstarted base without duplicate Project; disable survives unavailable Git/provider', async t => {
  let armed = true;
  const f = fixture(t, { fault: stage => { if (stage === 'before_enrollment' && armed) { armed = false; throw new Error('injected'); } } });
  const folder = f.folder('A', true); await assert.rejects(f.enroll(folder));
  const p = (await f.run('projects.list')).projects[0]; git(folder, 'branch', 'changed');
  await assert.rejects(f.run('projects.retry', { project_id: p.project_id }), { code: 'preview_changed' });
  assert.equal((await f.enroll(folder)).project_id, p.project_id);
  await f.run('project.activation', { project_id: p.project_id, enabled: true, expectedVersion: null });
  renameSync(folder, `${folder}-moved`);
  const disabled = await f.run('project.activation', { project_id: p.project_id, enabled: false, expectedVersion: 1 });
  assert.equal(disabled.state.enabled, false);
  await assert.rejects(f.run('project.activation', { project_id: p.project_id, enabled: true, expectedVersion: 2 }), { code: 'project_not_enrolled' });
  assert.equal((await f.run('project.read', { project_id: p.project_id })).activation.state.enabled, false);
});

test('three real settings routes isolate Projects, clear/replace keys and never persist canary or invoke model/read-key', async t => {
  const f = fixture(t), a = await f.enroll(f.folder('A')), b = await f.enroll(f.folder('B'));
  const canary = 'synthetic-only-app-key-DO-NOT-RETURN';
  for (const provider of Object.keys(PROVIDER_MODELS)) {
    await f.run('provider.configure', { project_id: a.project_id, config: config(provider) });
    const saved = await f.run('provider.replace', { project_id: a.project_id, provider, secret: canary });
    assert.deepEqual(saved, { state: 'configured' });
    const view = await f.run('project.read', { project_id: a.project_id });
    assert.equal(view.providers.statuses[provider].state, 'configured'); assert.equal(view.providers.verified, false);
    assert(!JSON.stringify(view).includes(canary));
    await f.run('provider.replace', { project_id: a.project_id, provider, secret: 'synthetic-replacement' });
    assert.equal((await f.run('project.read', { project_id: b.project_id })).providers.statuses[provider].state, 'missing');
    await f.run('provider.remove', { project_id: a.project_id, provider });
  }
  assert.equal(f.keys.size, 0);
  await f.app.close(); f.app = f.open();
  assert.deepEqual((await f.run('project.read', { project_id: a.project_id })).providers.config, config('typesafe'));
  for (const name of ['providers.sqlite', 'setup.sqlite']) assert(!readFileSync(join(f.dataDir, name)).includes(canary));
  assert.notEqual(setupProviderKey('ab', 'c'), setupProviderKey('a', 'bc'));
  assert.notEqual(setupProviderKey('a:b', 'c'), setupProviderKey('a', 'b:c'));
  assert.match(setupProviderKey('a', 'b'), /^project-[a-f0-9]{64}$/);
});

test('queued provider work rechecks expiry and never dispatches after revocation; close drains active work', async t => {
  let release, began;
  const started = new Promise(resolve => { began = resolve; }); let puts = 0;
  const f = fixture(t, { secretStore: { async put() { puts++; began(); await new Promise(resolve => { release = resolve; }); },
    async remove() {}, async status() { return 'missing'; }, async use() { assert.fail(); } } });
  const a = await f.enroll(f.folder());
  const first = f.run('provider.replace', { project_id: a.project_id, provider: 'typesafe', secret: 'synthetic-first' });
  await started;
  const second = f.run('provider.replace', { project_id: a.project_id, provider: 'vercel', secret: 'synthetic-queued' });
  f.clock.allowed = false; release();
  await assert.rejects(first, { code: 'setup_unauthorized' }); await assert.rejects(second, { code: 'setup_unauthorized' });
  assert.equal(puts, 1);
  f.clock.allowed = true; await f.app.close();
  await assert.rejects(f.run('projects.list'), { code: 'setup_closed' });
});

test('denials are typed, bounded and side-effect free; ephemeral grants do not exhaust after repeated polls', async t => {
  const f = fixture(t), folder = f.folder(); f.clock.allowed = false;
  await assert.rejects(f.run('folder.inspect', { folder }), { code: 'setup_unauthorized' });
  assert.equal(existsSync(join(folder, '.git')), false); f.clock.allowed = true;
  for (const [action, input] of [['projects.list', { tenant_id: 'other' }], ['provider.use', {}],
    ['folder.inspect', { folder: 'relative' }], ['project.read', { project_id: `project-${'0'.repeat(36)}` }],
    ['projects.enroll', { preview_id: 'x', name: 'A', principal_id: 'owner' }]]) await assert.rejects(f.run(action, input));
  for (let i = 0; i < 1100; i++) assert.equal((await f.run('projects.list')).projects.length, 0);
  assert.equal(f.calls.length, 0);
});

test('setup preserves foreign/corrupt stores and bounds persisted Project list', async t => {
  const f = fixture(t); await f.app.close();
  const path = join(f.dataDir, 'setup.sqlite'); rmSync(path); const db = new DatabaseSync(path);
  db.exec('CREATE TABLE private_user_data(value TEXT); INSERT INTO private_user_data VALUES (\'preserve\');'); db.close();
  assert.throws(() => f.open());
  const reopened = new DatabaseSync(path); assert.equal(reopened.prepare('SELECT value FROM private_user_data').get().value, 'preserve'); reopened.close();
  const other = fixture(t), first = await other.enroll(other.folder());
  const raw = new DatabaseSync(join(other.dataDir, 'setup.sqlite'));
  const row = raw.prepare("SELECT value FROM records WHERE namespace='app-setup'").get();
  const initial = JSON.parse(row.value).projects[0];
  const projects = Array.from({ length: 64 }, (_, i) => ({ ...initial, project_id: `project-${String(i).padStart(36, '0')}`, common_identity: `synthetic-${i}` }));
  raw.prepare("UPDATE records SET value=? WHERE namespace='app-setup'").run(JSON.stringify({ schema_version: 1, projects })); raw.close();
  await assert.rejects(other.enroll(other.folder('another')), { code: 'project_limit' });
  assert.equal((await other.run('projects.list')).projects.length, 64); assert(first.project_id);
});

test('fresh synthetic native app-owned Keychain entry is replaced/removed with cleanup', { skip: process.env.VIBEHUB_TEST_KEYCHAIN !== '1' || process.platform !== 'darwin' }, async t => {
  const refs = new Set(), native = new MacOSSecretStore();
  const secretStore = { async put(ref, text) { refs.add(ref); return native.put(ref, text); },
    remove: ref => native.remove(ref), status: ref => native.status(ref), use() { assert.fail('setup never reads keys'); } };
  const f = fixture(t, { secretStore });
  try {
    const p = await f.enroll(f.folder());
    await f.run('provider.configure', { project_id: p.project_id, config: config('typesafe') });
    await f.run('provider.replace', { project_id: p.project_id, provider: 'typesafe', secret: 'synthetic-native-app-fixture' });
    assert.equal((await f.run('project.read', { project_id: p.project_id })).providers.statuses.typesafe.state, 'configured');
    await f.run('provider.replace', { project_id: p.project_id, provider: 'typesafe', secret: 'synthetic-native-app-replaced' });
    await f.run('provider.remove', { project_id: p.project_id, provider: 'typesafe' });
    assert.equal((await f.run('project.read', { project_id: p.project_id })).providers.statuses.typesafe.state, 'missing');
  } finally { for (const ref of refs) await native.remove(ref); }
});

test('bare repositories are inspectable but not enrollable; detached HEAD is displayed and no checkout is performed', async t => {
  const f = fixture(t), bare = join(f.root, 'bare.git'); mkdirSync(bare); git(bare, 'init', '--bare');
  const p = await f.run('folder.inspect', { folder: bare }); assert.equal(p.inspection.status, 'bare');
  await assert.rejects(f.run('projects.enroll', { preview_id: p.preview_id, name: 'Bare' }), { code: 'bare_repository' });
  const folder = f.folder('detached', true), oid = git(folder, 'rev-parse', 'HEAD'); git(folder, 'checkout', '--detach', oid);
  const a = await f.enroll(folder); const view = await f.run('project.read', { project_id: a.project_id });
  assert.equal(view.git.value.checkouts[0].worktrees[0].detached, true);
  assert.equal(view.git.value.checkouts[0].worktrees[0].head, oid);
  assert.equal(git(folder, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
});

test('invalid provider input and secure-store errors reveal no secret and leave setup/switch usable', async t => {
  const canary = 'synthetic-error-canary';
  const f = fixture(t, { secretStore: { put() { throw new Error(canary); }, remove() { throw new Error(canary); },
    status() { throw new Error(canary); }, use() { assert.fail(); } } });
  const p = await f.enroll(f.folder());
  for (const invalid of [{ ...config('typesafe'), primary: { ...config('typesafe').primary, model: 'arbitrary' } },
    { ...config('typesafe'), primary: { ...config('typesafe').primary, baseUrl: 'http://example.invalid' } },
    { ...config('typesafe'), fallbacks: [config('typesafe').primary] }]) await assert.rejects(f.run('provider.configure', { project_id: p.project_id, config: invalid }));
  await assert.rejects(f.run('provider.replace', { project_id: p.project_id, provider: 'typesafe', secret: canary }), error => {
    assert.equal(error.code, 'secure_store_unavailable'); assert(!error.message.includes(canary)); return true;
  });
  assert.equal((await f.run('project.read', { project_id: p.project_id })).providers.statuses.typesafe.state, 'missing');
  await f.run('project.activation', { project_id: p.project_id, enabled: true, expectedVersion: null });
  await f.run('project.activation', { project_id: p.project_id, enabled: false, expectedVersion: 1 });
  assert.equal((await f.run('projects.list')).projects.length, 1);
});

test('temporary domain grants never outlive paired owner and expiry during Git enrollment cannot commit', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vh-app-expiry-'))), folder = join(root, 'project'); mkdirSync(folder);
  git(folder, 'init', '--initial-branch=main');
  let now = 1000, expireDuringEnrollment = false;
  const owner = Object.freeze({ expires_at: 2000 });
  class ExpiringAuthority extends LocalCredentialAuthority {
    issue(input) { const issued = super.issue(input); assert(issued.expires_at <= owner.expires_at); return issued; }
    inspect(context) {
      const grant = super.inspect(context);
      if (expireDuringEnrollment && grant?.actions.includes('project:enroll')) now = owner.expires_at;
      return grant;
    }
  }
  const authority = new ExpiringAuthority({ now: () => now }), dataDir = join(root, 'data');
  const app = new LocalAppSetup({ dataDir, authority, now: () => now,
    secretStore: { put() {}, remove() {}, status() { return 'missing'; }, use() { assert.fail(); } } });
  t.after(async () => { await app.close(); authority.close(); rmSync(root, { recursive: true, force: true }); });
  const guard = () => { if (now >= owner.expires_at) throw new Error('expired'); return owner; };
  const p = await app.execute('folder.inspect', { folder }, guard); expireDuringEnrollment = true;
  await assert.rejects(app.execute('projects.enroll', { preview_id: p.preview_id, name: 'Expiring owner' }, guard), { code: 'setup_unauthorized' });
  const db = new DatabaseSync(join(dataDir, 'setup.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM records WHERE namespace='git-enrollment'").get().n, 0); }
  finally { db.close(); }
});
