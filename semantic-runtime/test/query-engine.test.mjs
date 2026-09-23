import test from 'node:test';
import assert from 'node:assert/strict';
import { queryFixture, QUERY_ACTIONS, publish, rows, judgeTransport, judgeResponse } from './helpers/query-fixture.mjs';
import { LocalQueryEngine } from '../src/application/query/query-engine.mjs';
import { rankContextWindowV1 } from '../src/domain/query/query-ranking.mjs';

const query = (f, extra = {}, engine = f.engine) => engine.query(f.context, f.queryRequest(extra));
const scores = result => result.items.map(item => [item.key, item.rank.score]);

test('actual local Context query indexes text, retains contextual fallback and replays without credentials or writes', async t => {
  const f = await queryFixture(t), calls = judgeTransport(t);
  publish(f, 'unrelated', { typed: { summary: 'Decorative purple header', detail: 'Use a larger logo.' } });
  const before = rows(f), result = await query(f, { text: { value: 'PostgreSQL durable', match: 'all_terms' } });
  assert.equal(result.items.length, 2); assert.equal(result.items[0].ref.entity_id, f.target.entity_id);
  assert.equal(result.coverage.kind, 'selected_window'); assert.equal(result.coverage.global_recall, 'unknown');
  assert.equal(result.coverage.embeddings, 'not_configured'); assert.equal(result.coverage.text.documents, 2);
  assert.equal(rankContextWindowV1(result.rank_trace.replay_input).rank_digest, result.rank_trace.rank_digest);
  assert.equal(calls.length, 0); assert.equal(f.secrets.calls, 0); assert.deepEqual(rows(f), before);
  const denied = f.issue({ actions: QUERY_ACTIONS.filter(action => action !== 'query:read') }).context;
  await assert.rejects(f.engine.query(denied, f.queryRequest()), error => /unauthorized/.test(error.code));
});

test('one ranked window paginates atomically, keeps order and expires with credential replacement or restart', async t => {
  const f = await queryFixture(t), calls = judgeTransport(t);
  publish(f, 'second'); publish(f, 'third');
  const request = f.queryRequest({ budget: { max_results: 1, token_budget: 262144 } });
  const first = await f.engine.query(f.context, request), second = await f.engine.next(f.context, { cursor: first.cursor });
  const third = await f.engine.next(f.context, { cursor: second.cursor });
  assert.equal(new Set([first, second, third].map(r => r.items[0].key)).size, 3); assert.equal(third.cursor, null);
  assert.equal(first.rank_trace.rank_digest, third.rank_trace.rank_digest); assert.equal(calls.length, 0);
  const renewed = f.issue({ actions: QUERY_ACTIONS }).context;
  await assert.rejects(f.engine.next(renewed, { cursor: first.cursor }), { code: 'query_cursor_expired' });
  const other = f.issue({ principal: 'reader', actions: QUERY_ACTIONS }).context;
  await assert.rejects(f.engine.next(other, { cursor: first.cursor }), { code: 'query_cursor_expired' });
  await assert.rejects(f.makeQueryEngine().next(f.context, { cursor: first.cursor }), { code: 'query_cursor_expired' });
  assert.deepEqual((await f.engine.next(f.context, { cursor: first.cursor })).items, second.items);
});

test('serialized UTF-8 budget retains exact pointers and refuses insufficient mandatory metadata', async t => {
  const f = await queryFixture(t);
  publish(f, 'multibyte', { typed: { detail: '保留来源'.repeat(1800) } });
  const full = await query(f), size = Buffer.byteLength(JSON.stringify(full));
  const budget = size - 8000;
  const partial = await query(f, { budget: { max_results: 16, token_budget: budget } });
  assert(Buffer.byteLength(JSON.stringify(partial)) <= budget);
  const omitted = partial.items.find(item => item.text_omitted);
  assert(omitted); assert.equal(omitted.item, null); assert(omitted.pointer.sources.events.length);
  assert(omitted.pointer.publication.operation_origin_ref); assert(omitted.pointer.role);
  await assert.rejects(query(f, { budget: { max_results: 1, token_budget: 1 } }), { code: 'query_budget_too_small' });
});

test('empty minimum watermarks preserve unknown selected coverage', async t => {
  const f = await queryFixture(t), baseline = await query(f);
  const vector = baseline.selection.scopes[0].watermarks;
  assert.equal(vector.status, 'unknown'); assert.equal(vector.watermarks.length, 0);
  await assert.rejects(query(f, { freshness: { minimum_watermarks: [{ exploration_id: f.binding.exploration_id, vector }],
    max_commit_lag: null, allow_unknown_coverage: false } }), { code: 'query_freshness_unknown' });
});

test('a returned cursor has a retrievable atomic conflict page and sixteen variants fit the maximum budget', async t => {
  const f = await queryFixture(t), exact = publish(f, 'exact-first'), root = publish(f, 'wide-conflict');
  let exactVariant;
  for (let n = 0; n < 16; n++) {
    const variant = publish(f, `wide-${n}`, { base: root.revision, entity_id: root.revision.entity_id });
    if (n === 0) exactVariant = variant;
  }
  const selection = { exact: [{ exploration_id: f.binding.exploration_id, address: exact.revision },
    { exploration_id: f.binding.exploration_id, address: exactVariant.revision }],
    budget: { max_results: 1, token_budget: 262144 } };
  const result = await query(f, selection);
  assert(result.cursor);
  const continued = await f.engine.next(f.context, { cursor: result.cursor });
  const pages = [result, continued], conflict = pages.find(page => page.items[0].kind === 'conflict');
  assert(conflict); assert.equal(conflict.items[0].members.length, 16);
  assert(pages.some(page => page.items[0].kind === 'context' && page.items[0].ref.entity_id === exact.revision.entity_id));
  const traceScores = new Map(conflict.rank_trace.variants.map(variant => [variant.key, variant.score]));
  for (const member of conflict.items[0].members) assert.equal(member.rank.score, traceScores.get(member.key));
  assert.equal(conflict.items[0].rank.score, Math.max(...conflict.items[0].members.map(member => member.rank.score)));
  assert(new Set(conflict.items[0].members.map(member => member.rank.score)).size > 1);
});

test('seventeenth completed window evicts the first without rerunning a model', async t => {
  const f = await queryFixture(t), calls = judgeTransport(t); publish(f, 'second');
  const first = await query(f, { request_id: 'query-window-0', budget: { max_results: 1, token_budget: 262144 } });
  for (let n = 1; n < 17; n++) await query(f, { request_id: `query-window-${n}` });
  await assert.rejects(f.engine.next(f.context, { cursor: first.cursor }), { code: 'query_cursor_expired' }); assert.equal(calls.length, 0);
});

for (const positive of [true, false]) test(`actual Context Judge ${positive ? 'positive' : 'negative'} contributes signed rank and pagination makes no extra send`, async t => {
  const f = await queryFixture(t), calls = judgeTransport(t, ({ provider, body }) => judgeResponse(provider, body, { probability: positive ? 0.95 : 0.05 }));
  publish(f, 'second'); const engine = f.makeQueryEngine(f.runtime), before = rows(f);
  const baseline = await query(f), result = await query(f, { judge: f.queryJudge() }, engine);
  const previous = new Map(scores(baseline));
  for (const [key, score] of scores(result)) assert.equal(score - previous.get(key), positive ? 30 : -30);
  assert.equal(calls.length, 1); assert.equal(f.secrets.calls, 1);
  assert.equal(rankContextWindowV1(result.rank_trace.replay_input).rank_digest, result.rank_trace.rank_digest);
  assert(!JSON.stringify(result.rank_trace.replay_input).includes('durable primary store'));
  const paged = await query(f, { request_id: 'query-paged-judge', judge: f.queryJudge(), budget: { max_results: 1, token_budget: 262144 } }, engine);
  await engine.next(f.context, { cursor: paged.cursor }); assert.equal(calls.length, 2); assert.deepEqual(rows(f), before);
});

test('missing provider credential degrades to a fresh authorized local ranking', async t => {
  const f = await queryFixture(t), calls = judgeTransport(t), baseline = await query(f);
  f.secrets.values.clear(); const result = await query(f, { judge: f.queryJudge() }, f.makeQueryEngine(f.runtime));
  assert.deepEqual(scores(result), scores(baseline)); assert(result.degradation.some(item => item.code === 'judge_unavailable'));
  assert.equal(calls.length, 0);
});

test('a locally impossible response budget makes zero optional provider sends', async t => {
  const f = await queryFixture(t), calls = judgeTransport(t);
  await assert.rejects(query(f, { budget: { max_results: 1, token_budget: 1 }, judge: f.queryJudge() },
    f.makeQueryEngine(f.runtime)), { code: 'query_budget_too_small' });
  assert.equal(calls.length, 0); assert.equal(f.secrets.calls, 0);
});

test('real Judge from another store or changed canonical configuration cannot authorize Query ranking', async t => {
  const f = await queryFixture(t), other = await queryFixture(t), calls = judgeTransport(t);
  const wrongStore = new LocalQueryEngine({ store: f.store, authority: f.authority, canonical_reader: f.config, judge_runtime: other.runtime });
  await assert.rejects(query(f, { judge: f.queryJudge() }, wrongStore), { code: 'query_judge_binding_mismatch' });
  const config = structuredClone(f.config); config.selection.selection_id = 'different-query-selection';
  const wrongConfig = new LocalQueryEngine({ store: f.store, authority: f.authority, canonical_reader: config, judge_runtime: f.runtime });
  await assert.rejects(query(f, { judge: f.queryJudge() }, wrongConfig), { code: 'query_judge_binding_mismatch' }); assert.equal(calls.length, 0);
});

test('a caller replacement evaluateContext method cannot masquerade as the fixed Judge capability', async t => {
  const f = await queryFixture(t), calls = judgeTransport(t);
  f.runtime.evaluateContext = () => { throw new Error('replacement must never run'); };
  const result = await query(f, { judge: f.queryJudge() }, f.makeQueryEngine(f.runtime));
  assert.equal(calls.length, 1); assert.equal(result.coverage.judge[0].status, 'evaluated');
});

for (const change of ['source', 'head', 'grant']) test(`Query discards completed model result after ${change} changes`, async t => {
  const f = await queryFixture(t), engine = f.makeQueryEngine(f.runtime);
  const calls = judgeTransport(t, ({ provider, body }) => {
    if (change === 'source') f.ingress.updateSourceAccess(f.context, { registration_id: f.supportSource.registration_id,
      expectedVersion: f.supportSource.version, access: { ...f.supportSource.registration.access, allowed_principal_ids: [] } });
    if (change === 'head') publish(f, 'changed-head');
    if (change === 'grant') f.authority.revoke(f.issued.credential_id);
    return judgeResponse(provider, body);
  });
  await assert.rejects(query(f, { judge: f.queryJudge() }, engine), error => typeof error.code === 'string'); assert.equal(calls.length, 1);
});

for (const change of ['source', 'head']) test(`continuation refuses changed ${change} and cannot expose a cached prefix`, async t => {
  const f = await queryFixture(t); publish(f, 'second');
  const first = await query(f, { budget: { max_results: 1, token_budget: 262144 } });
  if (change === 'source') f.ingress.updateSourceAccess(f.context, { registration_id: f.supportSource.registration_id,
    expectedVersion: f.supportSource.version, access: { ...f.supportSource.registration.access, allowed_principal_ids: [] } });
  else publish(f, 'changed-head');
  await assert.rejects(f.engine.next(f.context, { cursor: first.cursor }), error => typeof error.code === 'string');
  await assert.rejects(f.engine.next(f.context, { cursor: first.cursor }), { code: 'query_cursor_expired' });
});

test('caller cancellation aborts Query rather than returning a provider fallback', async t => {
  const f = await queryFixture(t), controller = new AbortController();
  const calls = judgeTransport(t, ({ provider, body }) => { controller.abort(); return judgeResponse(provider, body); });
  await assert.rejects(f.makeQueryEngine(f.runtime).query(f.context, f.queryRequest({ judge: f.queryJudge() }), { signal: controller.signal }), { code: 'query_cancelled' });
  assert.equal(calls.length, 1);
  await assert.rejects(f.engine.query(f.context, f.queryRequest(), { signal: controller.signal }), { code: 'query_cancelled' });
});
