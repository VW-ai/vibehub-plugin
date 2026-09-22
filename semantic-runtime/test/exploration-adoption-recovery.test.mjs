import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fixture, adoption, ADOPTION_ACTIONS } from './helpers/adoption-fixture.mjs';
import { bind, bindRequest, mutation, executionFor, rows, git, register, resolve, rejected } from './helpers/exploration-fixture.mjs';
import { hashText } from './helpers/graph-store-fixture.mjs';

const helper = new URL('./helpers/adoption-process.mjs', import.meta.url);
function launch(t, f, mode, request, name, principal = 'owner') {
  const path = join(f.root, `${name}.json`), serialized = JSON.stringify({ config: f.config, principal, request });
  assert(!serialized.includes('credential')); writeFileSync(path, serialized, { mode: 0o600 });
  const child = spawn(process.execPath, [helper.pathname, mode, f.filePath, path], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4096); });
  child.diagnostics = () => stderr;
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return child;
}
function message(child, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`synthetic adoption child timed out: ${child.diagnostics()}`)), 12_000);
    const onMessage = value => { if (predicate(value)) finish(null, value); };
    const onExit = (code, signal) => finish(new Error(`synthetic adoption child exited ${code ?? signal}: ${child.diagnostics()}`));
    const finish = (error, value) => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); error ? reject(error) : resolve(value); };
    child.on('message', onMessage); child.once('exit', onExit);
  });
}
function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve([child.exitCode, child.signalCode]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('synthetic adoption child exit timed out')), 12_000);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve([code, signal]); });
  });
}
async function killAtPause(child, phase) {
  const reply = await message(child, value => value?.type === 'paused' || value?.type === 'error');
  assert.equal(reply.type, 'paused', JSON.stringify(reply)); assert.equal(reply.phase, phase);
  const exit = exited(child); assert(child.kill('SIGKILL')); assert.equal((await exit)[1], 'SIGKILL');
}
async function race(children) {
  const ready = await Promise.all(children.map(child => message(child, value => ['ready', 'error'].includes(value?.type))));
  assert(ready.every(value => value.type === 'ready'), JSON.stringify(ready));
  const pending = children.map(child => message(child, value => ['result', 'error'].includes(value?.type)));
  children.forEach(child => child.send({ type: 'start' }));
  const replies = await Promise.all(pending); await Promise.all(children.map(exited)); return replies;
}
const sourceValues = (snapshot, kind) => snapshot.sources.filter(row => row.kind === kind).map(row => JSON.parse(row.value));
function assertSingleCommit(f, before, result, request) {
  const after = rows(f);
  for (const kind of ['graph-receipt', 'graph-audit', 'graph-commit-receipt', 'exploration-operation-origin', 'exploration-operation']) {
    assert.equal(sourceValues(after, kind).length, sourceValues(before, kind).length + 1, `${kind} must commit exactly once`);
  }
  assert.equal(after.outbox.length, before.outbox.length + 2);
  const outbox = after.outbox.slice(before.outbox.length).map(row => JSON.parse(row.value));
  assert.deepEqual(outbox.map(value => value.kind).sort(), ['exploration_changed', 'graph_changed']);
  assert.deepEqual(outbox.find(value => value.kind === 'graph_changed').next_graph, result.receipt.next_graph);
  const origin = f.store.getSource(f.context, 'exploration-projection', result.operation_origin_ref).value;
  assert.equal(origin.operation, 'adopt'); assert.deepEqual(origin.previous_graph, request.destination.expected_graph);
  assert.deepEqual(origin.next_graph, result.receipt.next_graph); assert.equal(result.receipt.operation_origin_ref, result.operation_origin_ref);
  assert.deepEqual(f.graph.getHead(f.context, { generation_id: request.destination.expected_graph.generation_id }).graph_revision, result.receipt.next_graph);
  assert.deepEqual(f.graph.getHead(f.context, { generation_id: request.source.expected_head.generation_id }).graph_revision, request.source.expected_head);
  assert.deepEqual(f.explorations.getReceipt(f.context, { idempotency_key: request.idempotency_key }), result.receipt);
  return after;
}

test('independent SQLite adopters with the same request commit one Graph/origin/receipt/outbox set', { timeout: 30_000 }, async t => {
  const f = fixture(t), request = adoption(f, { key: 'same-request-writers' }), before = rows(f);
  const replies = await race([0, 1].map(i => launch(t, f, 'run', request, `same-request-${i}`)));
  assert(replies.every(reply => reply.type === 'result'), JSON.stringify(replies));
  const results = replies.map(reply => reply.result);
  assert.deepEqual(results.map(result => result.status).sort(), ['applied', 'duplicate']);
  assert.deepEqual(results[0].receipt, results[1].receipt); assert.deepEqual(results[0].revision, results[1].revision);
  assert.equal(results[0].operation_origin_ref, results[1].operation_origin_ref);
  const after = assertSingleCommit(f, before, results[0], request);
  assert.equal(f.explorations.adopt(f.context, request).status, 'duplicate'); assert.deepEqual(rows(f), after);
});

test('independent distinct-key adopters race one destination head with one commit and a stable no-effects refusal', { timeout: 30_000 }, async t => {
  const f = fixture(t), requests = ['first-key', 'second-key'].map(key => adoption(f, { key })), before = rows(f);
  const replies = await race(requests.map((request, i) => launch(t, f, 'run', request, `different-key-${i}`)));
  const winner = replies.findIndex(reply => reply.type === 'result' && reply.result.status === 'applied');
  assert(winner >= 0, JSON.stringify(replies)); const loser = 1 - winner;
  assert.equal(replies[loser].type, 'error', JSON.stringify(replies));
  assert.match(replies[loser].code, /^[a-z_]+$/); assert.notEqual(replies[loser].code, 'unexpected_child_failure');
  const after = assertSingleCommit(f, before, replies[winner].result, requests[winner]);
  assert.equal(f.explorations.getReceipt(f.context, { idempotency_key: requests[loser].idempotency_key }), null);
  assert(!JSON.stringify(after).includes(requests[loser].idempotency_key));
  assert.throws(() => f.explorations.adopt(f.context, requests[loser]), { code: replies[loser].code });
  assert.deepEqual(rows(f), after);
});

test('two authenticated actors in separate workspaces may concurrently use the same actor-scoped adoption key', { timeout: 30_000 }, async t => {
  const f = fixture(t), folderC = join(f.root, 'branch-c');
  git(f.folder, 'worktree', 'add', '-b', 'branch-c', folderC); f.refresh();
  const readerContext = f.issue({ principal: 'reader', actions: ADOPTION_ACTIONS }).context;
  const readerPublisher = f.graph.registerPublisherRun(readerContext, { epoch: f.epoch, run_key: 'reader-adoption-run' });
  const reader = { ...f, context: readerContext, publisher: readerPublisher };
  const c = bind(reader, { key: 'reader-workspace-c', execution: executionFor(f, folderC) });
  const key = 'shared-actor-key', requests = [adoption(f, { key }), adoption(reader, { key, b: c })];
  const before = rows(f), replies = await race(requests.map((request, i) => launch(t, f, 'run', request, `actor-${i}`, i ? 'reader' : 'owner')));
  assert(replies.every(reply => reply.type === 'result' && reply.result.status === 'applied'), JSON.stringify(replies));
  const [ownerResult, readerResult] = replies.map(reply => reply.result);
  assert.notDeepEqual(ownerResult.revision, readerResult.revision); assert.notEqual(ownerResult.operation_origin_ref, readerResult.operation_origin_ref);
  assert.equal(ownerResult.receipt.actor, 'owner'); assert.equal(readerResult.receipt.actor, 'reader');
  assert.equal(ownerResult.revision.generation_id, f.b.generation_id); assert.equal(readerResult.revision.generation_id, c.generation_id);
  const after = rows(f); assert.equal(after.outbox.length, before.outbox.length + 4);
  assert.equal(sourceValues(after, 'exploration-operation-origin').length, sourceValues(before, 'exploration-operation-origin').length + 2);
  assert.deepEqual(f.explorations.getReceipt(f.context, { idempotency_key: key }), ownerResult.receipt);
  assert.deepEqual(f.explorations.getReceipt(readerContext, { idempotency_key: key }), readerResult.receipt);
  assert.equal(f.explorations.adopt(f.context, requests[0]).status, 'duplicate');
  assert.equal(f.explorations.adopt(readerContext, requests[1]).status, 'duplicate'); assert.deepEqual(rows(f), after);
});

test('SIGKILL before adoption commit leaves no Graph/source/origin/receipt/outbox delta after reopen', { timeout: 30_000 }, async t => {
  const f = fixture(t), request = adoption(f, { key: 'adoption-precommit' }), before = rows(f);
  await killAtPause(launch(t, f, 'pause-before-commit', request, 'adoption-precommit'), 'before-commit');
  f.store.close(); const reopened = f.reopen(); assert.deepEqual(rows(reopened), before);
  assert.deepEqual(reopened.graph.getHead(reopened.context, { generation_id: f.b.generation_id }).graph_revision, request.destination.expected_graph);
  assert.equal(reopened.explorations.getReceipt(reopened.context, { idempotency_key: request.idempotency_key }), null);
  const result = reopened.explorations.adopt(reopened.context, request);
  assert.equal(result.status, 'applied'); assertSingleCommit(reopened, before, result, request);
});

test('SIGKILL after commit before reply retains the exact result through switch, ref/worktree deletion and disable', { timeout: 30_000 }, async t => {
  const f = fixture(t), request = adoption(f, { key: 'adoption-postcommit' }), before = rows(f);
  await killAtPause(launch(t, f, 'pause-after-commit', request, 'adoption-postcommit'), 'after-commit');
  const receipt = f.explorations.getReceipt(f.context, { idempotency_key: request.idempotency_key }); assert(receipt);
  const committed = f.explorations.adopt(f.context, request); assert.equal(committed.status, 'duplicate');
  assertSingleCommit(f, before, committed, request);
  git(f.otherFolder, 'switch', '-c', 'after-adoption-crash'); f.refresh();
  const replacement = bind(f, { key: 'replacement-after-crash', execution: f.executionB });
  assert.notEqual(replacement.exploration_id, f.b.exploration_id);
  git(f.folder, 'worktree', 'remove', '--force', f.otherFolder); git(f.folder, 'branch', '-D', 'branch-b');
  const activation = f.activation.get(f.context); f.activation.setEnabled(f.context, { enabled: false, expectedVersion: activation.version });
  renameSync(f.folder, `${f.folder}-removed`); f.store.close();
  const reopened = f.reopen(), after = rows(reopened), retry = reopened.explorations.adopt(reopened.context, request);
  assert.deepEqual(retry, committed); assert.deepEqual(retry.receipt, receipt);
  assert.equal(retry.revision.generation_id, f.b.generation_id);
  assert.deepEqual(reopened.explorations.getReceipt(reopened.context, { idempotency_key: request.idempotency_key }), receipt);
  assert.deepEqual(rows(reopened), after);
});

test('adoption keys share the existing actor operation namespace with bind and mutate', t => {
  const f = fixture(t), request = adoption(f, { key: 'method-namespace' }), result = f.explorations.adopt(f.context, request), before = rows(f);
  rejected(() => f.explorations.bind(f.context, bindRequest(f, { key: request.idempotency_key, execution: f.executionB })));
  rejected(() => f.explorations.mutate(f.context, mutation(f, f.b, 'namespace-collision', {
    idempotency_key: request.idempotency_key, expected_graph: result.receipt.next_graph })));
  rejected(() => f.explorations.adopt(f.context, adoption(f, { key: 'adoption-a' })));
  rejected(() => f.explorations.adopt(f.context, { ...request, publisher_ref: 'changed-publisher' }));
  assert.deepEqual(rows(f), before); assert.deepEqual(f.explorations.adopt(f.context, request).receipt, result.receipt);
});

function tombstone(f) {
  const key = 'adopted-source-tombstone', object = f.event.provenance.source_objects[0].object;
  const acl = { revision: key, allowed_principal_ids: ['owner', 'reader'] };
  const event = { schema_version: 1, kind: 'raw_event',
    event_id: f.ingress.eventIdFor(f.context, { registration_id: f.source.registration_id, idempotency_key: key }),
    partition: f.source.registration.partition, source_native_event_id: key, idempotency_key: key, source_event_type: 'tombstone',
    occurred_at: null, observed_at: '2026-09-22T15:00:00.000Z', producer: { ...f.source.registration.producer, sequence: 1 }, causal_parents: [], identity: {},
    payload: { kind: 'object_revision', object, revision_id: key, digest: hashText(key) },
    provenance: { delivery: { channel: 'system', delivery_id: key }, source_objects: [{ object, acl, sensitivity: 'normal' }] }, acl, sensitivity: 'normal' };
  f.ingress.submitSourceLifecycle(f.context, { registration_id: f.source.registration_id, epoch: f.epoch, event,
    expectedVersion: f.source.version, access_state: 'tombstoned', access: null });
}

test('revocation, tombstone and conservative Project fence withhold retained adoption results without erasing origin history', async t => {
  for (const change of ['revocation', 'tombstone', 'unrelated-fence']) await t.test(change, t => {
    const f = fixture(t), request = adoption(f), result = f.explorations.adopt(f.context, request);
    const originalOrigin = f.store.getSource(f.context, 'exploration-projection', f.original.operation_origin_ref);
    const adoptedOrigin = f.store.getSource(f.context, 'exploration-projection', result.operation_origin_ref);
    if (change === 'tombstone') tombstone(f);
    else {
      const source = change === 'revocation' ? f.source : register(f, { partition: 'unrelated-restriction' });
      f.ingress.updateSourceAccess(f.context, { registration_id: source.registration_id, expectedVersion: source.version,
        access: { ...source.registration.access, enabled: false, allowed_principal_ids: [] } });
    }
    const before = rows(f);
    rejected(() => f.explorations.adopt(f.context, request));
    rejected(() => f.explorations.getReceipt(f.context, { idempotency_key: request.idempotency_key }));
    assert.deepEqual(f.store.getSource(f.context, 'exploration-projection', f.original.operation_origin_ref), originalOrigin);
    assert.deepEqual(f.store.getSource(f.context, 'exploration-projection', result.operation_origin_ref), adoptedOrigin);
    if (change !== 'unrelated-fence') {
      assert.equal(resolve(f, f.a, f.original).local.status, 'denied'); assert.equal(resolve(f, f.b, result).local.status, 'denied');
    }
    assert.deepEqual(rows(f), before);
  });
});
