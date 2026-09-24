import test from 'node:test';
import assert from 'node:assert/strict';
import { checkJudgeJev } from '../check-jev-judge.mjs';
import { cases } from '../check-jev-synthetic.mjs';
import { judgeResponse } from '../../../../test/helpers/judge-runtime-fixture.mjs';

test('synthetic Judge service check uses all four families, isolated views, cache and actual-send revocation', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++; assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    const body = JSON.parse(options.body), selected = cases.find(entry => entry[2] === body.state.event.text);
    assert(selected); assert.equal(body.state.candidates.length, selected[3].length);
    assert(!JSON.stringify(body).includes('synthetic-local-key'));
    assert(!Object.hasOwn(body, 'labels')); assert(!Object.hasOwn(body.state, 'provenance'));
    return judgeResponse('typesafe', body, { probability: selected[4] ? 0.95 : 0.05 });
  });
  const report = await checkJudgeJev('synthetic-local-key');
  assert.equal(report.matched, 8); assert.equal(report.transport_calls, 9); assert.equal(calls, 9);
  assert.equal(new Set(report.results.map(row => row.family)).size, 4);
  assert.equal(report.isolated_explorations, 2); assert.equal(report.completed_cache_hits, 8);
  assert.equal(report.explicit_candidate_publications, 4);
  assert.equal(report.inflight_revocation.provider_completed, true);
  assert.equal(report.inflight_revocation.result_status, 'refused');
  assert.equal(report.inflight_revocation.graph_unchanged, true);
  assert.equal(report.canonical_promotion, false); assert.equal(report.ingress_acknowledged, false);
  assert(!JSON.stringify(report).includes('synthetic-local-key'));
  assert(!JSON.stringify(report).includes('/private/'));
});

test('synthetic check records low confidence without claiming success or publishing that result', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body), selected = cases.find(entry => entry[2] === body.state.event.text);
    return judgeResponse('typesafe', body, { probability: selected[0] === 'durable-yes' ? 0.6 : selected[4] ? 0.95 : 0.05 });
  });
  const report = await checkJudgeJev('synthetic-local-key');
  assert.equal(report.matched, 7); assert.equal(report.completed_cache_hits, 7);
  assert.equal(report.explicit_candidate_publications, 3);
  assert.equal(report.results[0].status, 'deferred'); assert.equal(report.results[0].reason_code, 'low_confidence');
});
