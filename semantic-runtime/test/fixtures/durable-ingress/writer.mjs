// Test-only process. All inputs and persisted rows are synthetic and local.
import { connect, effect } from './scenario.mjs';
process.send({ phase: 'ready' });
process.once('message', ({ filePath, mode, request }) => {
  const f = connect(filePath);
  const pause = phase => { process.send({ phase }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
  try {
    let result;
    if (mode === 'submit-before-commit') {
      const transaction = f.store.transaction.bind(f.store);
      f.store.transaction = (context, callback) => transaction(context, tx => { const value = callback(tx); pause('prepared'); return value; });
      result = f.ingress.submit(f.context, request);
    } else if (mode === 'submit-lost-response') {
      f.ingress.submit(f.context, request); pause('committed');
    } else if (mode === 'handoff-before-commit') {
      result = f.ingress.handoff(f.context, { event_id: request.event.event_id }, (tx, input) => { effect(tx, input); pause('prepared'); });
    } else if (mode === 'handoff') {
      result = f.ingress.handoff(f.context, { event_id: request.event.event_id }, effect);
    } else if (mode === 'disable') {
      result = f.activation.setEnabled(f.context, { enabled: false, expectedVersion: 1 });
    } else result = f.ingress.submit(f.context, request);
    process.send({ phase: 'result', result });
  } catch (error) { process.send({ phase: 'result', error: { code: error.code, category: error.category } }); }
  finally { f.store.close(); process.disconnect(); }
});
