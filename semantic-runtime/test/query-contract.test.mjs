import test from 'node:test';
import assert from 'node:assert/strict';
import { queryFixture } from './helpers/query-fixture.mjs';
import { queryRequest } from '../src/application/query/query-contract.mjs';

test('Query wire rejects executable properties without running them and refuses caller authority overrides', async t => {
  const f = await queryFixture(t), request = f.queryRequest(); let invoked = false;
  const getter = { ...request };
  Object.defineProperty(getter, 'request_id', { enumerable: true, get() { invoked = true; return 'unsafe'; } });
  assert.throws(() => queryRequest(getter), { code: 'query_invalid_request' }); assert.equal(invoked, false);
  for (const extra of [{ tenant_id: 'other' }, { candidates: [] }, { scores: [] }, { include_notices: true }]) {
    assert.throws(() => queryRequest({ ...request, ...extra }), { code: 'query_invalid_request' });
  }
  assert.equal(Object.isFrozen(queryRequest(request).own), true);
});

test('Query selectors cannot alias another generation or silently replace a snapshot', async t => {
  const f = await queryFixture(t), request = f.queryRequest();
  const other = structuredClone(f.target); other.generation_id = f.b.generation_id;
  assert.throws(() => queryRequest({ ...request, exact: [{ exploration_id: request.own.exploration_id, address: other }] }), { code: 'query_invalid_request' });
  assert.throws(() => queryRequest({ ...request, related: [request.own] }), { code: 'query_invalid_request' });
  assert.throws(() => queryRequest({ ...request, own: { ...request.own, at: 'latest' } }), { code: 'query_invalid_request' });
});

test('request text and result budgets use bounded UTF-8 and token counts', async t => {
  const f = await queryFixture(t), request = f.queryRequest();
  assert.throws(() => queryRequest({ ...request, text: { value: '语'.repeat(1366), match: 'phrase' } }), { code: 'query_invalid_request' });
  assert.throws(() => queryRequest({ ...request, text: { value: Array.from({ length: 33 }, (_, n) => `t${n}`).join(' '), match: 'all_terms' } }), { code: 'query_invalid_request' });
  assert.throws(() => queryRequest({ ...request, budget: { max_results: 17, token_budget: 65536 } }), { code: 'query_invalid_request' });
  assert.equal(queryRequest({ ...request, text: { value: '语'.repeat(1365), match: 'phrase' } }).text.value.length, 1365);
});
