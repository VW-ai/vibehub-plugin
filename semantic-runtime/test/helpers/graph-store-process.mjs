import { readFileSync } from 'node:fs';
import { DomainStore } from '../../src/local/domain-store.mjs';
import { connect } from './graph-store-fixture.mjs';

const [mode, filePath, requestPath] = process.argv.slice(2);
if (!['run', 'pause-before-commit', 'pause-after-commit'].includes(mode) || !filePath || !requestPath || typeof process.send !== 'function') {
  process.exitCode = 2;
} else {
  let request;
  try {
    request = JSON.parse(readFileSync(requestPath, 'utf8'));
  } catch {
    process.send({ type: 'error', code: 'invalid_synthetic_command' });
    process.exitCode = 2;
  }

  if (request) {
    const fixture = connect(filePath);
    const originalTransaction = DomainStore.prototype.transaction;
    let injected = false;
    const pause = phase => {
      if (injected) return;
      injected = true;
      process.send({ type: 'paused', phase });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    };

    if (mode === 'pause-before-commit') {
      DomainStore.prototype.transaction = function transactionWithPrecommitPause(context, operation) {
        return originalTransaction.call(this, context, transaction => {
          const result = operation(transaction);
          pause('before-commit');
          return result;
        });
      };
    } else if (mode === 'pause-after-commit') {
      DomainStore.prototype.transaction = function transactionWithPostcommitPause(context, operation) {
        const result = originalTransaction.call(this, context, operation);
        pause('after-commit');
        return result;
      };
    }

    const finish = () => {
      fixture.store.close();
      fixture.authority.close();
      process.disconnect();
    };
    const execute = () => {
      try {
        const result = fixture.graph.mutate(fixture.context, request);
        process.send({ type: 'result', result }, finish);
      } catch (error) {
        process.send({ type: 'error', code: error?.code ?? 'unexpected_child_failure' }, finish);
      }
    };

    if (mode === 'run') {
      process.send({ type: 'ready' });
      process.once('message', message => {
        if (message?.type !== 'start') {
          process.send({ type: 'error', code: 'invalid_start_message' }, finish);
          return;
        }
        execute();
      });
    } else {
      execute();
    }
  }
}
