import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { replay } from '../src/core/replay.mjs';
import { normalizeEvent, normalizeState, judgeInputHash, visibleState } from '../src/core/contracts.mjs';
import { validatePolicy } from '../src/core/policy.mjs';
import { compareRuns } from '../src/core/evaluation.mjs';
import { HeuristicJudge } from '../src/adapters/heuristic-judge.mjs';
import { RecordedJudge } from '../src/adapters/recorded-judge.mjs';
import { SqliteCandidateStore } from '../src/adapters/sqlite-store.mjs';
import { scope, policy, event, target, decision, judge, fixture } from './helpers.mjs';

const run = (store, options = {}) => replay({ store, events: [event()], state: [target()], scope, policy, judge: judge(), ...options });

test('four independent families run; non-durable evidence survives and remains candidate-only', async t => {
  const { store } = fixture(t);
  const report = await run(store, { judge: new HeuristicJudge() });
  assert.equal(report.decisions, 4);
  const saved = store.readRun(scope, report.run_id);
  assert.equal(saved.candidates.length, 1);
  assert.equal(saved.candidates[0].family, 'acceptance_relevance');
  assert.equal(saved.candidates[0].state, 'candidate');
  assert.equal(saved.candidates[0].relations[0].type, 'EVIDENCE_FOR');
  assert.equal(saved.events[0].payload, undefined);
  assert.equal(report.productization_gate, 'not_evaluated');
  assert.equal(report.downstream_task_success, null);
  assert.equal(report.labeled_metrics, null);
});

test('deduplicates exact events and rejects conflicting IDs before writing', async t => {
  const { store } = fixture(t);
  const report = await run(store, { events: [event(), event()] });
  assert.equal(report.events, 1);
  assert.equal(report.duplicate_events, 1);
  await assert.rejects(run(store, { events: [event(), event({ payload: { text: 'changed' } })] }), /Conflicting duplicate/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM runs').get().n, 1);
});

test('same event ID may be used in another tenant without sharing candidates', async t => {
  const { store } = fixture(t);
  const first = await run(store, { judge: new HeuristicJudge() });
  const other = { ...scope, tenant_id: 'another-tenant' };
  const second = await run(store, { scope: other, events: [event(other)], judge: new HeuristicJudge() });
  assert.equal(second.candidates, 0);
  assert.throws(() => store.readRun(other, first.run_id), /not found/);
  await assert.rejects(run(store, { events: [event(other)] }), /outside/);
});

test('future and cross-project state never reach judge; raw gold fields are dropped', async t => {
  const { store } = fixture(t);
  const seen = [];
  await run(store, {
    events: [event({ gold: 'DO NOT LEAK', labels: ['future'] })],
    state: [target(), target({ id: 'future', available_at: '2026-09-20T00:00:00Z' }), target({ id: 'foreign', project_id: 'other' })],
    judge: judge(input => { seen.push(input); return decision(); }),
  });
  assert.equal(seen.length, 4);
  assert.deepEqual(seen[0].stateRefs.map(item => item.id), ['acceptance-1']);
  assert.ok(seen.every(input => !JSON.stringify(input).includes('DO NOT LEAK')));
  assert.ok(seen.every(input => !JSON.stringify(input).includes('future')));
});

test('candidate ACL carries the most restrictive source seen by the decision', async t => {
  const { store } = fixture(t);
  const report = await run(store, { judge: new HeuristicJudge(), state: [target({ acl: { visibility: 'project', sensitivity: 'RESTRICTED' } })] });
  assert.equal(store.readRun(scope, report.run_id).candidates[0].acl.sensitivity, 'RESTRICTED');
});

test('judge failures, malformed confidence, and foreign target IDs fail to DEFER', async t => {
  const { store } = fixture(t);
  for (const implementation of [
    () => { throw new Error('secret provider error must not enter the audit'); },
    () => decision({ confidence: 1.1 }),
    () => decision({ value: { relevant: true, target_ids: ['foreign'] } }),
    () => decision({ value: { relevant: false, target_ids: [] }, reason_code: 'unbounded prose with spaces' }),
  ]) {
    const report = await run(store, { judge: judge(implementation) });
    assert.equal(report.actions.DEFER, 4);
    assert.equal(report.candidates, 0);
    assert.equal(JSON.stringify(store.readRun(scope, report.run_id)).includes('secret provider'), false);
  }
});

test('timeout aborts cooperative judge, audits failure, and completes replay', async t => {
  const { store } = fixture(t);
  const fastPolicy = structuredClone(policy);
  for (const node of Object.values(fastPolicy.nodes)) if (node.type === 'judge') node.timeout_ms = 10;
  let aborted = 0;
  const slow = judge((_, { signal }) => new Promise(() => signal.addEventListener('abort', () => aborted++)));
  const report = await run(store, { policy: fastPolicy, judge: slow });
  assert.equal(aborted, 4);
  assert.equal(report.actions.DEFER, 4);
  assert.ok(store.readRun(scope, report.run_id).decisions.every(item => item.error_code === 'judge_timeout'));
});

test('uncertain high-impact decisions request escalation without launching workers', async t => {
  const { store } = fixture(t);
  const report = await run(store, { events: [event({ impact: 'high' })], judge: judge(() => decision({ confidence: 0.6 })) });
  assert.equal(report.actions.ESCALATE, 4);
  assert.equal(report.candidates, 0);
});

test('recorded judge binds all input content and supports policy-threshold comparisons', async t => {
  const { store } = fixture(t);
  const normalized = normalizeEvent(event());
  const state = normalizeState([target()]);
  const records = Object.values(policy.nodes).filter(node => node.type === 'judge').map(node => ({
    input_hash: judgeInputHash({ event: normalized, stateRefs: visibleState(normalized, node.family, state), question: { family: node.family, text: node.question } }),
    result: decision({ confidence: 0.85 }),
  }));
  const recording = { schema_version: 1, records };
  const first = await run(store, { judge: new RecordedJudge(recording) });
  const stricter = structuredClone(policy);
  stricter.version = '2';
  for (const node of Object.values(stricter.nodes)) if (node.type === 'judge') node.confidence_threshold = 0.9;
  const second = await run(store, { policy: stricter, judge: new RecordedJudge(recording) });
  const comparison = compareRuns(store.readRun(scope, first.run_id), store.readRun(scope, second.run_id));
  assert.equal(comparison.changed, 4);
  assert.equal(second.actions.DEFER, 4);
  const third = await run(store, { judge: new RecordedJudge(recording), state: [target({ text: 'different state' })] });
  assert.equal(third.judge_errors, 1);
  assert.throws(() => compareRuns(store.readRun(scope, first.run_id), store.readRun(scope, third.run_id)), /state_hash/);
});

test('event/audit/candidate write is atomic on constraint failure', async t => {
  const { store } = fixture(t);
  store.startRun({ ...scope, run_id: 'rollback', status: 'running' });
  assert.throws(() => store.appendEvent(scope, 'rollback', normalizeEvent(event()), {
    decisions: [], candidates: [{ candidate_id: 'c', event_id: 'event-1', decision_id: 'missing', state: 'candidate', relations: [] }],
  }), /FOREIGN KEY/);
  for (const table of ['events', 'run_events', 'decisions', 'candidates']) {
    assert.equal(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  }
});

test('changed event identity across runs fails visibly, preserving earlier audit', async t => {
  const { store } = fixture(t);
  const first = await run(store);
  await assert.rejects(run(store, { events: [event({ payload: { text: 'replacement' } })] }), /identity changed/);
  const statuses = store.db.prepare('SELECT manifest FROM runs').all().map(row => JSON.parse(row.manifest).status);
  assert.deepEqual(statuses.sort(), ['complete', 'failed']);
  assert.equal(store.readRun(scope, first.run_id).decisions.length, 4);
});

test('completed runs are immutable and persist across opening the database', async t => {
  const { store, database } = fixture(t);
  const report = await run(store);
  assert.throws(() => store.appendEvent(scope, report.run_id, normalizeEvent(event()), { decisions: [], candidates: [] }), /not writable/);
  assert.throws(() => store.finishRun(scope, report.run_id, 'failed', {}), /already finished/);
  const reopened = new SqliteCandidateStore(database, { readOnly: true });
  try { assert.equal(reopened.readRun(scope, report.run_id).manifest.status, 'complete'); }
  finally { reopened.close(); }
});

test('labels remain evaluator-only; abstention has explicit coverage and missed positives', async t => {
  const { store } = fixture(t);
  const labels = [{ event_id: 'event-1', family: 'acceptance_relevance', relevant: true, target_ids: ['acceptance-1'] }];
  const report = await run(store, { labels, judge: judge(input => {
    assert.equal(input.labels, undefined);
    return decision({ confidence: 0.6 });
  }) });
  const metrics = report.labeled_metrics.acceptance_relevance;
  assert.equal(metrics.coverage, 0);
  assert.equal(metrics.recall, 0);
  assert.equal(metrics.precision, null);
  assert.equal(metrics.abstained, 1);
});

test('invalid labels cannot leave an apparently successful persisted run', async t => {
  const { store } = fixture(t);
  await assert.rejects(run(store, { labels: [{ event_id: 'absent', family: 'acceptance_relevance' }] }), /unknown event/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM runs').get().n, 0);
});

test('normalization rejects ambiguous timestamps and missing provenance/ACL', () => {
  for (const bad of [event({ timestamp: '2026-09-19' }), event({ source: {} }), event({ acl: {} }), event({ type: 'SLACK_MESSAGE' })]) {
    assert.throws(() => normalizeEvent(bad));
  }
});

test('policy validation rejects cycles, missing edges, unreachable nodes, and unsafe thresholds', () => {
  const variants = [
    p => { p.nodes.work.next = 'acceptance'; },
    p => { p.nodes.work.next = 'missing'; },
    p => { p.nodes.orphan = { type: 'end' }; },
    p => { p.nodes.work.confidence_threshold = 0; },
    p => { p.nodes.work.type = 'canonicalize'; },
  ];
  for (const change of variants) { const p = structuredClone(policy); change(p); assert.throws(() => validatePolicy(p)); }
});

test('conditional graph edges select routes by action and audit skipped families honestly', async t => {
  const { store } = fixture(t);
  const branch = structuredClone(policy);
  branch.nodes.acceptance.next = { INGEST: 'durability', IGNORE: 'durability', DEFER: 'end', ESCALATE: 'end' };
  const report = await run(store, { policy: branch, judge: judge(() => decision({ confidence: 0.6 })) });
  assert.equal(report.decisions, 1);
  assert.equal(report.actions.DEFER, 1);
});

test('synthetic demo executes end-to-end with baseline quality metrics explicitly scoped', async t => {
  const { store } = fixture(t);
  const base = new URL('fixtures/', import.meta.url);
  const events = readFileSync(new URL('events.jsonl', base), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const state = JSON.parse(readFileSync(new URL('state.json', base), 'utf8'));
  const labels = JSON.parse(readFileSync(new URL('labels.json', base), 'utf8'));
  const report = await replay({ events, state, labels, scope: { tenant_id: 'demo', project_id: 'auth' }, policy, judge: new HeuristicJudge(), store, datasetKind: 'synthetic' });
  assert.equal(report.events, 5);
  assert.equal(report.decisions, 20);
  assert.equal(report.judge_errors, 0);
  assert.equal(report.dataset_kind, 'synthetic');
  assert.equal(report.labeled_metrics.acceptance_relevance.recall, 1);
  assert.equal(report.productization_gate, 'not_evaluated');
});
