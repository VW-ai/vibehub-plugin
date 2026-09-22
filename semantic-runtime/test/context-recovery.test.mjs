import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fixture, contextRequest, publish, adoption, rows } from './helpers/context-fixture.mjs';

// Reuse the exploration process harness and actual SQLite admission boundary.
function launch(t, f, mode, method, request, name) {
  const path = join(f.root, `${name}.json`);
  writeFileSync(path, JSON.stringify({ config: f.config, surface: 'context', method, request }), { mode: 0o600 });
  const child = spawn(process.execPath, [new URL('./helpers/exploration-process.mjs', import.meta.url).pathname,
    mode, f.filePath, path], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }); return child;
}
function message(child, wanted) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('Context fixture child timeout')), 12000);
    const receive = value => { if (wanted.includes(value?.type)) done(null, value); };
    const exited = () => done(new Error('Context fixture child exited before response'));
    function done(error, value) { clearTimeout(timer); child.off('message', receive); child.off('exit', exited); error ? reject(error) : resolve(value); }
    child.on('message', receive); child.once('exit', exited);
  });
}
function exit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('exit', resolve));
}
function single(before, after) {
  for (const kind of ['graph-receipt', 'graph-audit', 'graph-commit-receipt', 'exploration-operation-origin', 'exploration-operation']) {
    assert.equal(after.sources.filter(row => row.kind === kind).length, before.sources.filter(row => row.kind === kind).length + 1, kind);
  }
  assert.equal(after.outbox.length, before.outbox.length + 2);
}

test('two typed Context writers with one exact request retain one atomic publication', { timeout: 30000 }, async t => {
  const f = fixture(t), request = contextRequest(f, f.a, 'concurrent-context'), before = rows(f);
  const children = [0, 1].map(n => launch(t, f, 'run', 'mutate', request, `writer-${n}`));
  const ready = await Promise.all(children.map(child => message(child, ['ready', 'error'])));
  assert(ready.every(value => value.type === 'ready'));
  const pending = children.map(child => message(child, ['result', 'error'])); children.forEach(child => child.send({ type: 'start' }));
  const replies = await Promise.all(pending); await Promise.all(children.map(exit));
  assert(replies.every(value => value.type === 'result'), JSON.stringify(replies));
  assert.deepEqual(replies.map(value => value.result.status).sort(), ['applied', 'duplicate']);
  assert.deepEqual(replies[0].result, { ...replies[1].result, status: replies[0].result.status });
  single(before, rows(f));
});

for (const method of ['mutate', 'adopt']) for (const phase of ['before', 'after']) {
  test(`SIGKILL ${phase} commit preserves typed ${method} atomicity and exact retry`, { timeout: 30000 }, async t => {
    const f = fixture(t), source = method === 'adopt' ? publish(f, 'context-source') : null;
    const request = method === 'adopt' ? adoption(f, { source, key: `context-crash-${phase}` }) : contextRequest(f, f.a, `context-crash-${phase}`);
    const before = rows(f), child = launch(t, f, `pause-${phase}-commit`, method, request, 'crash');
    const paused = await message(child, ['paused', 'error']); assert.equal(paused.type, 'paused', JSON.stringify(paused));
    assert.equal(paused.phase, `${phase}-commit`); const stopped = exit(child); child.kill('SIGKILL'); await stopped;
    f.store.close(); const resumed = f.reopen(), afterCrash = rows(resumed);
    if (phase === 'before') assert.deepEqual(afterCrash, before); else single(before, afterCrash);
    const result = resumed.contexts[method](resumed.context, request);
    assert.equal(result.status, phase === 'before' ? 'applied' : 'duplicate');
    single(before, rows(resumed)); const committed = rows(resumed);
    assert.deepEqual(resumed.contexts[method](resumed.context, request), { ...result, status: 'duplicate' });
    const { shared, ...receipt } = resumed.contexts.getReceipt(resumed.context, { idempotency_key: request.idempotency_key });
    assert.deepEqual(receipt, result.receipt); assert(shared); assert.deepEqual(rows(resumed), committed);
  });
}
