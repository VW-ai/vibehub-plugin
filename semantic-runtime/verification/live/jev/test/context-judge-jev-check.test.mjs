import test from 'node:test';
import assert from 'node:assert/strict';
import { checkContextJev, CONTEXT_JEV_CASES } from '../check-jev-context.mjs';
import { judgeResponse, judgeJSON } from '../../../../test/support/judge-runtime-fixture.mjs';

for (const mode of ['matched', 'mismatched', 'incomplete-fourth']) test(`four-call Context JEV checker reports ${mode} honestly with actual-send revocation`, async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body), entry = CONTEXT_JEV_CASES[calls++];
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); assert.equal(body.state.event.text, entry.text);
    assert(!JSON.stringify(body).includes('synthetic-live-key'));
    if (mode === 'incomplete-fourth' && calls === 4) return judgeJSON({ error: 'Synthetic unavailable' }, 503);
    const positive = mode === 'mismatched' && calls === 2 ? true : entry.expected ?? true;
    return judgeResponse('typesafe', body, { probability: positive ? 0.95 : 0.05 });
  });
  const report = await checkContextJev('synthetic-live-key');
  assert.equal(calls, 4); assert.equal(report.transport_calls, 4); assert.equal(report.labelled_cases, 3);
  assert.equal(report.matched, mode === 'mismatched' ? 2 : 3);
  assert.equal(report.passed, mode === 'matched');
  assert.equal(report.results[3].fetch_boundary_entered, true);
  assert.equal(report.results[3].provider_completed, mode !== 'incomplete-fourth');
  assert.equal(report.results[3].completed_response_discarded, mode !== 'incomplete-fourth');
  assert.equal(report.results[3].no_cached_success, true); assert(!Object.hasOwn(report.results[3], 'expected_relevant'));
  assert.equal(report.structural_canaries_excluded, true); assert.equal(report.source_graph_unchanged_by_adoption, true);
  assert.equal(report.a_superseded_b_current, true);
  assert.equal(report.canonical_promotion, false); assert.equal(report.ingress_acknowledged, false);
  assert(!JSON.stringify(report).includes('synthetic-live-key')); assert(!JSON.stringify(report).includes('/private/'));
});
