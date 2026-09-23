import test from 'node:test';
import assert from 'node:assert/strict';
import { matchContextTextV1 } from '../src/domain/query/query-text.mjs';
import { rankContextWindowV1 } from '../src/domain/query/query-ranking.mjs';
import { queryFixture, publish } from './helpers/query-fixture.mjs';

test('positional full-text search distinguishes terms, phrases, field boundaries and Unicode normalization', () => {
  const documents = [
    { key: 'a', fields: ['PostgreSQL durable store', 'pool transactions'] },
    { key: 'b', fields: ['durable PostgreSQL store', 'pool transactions'] },
    { key: 'c', fields: ['项目知识图谱', '同步上下文'] },
    { key: 'd', fields: ['ends with durable', 'PostgreSQL begins here'] },
  ];
  const terms = matchContextTextV1({ documents, text: { value: 'ＤＵＲＡＢＬＥ postgresql', match: 'all_terms' } });
  assert.deepEqual(terms.matched.filter(item => item.hit).map(item => item.key), ['a', 'b', 'd']);
  const phrase = matchContextTextV1({ documents, text: { value: 'PostgreSQL durable', match: 'phrase' } });
  assert.deepEqual(phrase.matched.filter(item => item.hit).map(item => item.key), ['a']);
  const boundary = matchContextTextV1({ documents, text: { value: 'durable PostgreSQL', match: 'phrase' } });
  assert.deepEqual(boundary.matched.filter(item => item.hit).map(item => item.key), ['b']);
  const cjk = matchContextTextV1({ documents, text: { value: '项目知识图谱', match: 'phrase' } });
  assert.deepEqual(cjk.matched.filter(item => item.hit).map(item => item.key), ['c']);
});

test('full-text capacity degrades every document honestly while unknown faults still throw', t => {
  const capacity = matchContextTextV1({ documents: [{ key: 'large', fields: ['x'.repeat(262145)] }],
    text: { value: 'x', match: 'all_terms' } });
  assert.deepEqual(capacity.degradation, { code: 'text_unavailable', reason: 'index_capacity' });
  assert.deepEqual(capacity.matched.map(item => [item.evaluated, item.hit]), [[false, null]]);
  t.mock.method(String.prototype, 'normalize', () => { throw new Error('unknown-index-fault'); });
  assert.throws(() => matchContextTextV1({ documents: [{ key: 'a', fields: ['text'] }],
    text: { value: 'text', match: 'all_terms' } }), /unknown-index-fault/);
});

test('rank trace contains no Context text and replays the same order and digest', async t => {
  const f = await queryFixture(t), second = publish(f, 'rank-second', { typed: { summary: 'Private replay sentinel', detail: 'Must stay out.' } });
  const prepared = f.inputs().prepare(f.context, f.queryRequest({ exact: [{ exploration_id: f.a.exploration_id, address: second.revision }] }));
  const text = matchContextTextV1({ documents: prepared.candidates.map(c => ({ key: c.key, fields: [c.item.meaning.summary, c.item.meaning.detail] })),
    text: { value: 'private sentinel', match: 'all_terms' } });
  const matches = new Map(text.matched.map(item => [item.key, item]));
  const scopes = new Map(prepared.selection.scopes.map(scope => [scope.exploration_id, scope]));
  const ranked = rankContextWindowV1({ candidates: prepared.candidates.map(candidate => ({ ...candidate,
    text: matches.get(candidate.key), group: null, selection: scopes.get(candidate.exploration_id) })),
    shared: { ...prepared.shared, text_matches: prepared.shared.documents.map(document => ({ key: document.key,
      evaluated: true, hit: false, matched_distinct_terms: 0, text_digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' })) },
    seen_refs: [], judge: null });
  assert.equal(JSON.stringify(ranked.trace).includes('Private replay sentinel'), false);
  const replay = rankContextWindowV1(ranked.trace.replay_input);
  assert.equal(replay.rank_digest, ranked.rank_digest); assert.deepEqual(replay.units, ranked.units);
});

test('ranker keeps a complete conflict group atomic and excludes it only when every variant mismatches scope', async t => {
  const f = await queryFixture(t), first = f.targetResult;
  publish(f, 'conflict-left', { base: first.revision });
  const right = publish(f, 'conflict-right', { base: first.revision });
  const prepared = f.inputs().prepare(f.context, f.queryRequest({ exact: [{ exploration_id: f.a.exploration_id, address: right.revision }] }));
  const group = prepared.conflict_groups[0]; assert(group); assert.equal(group.member_keys.length, 2);
  const scopes = new Map(prepared.selection.scopes.map(scope => [scope.exploration_id, scope]));
  const candidates = prepared.candidates.map(candidate => ({ ...candidate,
    text: { key: candidate.key, evaluated: true, hit: false, matched_distinct_terms: 0,
      text_digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' },
    group: candidate.conflict_group ? group : null, selection: scopes.get(candidate.exploration_id) }));
  const shared = { ...prepared.shared, text_matches: prepared.shared.documents.map(document => ({ key: document.key,
    evaluated: true, hit: false, matched_distinct_terms: 0, text_digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' })) };
  const ranked = rankContextWindowV1({ candidates, shared, seen_refs: [], judge: null });
  assert.deepEqual(Object.keys(ranked.trace.replay_input).sort(), ['candidates', 'judge', 'seen_refs', 'shared']);
  assert.equal(ranked.units.find(unit => unit.key === group.key).member_keys.length, 2);
  const mismatched = candidates.map(candidate => candidate.group ? { ...candidate,
    scope_match: { ...candidate.scope_match, status: 'mismatch', dimensions: candidate.scope_match.dimensions.map((dimension, index) =>
      index === 0 ? { ...dimension, status: 'mismatch', filter_refs: [{ synthetic: 'filter' }] } : dimension) } } : candidate);
  assert.equal(rankContextWindowV1({ candidates: mismatched, shared, seen_refs: [], judge: null }).units.some(unit => unit.key === group.key), false);
});
