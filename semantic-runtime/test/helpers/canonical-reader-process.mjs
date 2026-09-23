import { readFileSync } from 'node:fs';
import { DurableIngress } from '../../src/local/durable-ingress.mjs';
import { LocalGraphStore } from '../../src/local/graph-store.mjs';
import { CanonicalSourceReader } from '../../src/application/sources/canonical-source-reader.mjs';
import { connect } from './graph-store-fixture.mjs';
import { READER_ACTIONS } from './canonical-reader-fixture.mjs';

const [mode, filePath, commandPath] = process.argv.slice(2);
const pause = phase => {
  process.send({ type: 'paused', phase });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
if (!['partial-ingress', 'published'].includes(mode) || typeof process.send !== 'function') process.exitCode = 2;
else {
  const command = JSON.parse(readFileSync(commandPath, 'utf8'));
  const f = connect(filePath); f.context = f.issue({ actions: READER_ACTIONS }).context;
  if (mode === 'partial-ingress') {
    const submit = DurableIngress.prototype.submit;
    let count = 0;
    DurableIngress.prototype.submit = function (...args) {
      const result = submit.apply(this, args);
      if (++count === 3) pause('partial-ingress');
      return result;
    };
  } else {
    const mutate = LocalGraphStore.prototype.mutate;
    LocalGraphStore.prototype.mutate = function (...args) {
      const result = mutate.apply(this, args);
      if (result.status === 'applied') pause('published');
      return result;
    };
  }
  try {
    const reader = new CanonicalSourceReader({ store: f.store, authority: f.authority, ...command.config });
    reader.refresh(f.context, command.request);
    process.send({ type: 'error', code: 'synthetic_pause_not_reached' });
  } catch (error) { process.send({ type: 'error', code: error?.code ?? 'synthetic_child_failure' }); }
  f.store.close(); f.authority.close(); process.disconnect();
}
