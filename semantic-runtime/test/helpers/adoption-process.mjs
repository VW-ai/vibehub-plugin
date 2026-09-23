import { readFileSync } from 'node:fs';
import { DomainStore } from '../../src/adapters/sqlite/domain-store.mjs';
import { connect } from './exploration-fixture.mjs';
import { ADOPTION_ACTIONS } from './adoption-fixture.mjs';

const [mode, filePath, commandPath] = process.argv.slice(2);
if (!['run', 'pause-before-commit', 'pause-after-commit'].includes(mode) || !filePath || !commandPath || typeof process.send !== 'function') {
  process.exitCode = 2;
} else {
  const command = JSON.parse(readFileSync(commandPath, 'utf8'));
  const f = connect(filePath, command.config), transaction = DomainStore.prototype.transaction;
  // Each process authenticates independently. The command file contains no grant or credential.
  f.context = f.issue({ principal: command.principal, actions: ADOPTION_ACTIONS }).context;
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
    try { process.send({ type: 'result', result: f.explorations.adopt(f.context, command.request) }, finish); }
    catch (error) { process.send({ type: 'error', code: error?.code ?? 'unexpected_child_failure' }, finish); }
  };
  if (mode === 'run') {
    process.send({ type: 'ready' });
    process.once('message', message => {
      if (message?.type === 'start') execute();
      else process.send({ type: 'error', code: 'invalid_start_message' }, finish);
    });
  } else execute();
}
