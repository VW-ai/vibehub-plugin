import test from 'node:test';
import assert from 'node:assert/strict';
import { contextJudgeFixture, adoption, rows, judgeTransport } from '../support/context-judge-fixture.mjs';

test('exact immutable publication verification admits 32 records and refuses a 33rd without a send', async t => {
  const f = await contextJudgeFixture(t, { timeout_ms: 15000 }), calls = judgeTransport(t);
  let source = f.targetResult, from = f.a, destination = f.b;
  const append = ordinal => {
    source = f.explorations.adopt(f.context, adoption(f, { source, a: from, b: destination, key: `bounded-publication-${ordinal}` }));
    assert.equal(source.status, 'applied');
    [from, destination] = [destination, from]; f.binding = from; f.target = source.revision;
  };
  for (let ordinal = 1; ordinal <= 31; ordinal++) append(ordinal);
  let before = rows(f);
  const accepted = await f.runtime.evaluateContext(f.context, f.request({ invocation_id: '32-publications' }));
  assert.equal(accepted.status, 'decision', accepted.reason_code); assert.equal(calls.length, 1);
  assert.deepEqual(rows(f), before);
  append(32); before = rows(f);
  const denied = await f.runtime.evaluateContext(f.context, f.request({ invocation_id: '33-publications' }));
  assert.equal(denied.status, 'refused'); assert.equal(denied.reason_code, 'context_capacity');
  assert.equal(denied.decision, null); assert.equal(calls.length, 1); assert.equal(f.secrets.calls, 1);
  assert.deepEqual(rows(f), before);
});
