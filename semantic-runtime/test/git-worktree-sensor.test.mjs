import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, renameSync, unlinkSync, symlinkSync, mkdirSync, mkdtempSync, rmSync, existsSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DurableIngress } from '../src/application/project/durable-ingress.mjs';
import { LocalGitWorktreeSensor } from '../src/adapters/git/git-worktree-sensor.mjs';
import { validateGitWorktreeObservation, GIT_SENSOR_LIMITS } from '../src/domain/sources/git-worktree-observation.mjs';
import { observeGitWorktree } from '../src/adapters/git/git-worktree-observer.mjs';
import { sensorFixture, git, SENSOR_ACTIONS, SENSOR_SCOPE } from './helpers/git-sensor-fixture.mjs';
const bind = f => { const s = f.register(); f.sensor.bind(f.context, { registration_id: s.registration_id }); return s; };
const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const path = s => Buffer.from(s).toString('base64');
const selected = f => { const c = f.registry.get(f.context).value.checkouts[0]; return { checkout: c, worktree: c.worktrees.find(w => w.path === f.folder) }; };

test('real registered Git -> approved metadata -> durable normalized event, bytes, cursor and outbox after reopen', async t => {
  const f = sensorFixture(t), s = bind(f); writeFileSync(join(f.folder, 'note.txt'), 'Changed synthetic text, never retained.\n');
  const result = await f.capture(s); assert.equal(result.status, 'accepted'); const metadata = f.metadata(result.event_id); assert(validateGitWorktreeObservation(metadata));
  assert.equal(metadata.staged.changes.length, 0); assert.equal(metadata.unstaged.changes[0].path_base64, path('note.txt'));
  assert.deepEqual(metadata.mapping.host_session, 'unknown'); assert.equal(metadata.mapping.exploration, 'unmapped');
  const text = f.ingress.readSnapshot(f.context, { event_id: result.event_id }).text;
  assert(!text.includes('Changed synthetic text')); assert(!text.includes(f.folder));
  const next = f.reopen(), actual = next.ingress.readEvent(next.context, { event_id: result.event_id });
  assert.equal(actual.event.event_type, 'GIT_DIFF'); assert.equal(actual.event.producer.sequence, null); assert.deepEqual(actual.event.causal_parents, []);
  assert.equal(actual.raw.identity.session_id, undefined); assert.deepEqual(actual.receipt, result.receipt);
  assert.equal(next.ingress.readSnapshot(next.context, { event_id: result.event_id }).text, text);
  assert.equal(next.ingress.getSource(next.context, { registration_id: s.registration_id }).cursor.state.entries.length, 1);
  assert.equal(next.ingress.listPending(next.context).length, 1);
});

test('debounce/max wait, unchanged suppression and a further dirty edit have content-sensitive identity', async t => {
  const f = sensorFixture(t), s = bind(f), id = { registration_id: s.registration_id };
  for (let n = 0; n < 10; n++) { f.sensor.hint(id); f.clock.mono += 100; }
  assert.equal((await f.sensor.drain(f.context, { limit: 1 })).status, 'idle');
  f.clock.mono = 2001; f.sensor.hint(id); const result = (await f.sensor.drain(f.context, { limit: 1 })).results[0]; assert.equal(result.status, 'accepted');
  assert.equal((await f.capture(s)).status, 'unchanged');
  writeFileSync(join(f.folder, 'note.txt'), 'second\n'); const second = await f.capture(s); assert.equal(second.status, 'accepted');
  writeFileSync(join(f.folder, 'note.txt'), 'third\n'); const third = await f.capture(s); assert.equal(third.status, 'accepted');
  assert.notEqual(f.metadata(second.event_id).unstaged.digest, f.metadata(third.event_id).unstaged.digest);
  assert.equal(f.ingress.listPending(f.context).length, 3);
});

test('stage versus further worktree edit, rename-as-delete/add, binary and untracked byte names', async t => {
  const f = sensorFixture(t), s = bind(f); writeFileSync(join(f.folder, 'note.txt'), 'staged\n'); git(f.folder, 'add', 'note.txt'); writeFileSync(join(f.folder, 'note.txt'), 'unstaged\n');
  writeFileSync(join(f.folder, 'binary.bin'), Buffer.from([0, 1, 2, 3])); git(f.folder, 'add', 'binary.bin'); writeFileSync(join(f.folder, 'binary.bin'), Buffer.from([0, 4, 5, 6]));
  const byteName = Buffer.concat([Buffer.from(f.folder + '/'), Buffer.from('λ\nn')]); writeFileSync(byteName, 'untracked content never read');
  symlinkSync('/nonexistent-synthetic-target', join(f.folder, 'link'));
  const first = await f.capture(s); assert.equal(first.status, 'accepted'); const m = f.metadata(first.event_id);
  assert(m.staged.changes.some(c => c.path_base64 === path('note.txt'))); assert(m.unstaged.changes.some(c => c.path_base64 === path('note.txt')));
  assert.equal(m.unstaged.changes.find(c => c.path_base64 === path('binary.bin')).binary, 'yes');
  assert(m.untracked.some(c => c.path_base64 === Buffer.from('λ\nn').toString('base64'))); assert(m.untracked.some(c => c.kind === 'symlink'));
  renameSync(join(f.folder, 'note.txt'), join(f.folder, 'renamed.txt')); git(f.folder, 'add', '-A'); const second = await f.capture(s); assert.equal(second.status, 'accepted');
  const moved = f.metadata(second.event_id); assert.equal(moved.staged.rename_detection, 'disabled');
  assert(moved.staged.changes.some(c => c.status === 'D' && c.path_base64 === path('note.txt'))); assert(moved.staged.changes.some(c => c.status === 'A' && c.path_base64 === path('renamed.txt')));
});

test('unborn and SHA256 source commits are honest; detached and later checkout retain old base', async t => {
  const f = sensorFixture(t, { unborn: true, format: 'sha256' }), s = bind(f); writeFileSync(join(f.folder, 'new.txt'), 'synthetic\n'); git(f.folder, 'add', 'new.txt');
  const first = await f.capture(s); assert.equal(first.status, 'accepted'); assert.equal(f.metadata(first.event_id).head.state, 'unborn'); assert.equal(f.metadata(first.event_id).head.oid, null);
  git(f.folder, 'commit', '-m', 'first synthetic'); git(f.folder, 'checkout', '--detach'); const detached = await f.capture(s); assert.equal(detached.status, 'accepted');
  const m = f.metadata(detached.event_id); assert.equal(m.head.state, 'detached'); assert.equal(m.head.oid.length, 64);
  git(f.folder, 'switch', '-c', 'other'); writeFileSync(join(f.folder, 'new.txt'), 'later\n'); git(f.folder, 'add', '.'); git(f.folder, 'commit', '-m', 'later');
  assert.equal(f.metadata(detached.event_id).head.oid, m.head.oid); const later = await f.capture(s); assert.equal(later.status, 'accepted'); assert.equal(f.metadata(later.event_id).mapping.ref_incarnation_id, null);
});

test('outside-folder linked worktree is captured via actual enrollment; a branch-only execution cannot bind', async t => {
  const f = sensorFixture(t), outside = join(f.root, 'linked'); git(f.folder, 'worktree', 'add', '-b', 'linked-feature', outside); f.refresh();
  const s = f.register(outside); f.sensor.bind(f.context, { registration_id: s.registration_id }); writeFileSync(join(outside, 'note.txt'), 'external synthetic change\n');
  const result = await f.capture(s); assert.equal(result.status, 'accepted'); assert.equal(f.metadata(result.event_id).identity.worktree_id, s.registration.execution.worktree_id);
  assert.throws(() => f.register(outside, { execution: { ...s.registration.execution, worktree_id: 'branch-only' } }));
  git(f.folder, 'worktree', 'remove', '--force', outside); f.refresh(); const removed = await f.capture(s); assert.equal(removed.status, 'gap');
  assert.equal(f.ingress.listPending(f.context).length, 1);
});

test('disabled binding reads no worktree content; re-enable samples only current state, never old pending', async t => {
  const f = sensorFixture(t, { enabled: false }), s = bind(f); const first = await f.capture(s); assert.equal(first.status, 'paused'); assert.equal(f.ingress.listPending(f.context).length, 0);
  writeFileSync(join(f.folder, 'note.txt'), 'disabled changes\n'); f.activation.setEnabled(f.context, { enabled: true, expectedVersion: null });
  const live = await f.capture(s); assert.equal(live.status, 'accepted'); assert(f.metadata(live.event_id).gap_summary.reasons.some(g => g.code === 'project_disabled'));
  const state = f.activation.get(f.context); f.activation.setEnabled(f.context, { enabled: false, expectedVersion: state.version });
  assert.equal((await f.capture(s)).status, 'paused'); assert.equal(f.ingress.listPending(f.context).length, 1);
});

test('lost response after actual intake commit reconciles original receipt without duplicate effect', async t => {
  const f = sensorFixture(t), s = bind(f); const original = DurableIngress.prototype.submit; let first = true;
  DurableIngress.prototype.submit = function (...args) { const result = original.apply(this, args); if (first) { first = false; throw Object.assign(new Error('synthetic lost response'), { code: 'store_unavailable' }); } return result; };
  t.after(() => { DurableIngress.prototype.submit = original; });
  const pending = await f.capture(s); assert.equal(pending.status, 'pending'); const accepted = f.ingress.getReceipt(f.context, { event_id: pending.event_id }); assert(accepted);
  const duplicate = (await f.sensor.drain(f.context, { limit: 1 })).results[0]; assert.equal(duplicate.status, 'duplicate'); assert.deepEqual(duplicate.receipt, accepted);
  assert.equal(f.ingress.listPending(f.context).length, 1); assert.equal(f.ingress.getSource(f.context, { registration_id: s.registration_id }).cursor.state.entries.length, 1);
});

test('three explicit transient attempts drop with unknown admission; capacity stops without rotating source', async t => {
  const f = sensorFixture(t), s = bind(f), original = DurableIngress.prototype.submit; let attempts = 0;
  DurableIngress.prototype.submit = () => { attempts++; throw Object.assign(new Error('temporary'), { code: 'store_unavailable' }); };
  t.after(() => { DurableIngress.prototype.submit = original; });
  assert.equal((await f.capture(s)).status, 'pending'); assert.equal((await f.sensor.drain(f.context, { limit: 1 })).results[0].status, 'pending');
  const dropped = (await f.sensor.drain(f.context, { limit: 1 })).results[0]; assert.equal(dropped.code, 'delivery_unknown'); assert.equal(attempts, 3);
  assert.equal(f.sensor.status(f.context, { registration_id: s.registration_id }).pending_event_id, null);
  DurableIngress.prototype.submit = () => { throw Object.assign(new Error('bounded inherited capacity'), { code: 'cursor_capacity' }); };
  const capacity = await f.capture(s); assert.equal(capacity.status, 'gap'); assert.equal(capacity.code, 'cursor_capacity');
  let recaptures = 0; DurableIngress.prototype.submit = () => { recaptures++; throw new Error('must not resubmit'); };
  assert.equal((await f.capture(s)).status, 'paused'); assert.equal(recaptures, 0); assert.equal(f.ingress.getSource(f.context, { registration_id: s.registration_id }).registration.producer.epoch, 'epoch-1');
});

test('pending epoch is not replayed after disable/re-enable, captured ACL tightening denies old reads', async t => {
  const f = sensorFixture(t), s = bind(f), original = DurableIngress.prototype.submit;
  DurableIngress.prototype.submit = () => { throw Object.assign(new Error('temporary'), { code: 'store_unavailable' }); };
  t.after(() => { DurableIngress.prototype.submit = original; });
  const pending = await f.capture(s); assert.equal(pending.status, 'pending'); DurableIngress.prototype.submit = original;
  let state = f.activation.get(f.context); f.activation.setEnabled(f.context, { enabled: false, expectedVersion: state.version }); state = f.activation.get(f.context);
  f.activation.setEnabled(f.context, { enabled: true, expectedVersion: state.version });
  assert.equal((await f.sensor.drain(f.context, { limit: 1 })).results[0].code, 'stale_activation_epoch'); assert.equal(f.ingress.getReceipt(f.context, { event_id: pending.event_id }), null);
  const live = await f.capture(s); assert.equal(live.status, 'accepted');
  f.ingress.updateSourceAccess(f.context, { registration_id: s.registration_id, expectedVersion: 1, access: { ...s.registration.access, sensitivity: 'restricted' } });
  assert.throws(() => f.ingress.readSnapshot(f.context, { event_id: live.event_id }), { code: 'source_access_denied' });
  assert.throws(() => f.sensor.status(f.context, { registration_id: s.registration_id }));
});

test('strict inert boundaries, tenant/producer denial, and snapshot validator reject forged or oversized metadata', async t => {
  const f = sensorFixture(t), s = bind(f); let getters = 0;
  assert.throws(() => f.sensor.hint({ get registration_id() { getters++; return s.registration_id; } })); assert.equal(getters, 0);
  const reader = f.issue({ principal: 'reader' }); assert.throws(() => f.sensor.bind(reader.context, { registration_id: s.registration_id }));
  const other = f.issue({ scope: { ...SENSOR_SCOPE, project_id: 'other' } }); assert.throws(() => f.sensor.status(other.context, { registration_id: s.registration_id }));
  const limited = f.issue({ actions: SENSOR_ACTIONS.filter(a => a !== 'sensor:capture') }); await assert.rejects(f.sensor.drain(limited.context, { limit: 1 }), { code: 'sensor_unauthorized' });
  const captured = await f.capture(s), m = f.metadata(captured.event_id); assert(validateGitWorktreeObservation(m));
  const arbitraryBytes = structuredClone(m); arbitraryBytes.untracked.push({path_base64: Buffer.from([255,110]).toString('base64'), kind:'file', size:0, mode:33188});
  assert(validateGitWorktreeObservation(arbitraryBytes)); // Wire byte preservation; macOS does not create non-UTF8 names.
  assert.throws(() => validateGitWorktreeObservation({ ...m, arbitrary: 'not allowed' })); assert.throws(() => validateGitWorktreeObservation({ ...m, get head() { getters++; return m.head; } })); assert.equal(getters, 0);
  assert.throws(() => validateGitWorktreeObservation({ ...m, payload: 'x'.repeat(GIT_SENSOR_LIMITS.snapshot_bytes) }));
});

test('cancellation/expiry leave no intake and no scratch directories; another coding Git command still works', async t => {
  const f = sensorFixture(t), s = bind(f), before = readdirSync(tmpdir()).filter(n => n.startsWith('vh-git-observe-'));
  f.sensor.hint({ registration_id: s.registration_id }); const run = f.sensor.drain(f.context, { limit: 1, force: true }); f.sensor.close();
  assert.equal((await run).results[0].status, 'gap'); assert.equal(f.ingress.listPending(f.context).length, 0); assert.equal(git(f.folder, 'rev-parse', '--is-inside-work-tree'), 'true');
  assert.deepEqual(readdirSync(tmpdir()).filter(n => n.startsWith('vh-git-observe-')), before);
  const sensor = new LocalGitWorktreeSensor({ store: f.store, authority: f.authority }); sensor.bind(f.context, { registration_id: s.registration_id }); t.after(() => sensor.close());
  const original = f.authority.inspect.bind(f.authority); let checks = 0; f.authority.inspect = ctx => { if (++checks === 70) f.clock.auth += 3600001; return original(ctx); };
  const expired = await f.capture(s, { sensor }); assert.equal(expired.status, 'gap');
});

test('real conversion/helper configurations are refused without invoking programs or changing source metadata', async t => {
  const f = sensorFixture(t), s = bind(f), marker = join(f.root, 'helper-ran'), helper = join(f.root, 'helper');
  writeFileSync(helper, `#!/bin/sh\nprintf hit > '${marker}'\ncat\n`, { mode: 0o700 });
  for (const key of ['filter.evil.clean', 'filter.evil.process', 'core.fsmonitor', 'diff.external', 'diff.evil.textconv']) git(f.folder, 'config', key, helper);
  git(f.folder, 'config', 'remote.origin.url', 'ext::' + helper); git(f.folder, 'config', 'remote.origin.promisor', 'true');
  writeFileSync(join(f.folder, '.gitattributes'), '*.txt filter=evil diff=evil\n'); writeFileSync(join(f.folder, 'note.txt'), 'dirty\n');
  const files = ['index', 'HEAD', 'config'].map(p => join(f.folder, '.git', p)), before = files.map(hash);
  const result = await f.capture(s); assert.equal(result.status, 'gap'); assert.equal(result.code, 'unsupported_profile'); assert(!existsSync(marker)); assert.deepEqual(files.map(hash), before);
});

test('plain binary/unmerged and directory-symlink boundary do not turn into content capture elsewhere', async t => {
  const f = sensorFixture(t), s = bind(f); git(f.folder, 'branch', 'other'); writeFileSync(join(f.folder, 'note.txt'), 'main\n'); git(f.folder, 'commit', '-am', 'main');
  git(f.folder, 'checkout', 'other'); writeFileSync(join(f.folder, 'note.txt'), 'other\n'); git(f.folder, 'commit', '-am', 'other');
  assert.throws(() => git(f.folder, 'merge', 'main'));
  const merged = await f.capture(s); assert.equal(merged.status, 'accepted'); assert.equal(f.metadata(merged.event_id).unmerged.length, 3);
  const outside = join(f.root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'hidden.txt'), 'must not enter metadata'); symlinkSync(outside, join(f.folder, 'directory-link'));
  const symlink = await f.capture(s); assert.equal(symlink.status, 'accepted'); assert(!JSON.stringify(f.metadata(symlink.event_id)).includes('hidden.txt'));
});

test('detected editor/index/checkout races settle once or report an explicit gap, never mixed snapshots', async t => {
  const f = sensorFixture(t); const before = selected(f); let passes = 0;
  const observed = await observeGitWorktree({ ...before, guard() {}, onPhase(name) { if (name === 'after-content' && passes++ === 0) writeFileSync(join(f.folder, 'note.txt'), 'race changed\n'); } });
  assert.equal(observed.metrics.samples, 3); assert(observed.observation.unstaged.changes.length);
  await assert.rejects(observeGitWorktree({ ...before, guard() {}, onPhase(name) { if (name === 'after-content') { writeFileSync(join(f.folder, 'note.txt'), `index-race-${passes++}\n`); git(f.folder, 'add', 'note.txt'); } } }), { code: 'unstable_capture' });
});

test('source config check/use race cannot run a newly configured process helper', async t => {
  const f = sensorFixture(t), marker = join(f.root, 'late-helper'), helper = join(f.root, 'late-program');
  writeFileSync(helper, `#!/bin/sh\nprintf bad > '${marker}'\ncat\n`, { mode: 0o700 });
  let switched = false;
  await assert.rejects(observeGitWorktree({ ...selected(f), guard() {}, onPhase(name) { if (name === 'after-profile' && !switched) { switched = true; git(f.folder, 'config', 'filter.evil.process', helper); writeFileSync(join(f.folder, '.gitattributes'), '*.txt filter=evil\n'); writeFileSync(join(f.folder, 'note.txt'), 'late change\n'); } } }), { code: 'unsupported_profile' });
  assert(!existsSync(marker));
});

test('bounded path and index workloads fail explicitly; fresh process declares preceding interval unknown', async t => {
  const f = sensorFixture(t), s = bind(f); for (let n = 0; n <= GIT_SENSOR_LIMITS.paths; n++) writeFileSync(join(f.folder, `untracked-${n}`), 'synthetic');
  const tooMany = await f.capture(s); assert.equal(tooMany.status, 'gap'); assert.equal(tooMany.code, 'capture_limit');
  for (let n = 0; n <= GIT_SENSOR_LIMITS.paths; n++) unlinkSync(join(f.folder, `untracked-${n}`));
  const fresh = f.reopen(); fresh.sensor.bind(fresh.context, { registration_id: s.registration_id }); const result = await f.capture(s, { sensor: fresh.sensor, context: fresh.context });
  assert.equal(result.status, 'accepted'); assert.equal(f.metadata(result.event_id).gap_summary.preceding_interval, 'unknown'); assert(f.metadata(result.event_id).gap_summary.reasons.some(r => r.code === 'process_start'));
});

test('assume-unchanged and skip-worktree flags cannot conceal a further tracked edit', async t => {
  const f = sensorFixture(t), s = bind(f);
  git(f.folder, 'update-index', '--assume-unchanged', 'note.txt'); writeFileSync(join(f.folder, 'note.txt'), 'hidden edit\n');
  const ignored = await f.capture(s); assert.equal(ignored.code, 'unsupported_profile'); assert.equal(ignored.status, 'gap');
  git(f.folder, 'update-index', '--no-assume-unchanged', 'note.txt'); git(f.folder, 'update-index', '--skip-worktree', 'note.txt');
  assert.equal((await f.capture(s)).code, 'unsupported_profile');
  git(f.folder, 'update-index', '--no-skip-worktree', 'note.txt'); const current = await f.capture(s); assert.equal(current.status, 'accepted'); assert(f.metadata(current.event_id).unstaged.changes.length);
});

test('all public JSON input boundaries reject Proxy traps without executing them', async t => {
  const f = sensorFixture(t); let traps = 0; const proxy = new Proxy({}, { getPrototypeOf() { traps++; return Object.prototype; }, ownKeys() { traps++; return []; }, get() { traps++; return undefined; } });
  assert.throws(() => f.sensor.bind(f.context, proxy)); assert.throws(() => f.sensor.hint(proxy)); assert.throws(() => f.sensor.status(f.context, proxy));
  await assert.rejects(f.sensor.drain(f.context, proxy)); assert.throws(() => validateGitWorktreeObservation(proxy)); assert.equal(traps, 0);
});

test('slash-bearing scope components never collide with another Project pending observation', async t => {
  const f = sensorFixture(t), aScope = { tenant_id: 'scope/a', project_id: 'b' }, bScope = { tenant_id: 'scope', project_id: 'a/b' }, a = f.issue({ scope: aScope }), b = f.issue({ scope: bScope });
  f.registry.enroll(a.context, { folder: f.folder, expectedVersion: null }); f.activation.setEnabled(a.context, { enabled: true, expectedVersion: null });
  const cat = f.registry.get(a.context).value, c = cat.checkouts[0], w = c.worktrees[0], base = f.register().registration;
  const source = f.ingress.registerSource(a.context, { partition: { ...aScope, source_installation_id: cat.installation_id, partition_id: 'slash-scope' },
    producer: base.producer, producer_principal_id: 'owner', start_sequence: 0, mapping: base.mapping, access: base.access,
    execution: { repository_id: c.repository_id, checkout_id: c.checkout_id, worktree_id: w.worktree_id } });
  f.sensor.bind(a.context, { registration_id: source.registration_id }); const original = DurableIngress.prototype.submit;
  DurableIngress.prototype.submit = () => { throw Object.assign(new Error('temporary'), { code: 'store_unavailable' }); };
  t.after(() => { DurableIngress.prototype.submit = original; });
  const pending = await f.capture(source, { context: a.context }); assert.equal(pending.status, 'pending');
  const foreign = await f.sensor.drain(b.context, { limit: 1, force: true }); assert.deepEqual(foreign.results, []); assert.equal(foreign.more_due, false); assert(!JSON.stringify(foreign).includes(source.registration_id));
  assert.throws(() => f.sensor.status(b.context, { registration_id: source.registration_id }));
  assert.equal(f.sensor.status(a.context, { registration_id: source.registration_id }).pending_event_id, pending.event_id);
});

test('isolated sampling ignores non-conversion helpers and does not recurse into Gitlinks', async t => {
  const f = sensorFixture(t), s = bind(f), marker = join(f.root, 'helper-marker'), helper = join(f.root, 'program');
  writeFileSync(helper, `#!/bin/sh\nprintf bad > '${marker}'\ncat\n`, { mode: 0o700 });
  for (const key of ['core.fsmonitor', 'diff.external', 'diff.evil.textconv']) git(f.folder, 'config', key, helper);
  git(f.folder, 'config', 'remote.origin.url', 'ext::' + helper); git(f.folder, 'config', 'remote.origin.promisor', 'true');
  mkdirSync(join(f.folder, '.git', 'hooks'), { recursive: true }); writeFileSync(join(f.folder, '.git', 'hooks', 'post-index-change'), readFileSync(helper), { mode: 0o700 });
  writeFileSync(join(f.folder, '.gitattributes'), '*.txt diff=evil\n'); writeFileSync(join(f.folder, 'note.txt'), 'new synthetic\n');
  const pins = ['index', 'HEAD', 'config'].map(p => hash(join(f.folder, '.git', p)));
  const result = await f.capture(s); assert.equal(result.status, 'accepted'); assert(!existsSync(marker)); assert.deepEqual(['index', 'HEAD', 'config'].map(p => hash(join(f.folder, '.git', p))), pins);
  const oid = git(f.folder, 'rev-parse', 'HEAD'); git(f.folder, 'update-index', '--add', '--cacheinfo', `160000,${oid},nested`);
  // update-index is a fixture writer and may run its own post-index hook: remove that marker before observing.
  if (existsSync(marker)) unlinkSync(marker);
  git(f.folder, 'config', 'submodule.nested.url', 'ext::' + helper); git(f.folder, 'config', 'submodule.nested.update', '!' + helper);
  const nested = await f.capture(s); assert.equal(nested.status, 'accepted'); assert(!existsSync(marker));
  assert(f.metadata(nested.event_id).staged.changes.some(c => c.path_base64 === path('nested') && c.new_mode === '160000'));
  git(f.folder, 'add', 'note.txt'); git(f.folder, 'commit', '-m', 'synthetic gitlink base'); const nextOid = git(f.folder, 'rev-parse', 'HEAD');
  git(f.folder, 'update-index', '--cacheinfo', `160000,${nextOid},nested`);
  if (existsSync(marker)) unlinkSync(marker);
  const changed = await f.capture(s); assert.equal(changed.status, 'accepted'); const changedLink = f.metadata(changed.event_id).staged.changes.find(c => c.path_base64 === path('nested'));
  assert.equal(changedLink.old_oid, oid); assert.equal(changedLink.new_oid, nextOid); assert.equal(f.metadata(changed.event_id).submodule_worktrees, 'not_observed'); assert(!existsSync(marker));
});

test('oversized index, oversized complete diff and copied-index metadata symlink are explicit gaps', async t => {
  const f = sensorFixture(t), s = bind(f), indexPath = join(f.folder, '.git', 'index'), original = readFileSync(indexPath);
  writeFileSync(indexPath, Buffer.alloc(GIT_SENSOR_LIMITS.index_bytes + 1)); const index = await f.capture(s); assert.equal(index.code, 'capture_limit'); writeFileSync(indexPath, original);
  writeFileSync(join(f.folder, 'note.txt'), 'large changed line\n'.repeat(160000)); assert.equal((await f.capture(s)).code, 'capture_limit');
  const target = join(f.root, 'other-index'); writeFileSync(target, original); unlinkSync(indexPath); symlinkSync(target, indexPath);
  assert.equal((await f.capture(s)).code, 'unsupported_profile'); unlinkSync(indexPath); writeFileSync(indexPath, original);
});

test('scratch index never conceals same-size binary changes with restored modification time', async t => {
  const f = sensorFixture(t), s = bind(f), file = join(f.folder, 'racy.bin'); writeFileSync(file, Buffer.from([0, 1, 2, 3])); git(f.folder, 'add', 'racy.bin');
  const prior = statSync(file), index = hash(join(f.folder, '.git', 'index')); writeFileSync(file, Buffer.from([0, 4, 5, 6])); utimesSync(file, prior.atime, prior.mtime);
  assert(git(f.folder, 'diff', '--raw', '--', 'racy.bin').includes('racy.bin'));
  const result = await f.capture(s); assert.equal(result.status, 'accepted'); const m = f.metadata(result.event_id); assert(m.unstaged.changes.some(c => c.path_base64 === path('racy.bin') && c.binary === 'yes'));
  assert.equal(hash(join(f.folder, '.git', 'index')), index);
  utimesSync(file, 0, 0); assert.equal((await f.capture(s)).code, 'unsupported_profile');
});

test('a tracked parent replaced by a symlink is refused without reading the outside tree', async t => {
  const f = sensorFixture(t), s = bind(f); mkdirSync(join(f.folder, 'dir')); writeFileSync(join(f.folder, 'dir', 'tracked.txt'), 'inside\n'); git(f.folder, 'add', '.'); git(f.folder, 'commit', '-m', 'directory');
  const outside = join(f.root, 'outside-tree'); mkdirSync(outside); writeFileSync(join(outside, 'tracked.txt'), 'outside private synthetic\n');
  renameSync(join(f.folder, 'dir'), join(f.folder, 'old-dir')); symlinkSync(outside, join(f.folder, 'dir'));
  const result = await f.capture(s); assert.equal(result.status, 'gap'); assert.equal(result.code, 'unsupported_profile'); assert.equal(f.ingress.listPending(f.context).length, 0);
});

test('source config include FIFO is never opened, even after the profile check', async t => {
  const f = sensorFixture(t), s = bind(f), fifo = join(f.root, 'never-read-config'); execFileSync('mkfifo', [fifo]);
  const config = join(f.folder, '.git', 'config'), original = readFileSync(config);
  writeFileSync(config, Buffer.concat([original, Buffer.from(`\n[include]\npath = ${fifo}\n`)]));
  const result = await f.capture(s); assert.equal(result.code, 'unsupported_profile'); // Opening the FIFO would time out instead.
  writeFileSync(config, original); let changed = false;
  await assert.rejects(observeGitWorktree({ ...selected(f), guard() {}, onPhase(name) { if (name === 'after-profile' && !changed) { changed = true;
    writeFileSync(config, Buffer.concat([original, Buffer.from(`\n[include]\npath = ${fifo}\n`)])); } } }), { code: 'unsupported_profile' });
});

test('actual index/config/HEAD FIFOs fail promptly without intake or scratch leaks', t => {
  // A child timeout also catches a blocked open that prevents the sampler's own deadline from firing.
  const childRoot = mkdtempSync(join(tmpdir(), 'vh-sensor-fifo-child-'));
  t.after(() => rmSync(childRoot, { recursive: true, force: true }));
  const script = `
    import assert from 'node:assert/strict';
    import { unlinkSync, readdirSync } from 'node:fs';
    import { execFileSync } from 'node:child_process';
    import { join } from 'node:path';
    import { tmpdir } from 'node:os';
    import { sensorFixture } from ${JSON.stringify(new URL('./helpers/git-sensor-fixture.mjs', import.meta.url).href)};
    const results = [];
    for (const name of ['index', 'config', 'HEAD']) {
      const cleanup = [], f = sensorFixture({ after(fn) { cleanup.push(fn); } });
      try {
        const s = f.register(); f.sensor.bind(f.context, { registration_id: s.registration_id });
        const metadata = join(f.folder, '.git', name); unlinkSync(metadata); execFileSync('mkfifo', [metadata]);
        const started = performance.now(), result = await f.capture(s);
        assert.equal(result.status, 'gap'); assert.equal(result.code, 'unsupported_profile');
        assert(performance.now() - started < 2000); assert.equal(f.ingress.listPending(f.context).length, 0);
        assert.deepEqual(readdirSync(tmpdir()).filter(n => n.startsWith('vh-git-observe-')), []);
        results.push(name);
      } finally { for (const fn of cleanup.reverse()) fn(); }
    }
    process.stdout.write(JSON.stringify(results));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TMPDIR: childRoot }, encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.deepEqual(JSON.parse(output), ['index', 'config', 'HEAD']);
  assert.deepEqual(readdirSync(childRoot), []);
});

test('packed refs and intent-to-add are retained; split index is explicitly unsupported', async t => {
  const f = sensorFixture(t), s = bind(f), oid = git(f.folder, 'rev-parse', 'HEAD'); git(f.folder, 'pack-refs', '--all', '--prune');
  writeFileSync(join(f.folder, 'intent.txt'), 'uncommitted synthetic intent\n'); git(f.folder, 'add', '--intent-to-add', 'intent.txt');
  const captured = await f.capture(s); assert.equal(captured.status, 'accepted'); const m = f.metadata(captured.event_id); assert.equal(m.head.oid, oid);
  assert(!m.staged.changes.some(c => c.path_base64 === path('intent.txt'))); assert(m.unstaged.changes.some(c => c.path_base64 === path('intent.txt')));
  git(f.folder, 'update-index', '--split-index'); const unsupported = await f.capture(s); assert.equal(unsupported.code, 'unsupported_profile');
});

test('real worktree physical replacement and branch checkout during capture produce explicit observed boundaries', async t => {
  const f = sensorFixture(t), s = bind(f); git(f.folder, 'branch', 'alternate'); let moved = false;
  const sample = await observeGitWorktree({ ...selected(f), guard() {}, onPhase(name) { if (name === 'after-content' && !moved) { moved = true; git(f.folder, 'switch', 'alternate'); } } });
  assert.equal(Buffer.from(sample.observation.head.branch_base64, 'base64').toString(), 'refs/heads/alternate'); assert.equal(sample.metrics.samples, 3);
  const oldAdmin = join(f.folder, '.git-old'); renameSync(join(f.folder, '.git'), oldAdmin); git(f.folder, 'init', '--initial-branch=new');
  const replacement = await f.capture(s); assert.equal(replacement.code, 'membership_gap'); assert.equal(f.ingress.listPending(f.context).length, 0);
});

test('fixed synthetic workload records actual bounded capture cost without raw content or project paths', async t => {
  const f = sensorFixture(t);
  for (let n = 0; n < 32; n++) writeFileSync(join(f.folder, `code-${n}.txt`), `synthetic baseline ${n}\n`.repeat(8));
  git(f.folder, 'add', '.'); git(f.folder, 'commit', '-m', 'synthetic workload'); f.refresh();
  for (let n = 0; n < 32; n++) { writeFileSync(join(f.folder, `code-${n}.txt`), `synthetic changed ${n}\n`.repeat(8)); if (n % 2 === 0) git(f.folder, 'add', `code-${n}.txt`); }
  for (let n = 0; n < 8; n++) writeFileSync(join(f.folder, `untracked-${n}`), 'unread body');
  const s = bind(f), result = await f.capture(s); assert.equal(result.status, 'accepted'); const status = f.sensor.status(f.context, { registration_id: s.registration_id }), metadata = f.metadata(result.event_id);
  const measurement = { schema_version: 1, workload: 'synthetic32tracked8untracked', staged_paths: metadata.staged.changes.length,
    unstaged_paths: metadata.unstaged.changes.length, untracked_paths: metadata.untracked.length,
    snapshot_bytes: Buffer.byteLength(f.ingress.readSnapshot(f.context, { event_id: result.event_id }).text),
    commands: status.counters.commands, command_output_bytes: status.counters.bytes, sample_passes: status.counters.samples, capture_duration_ms: status.counters.duration_ms,
    receipt_count: f.ingress.listPending(f.context).length, producer_sequence: null, actual_model_calls: 0,
    limits: GIT_SENSOR_LIMITS, assurance: 'observed stable endpoints; no atomic filesystem snapshot or native conversion fidelity' };
  assert.equal(measurement.staged_paths, 16); assert.equal(measurement.unstaged_paths, 16); assert.equal(measurement.untracked_paths, 8);
  assert.equal(measurement.sample_passes, 2); assert(measurement.commands < 64); assert(measurement.snapshot_bytes <= GIT_SENSOR_LIMITS.snapshot_bytes);
  if (process.env.GIT_SENSOR_MEASURE_PATH) writeFileSync(process.env.GIT_SENSOR_MEASURE_PATH, JSON.stringify(measurement, null, 2) + '\n');
});
