import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fixture, register, capture, initialize, assertion, mutation, rows } from '../support/graph-store-fixture.mjs';

const helper = new URL('../support/graph-store-process.mjs', import.meta.url);
const TIMEOUT_MS = 8_000;

function commandFile(fixtureState, name, request) {
  const path = join(fixtureState.root, `${name}.json`);
  const serialized = JSON.stringify(request);
  assert(!serialized.includes('credential'), 'synthetic child input must not contain credentials');
  writeFileSync(path, serialized, { mode: 0o600 });
  return path;
}

function launch(t, fixtureState, mode, requestPath) {
  const child = spawn(process.execPath, [helper.pathname, mode, fixtureState.filePath, requestPath], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4_096); });
  child.syntheticStderr = () => stderr;
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return child;
}

function message(child, predicate, label, timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`${label}: timed out${child.syntheticStderr?.() ? `: ${child.syntheticStderr()}` : ''}`)), timeout);
    const onMessage = value => { if (predicate(value)) finish(null, value); };
    const onExit = (code, signal) => finish(new Error(`${label}: child exited ${code ?? signal}${child.syntheticStderr?.() ? `: ${child.syntheticStderr()}` : ''}`));
    const finish = (error, value) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      if (error) reject(error); else resolve(value);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

function exit(child, label, timeout = TIMEOUT_MS) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve([child.exitCode, child.signalCode]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`${label}: exit timed out`)), timeout);
    const onExit = (code, signal) => finish(null, [code, signal]);
    const finish = (error, value) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      if (error) reject(error); else resolve(value);
    };
    child.once('exit', onExit);
  });
}

function killAtPause(child, phase) {
  return message(child, value => value?.type === 'paused' && value.phase === phase, phase).then(async () => {
    const exited = exit(child, phase);
    assert.equal(child.kill('SIGKILL'), true);
    const [, signal] = await exited;
    assert.equal(signal, 'SIGKILL');
  });
}

function setup(t) {
  const f = fixture(t);
  const source = register(f);
  const event = capture(f, source);
  const genesis = initialize(f);
  return { f, event, graph: genesis.receipt.next_graph };
}

test('independent processes racing one head commit exactly one command and leave the loser effect-free', { timeout: 20_000 }, async t => {
  const { f, event, graph } = setup(t);
  const requests = [
    mutation(f, graph, assertion(f, event, 'race-a', { entity_id: 'race-a' })),
    mutation(f, graph, assertion(f, event, 'race-b', { entity_id: 'race-b' })),
  ];
  const before = rows(f);
  const children = requests.map((request, index) => launch(t, f, 'run', commandFile(f, `race-${index}`, request)));
  await Promise.all(children.map((child, index) => message(child, value => value?.type === 'ready', `race-${index}-ready`)));
  const results = children.map((child, index) => message(child, value => value?.type === 'result' || value?.type === 'error', `race-${index}-result`));
  children.forEach(child => child.send({ type: 'start' }));
  const replies = await Promise.all(results);
  assert(replies.every(reply => reply.type === 'result'), JSON.stringify(replies));
  assert.deepEqual(replies.map(reply => reply.result.status).sort(), ['applied', 'graph_revision_mismatch']);
  await Promise.all(children.map((child, index) => exit(child, `race-${index}-exit`)));

  const winnerIndex = replies.findIndex(reply => reply.result.status === 'applied');
  const loserIndex = 1 - winnerIndex;
  const winner = replies[winnerIndex].result;
  const loser = replies[loserIndex].result;
  assert.deepEqual(loser.proposal, requests[loserIndex]);
  assert.deepEqual(loser.effects, []);
  assert.deepEqual(f.graph.getHead(f.context, { generation_id: 'generation-1' }).graph_revision, winner.receipt.next_graph);
  assert.deepEqual(f.graph.getReceipt(f.context, { generation_id: 'generation-1', idempotency_key: requests[winnerIndex].idempotency_key }), winner.receipt);
  assert.equal(f.graph.getReceipt(f.context, { generation_id: 'generation-1', idempotency_key: requests[loserIndex].idempotency_key }), null);
  const after = rows(f);
  assert.equal(after.outbox.length, before.outbox.length + 1);
  assert(!JSON.stringify(after).includes(requests[loserIndex].idempotency_key), 'rejected command must leave no Graph row');
});

test('independent exact retries produce one effect and one durable receipt', { timeout: 20_000 }, async t => {
  const { f, event, graph } = setup(t);
  const request = mutation(f, graph, assertion(f, event, 'duplicate-race', { entity_id: 'duplicate-race' }));
  const before = rows(f);
  const path = commandFile(f, 'duplicate-race', request);
  const children = [launch(t, f, 'run', path), launch(t, f, 'run', path)];
  await Promise.all(children.map((child, index) => message(child, value => value?.type === 'ready', `duplicate-${index}-ready`)));
  const results = children.map((child, index) => message(child, value => value?.type === 'result' || value?.type === 'error', `duplicate-${index}-result`));
  children.forEach(child => child.send({ type: 'start' }));
  const replies = await Promise.all(results);
  assert(replies.every(reply => reply.type === 'result'), JSON.stringify(replies));
  assert.deepEqual(replies.map(reply => reply.result.status).sort(), ['applied', 'duplicate']);
  assert.deepEqual(replies[0].result.receipt, replies[1].result.receipt);
  await Promise.all(children.map((child, index) => exit(child, `duplicate-${index}-exit`)));

  const after = rows(f);
  assert.equal(after.outbox.length, before.outbox.length + 1);
  assert.deepEqual(f.graph.getHead(f.context, { generation_id: 'generation-1' }).graph_revision, replies[0].result.receipt.next_graph);
  assert.deepEqual(f.graph.getReceipt(f.context, { generation_id: 'generation-1', idempotency_key: request.idempotency_key }), replies[0].result.receipt);
});

test('SIGKILL after the Graph callback but before SQLite commit rolls back every Graph effect', { timeout: 20_000 }, async t => {
  const { f, event, graph } = setup(t);
  const request = mutation(f, graph, assertion(f, event, 'precommit-crash', { entity_id: 'precommit-crash' }));
  const before = rows(f);
  const child = launch(t, f, 'pause-before-commit', commandFile(f, 'precommit-crash', request));
  await killAtPause(child, 'before-commit');

  assert.deepEqual(rows(f), before);
  assert.deepEqual(f.graph.getHead(f.context, { generation_id: 'generation-1' }).graph_revision, graph);
  assert.equal(f.graph.getReceipt(f.context, { generation_id: 'generation-1', idempotency_key: request.idempotency_key }), null);
});

test('SIGKILL after commit but before facade return preserves the exact receipt for retry', { timeout: 20_000 }, async t => {
  const { f: original, event, graph } = setup(t);
  const request = mutation(original, graph, assertion(original, event, 'postcommit-crash', { entity_id: 'postcommit-crash' }));
  const before = rows(original);
  const child = launch(t, original, 'pause-after-commit', commandFile(original, 'postcommit-crash', request));
  await killAtPause(child, 'after-commit');

  original.store.close();
  const f = original.reopen();
  const receipt = f.graph.getReceipt(f.context, { generation_id: 'generation-1', idempotency_key: request.idempotency_key });
  assert(receipt);
  assert.deepEqual(f.graph.getHead(f.context, { generation_id: 'generation-1' }).graph_revision, receipt.next_graph);
  const retry = f.graph.mutate(f.context, request);
  assert.equal(retry.status, 'duplicate');
  assert.deepEqual(retry.receipt, receipt);
  const after = rows(f);
  assert.equal(after.outbox.length, before.outbox.length + 1);
  assert.equal(JSON.stringify(after).split(request.idempotency_key).length > 1, true);
});
