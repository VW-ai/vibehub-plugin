import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fixture, register, observation, counts, clone, digest, WORK } from '../fixtures/durable-ingress/scenario.mjs';

function child(t) {
  const processHandle = spawn(process.execPath, [new URL('../fixtures/durable-ingress/writer.mjs', import.meta.url).pathname], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exit = once(processHandle, 'exit'); let stderr = '';
  processHandle.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  t.after(() => processHandle.kill('SIGKILL'));
  const message = () => Promise.race([once(processHandle, 'message').then(([value]) => value), exit.then(([code, signal]) => { throw new Error(`fixture writer exited ${code}/${signal}: ${stderr}`); })]);
  return { processHandle, exit, ready: message(), message, start: data => processHandle.send(data),
    async kill() { processHandle.kill('SIGKILL'); await exit; } };
}
async function race(t, f, requests) {
  const children = requests.map(() => child(t)); await Promise.all(children.map(c => c.ready));
  const results = children.map(c => c.message()); children.forEach((c, i) => c.start({ filePath: f.filePath, ...requests[i] }));
  const resolved = await Promise.all(results); await Promise.all(children.map(c => c.exit)); return resolved;
}
const receipt = (f, request) => f.ingress.getReceipt(f.context, { event_id: request.event.event_id });

test('separate real SQLite writers admit a duplicate only once and return the same durable receipt', { timeout: 15000 }, async t => {
  const f = fixture(t), source = register(f), request = observation(f, source);
  const results = await race(t, f, [{ mode: 'submit', request }, { mode: 'submit', request }]);
  assert.deepEqual(results.map(r => r.result?.status ?? r.error).sort(), ['accepted', 'duplicate']);
  assert.deepEqual(results[0].result.receipt, results[1].result.receipt);
  assert.equal(f.ingress.listPending(f.context).length, 1);
  assert.equal(f.ingress.getSource(f.context, { registration_id: source.registration_id }).cursor.state.entries.length, 1);
});

test('separate writers cannot commit conflicting logical observations at one retry identity', { timeout: 15000 }, async t => {
  const f = fixture(t), source = register(f), request = observation(f, source), conflict = clone(request);
  conflict.snapshot_text = 'A different selected synthetic fact'; conflict.event.payload.digest = digest(conflict.snapshot_text);
  const results = await race(t, f, [{ mode: 'submit', request }, { mode: 'submit', request: conflict }]);
  assert.equal(results.filter(r => r.result?.status === 'accepted').length, 1);
  assert.equal(results.filter(r => r.error?.category === 'rejected').length, 1);
  assert.equal(f.ingress.listPending(f.context).length, 1);
  const expected = results[0].result ? request : conflict;
  assert.equal(f.ingress.readSnapshot(f.context, { event_id: request.event.event_id }).text, expected.snapshot_text);
});

test('SIGKILL with prepared intake leaves no event/bytes/cursor/outbox and retry can acquire the released lock', { timeout: 15000 }, async t => {
  const f = fixture(t), source = register(f), request = observation(f, source), before = counts(f);
  const initialCursor = f.ingress.getSource(f.context, { registration_id: source.registration_id }).cursor;
  const writer = child(t); await writer.ready; const prepared = writer.message(); writer.start({ filePath: f.filePath, mode: 'submit-before-commit', request });
  assert.equal((await prepared).phase, 'prepared');
  assert.equal(receipt(f, request), null); assert.deepEqual(counts(f), before);
  assert.throws(() => f.ingress.submit(f.context, request), error => error.category === 'retryable_failure' && error.code === 'store_busy');
  await writer.kill(); f.store.close(); const recovered = f.reopen();
  assert.equal(receipt(recovered, request), null); assert.deepEqual(counts(recovered), before);
  assert.deepEqual(recovered.ingress.getSource(recovered.context, { registration_id: source.registration_id }).cursor, initialCursor);
  assert.equal(recovered.ingress.submit(recovered.context, request).status, 'accepted');
});

test('a killed process after commit but before response is reconciled through original receipt on retry', { timeout: 15000 }, async t => {
  const f = fixture(t), source = register(f), request = observation(f, source), writer = child(t);
  await writer.ready; const committed = writer.message(); writer.start({ filePath: f.filePath, mode: 'submit-lost-response', request });
  assert.equal((await committed).phase, 'committed'); const original = receipt(f, request); assert(original);
  await writer.kill(); f.store.close(); const recovered = f.reopen(), before = counts(recovered);
  assert.deepEqual(recovered.ingress.submit(recovered.context, request), { status: 'duplicate', receipt: original });
  assert.deepEqual(counts(recovered), before); assert.equal(recovered.ingress.listPending(recovered.context).length, 1);
});

test('SIGKILL in handoff rolls back effect and ACK; independent restarted contenders produce one consumer effect', { timeout: 15000 }, async t => {
  const f = fixture(t), source = register(f), request = observation(f, source); f.ingress.submit(f.context, request);
  const before = counts(f), writer = child(t); await writer.ready;
  const prepared = writer.message(); writer.start({ filePath: f.filePath, mode: 'handoff-before-commit', request });
  assert.equal((await prepared).phase, 'prepared'); assert.equal(f.store.getRecord(f.context, WORK, request.event.event_id), null);
  await writer.kill(); f.store.close(); const recovered = f.reopen(); assert.deepEqual(counts(recovered), before);
  assert.equal(recovered.store.getRecord(recovered.context, WORK, request.event.event_id), null);
  const results = await race(t, recovered, [{ mode: 'handoff', request }, { mode: 'handoff', request }]);
  assert.deepEqual(results.map(r => r.result?.status ?? r.error).sort(), ['duplicate', 'handed_off']);
  assert.deepEqual(results[0].result.receipt, results[1].result.receipt);
  assert.equal(recovered.store.getRecord(recovered.context, WORK, request.event.event_id).version, 1);
  assert.equal(recovered.ingress.listPending(recovered.context).length, 0);
  assert.equal(recovered.ingress.getSource(recovered.context, { registration_id: source.registration_id }).cursor.state.completed_through, null);
});

test('real writer disable races intake and handoff with no post-disable acceptance or unfenced effect', { timeout: 20000 }, async t => {
  for (const mode of ['submit', 'handoff']) {
    const f = fixture(t), source = register(f), request = observation(f, source);
    if (mode === 'handoff') f.ingress.submit(f.context, request);
    const results = await race(t, f, [{ mode, request }, { mode: 'disable', request }]);
    assert.equal(results[1].result.state.enabled, false);
    const won = !!results[0].result;
    if (!won) assert.equal(results[0].error.category, 'rejected');
    if (mode === 'submit') assert.equal(!!receipt(f, request), won);
    else assert.equal(!!f.store.getRecord(f.context, WORK, request.event.event_id), won);
    let calls = 0;
    assert.throws(() => f.ingress.submit(f.context, request));
    // Even a pre-disable accepted event cannot begin a new effect from the retained inbox.
    if (mode === 'submit' && won || mode === 'handoff' && !won) {
      assert.throws(() => f.ingress.handoff(f.context, { event_id: request.event.event_id }, () => calls++));
      assert.equal(calls, 0);
    }
  }
});
