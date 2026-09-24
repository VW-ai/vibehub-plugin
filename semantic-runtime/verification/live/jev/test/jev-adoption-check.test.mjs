import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAdoptionJev } from '../check-jev-adoption.mjs';
import { cases } from '../check-jev-synthetic.mjs';
import { judgeResponse } from '../../../../test/helpers/judge-runtime-fixture.mjs';

test('adoption smoke sends only fixed synthetic text and exact A/B targets through actual Judge service', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++; assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    const body = JSON.parse(options.body), row = cases.find(entry => entry[2] === body.state.event.text);
    assert(row); assert.equal(body.state.candidates.length, 1);
    assert(!JSON.stringify(body).includes('synthetic-local-key'));
    return judgeResponse('typesafe', body, { probability: row[4] ? 0.95 : 0.05 });
  });
  const report = await checkAdoptionJev('synthetic-local-key');
  assert.equal(calls, 4); assert.equal(report.matched, 4); assert.equal(report.adoption_model_calls, 0);
  assert(report.before_adoption_foreign_target_refused); assert(report.source_revocation_refused_before_send);
  assert.equal(report.canonical_promotion, false); assert(!JSON.stringify(report).includes('synthetic-local-key'));
});
