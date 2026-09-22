import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSyntheticJev, cases, edgeCases } from '../scripts/check-jev-synthetic.mjs';

test('synthetic live check keeps labels local and records semantic misses separately from transport failure', async () => {
  let calls = 0;
  const result = await checkSyntheticJev({ async evaluate(input, { signal }) {
    assert.equal(Object.hasOwn(input, 'expected'), false);
    assert.equal(Object.hasOwn(input.event, 'label'), false);
    assert.ok(signal instanceof AbortSignal);
    const index = calls++;
    if (index === 0) throw new Error('canary-provider-key');
    const relevant = index === 1 ? true : cases[index][4];
    return { value: { relevant, target_ids: relevant ? input.stateRefs.map(x => x.id) : [] },
      confidence: 0.9, latency_ms: 1, provider: 'synthetic', model: 'fixture', reason_code: 'synthetic' };
  } });
  assert.equal(calls, 8); assert.equal(result.completed, 7); assert.equal(result.matched, 6);
  assert.equal(result.rows[2].successful_attempt_ms, 1);
  assert.equal(result.rows[0].status, 'failed'); assert.equal(result.rows[1].matched, false);
  assert.equal(JSON.stringify(result).includes('canary-provider-key'), false);
});

test('edge check measures exact target association, not just a positive answer', async () => {
  let index = 0;
  const result = await checkSyntheticJev({ async evaluate(input) {
    const entry = edgeCases[index++];
    return { value: { relevant: entry[4], target_ids: index === 3 ? ['storage'] : entry[5] ?? [] },
      confidence: 0.9, latency_ms: 1, provider: 'synthetic', model: 'fixture', reason_code: 'synthetic' };
  } }, { suite: 'edge' });
  assert.equal(result.completed, 8); assert.equal(result.matched, 7);
  assert.equal(result.rows[2].matched, false);
  await assert.rejects(checkSyntheticJev({}, { suite: 'unknown' }), /Unknown/);
});
