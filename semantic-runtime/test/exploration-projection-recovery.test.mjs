import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fixture, bind, bindRequest, mutation, rows, git } from './helpers/exploration-fixture.mjs';

const helper = new URL('./helpers/exploration-process.mjs', import.meta.url);
function launch(t, f, mode, method, request, name) {
  const path = join(f.root, `${name}.json`), serialized = JSON.stringify({ config: f.config, method, request });
  assert(!serialized.includes('credential')); writeFileSync(path, serialized, { mode: 0o600 });
  const child = spawn(process.execPath, [helper.pathname, mode, f.filePath, path], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4096); });
  child.diagnostics = () => stderr;
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return child;
}
function message(child, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`synthetic child timed out: ${child.diagnostics()}`)), 12_000);
    const onMessage = value => { if (predicate(value)) finish(null, value); };
    const onExit = (code, signal) => finish(new Error(`synthetic child exited ${code ?? signal}: ${child.diagnostics()}`));
    const finish = (error, value) => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); error ? reject(error) : resolve(value); };
    child.on('message', onMessage); child.once('exit', onExit);
  });
}
function exit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve([child.exitCode, child.signalCode]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('synthetic child exit timed out')), 12_000);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve([code, signal]); });
  });
}
async function killAtPause(child, phase) {
  const reply = await message(child, value => value?.type === 'paused' || value?.type === 'error');
  assert.equal(reply.type, 'paused', JSON.stringify(reply)); assert.equal(reply.phase, phase);
  const exited = exit(child); assert(child.kill('SIGKILL')); assert.equal((await exited)[1], 'SIGKILL');
}
async function race(children) {
  await Promise.all(children.map(child => message(child, value => value?.type === 'ready')));
  const pending = children.map(child => message(child, value => ['result', 'error'].includes(value?.type)));
  children.forEach(child => child.send({ type: 'start' }));
  const replies = await Promise.all(pending); await Promise.all(children.map(exit));
  assert(replies.every(reply => reply.type === 'result'), JSON.stringify(replies));
  return replies.map(reply => reply.result);
}

test('two actual child writers race an exploration head; only one Graph/origin/receipt/outbox set commits', { timeout: 30_000 }, async t => {
  const f = fixture(t), a = bind(f), requests = ['writer-a', 'writer-b'].map(name => mutation(f, a, name));
  const before = rows(f);
  const replies = await race(requests.map((request, i) => launch(t, f, 'run', 'mutate', request, `race-${i}`)));
  assert.deepEqual(replies.map(reply => reply.status).sort(), ['applied', 'graph_revision_mismatch']);
  const winner = replies.findIndex(reply => reply.status === 'applied'), loser = 1 - winner;
  assert.deepEqual(replies[loser].proposal, requests[loser]); assert.deepEqual(replies[loser].effects, []);
  assert.deepEqual(f.graph.getHead(f.context, { generation_id: a.generation_id }).graph_revision, replies[winner].receipt.next_graph);
  assert.equal(f.explorations.getReceipt(f.context, { idempotency_key: requests[loser].idempotency_key }), null);
  const after = rows(f); assert(after.outbox.length > before.outbox.length);
  assert(!JSON.stringify(after).includes(requests[loser].idempotency_key));
});

test('two actual child writers executing the same command retain one operation origin and identical receipt', { timeout: 30_000 }, async t => {
  const f = fixture(t), a = bind(f), command = mutation(f, a, 'duplicate-writers');
  const replies = await race([0, 1].map(i => launch(t, f, 'run', 'mutate', command, `duplicate-${i}`)));
  assert.deepEqual(replies.map(reply => reply.status).sort(), ['applied', 'duplicate']);
  assert.deepEqual(replies[0].receipt, replies[1].receipt); assert.deepEqual(replies[0].operation_origin_ref, replies[1].operation_origin_ref);
  assert.deepEqual(f.explorations.getReceipt(f.context, { idempotency_key: command.idempotency_key }), replies[0].receipt);
});

test('SIGKILL before bind transaction commits leaves no partial generation, binding, origin, receipt or outbox', { timeout: 30_000 }, async t => {
  const f = fixture(t), request = bindRequest(f), before = rows(f);
  await killAtPause(launch(t, f, 'pause-before-commit', 'bind', request, 'bind-precommit'), 'before-commit');
  assert.deepEqual(rows(f), before);
  assert.equal(f.explorations.getBinding(f.context, { execution: f.execution }).status, 'unmapped');
  assert.equal(f.explorations.getReceipt(f.context, { idempotency_key: request.idempotency_key }), null);
});

test('SIGKILL before mutation commit rolls back Graph and immutable publishing origin together', { timeout: 30_000 }, async t => {
  const f = fixture(t), a = bind(f), command = mutation(f, a, 'mutation-precommit'), before = rows(f);
  await killAtPause(launch(t, f, 'pause-before-commit', 'mutate', command, 'mutation-precommit'), 'before-commit');
  assert.deepEqual(rows(f), before);
  assert.deepEqual(f.graph.getHead(f.context, { generation_id: a.generation_id }).graph_revision, a.graph_revision);
  assert.equal(f.explorations.getReceipt(f.context, { idempotency_key: command.idempotency_key }), null);
});

test('SIGKILL after commit and workspace switch/removal reconciles the original A result before inspecting Git', { timeout: 30_000 }, async t => {
  const f = fixture(t), a = bind(f), command = mutation(f, a, 'committed-lost-response');
  await killAtPause(launch(t, f, 'pause-after-commit', 'mutate', command, 'mutation-postcommit'), 'after-commit');
  const receipt = f.explorations.getReceipt(f.context, { idempotency_key: command.idempotency_key }); assert(receipt);
  git(f.folder, 'switch', '-c', 'workspace-b'); f.refresh(); const b = bind(f, { key: 'bind-after-crash-b' });
  assert.notEqual(b.exploration_id, a.exploration_id); renameSync(f.folder, `${f.folder}-unavailable`);
  f.store.close(); const resumed = f.reopen(), before = rows(resumed);
  const retry = resumed.explorations.mutate(resumed.context, command);
  assert.equal(retry.status, 'duplicate'); assert.deepEqual(retry.receipt, receipt);
  assert.equal(retry.receipt.next_graph.generation_id, a.generation_id);
  assert.deepEqual(rows(resumed), before);
});
