import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fixture, register, capture, hashText, SCOPE, ACTIONS } from '../support/graph-store-fixture.mjs';
import { SourceInvalidationFeed, sourceLifecycleInvalidationId } from '../../src/application/sources/source-invalidation.mjs';

const actions = [...ACTIONS, 'source:invalidation:capture', 'source:invalidation:read', 'source:invalidation:consume'];
function setup(t) {
  const f = fixture(t); f.context = f.issue({ actions }).context;
  const source = register(f), event = capture(f, source);
  return { f, source, event };
}
function request(f, source, sequence = 1) {
  const key = `invalidation-${sequence}`, object = { kind: 'source_object', tenant_id: SCOPE.tenant_id,
    provider: 'vibehub', authority: 'local', object_id: 'decision-source' };
  const acl = { revision: key, allowed_principal_ids: ['owner', 'reader'] };
  return { registration_id: source.registration_id, expectedVersion: source.version, epoch: f.epoch,
    access_state: 'unknown', access: { enabled: false, allowed_principal_ids: [], sensitivity: 'restricted', allow_snapshots: false },
    event: { schema_version: 1, kind: 'raw_event',
      event_id: f.ingress.eventIdFor(f.context, { registration_id: source.registration_id, idempotency_key: key }),
      partition: source.registration.partition, source_native_event_id: key, idempotency_key: key, source_event_type: 'access',
      occurred_at: null, observed_at: '2026-09-22T15:00:00.000Z', producer: { ...source.registration.producer, sequence }, causal_parents: [], identity: {},
      payload: { kind: 'object_revision', object, revision_id: key, digest: hashText(key) },
      provenance: { delivery: { channel: 'system', delivery_id: key }, source_objects: [{ object, acl, sensitivity: 'normal' }] }, acl, sensitivity: 'normal' } };
}
function dump(f) {
  const db = new DatabaseSync(f.filePath, { readOnly: true });
  try { return Object.fromEntries(['records', 'sources', 'outbox'].map(table => [table,
    db.prepare(`SELECT * FROM ${table} WHERE namespace IN ('durable-ingress','source-invalidation') ORDER BY rowid`).all()])); }
  finally { db.close(); }
}
function launch(t, f, mode, value, name = mode) {
  const path = join(f.root, `${name}.json`); writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  const child = spawn(process.execPath, [new URL('../support/source-invalidation-process.mjs', import.meta.url).pathname,
    mode, f.filePath, path], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return child;
}
function reply(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Synthetic child timed out')), 8_000);
    const onExit = () => finish(new Error('Synthetic child exited before reply'));
    const onMessage = value => { if (value?.type === type || value?.type === 'error') finish(null, value); };
    const finish = (error, value) => { clearTimeout(timer); child.off('exit', onExit); child.off('message', onMessage);
      if (error) reject(error); else resolve(value); };
    child.once('exit', onExit); child.on('message', onMessage);
  });
}
function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.signalCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Synthetic child did not exit')), 8_000);
    child.once('exit', (_code, signal) => { clearTimeout(timer); resolve(signal); });
  });
}
async function killPaused(child, phase) {
  const paused = await reply(child, 'paused'); assert.deepEqual(paused, { type: 'paused', phase });
  const exit = exited(child); assert(child.kill('SIGKILL')); assert.equal(await exit, 'SIGKILL');
}
const feed = f => new SourceInvalidationFeed({ store: f.store, authority: f.authority });

test('SIGKILL before commit leaves no admitted lifecycle, guard, policy or fence effect', { timeout: 20_000 }, async t => {
  const { f, source, event } = setup(t), command = request(f, source), before = dump(f);
  await killPaused(launch(t, f, 'before-commit', command), 'before-commit');
  assert.deepEqual(dump(f), before); assert.equal(feed(f).head(f.context).sequence, 0);
  assert.equal(f.ingress.getReceipt(f.context, { event_id: command.event.event_id }), null);
  assert.equal(f.ingress.readEvent(f.context, { event_id: event.event_id }).event.event_id, event.event_id);
});

test('SIGKILL after commit before reply preserves atomic restriction and the exact retry receipt after reopening', { timeout: 20_000 }, async t => {
  const { f, source, event } = setup(t), command = request(f, source);
  await killPaused(launch(t, f, 'after-commit', command), 'after-commit');
  f.store.close(); const reopened = f.reopen(); reopened.context = reopened.issue({ actions }).context;
  const selected = feed(reopened).readLifecycleEvent(reopened.context,
    { invalidation_id: sourceLifecycleInvalidationId(SCOPE, command.event.event_id) });
  assert.equal(selected.status, 'applied'); assert.equal(feed(reopened).head(reopened.context).sequence, 1);
  assert.throws(() => reopened.ingress.readEvent(reopened.context, { event_id: event.event_id }), { code: 'source_access_denied' });
  const before = dump(reopened), duplicate = reopened.ingress.submitSourceLifecycle(reopened.context, command);
  assert.equal(duplicate.status, 'duplicate'); assert.deepEqual(duplicate.receipt, selected.receipt);
  assert.deepEqual(dump(reopened), before);
});

for (const identical of [true, false]) test(`independent ${identical ? 'exact retries share one receipt' : 'source-version competitors commit only one restriction'}`,
  { timeout: 20_000 }, async t => {
    const { f, source } = setup(t), commands = [request(f, source), request(f, source, identical ? 1 : 2)];
    const before = dump(f), children = commands.map((command, i) => launch(t, f, 'run', command, `race-${i}`));
    const ready = await Promise.all(children.map(child => reply(child, 'ready'))); assert(ready.every(item => item.type === 'ready'));
    const pending = children.map(child => reply(child, 'result')); children.forEach(child => child.send({ type: 'start' }));
    const results = await Promise.all(pending); await Promise.all(children.map(exited));
    if (identical) {
      assert.deepEqual(results.map(item => item.result?.status).sort(), ['accepted', 'duplicate']);
      assert.deepEqual(results[0].result.receipt, results[1].result.receipt);
    } else {
      assert.equal(results.filter(item => item.result?.status === 'accepted').length, 1);
      assert.equal(results.filter(item => item.type === 'error' && item.code === 'source_changed').length, 1);
    }
    assert.equal(feed(f).head(f.context).sequence, 1);
    assert.equal(dump(f).outbox.length, before.outbox.length + 1);
  });
