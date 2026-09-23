import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CachedJudge } from '../../src/adapters/providers/cached-judge.mjs';
import { ResilientJudge } from '../../src/adapters/providers/resilient-judge.mjs';
import { SqliteCandidateStore } from './adapters/sqlite-store.mjs';
import { TypeSafeJevJudge } from '../../src/adapters/providers/typesafe-jev-judge.mjs';
import { replay } from './src/replay.mjs';
import { verifyBenchmarkReport } from './benchmark-peel-jev.mjs';

const SCOPE = { tenant_id: 'benchmark', project_id: 'peel' };

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

export async function runDirectPeelBenchmark({
  database = resolve('.local/peel-jev-direct-v1.sqlite'),
  cachePath = resolve('.local/peel-jev-direct-v1-cache.jsonl'),
  reportPath = resolve('.local/peel-jev-direct-v1.json'),
  minIntervalMs = 500,
  maxAttempts = 4,
} = {}) {
  if (!process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is required');
  const events = readFileSync('research/phase0-replay/fixtures/peel/events.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const state = JSON.parse(readFileSync('research/phase0-replay/fixtures/peel/state.json', 'utf8'));
  const labels = JSON.parse(readFileSync('research/phase0-replay/fixtures/peel/labels.json', 'utf8'));
  const policy = JSON.parse(readFileSync(new URL('./policies/peel-benchmark.json', import.meta.url), 'utf8'));
  const transport = new ResilientJudge(new TypeSafeJevJudge(), {
    minIntervalMs, maxAttempts, baseDelayMs: 500, maxDelayMs: 8_000,
  });
  const judge = new CachedJudge(transport, { path: cachePath });
  const store = new SqliteCandidateStore(database);
  let report;
  let run;
  try {
    report = await replay({ events, state, labels, policy, scope: SCOPE, judge, store, datasetKind: 'real' });
    verifyBenchmarkReport(report);
    run = store.readRun(SCOPE, report.run_id);
  } finally {
    store.close();
  }
  const artifact = {
    schema_version: 1,
    run_id: report.run_id,
    productization_gate: 'not_evaluated',
    report,
    latency: latency(run),
    operational: judge.snapshot(),
  };
  writeFileSync(reportPath, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { ok: true, database, cache: cachePath, report: reportPath, artifact };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runDirectPeelBenchmark(), null, 2));
  } catch {
    console.error(JSON.stringify({ ok: false, error: 'TypeSafe direct Peel benchmark failed; inspect the ignored local audit before retrying.' }));
    process.exitCode = 1;
  }
}
