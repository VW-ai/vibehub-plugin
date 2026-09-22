import { readFileSync } from 'node:fs';
import { DomainStore } from '../../src/local/domain-store.mjs';
import { connect, ACTIONS } from './graph-store-fixture.mjs';

const [mode, filePath, requestPath] = process.argv.slice(2);
if (!['run', 'before-commit', 'after-commit'].includes(mode) || !filePath || !requestPath || !process.send) {
  process.exitCode = 2;
} else {
  const request = JSON.parse(readFileSync(requestPath, 'utf8')), f = connect(filePath);
  const context = f.issue({ actions: [...ACTIONS, 'source:invalidation:capture'] }).context;
  const transaction = DomainStore.prototype.transaction;
  const pause = phase => {
    process.send({ type: 'paused', phase });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  };
  if (mode === 'before-commit') DomainStore.prototype.transaction = function (ctx, operation) {
    return transaction.call(this, ctx, tx => { const result = operation(tx); pause(mode); return result; });
  };
  if (mode === 'after-commit') DomainStore.prototype.transaction = function (ctx, operation) {
    const result = transaction.call(this, ctx, operation); pause(mode); return result;
  };
  const finish = () => { f.store.close(); f.authority.close(); process.disconnect(); };
  const run = () => {
    try { process.send({ type: 'result', result: f.ingress.submitSourceLifecycle(context, request) }, finish); }
    catch (error) { process.send({ type: 'error', code: error?.code ?? 'synthetic_child_failure' }, finish); }
  };
  if (mode === 'run') {
    process.send({ type: 'ready' }); process.once('message', message => {
      if (message?.type === 'start') run(); else process.send({ type: 'error', code: 'invalid_start' }, finish);
    });
  } else run();
}
