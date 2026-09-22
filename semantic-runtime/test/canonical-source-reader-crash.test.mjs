import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { readerFixture, makeReader, READER_ACTIONS } from './helpers/canonical-reader-fixture.mjs';
import { rows } from './helpers/graph-store-fixture.mjs';

async function crashAt(t, f, phase) {
  const command = { config: { repository_path: f.folder, execution: f.execution,
    registration_id: f.source.registration_id, selection: f.selection }, request: f.request };
  const commandPath = join(f.root, `synthetic-${phase}.json`);
  writeFileSync(commandPath, JSON.stringify(command), { mode: 0o600 });
  const child = spawn(process.execPath, [new URL('./helpers/canonical-reader-process.mjs', import.meta.url).pathname,
    phase, f.filePath, commandPath], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('Synthetic reader child timed out')), 15000);
    const onExit = () => done(new Error('Synthetic reader child exited before pause'));
    const onMessage = message => {
      if (message?.type === 'paused' && message.phase === phase) done();
      else done(new Error(`Synthetic reader child failed: ${message?.code ?? 'unexpected_reply'}`));
    };
    function done(error) { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); error ? reject(error) : resolve(); }
    child.once('exit', onExit); child.on('message', onMessage);
  });
  const stopped = new Promise(resolve => child.once('exit', (_code, signal) => resolve(signal)));
  assert(child.kill('SIGKILL')); assert.equal(await stopped, 'SIGKILL');
}
function reopen(f) {
  f.store.close(); const opened = f.reopen();
  opened.context = opened.issue({ actions: READER_ACTIONS }).context;
  Object.assign(opened, { folder: f.folder, execution: f.execution, source: f.source, selection: f.selection });
  opened.reader = makeReader(opened); return opened;
}

test('SIGKILL after partial canonical ingress preserves facts but no semantic selection; exact retry completes once', { timeout: 25000 }, async t => {
  const f = readerFixture(t), before = rows(f);
  await crashAt(t, f, 'partial-ingress');
  assert.deepEqual(rows(f), before);
  assert.equal(f.ingress.listPending(f.context, { limit: 64 }).length, 3);
  const next = reopen(f), result = next.reader.refresh(next.context, f.request);
  assert.equal(result.status, 'applied'); assert.equal(next.ingress.listPending(next.context, { limit: 64 }).length, 8);
  assert.equal(rows(next).outbox.length, before.outbox.length + 1);
  const after = rows(next), retry = next.reader.refresh(next.context, f.request);
  assert.equal(retry.status, 'duplicate'); assert.deepEqual(retry.receipt, result.receipt); assert.deepEqual(rows(next), after);
});

test('SIGKILL after canonical publication before reply retains the selection and retry without Git reads', { timeout: 25000 }, async t => {
  const f = readerFixture(t), before = rows(f);
  await crashAt(t, f, 'published');
  assert.equal(rows(f).outbox.length, before.outbox.length + 1);
  assert.equal(f.ingress.listPending(f.context, { limit: 64 }).length, 8);
  const next = reopen(f), beforeRetry = rows(next);
  renameSync(f.folder, `${f.folder}-unavailable`);
  const retry = next.reader.refresh(next.context, f.request);
  assert.equal(retry.status, 'duplicate'); assert.equal(retry.selection_status, 'current');
  assert.deepEqual(rows(next), beforeRetry); assert.equal(retry.selection.assertion.canonical_refs.length, 8);
});
