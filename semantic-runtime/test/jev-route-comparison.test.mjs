import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRouteComparisonReport } from '../scripts/compare-peel-jev-routes.mjs';

const families = ['acceptance_relevance', 'durable_cross_ticket_value', 'context_relevance', 'independently_schedulable_work'];
const metrics = value => Object.fromEntries(families.map(family => [family, {
  precision: value, recall: value, coverage: value,
  target_precision: family.includes('relevance') ? value : null,
  target_recall: family.includes('relevance') ? value : null,
}]));

function run(id, provider, value, latencyMs) {
  return {
    manifest: {
      status: 'complete', tenant_id: 'benchmark', project_id: 'peel', run_id: id,
      dataset_hash: 'dataset', state_hash: 'state', labels_hash: 'labels', policy_hash: 'policy',
      judge: { provider, model: provider === 'vercel-ai-gateway' ? 'typesafe-ai/jev' : 'jev-latest' },
      policy: {
        schema_version: 1, policy_id: 'fixture', version: '1', entry: 'judge',
        nodes: {
          judge: { type: 'judge', family: 'acceptance_relevance', question: 'same', confidence_threshold: 0.8, timeout_ms: 15_000, next: 'end' },
          end: { type: 'end' },
        },
      },
    },
    report: {
      events: 20, decisions: 80, judge_errors: 0, productization_gate: 'not_evaluated',
      actions: { IGNORE: value > 0.5 ? 0 : 80, INGEST: value > 0.5 ? 80 : 0, DEFER: 0, ESCALATE: 0 },
      labeled_metrics: metrics(value),
    },
    decisions: Array.from({ length: 80 }, (_, index) => ({
      event_id: `event-${Math.floor(index / 4)}`,
      family: families[index % 4],
      input_hash: `hash-${index}`,
      action: value > 0.5 ? 'INGEST' : 'IGNORE',
      error_code: null,
      result: {
        value: { relevant: value > 0.5, target_ids: [] },
        latency_ms: latencyMs,
        model: provider === 'typesafe-direct' ? 'jev-1.13.0' : 'typesafe-ai/jev',
      },
    })),
  };
}

test('JEV route comparison proves exact inputs and reports route-specific differences', () => {
  const gateway = run('gateway-run', 'vercel-ai-gateway', 0.4, 300);
  const direct = run('direct-run', 'typesafe-direct', 0.6, 140);
  const artifact = {
    run_id: 'direct-run', productization_gate: 'not_evaluated',
    operational: { transport: { requests: 77, retries: 0, rate_limited: 0 } },
  };
  const report = buildRouteComparisonReport(gateway, direct, artifact);
  assert.equal(report.latency.median_leader, 'direct');
  assert.equal(report.latency.observed_median_ratio, 140 / 300);
  assert.equal(report.quality.acceptance_relevance.recall.leader, 'direct');
  assert.equal(report.disagreements.changed, 80);
  assert.deepEqual(report.routes.direct.resolved_models, ['jev-1.13.0']);
  assert.equal(report.operational.direct.transport.rate_limited, 0);
  assert.equal(report.productization_gate, 'not_evaluated');
});

test('JEV route comparison rejects the wrong route and mismatched direct artifact', () => {
  const gateway = run('gateway-run', 'vercel-ai-gateway', 0.4, 300);
  const direct = run('direct-run', 'typesafe-direct', 0.6, 140);
  assert.throws(() => buildRouteComparisonReport(gateway, direct, {
    run_id: 'other', productization_gate: 'not_evaluated', operational: {},
  }), /does not match/);
  const wrongRoute = run('direct-run', 'claude-cli', 0.6, 140);
  assert.throws(() => buildRouteComparisonReport(gateway, wrongRoute, {
    run_id: 'direct-run', productization_gate: 'not_evaluated', operational: {},
  }), /official TypeSafe direct/);
});
