import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CachedJudge } from '../src/adapters/cached-judge.mjs';
import { ClaudeCliJudge } from '../src/adapters/claude-cli-judge.mjs';
import { HaikuJudge } from '../src/adapters/haiku-judge.mjs';
import { ResilientJudge } from '../src/adapters/resilient-judge.mjs';
import { SqliteCandidateStore } from '../src/adapters/sqlite-store.mjs';
import { canonical, fingerprint, requireValue } from '../src/core/contracts.mjs';
import { compareRuns } from '../src/core/evaluation.mjs';
import { replay } from '../src/core/replay.mjs';

const SCOPE = { tenant_id: 'benchmark', project_id: 'peel' };
const DEFAULT_JEV_RUN = 'b6854e64-6104-4ee3-8cb2-84a054c84a44';
const QUALITY_METRICS = ['precision', 'recall', 'coverage', 'target_precision', 'target_recall'];

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  requireValue(process.argv[index + 1], `Missing value for ${name}`);
  return process.argv[index + 1];
}

function positiveInteger(name, fallback) {
  const value = Number(option(name, fallback));
  requireValue(Number.isInteger(value) && value >= 0, `Invalid ${name}`);
  return value;
}

function judgeTimeout(name, fallback) {
  const value = positiveInteger(name, fallback);
  requireValue(value > 0 && value <= 60_000, `Invalid ${name}`);
  return value;
}

function decisionKey(item) {
  return canonical([item.event_id, item.family]);
}

function decisionInputs(run) {
  return Object.fromEntries(run.decisions.map(item => [decisionKey(item), item.input_hash]));
}

function semanticPolicy(policy) {
  const snapshot = structuredClone(policy);
  for (const node of Object.values(snapshot.nodes ?? {})) delete node.timeout_ms;
  return snapshot;
}

export function verifyComparableRuns(left, right) {
  requireValue(left.manifest.status === 'complete' && right.manifest.status === 'complete', 'Comparison requires complete runs');
  for (const key of ['tenant_id', 'project_id', 'dataset_hash', 'state_hash', 'labels_hash']) {
    requireValue(left.manifest[key] === right.manifest[key], `Comparison mismatch: ${key}`);
  }
  requireValue(canonical(semanticPolicy(left.manifest.policy)) === canonical(semanticPolicy(right.manifest.policy)),
    'Comparison mismatch: semantic policy snapshot');
  requireValue(canonical(decisionInputs(left)) === canonical(decisionInputs(right)), 'Comparison mismatch: decision inputs');
  for (const run of [left, right]) {
    requireValue(run.report?.events === 20 && run.report?.decisions === 80, 'Comparison requires the complete Peel corpus');
    requireValue(run.report?.judge_errors === 0, 'Comparison cannot include judge errors');
    requireValue(run.report?.productization_gate === 'not_evaluated', 'Comparison cannot advance the productization gate');
  }
}

function leader(left, right, lowerIsBetter = false) {
  if (left === null || right === null || left === right) return left === right ? 'tie' : 'not_comparable';
  if (lowerIsBetter) return left < right ? 'jev' : 'haiku';
  return left > right ? 'jev' : 'haiku';
}

function quality(left, right) {
  return Object.fromEntries(Object.keys(left.report.labeled_metrics).map(family => [family,
    Object.fromEntries(QUALITY_METRICS.map(metric => {
      const jev = left.report.labeled_metrics[family][metric];
      const haiku = right.report.labeled_metrics[family][metric];
      return [metric, { jev, haiku, delta_haiku_minus_jev: jev === null || haiku === null ? null : haiku - jev, leader: leader(jev, haiku) }];
    }))
  ]));
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}

function latency(run) {
  const values = run.decisions.map(item => item.result?.latency_ms).filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    observed_provider_calls: values.length,
    total_ms: total,
    mean_ms: values.length ? total / values.length : null,
    median_ms: percentile(values, 0.5),
    p95_ms: percentile(values, 0.95),
  };
}

function actionCounts(run) {
  return run.report.actions;
}

export function buildComparisonReport(jev, haiku, operations) {
  verifyComparableRuns(jev, haiku);
  const decisions = compareRuns(jev, haiku);
  return {
    schema_version: 1,
    comparison: `typesafe-ai/jev-vs-${haiku.manifest.judge.provider}/${haiku.manifest.judge.model}`,
    scope: SCOPE,
    dataset_kind: 'real',
    baseline_run_id: jev.manifest.run_id,
    challenger_run_id: haiku.manifest.run_id,
    productization_gate: 'not_evaluated',
    calibrated: false,
    caveat: 'This 20-event curated regression comparison does not establish product-wide calibration or a permanent routing decision.',
    integrity: {
      dataset_hash: jev.manifest.dataset_hash,
      state_hash: jev.manifest.state_hash,
      labels_hash: jev.manifest.labels_hash,
      semantic_policy_hash: fingerprint(semanticPolicy(jev.manifest.policy)),
      baseline_policy_hash: jev.manifest.policy_hash,
      challenger_policy_hash: haiku.manifest.policy_hash,
      decision_inputs: jev.decisions.length,
    },
    actions: { jev: actionCounts(jev), haiku: actionCounts(haiku) },
    quality: quality(jev, haiku),
    latency: { jev: latency(jev), haiku: latency(haiku) },
    operational: operations,
    disagreements: decisions,
  };
}

export async function runComparison({
  jevDatabase = resolve('.local/peel-jev-v3.sqlite'),
  jevRunId = DEFAULT_JEV_RUN,
  haikuDatabase = resolve('.local/peel-haiku-v1.sqlite'),
  cachePath = resolve('.local/peel-haiku-v1-cache.jsonl'),
  reportPath = resolve('.local/peel-jev-vs-haiku-v1.json'),
  minIntervalMs = 3000,
  maxAttempts = 3,
  judgeTimeoutMs = 60_000,
  transport = 'claude-cli',
} = {}) {
  const events = readFileSync('test/fixtures/peel/events.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const state = JSON.parse(readFileSync('test/fixtures/peel/state.json', 'utf8'));
  const labels = JSON.parse(readFileSync('test/fixtures/peel/labels.json', 'utf8'));
  const policy = JSON.parse(readFileSync('policies/peel-benchmark.json', 'utf8'));
  for (const node of Object.values(policy.nodes)) {
    if (node.type === 'judge') node.timeout_ms = judgeTimeoutMs;
  }
  requireValue(['claude-cli', 'gateway'].includes(transport), 'Unsupported Haiku transport');
  const transportJudge = new ResilientJudge(transport === 'claude-cli' ? new ClaudeCliJudge() : new HaikuJudge(), {
    minIntervalMs, maxAttempts, baseDelayMs: 2000, maxDelayMs: 8000,
  });
  const judge = new CachedJudge(transportJudge, { path: cachePath });
  const haikuStore = new SqliteCandidateStore(haikuDatabase);
  let report;
  let haikuRun;
  try {
    report = await replay({
      events, state, labels, policy,
      scope: SCOPE,
      judge,
      store: haikuStore,
      datasetKind: 'real',
    });
    haikuRun = haikuStore.readRun(SCOPE, report.run_id);
  } finally {
    haikuStore.close();
  }
  const jevStore = new SqliteCandidateStore(jevDatabase, { readOnly: true });
  let jevRun;
  try {
    jevRun = jevStore.readRun(SCOPE, jevRunId);
  } finally {
    jevStore.close();
  }
  const comparison = buildComparisonReport(jevRun, haikuRun, { ...judge.snapshot(), judge_timeout_ms: judgeTimeoutMs });
  writeFileSync(reportPath, `${JSON.stringify(comparison, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { ok: true, haiku_database: haikuDatabase, cache: cachePath, report: reportPath, comparison };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runComparison({
      jevDatabase: resolve(option('--jev-db', '.local/peel-jev-v3.sqlite')),
      jevRunId: option('--jev-run', DEFAULT_JEV_RUN),
      haikuDatabase: resolve(option('--haiku-db', '.local/peel-haiku-v1.sqlite')),
      cachePath: resolve(option('--cache', '.local/peel-haiku-v1-cache.jsonl')),
      reportPath: resolve(option('--report', '.local/peel-jev-vs-haiku-v1.json')),
      minIntervalMs: positiveInteger('--interval-ms', 3000),
      maxAttempts: positiveInteger('--max-attempts', 3),
      judgeTimeoutMs: judgeTimeout('--timeout-ms', 60_000),
      transport: option('--transport', 'claude-cli'),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch {
    console.error(JSON.stringify({ ok: false, error: 'Peel judge comparison failed; inspect the ignored local audit before retrying.' }));
    process.exitCode = 1;
  }
}
