import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { checkJevSourceFence } from '../check-jev-source-fence.mjs';
import { DomainStore } from '../../../../src/index.mjs';

test('a completed judgment cannot publish using a parent revoked while its model call was outstanding', async t => {
  let views = 0, calls = 0;
  for (const method of ['readSnapshot', 'transaction']) {
    const original = DomainStore.prototype[method];
    t.mock.method(DomainStore.prototype, method, function (...args) {
      views++; try { return original.apply(this, args); } finally { views--; }
    });
  }
  const result = await checkJevSourceFence({ async evaluate(input, { signal }) {
    calls++; assert.equal(views, 0); assert(signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(input).sort(), ['event', 'question', 'stateRefs']);
    assert.deepEqual(input.stateRefs, [{ id: 'login', text: 'Login currently uses a copied long-lived API key.' }]);
    assert.deepEqual(Object.keys(input.event).sort(), ['payload', 'timestamp', 'type']);
    await setImmediate(); assert.equal(views, 0);
    return { value: { relevant: true, target_ids: ['login'] }, confidence: 0.9,
      latency_ms: 1, provider: 'synthetic', model: 'fixture', reason_code: 'synthetic' };
  } });
  assert.equal(calls, 1); assert.equal(result.matched, true);
  assert.equal(result.direct_event_still_readable, true); assert.equal(result.state_parent_denied, true);
  assert.equal(result.result_publication, 'rejected'); assert.equal(result.rejection_code, 'graph_access_denied');
  assert.equal(result.graph_unchanged, true); assert.equal(result.result_receipt_absent, true);
  assert.equal(result.retries, 0); assert.equal(result.canonical_promotion, false);
});

test('source fence smoke never retries or exposes a failed provider diagnostic', async () => {
  let calls = 0;
  await assert.rejects(checkJevSourceFence({ async evaluate() {
    calls++; throw new Error('CANARY-PROVIDER-BODY');
  } }), error => error.message === 'Synthetic source fence failed' && !String(error).includes('CANARY'));
  assert.equal(calls, 1);
});
