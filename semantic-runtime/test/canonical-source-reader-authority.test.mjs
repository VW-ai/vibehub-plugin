import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { SourceInvalidationFeed } from '../src/local/source-invalidation.mjs';
import { fixture, register, capture, initialize, assertion, mutation, rows, hashText, SCOPE, ACTIONS, git } from './helpers/graph-store-fixture.mjs';

const actions = [...ACTIONS, 'source:invalidate', 'source:invalidation:capture', 'source:invalidation:read'];
function setup(t) {
  const f = fixture(t); f.context = f.issue({ actions }).context;
  return f;
}
const denied = (operation, code) => assert.throws(operation, e => e.code === code);
const head = f => f.graph.getHead(f.context, { generation_id: 'generation-1' }).graph_revision;
const fence = f => new SourceInvalidationFeed({ store: f.store, authority: f.authority }).head(f.context).sequence;

test('optional source fence pins exact mutations and receipts without changing legacy requests', t => {
  const f = setup(t), source = register(f), event = capture(f, source), genesis = initialize(f);
  const legacy = mutation(f, genesis.receipt.next_graph, assertion(f, event));
  const first = f.graph.mutate(f.context, legacy);
  const request = mutation(f, first.receipt.next_graph, assertion(f, event, 'pinned', { entity_id: 'pinned' }), { expected_source_fence: 0 });
  const applied = f.graph.mutate(f.context, request);
  assert.equal(applied.status, 'applied');
  assert.equal(f.graph.mutate(f.context, request).status, 'duplicate');
  assert.deepEqual(f.graph.getReceipt(f.context, { generation_id: 'generation-1', idempotency_key: request.idempotency_key }), applied.receipt);
  const unrelated = register(f, { partition: 'unrelated' });
  f.ingress.updateSourceAccess(f.context, { registration_id: unrelated.registration_id, expectedVersion: unrelated.version,
    access: { ...unrelated.registration.access, enabled: false } });
  assert.equal(fence(f), 1);
  const before = rows(f);
  denied(() => f.graph.mutate(f.context, request), 'stale_invalidation_fence');
  denied(() => f.graph.getReceipt(f.context, { generation_id: 'generation-1', idempotency_key: request.idempotency_key }), 'stale_invalidation_fence');
  denied(() => f.graph.mutate(f.context, { ...request, expected_source_fence: 1 }), 'graph_idempotency_conflict');
  assert.equal(f.graph.mutate(f.context, legacy).status, 'duplicate');
  assert.deepEqual(rows(f), before);
  for (const invalid of [null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
    denied(() => f.graph.mutate(f.context, { ...request, expected_source_fence: invalid }), 'invalid_graph_input');
  }
});

test('a second process moving the fence after initial inspection prevents every Graph write', t => {
  const f = setup(t), source = register(f), event = capture(f, source), genesis = initialize(f);
  const unrelated = register(f, { partition: 'cross-process-fence' });
  const request = mutation(f, genesis.receipt.next_graph, assertion(f, event), { expected_source_fence: 0 });
  const commandPath = join(f.root, 'move-fence.json');
  writeFileSync(commandPath, JSON.stringify({ registration_id: unrelated.registration_id, expectedVersion: unrelated.version,
    access: { ...unrelated.registration.access, enabled: false } }));
  const before = rows(f), original = f.store.readSnapshot.bind(f.store);
  let moved = false;
  f.store.readSnapshot = (context, operation) => {
    const result = original(context, operation);
    if (!moved) {
      moved = true;
      const child = spawnSync(process.execPath, [new URL('./helpers/canonical-fence-process.mjs', import.meta.url).pathname,
        f.filePath, commandPath], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
      assert.equal(child.status, 0, 'Synthetic fence process failed');
    }
    return result;
  };
  denied(() => f.graph.mutate(f.context, request), 'stale_invalidation_fence');
  assert(moved); assert.equal(fence(f), 1); assert.deepEqual(rows(f), before);
  assert.deepEqual(head(f), genesis.receipt.next_graph);
});

test('a pinned exact retry remains readable when capture is disabled but rejects a later fence change', t => {
  const f = setup(t), source = register(f), event = capture(f, source), genesis = initialize(f);
  const request = mutation(f, genesis.receipt.next_graph, assertion(f, event), { expected_source_fence: 0 });
  const applied = f.graph.mutate(f.context, request), activation = f.activation.get(f.context);
  f.activation.setEnabled(f.context, { enabled: false, expectedVersion: activation.version });
  assert.deepEqual(f.graph.mutate(f.context, request).receipt, applied.receipt);
  f.ingress.updateSourceAccess(f.context, { registration_id: source.registration_id, expectedVersion: source.version,
    access: source.registration.access });
  denied(() => f.graph.mutate(f.context, request), 'stale_invalidation_fence');
});

test('disabled-admission reconciliation cannot return a committed receipt under a stale fence', t => {
  const f = setup(t), source = register(f), event = capture(f, source), genesis = initialize(f);
  const unrelated = register(f, { partition: 'reconcile-fence' });
  const request = mutation(f, genesis.receipt.next_graph, assertion(f, event), { expected_source_fence: 0 });
  const snapshot = f.store.readSnapshot.bind(f.store); let injected = false, committed;
  f.store.readSnapshot = (context, operation) => {
    const result = snapshot(context, operation);
    if (!injected) {
      injected = true;
      committed = f.graph.mutate(f.context, request);
      const activation = f.activation.get(f.context);
      f.activation.setEnabled(f.context, { enabled: false, expectedVersion: activation.version });
      f.ingress.updateSourceAccess(f.context, { registration_id: unrelated.registration_id, expectedVersion: unrelated.version,
        access: { ...unrelated.registration.access, enabled: false } });
    }
    return result;
  };
  denied(() => f.graph.mutate(f.context, request), 'stale_invalidation_fence');
  assert.equal(committed.status, 'applied'); assert.deepEqual(head(f), committed.receipt.next_graph);
  assert.equal(rows(f).outbox.length, 2, 'only genesis and the concurrent commit exist');
});

function gitSource(f) {
  const checkout = f.registry.get(f.context).value.checkouts[0], worktree = checkout.worktrees[0];
  const execution = { repository_id: checkout.repository_id, checkout_id: checkout.checkout_id, worktree_id: worktree.worktree_id };
  return { source: register(f, { execution }), object: { kind: 'git_commit', tenant_id: SCOPE.tenant_id,
    repository_id: checkout.repository_id, object_format: 'sha1', oid: git(f.folder, 'rev-parse', 'HEAD') } };
}
function raw(f, source, object, sequence, type) {
  const key = `git-${sequence}`, acl = { revision: key, allowed_principal_ids: ['owner', 'reader'] };
  return { schema_version: 1, kind: 'raw_event',
    event_id: f.ingress.eventIdFor(f.context, { registration_id: source.registration_id, idempotency_key: key }),
    partition: source.registration.partition, source_native_event_id: key, idempotency_key: key,
    source_event_type: type, occurred_at: null, observed_at: '2026-09-22T15:00:00.000Z',
    producer: { ...source.registration.producer, sequence }, causal_parents: [], identity: source.registration.execution,
    payload: { kind: 'git_revision', object, path: null, digest: hashText(key) },
    provenance: { delivery: { channel: 'local_git', delivery_id: key }, source_objects: [{ object, acl, sensitivity: 'normal' }] },
    acl, sensitivity: 'normal' };
}

test('prospective Git reads allow unknown objects without writes, while old guards and metadata ACL remain enforced', t => {
  const f = setup(t), { source, object } = gitSource(f);
  const inspect = value => f.ingress.assertGitReadAccess(f.context, { registration_id: source.registration_id, object: value });
  const db = new DatabaseSync(f.filePath, { readOnly: true }); t.after(() => db.close());
  const count = () => db.prepare("SELECT COUNT(*) AS n FROM records WHERE namespace='source-invalidation'").get().n;
  const before = count(); assert.equal(inspect(object).source_fence, 0); assert.equal(count(), before);
  const event = raw(f, source, object, 0, 'note');
  f.ingress.submit(f.context, { registration_id: source.registration_id, epoch: f.epoch, event });
  f.ingress.submitSourceLifecycle(f.context, { registration_id: source.registration_id, epoch: f.epoch,
    expectedVersion: source.version, event: raw(f, source, object, 1, 'tombstone'), access_state: 'tombstoned', access: null });
  denied(() => inspect(object), 'source_access_denied');
  denied(() => f.ingress.getSource(f.context, { registration_id: source.registration_id }), 'source_access_denied');
  const registration = f.ingress.getRegistration(f.context, { registration_id: source.registration_id });
  assert.deepEqual(Object.keys(registration).sort(), ['registration', 'registration_id', 'version']);
  writeFileSync(join(f.folder, 'fixture.txt'), 'New authorized synthetic commit.\n');
  git(f.folder, 'add', 'fixture.txt'); git(f.folder, 'commit', '-m', 'synthetic next');
  const next = { ...object, oid: git(f.folder, 'rev-parse', 'HEAD') }, later = count();
  assert.equal(inspect(next).source_fence, 1); assert.equal(count(), later);
  denied(() => inspect({ ...next, repository_id: 'other-repository' }), 'source_mismatch');
  denied(() => inspect({ ...next, tenant_id: 'other-tenant' }), 'source_mismatch');
  const other = f.issue({ principal: 'reader', actions }).context;
  denied(() => f.ingress.assertGitReadAccess(other, { registration_id: source.registration_id, object: next }), 'ingress_unauthorized');
  f.ingress.updateSourceAccess(f.context, { registration_id: source.registration_id, expectedVersion: source.version,
    access: { ...source.registration.access, allowed_principal_ids: [] } });
  denied(() => inspect(next), 'source_access_denied');
  denied(() => f.ingress.getRegistration(f.context, { registration_id: source.registration_id }), 'source_access_denied');
});

test('prospective read never recreates a lost summary for a known Git object', t => {
  const f = setup(t), { source, object } = gitSource(f), event = raw(f, source, object, 0, 'note');
  f.ingress.submit(f.context, { registration_id: source.registration_id, epoch: f.epoch, event });
  const db = new DatabaseSync(f.filePath);
  try { db.prepare("DELETE FROM records WHERE namespace='source-invalidation' AND key LIKE 'summary-%'").run(); }
  finally { db.close(); }
  denied(() => f.ingress.assertGitReadAccess(f.context, { registration_id: source.registration_id, object }), 'invalidation_corrupt');
});
