import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildComparisonReport, verifyComparableRuns } from '../compare-peel-judges.mjs';

const families = ['acceptance_relevance', 'durable_cross_ticket_value', 'context_relevance', 'independently_schedulable_work'];
const metrics = value => Object.fromEntries(families.map(family => [family, {
  precision: value, recall: value, coverage: value,
  target_precision: family.includes('relevance') ? value : null,
  target_recall: family.includes('relevance') ? value : null,
}]));

function run(id, value, overrides = {}) {
  const decisions = Array.from({ length: 80 }, (_, index) => ({
    event_id: `event-${Math.floor(index / 4)}`,
    family: families[index % 4],
    input_hash: `hash-${index}`,
    action: value > 0.5 ? 'INGEST' : 'IGNORE',
    error_code: null,
    result: { value: { relevant: value > 0.5, target_ids: [] }, latency_ms: value * 100 },
  }));
  return {
    manifest: {
      status: 'complete', tenant_id: 'benchmark', project_id: 'peel', run_id: id,
      dataset_hash: 'dataset', state_hash: 'state', labels_hash: 'labels', policy_hash: 'policy',
      judge: { provider: id === 'jev' ? 'vercel-ai-gateway' : 'claude-cli', model: id === 'jev' ? 'typesafe-ai/jev' : 'claude-haiku-4-5-20251001' },
      policy: {
        schema_version: 1, policy_id: 'fixture', version: '1', entry: 'judge',
        nodes: {
          judge: { type: 'judge', family: 'acceptance_relevance', question: 'same', confidence_threshold: 0.8, timeout_ms: 15_000, next: 'end' },
          end: { type: 'end' },
        },
      },
      ...overrides,
    },
    report: {
      events: 20, decisions: 80, judge_errors: 0, productization_gate: 'not_evaluated',
      actions: { IGNORE: 80, INGEST: 0, DEFER: 0, ESCALATE: 0 },
      labeled_metrics: metrics(value),
    },
    decisions,
  };
}

test('judge comparison refuses mismatched corpus, semantic policy, labels, or decision inputs', () => {
  const baseline = run('jev', 0.4);
  assert.doesNotThrow(() => verifyComparableRuns(baseline, run('haiku', 0.6)));
  for (const [field, value] of [['dataset_hash', 'other'], ['state_hash', 'other'], ['labels_hash', 'other']]) {
    assert.throws(() => verifyComparableRuns(baseline, run('haiku', 0.6, { [field]: value })), new RegExp(field));
  }
  const slowerDeadline = run('haiku', 0.6, { policy_hash: 'operationally-different' });
  slowerDeadline.manifest.policy.nodes.judge.timeout_ms = 60_000;
  assert.doesNotThrow(() => verifyComparableRuns(baseline, slowerDeadline));
  const changedQuestion = run('haiku', 0.6);
  changedQuestion.manifest.policy.nodes.judge.question = 'different';
  assert.throws(() => verifyComparableRuns(baseline, changedQuestion), /semantic policy snapshot/);
  const changedThreshold = run('haiku', 0.6);
  changedThreshold.manifest.policy.nodes.judge.confidence_threshold = 0.7;
  assert.throws(() => verifyComparableRuns(baseline, changedThreshold), /semantic policy snapshot/);
  const changed = run('haiku', 0.6);
  changed.decisions[0].input_hash = 'different';
  assert.throws(() => verifyComparableRuns(baseline, changed), /decision inputs/);
});

test('judge comparison reports per-metric leaders, latency, and action disagreements', () => {
  const baseline = run('jev', 0.4);
  const challenger = run('haiku', 0.6);
  const report = buildComparisonReport(baseline, challenger, { cache_hits: 0, cache_misses: 80 });
  assert.equal(report.quality.acceptance_relevance.precision.leader, 'haiku');
  assert.ok(Math.abs(report.quality.acceptance_relevance.precision.delta_haiku_minus_jev - 0.2) < 1e-12);
  assert.equal(report.latency.jev.observed_provider_calls, 80);
  assert.equal(report.disagreements.changed, 80);
  assert.equal(report.productization_gate, 'not_evaluated');
  assert.equal(report.calibrated, false);
});
