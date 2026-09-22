import { readFileSync } from 'node:fs';
import { DomainStore } from '../../src/local/domain-store.mjs';
import { connect } from './exploration-fixture.mjs';

const [mode, filePath, commandPath] = process.argv.slice(2);
if (!['run', 'pause-before-commit', 'pause-after-commit'].includes(mode) || !filePath || !commandPath || typeof process.send !== 'function') {
  process.exitCode = 2;
} else {
  const command = JSON.parse(readFileSync(commandPath, 'utf8'));
  const f = connect(filePath, command.config), transaction = DomainStore.prototype.transaction;
  let paused = false;
  const pause = phase => {
    if (paused) return;
    paused = true; process.send({ type: 'paused', phase });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  };
  if (mode === 'pause-before-commit') {
    DomainStore.prototype.transaction = function (context, callback) {
      return transaction.call(this, context, tx => { const result = callback(tx); pause('before-commit'); return result; });
    };
  } else if (mode === 'pause-after-commit') {
    DomainStore.prototype.transaction = function (context, callback) {
      const result = transaction.call(this, context, callback); pause('after-commit'); return result;
    };
  }
  const finish = () => { f.store.close(); f.authority.close(); process.disconnect(); };
  const execute = () => {
    try {
      if (!['bind', 'mutate', 'setProjectSelection'].includes(command.method)) throw new Error('invalid fixture method');
      const result = f.explorations[command.method](f.context, command.request);
      process.send({ type: 'result', result }, finish);
    } catch (error) { process.send({ type: 'error', code: error?.code ?? 'unexpected_child_failure' }, finish); }
  };
  if (mode === 'run') {
    process.send({ type: 'ready' });
    process.once('message', message => {
      if (message?.type === 'start') execute();
      else process.send({ type: 'error', code: 'invalid_start_message' }, finish);
    });
  } else execute();
}
