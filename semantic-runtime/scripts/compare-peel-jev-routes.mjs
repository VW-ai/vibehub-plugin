import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteCandidateStore } from '../src/adapters/sqlite-store.mjs';
import { fingerprint, requireValue } from '../src/core/contracts.mjs';
import { compareRuns } from '../src/core/evaluation.mjs';
import { verifyComparableRuns } from './compare-peel-judges.mjs';

const SCOPE = { tenant_id: 'benchmark', project_id: 'peel' };
const DEFAULT_GATEWAY_RUN = 'b6854e64-6104-4ee3-8cb2-84a054c84a44';
const QUALITY_METRICS = ['precision', 'recall', 'coverage', 'target_precision', 'target_recall'];

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  requireValue(process.argv[index + 1], `Missing value for ${name}`);
  return process.argv[index + 1];
}

function readRun(database, runId) {
  const store = new SqliteCandidateStore(database, { readOnly: true });
  try {
    return store.readRun(SCOPE, runId);
  } finally {
    store.close();
  }
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}

function latency(run) {
  const values = run.decisions.map(item => item.result?.latency_ms)
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    observed_provider_calls: values.length,
    total_ms: total,
    mean_ms: values.length ? total / values.length : null,
    median_ms: percentile(values, 0.5),
    p95_ms: percentile(values, 0.95),
  };
}

function leader(gateway, direct, lowerIsBetter = false) {
  if (gateway === null || direct === null) return 'not_comparable';
  if (gateway === direct) return 'tie';
  if (lowerIsBetter) return direct < gateway ? 'direct' : 'gateway';
  return direct > gateway ? 'direct' : 'gateway';
}

function quality(gateway, direct) {
  return Object.fromEntries(Object.keys(gateway.report.labeled_metrics).map(family => [family,
    Object.fromEntries(QUALITY_METRICS.map(metric => {
      const gatewayValue = gateway.report.labeled_metrics[family][metric];
      const directValue = direct.report.labeled_metrics[family][metric];
      return [metric, {
        gateway: gatewayValue,
        direct: directValue,
        delta_direct_minus_gateway: gatewayValue === null || directValue === null ? null : directValue - gatewayValue,
        leader: leader(gatewayValue, directValue),
      }];
    }))
  ]));
}

function semanticPolicy(policy) {
  const snapshot = structuredClone(policy);
  for (const node of Object.values(snapshot.nodes ?? {})) delete node.timeout_ms;
  return snapshot;
}

function route(run) {
  const providerDecisions = run.decisions.filter(item => Number.isFinite(item.result?.latency_ms) && item.result.latency_ms > 0);
  return {
    provider: run.manifest.judge.provider,
    requested_model: run.manifest.judge.model,
    resolved_models: [...new Set(providerDecisions.map(item => item.result?.model).filter(Boolean))].sort(),
  };
}

export function buildRouteComparisonReport(gateway, direct, directArtifact) {
  verifyComparableRuns(gateway, direct);
  requireValue(gateway.manifest.judge.provider === 'vercel-ai-gateway', 'Baseline must use Vercel AI Gateway');
  requireValue(direct.manifest.judge.provider === 'typesafe-direct', 'Challenger must use official TypeSafe direct');
  requireValue(directArtifact?.run_id === direct.manifest.run_id, 'Direct artifact does not match the direct audit run');
  requireValue(directArtifact?.productization_gate === 'not_evaluated', 'Direct artifact cannot advance the productization gate');
  const gatewayLatency = latency(gateway);
  const directLatency = latency(direct);
  return {
    schema_version: 1,
    comparison: 'typesafe-ai/jev-gateway-vs-official-direct',
    scope: SCOPE,
    dataset_kind: 'real',
    gateway_run_id: gateway.manifest.run_id,
    direct_run_id: direct.manifest.run_id,
    productization_gate: 'not_evaluated',
    calibrated: false,
    caveat: 'This 20-event curated route comparison includes transport and adapter/API behavior. It does not establish provider-wide latency, probability calibration, downstream task success, or a permanent routing decision.',
    integrity: {
      dataset_hash: gateway.manifest.dataset_hash,
      state_hash: gateway.manifest.state_hash,
      labels_hash: gateway.manifest.labels_hash,
      semantic_policy_hash: fingerprint(semanticPolicy(gateway.manifest.policy)),
      decision_inputs: gateway.decisions.length,
    },
    routes: { gateway: route(gateway), direct: route(direct) },
    actions: { gateway: gateway.report.actions, direct: direct.report.actions },
    quality: quality(gateway, direct),
    latency: {
      gateway: gatewayLatency,
      direct: directLatency,
      observed_median_delta_ms: directLatency.median_ms - gatewayLatency.median_ms,
      observed_median_ratio: directLatency.median_ms / gatewayLatency.median_ms,
      median_leader: leader(gatewayLatency.median_ms, directLatency.median_ms, true),
      p95_leader: leader(gatewayLatency.p95_ms, directLatency.p95_ms, true),
    },
    operational: {
      gateway: { available: false, note: 'The accepted Gateway audit predates shared transport counters; decision latency remains available.' },
      direct: directArtifact.operational,
    },
    disagreements: compareRuns(gateway, direct),
  };
}

export function comparePeelJevRoutes({
  gatewayDatabase = resolve('.local/peel-jev-v3.sqlite'),
  gatewayRunId = DEFAULT_GATEWAY_RUN,
  directDatabase = resolve('.local/peel-jev-direct-v1.sqlite'),
  directArtifactPath = resolve('.local/peel-jev-direct-v1.json'),
  reportPath = resolve('.local/peel-jev-gateway-vs-direct-v1.json'),
} = {}) {
  const directArtifact = JSON.parse(readFileSync(directArtifactPath, 'utf8'));
  const gateway = readRun(gatewayDatabase, gatewayRunId);
  const direct = readRun(directDatabase, directArtifact.run_id);
  const comparison = buildRouteComparisonReport(gateway, direct, directArtifact);
  writeFileSync(reportPath, `${JSON.stringify(comparison, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { ok: true, report: reportPath, comparison };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = comparePeelJevRoutes({
      gatewayDatabase: resolve(option('--gateway-db', '.local/peel-jev-v3.sqlite')),
      gatewayRunId: option('--gateway-run', DEFAULT_GATEWAY_RUN),
      directDatabase: resolve(option('--direct-db', '.local/peel-jev-direct-v1.sqlite')),
      directArtifactPath: resolve(option('--direct-artifact', '.local/peel-jev-direct-v1.json')),
      reportPath: resolve(option('--report', '.local/peel-jev-gateway-vs-direct-v1.json')),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch {
    console.error(JSON.stringify({ ok: false, error: 'Peel JEV route comparison failed; inspect the ignored local audits.' }));
    process.exitCode = 1;
  }
}
