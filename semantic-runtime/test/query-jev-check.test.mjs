import test from 'node:test';
import assert from 'node:assert/strict';
import { checkQueryJev, QUERY_JEV_CASES } from '../scripts/check-jev-query.mjs';
import { judgeResponse } from './helpers/judge-runtime-fixture.mjs';

for (const mode of ['matched', 'mismatched']) test(`two-call Query JEV checker reports ${mode} honestly`, async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body), entry = QUERY_JEV_CASES[calls++];
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); assert.equal(body.state.event.text, entry.text);
    assert.equal(JSON.stringify(body).includes('synthetic-query-key'), false);
    const relevant = mode === 'mismatched' && calls === 2 ? true : entry.expected;
    return judgeResponse('typesafe', body, { probability: relevant ? 0.95 : 0.05 });
  });
  const report = await checkQueryJev('synthetic-query-key');
  assert.equal(calls, 2); assert.equal(report.transport_calls, 2); assert.equal(report.labelled_cases, 2);
  assert.equal(report.matched, mode === 'matched' ? 2 : 1); assert.equal(report.passed, mode === 'matched');
  assert.deepEqual(report.results.map(result => result.judge_contribution), mode === 'matched' ? [30, -30] : [30, 30]);
  assert.equal(report.pagination_provider_sends, 0); assert.equal(report.global_recall, 'unknown');
  assert.equal(report.canonical_promotion, false); assert.equal(report.query_effects, false);
  assert.equal(JSON.stringify(report).includes('synthetic-query-key'), false);
});
